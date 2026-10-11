import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import type { Session, User } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { getBuyerAppContext, type BuyerAppContext } from '@/lib/auth';
import { isoDateInTimeZone } from '@/lib/date-utils';
import { DEFAULT_TENANT_SETTINGS_STORED } from '@/lib/tenant-settings/defaults';
import { firstNameFromValue, normalizeIndianPhone } from '@/lib/phone';
import { supabaseAdmin } from '@/lib/supabase';
import type { LoginOtpCandidate } from '@/lib/server/buyer-otp-store';
import { syncBuyerEntrySafe } from '@/lib/server/inbox-entries';

export interface BuyerLoginCandidate {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_whatsapp_number: string | null;
  tenant_whatsapp_display_name: string | null;
  tenant_logo_url: string | null;
  buyer_id: string;
  role: 'buyer_admin' | 'buyer_assistant';
  principal_type: 'buyer' | 'delegate';
  user_id: string | null;
  buyer_user_id: string | null;
  phone: string;
  business_name: string;
  contact_name: string | null;
  buyer_app_enabled: boolean;
  tenant_app_enabled: boolean;
}

interface TenantSettingsRow {
  tenant_id: string;
  settings: Record<string, unknown> | null;
}

interface TenantBuyerAppMetadata {
  enabled: boolean;
  whatsapp_number: string | null;
  whatsapp_display_name: string | null;
  logo_url: string | null;
}

interface BuyerRow {
  id: string;
  tenant_id: string;
  business_name: string;
  contact_name: string | null;
  email?: string | null;
  credit_limit: number | null;
  phone: string | null;
  gstin: string | null;
  buyer_app_enabled: boolean | null;
  geography?: { state?: string; city?: string; zone?: string; pincode?: string } | null;
  billing_address?: Record<string, unknown> | null;
  custom_fields?: Record<string, unknown> | null;
  whatsapp_consent_at?: string | null;
  whatsapp_opt_out_at?: string | null;
}

interface TenantRow {
  id: string;
  business_name: string;
  slug: string;
  settings?: Record<string, unknown> | null;
}

export interface BuyerAccessProfile {
  context: BuyerAppContext;
  buyer: BuyerRow | null;
  tenant: TenantRow | null;
  greeting_name: string | null;
}

export interface BuyerVisibleCatalog {
  id: string;
  tenant_id: string;
  name: string;
  share_token: string;
  valid_to: string | null;
  message: string | null;
  created_at: string;
  scope_type: 'cohort' | 'buyer' | 'geography' | 'all';
  scope_value: Record<string, unknown> | null;
  hero_image_url: string | null;
}

type BuyerCandidateRpcRow = {
  kind: 'owner' | 'delegate';
  id: string;
  tenant_id: string;
  business_name: string | null;
  contact_name: string | null;
  buyer_id: string;
  role: string;
  user_id: string | null;
  buyer_user_id?: string | null;
  phone?: string | null;
  buyer_app_enabled: boolean | null;
  buyer_is_active?: boolean | null;
  buyer_deleted_at?: string | null;
  tenant_business_name: string | null;
  tenant_slug: string | null;
  tenant_whatsapp_number?: string | null;
  tenant_whatsapp_display_name?: string | null;
  tenant_logo_url?: string | null;
};

const BUYER_SESSION_PASSWORD_LENGTH = 32;

function buyerAppMetadataFromSettings(
  settings: Record<string, unknown> | null | undefined,
  logoUrl: string | null = null,
): TenantBuyerAppMetadata {
  const settingsBusiness = settings?.business;
  const settingsLogoUrl = settingsBusiness
    && typeof settingsBusiness === 'object'
    && 'logo_url' in settingsBusiness
    && typeof (settingsBusiness as { logo_url?: unknown }).logo_url === 'string'
    && (settingsBusiness as { logo_url: string }).logo_url.trim()
      ? (settingsBusiness as { logo_url: string }).logo_url.trim()
      : null;
  const resolvedLogoUrl = logoUrl?.trim() || settingsLogoUrl;
  const buyerApp = settings?.buyer_app;
  if (buyerApp && typeof buyerApp === 'object' && 'enabled' in buyerApp) {
    const typedBuyerApp = buyerApp as {
      enabled?: unknown;
      whatsapp_number?: unknown;
      whatsapp_display_name?: unknown;
    };

    return {
      enabled: Boolean(typedBuyerApp.enabled),
      whatsapp_number:
        typeof typedBuyerApp.whatsapp_number === 'string' && typedBuyerApp.whatsapp_number.trim()
          ? typedBuyerApp.whatsapp_number.trim()
          : null,
      whatsapp_display_name:
        typeof typedBuyerApp.whatsapp_display_name === 'string' && typedBuyerApp.whatsapp_display_name.trim()
          ? typedBuyerApp.whatsapp_display_name.trim()
          : null,
      logo_url: resolvedLogoUrl,
    };
  }

  return {
    enabled: DEFAULT_TENANT_SETTINGS_STORED.buyer_app.enabled,
    whatsapp_number: DEFAULT_TENANT_SETTINGS_STORED.buyer_app.whatsapp_number || null,
    whatsapp_display_name: DEFAULT_TENANT_SETTINGS_STORED.buyer_app.whatsapp_display_name || null,
    logo_url: resolvedLogoUrl,
  };
}

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, '')
    + crypto.randomUUID().replace(/-/g, '').slice(0, BUYER_SESSION_PASSWORD_LENGTH);
}

function syntheticBuyerEmail(phone: string, buyerId: string) {
  return `buyer-${phone}-${buyerId}@buyers.yukti.local`;
}

/**
 * One auth.users identity per real phone number, not one per buyers row —
 * a phone buying from multiple tenants (or multiple businesses at one tenant)
 * shares this id across every buyers/buyer_users row it's linked to, instead of
 * minting a fresh Supabase Auth user (and MAU) per relationship. Requires the
 * custom_access_token_hook's current_tenant_id/current_buyer_id preference
 * (fix_buyer_owner_hook_context_preference migration) to already be in place —
 * that's what makes it safe for multiple buyers rows to share one user_id.
 */
async function findExistingAuthUserIdForPhone(phone: string): Promise<string | null> {
  if (!supabaseAdmin) return null;

  const [buyersRes, buyerUsersRes] = await Promise.all([
    supabaseAdmin
      .schema('app')
      .from('buyers')
      .select('user_id')
      .eq('phone', phone)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .schema('app')
      .from('buyer_users')
      .select('user_id')
      .eq('phone', phone)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const buyerUserId = (buyersRes.data as { user_id: string | null } | null)?.user_id ?? null;
  const buyerUsersUserId = (buyerUsersRes.data as { user_id: string | null } | null)?.user_id ?? null;

  return buyerUserId ?? buyerUsersUserId;
}

async function loadTenantBuyerAppMetadata(tenantIds: string[]): Promise<Map<string, TenantBuyerAppMetadata>> {
  if (!supabaseAdmin || tenantIds.length === 0) return new Map();

  const [tenantSettingsRes, tenantsRes] = await Promise.all([
    supabaseAdmin
      .schema('app')
      .from('tenant_settings')
      .select('tenant_id, settings')
      .in('tenant_id', tenantIds),
    supabaseAdmin
      .schema('app')
      .from('tenants')
      .select('id, settings, logo_url')
      .in('id', tenantIds),
  ]);

  if (tenantSettingsRes.error || tenantsRes.error) {
    throw new Error(`Failed to load tenant settings: ${tenantSettingsRes.error?.message ?? tenantsRes.error?.message}`);
  }

  const tenantSettingsById = new Map(
    ((tenantSettingsRes.data ?? []) as TenantSettingsRow[]).map((row) => [row.tenant_id, row.settings]),
  );

  return new Map(
    ((tenantsRes.data ?? []) as Array<{ id: string; settings: Record<string, unknown> | null; logo_url: string | null }>).map((row) => [
      row.id,
      buyerAppMetadataFromSettings(tenantSettingsById.get(row.id) ?? row.settings, row.logo_url ?? null),
    ]),
  );
}

/** Seller's phone for buyer preview linking — domain-owned on app.tenant_users, not auth.users. */
export async function resolveSellerAuthPhone(userId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;

  // A user can belong to multiple tenants (multi-tenant seller_admin) — .maybeSingle()
  // errors on >1 rows. Phone is the same real person regardless of which tenant_users
  // row we read it off, so just take one deterministically.
  const { data } = await supabaseAdmin
    .schema('app')
    .from('tenant_users')
    .select('id, phone')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const row = data as { id: string; phone: string | null } | null;
  if (row?.phone) return row.phone;

  // Row exists but phone was never backfilled (or this tenant_users row predates the
  // column) — fall back to Auth once and persist it so the next call skips Auth.
  if (!row) return null;

  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
  const meta = authUser?.user?.user_metadata as Record<string, unknown> | null | undefined;
  const phone = (typeof meta?.phone === 'string' && meta.phone ? meta.phone : null)
    ?? authUser?.user?.phone
    ?? null;

  if (phone) {
    await supabaseAdmin
      .schema('app')
      .from('tenant_users')
      .update({ phone })
      .eq('id', row.id);
  }

  return phone;
}

/** Deduped buyer rows in a tenant that share the seller's phone (preview only). */
export async function findTenantBuyerPreviewCandidates(
  userId: string,
  tenantId: string,
): Promise<BuyerLoginCandidate[]> {
  const phone = await resolveSellerAuthPhone(userId);
  if (!phone) return [];

  const candidates = await findBuyerLoginCandidates(phone);
  const byBuyerId = new Map<string, BuyerLoginCandidate>();
  for (const candidate of candidates) {
    if (candidate.tenant_id !== tenantId) continue;
    if (!byBuyerId.has(candidate.buyer_id)) {
      byBuyerId.set(candidate.buyer_id, candidate);
    }
  }

  return Array.from(byBuyerId.values());
}

export async function findBuyerLoginCandidates(phone: string): Promise<BuyerLoginCandidate[]> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const normalizedPhone = normalizeIndianPhone(phone);
  const db = supabaseAdmin;

  // Single RPC combining what used to be 2 sequential PostgREST round trips
  // (app.buyers and app.buyer_users, each with a nested tenants embed) — see
  // app.find_buyer_login_candidates.
  const { data: rows, error } = await db
    .schema('app')
    .rpc('find_buyer_login_candidates', { p_phone: normalizedPhone });

  if (error) {
    throw new Error(`Buyer login candidate lookup failed: ${error.message}`);
  }

  const tenantIds = new Set<string>();
  const ownerCandidates: BuyerLoginCandidate[] = [];
  const delegateCandidates: BuyerLoginCandidate[] = [];

  for (const row of (rows ?? []) as BuyerCandidateRpcRow[]) {
    if (row.kind === 'owner') {
      const candidate: BuyerLoginCandidate = {
        tenant_id: String(row.tenant_id),
        tenant_name: String(row.tenant_business_name ?? ''),
        tenant_slug: String(row.tenant_slug ?? ''),
        tenant_whatsapp_number: null,
        tenant_whatsapp_display_name: null,
        tenant_logo_url: null,
        buyer_id: String(row.id),
        role: 'buyer_admin',
        principal_type: 'buyer',
        user_id: row.user_id,
        buyer_user_id: null,
        phone: normalizedPhone,
        business_name: String(row.business_name ?? ''),
        contact_name: row.contact_name,
        buyer_app_enabled: Boolean(row.buyer_app_enabled),
        tenant_app_enabled: false,
      };
      tenantIds.add(candidate.tenant_id);
      ownerCandidates.push(candidate);
      continue;
    }

    if (!row.buyer_is_active || row.buyer_deleted_at) continue;

    const candidate: BuyerLoginCandidate = {
      tenant_id: String(row.tenant_id ?? ''),
      tenant_name: String(row.tenant_business_name ?? ''),
      tenant_slug: String(row.tenant_slug ?? ''),
      tenant_whatsapp_number: null,
      tenant_whatsapp_display_name: null,
      tenant_logo_url: null,
      buyer_id: String(row.buyer_id ?? ''),
      role: (String(row.role ?? 'buyer_assistant') as 'buyer_admin' | 'buyer_assistant'),
      principal_type: 'delegate',
      user_id: String(row.user_id ?? ''),
      buyer_user_id: String(row.id ?? ''),
      phone: normalizedPhone,
      business_name: String(row.business_name ?? ''),
      contact_name: row.contact_name,
      buyer_app_enabled: Boolean(row.buyer_app_enabled),
      tenant_app_enabled: false,
    };
    tenantIds.add(candidate.tenant_id);
    delegateCandidates.push(candidate);
  }

  const metadataByTenant = await loadTenantBuyerAppMetadata(Array.from(tenantIds));

  return [...ownerCandidates, ...delegateCandidates].map((candidate) => ({
    ...candidate,
    tenant_app_enabled: metadataByTenant.get(candidate.tenant_id)?.enabled === true,
    tenant_whatsapp_number: metadataByTenant.get(candidate.tenant_id)?.whatsapp_number ?? null,
    tenant_whatsapp_display_name: metadataByTenant.get(candidate.tenant_id)?.whatsapp_display_name ?? null,
    tenant_logo_url: metadataByTenant.get(candidate.tenant_id)?.logo_url ?? null,
  }));
}

export async function findBuyerWorkspaceCandidatesForUser(userId: string): Promise<BuyerLoginCandidate[]> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const { data: rows, error } = await supabaseAdmin
    .schema('app')
    .rpc('find_buyer_workspace_candidates_for_user', { p_user_id: userId });

  if (error) {
    throw new Error(`Buyer workspace candidate lookup failed: ${error.message}`);
  }

  const typedRows = (rows ?? []) as BuyerCandidateRpcRow[];
  const tenantIds = Array.from(new Set(typedRows.map((row) => String(row.tenant_id)).filter(Boolean)));
  const metadataByTenant = await loadTenantBuyerAppMetadata(tenantIds);

  return typedRows.map((row) => ({
    tenant_id: String(row.tenant_id),
    tenant_name: String(row.tenant_business_name ?? ''),
    tenant_slug: String(row.tenant_slug ?? ''),
    tenant_whatsapp_number: row.tenant_whatsapp_number ?? null,
    tenant_whatsapp_display_name: row.tenant_whatsapp_display_name ?? null,
    tenant_logo_url: row.tenant_logo_url?.trim() || metadataByTenant.get(String(row.tenant_id))?.logo_url || null,
    buyer_id: String(row.buyer_id ?? row.id),
    role: row.kind === 'owner'
      ? 'buyer_admin'
      : (String(row.role ?? 'buyer_assistant') as 'buyer_admin' | 'buyer_assistant'),
    principal_type: row.kind === 'owner' ? 'buyer' : 'delegate',
    user_id: row.user_id,
    buyer_user_id: row.kind === 'delegate' ? String(row.buyer_user_id ?? row.id) : null,
    phone: String(row.phone ?? ''),
    business_name: String(row.business_name ?? ''),
    contact_name: row.contact_name,
    buyer_app_enabled: Boolean(row.buyer_app_enabled),
    tenant_app_enabled: true,
  }));
}

// The owner logs in as app.buyers directly — never via app.buyer_users, which
// is reserved for real staff (assistants/managers) under a buyer. The auth
// link lives on buyers.user_id, filled in lazily on first login.
async function ensureBuyerOwnerPrincipal(candidate: BuyerLoginCandidate): Promise<{ user: User; email: string }> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const email = syntheticBuyerEmail(candidate.phone, candidate.buyer_id);

  if (candidate.user_id) {
    return { user: { id: candidate.user_id } as User, email };
  }

  const fullName = candidate.contact_name?.trim() || candidate.business_name;

  // This phone may already have an auth.users identity from a different
  // buyers/buyer_users row (another tenant, or another business at this
  // tenant) — reuse it instead of minting a new one. custom_access_token_hook
  // resolves which row a given session is scoped to via app_metadata.current_*,
  // not via a 1:1 user_id assumption, so sharing is safe once linked.
  const existingUserId = await findExistingAuthUserIdForPhone(candidate.phone);

  if (existingUserId) {
    await supabaseAdmin.auth.admin.updateUserById(existingUserId, {
      user_metadata: {
        full_name: fullName,
        first_name: firstNameFromValue(fullName),
        phone: candidate.phone,
        buyer_id: candidate.buyer_id,
        tenant_id: candidate.tenant_id,
      },
    });

    const { error: linkError } = await supabaseAdmin
      .schema('app')
      .from('buyers')
      .update({ user_id: existingUserId, updated_by: existingUserId })
      .eq('id', candidate.buyer_id);

    if (linkError) {
      throw new Error(`Failed to link buyer auth user: ${linkError.message}`);
    }

    return { user: { id: existingUserId } as User, email };
  }

  const password = randomPassword();
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      first_name: firstNameFromValue(fullName),
      phone: candidate.phone,
      buyer_id: candidate.buyer_id,
      tenant_id: candidate.tenant_id,
    },
    app_metadata: {
      current_tenant_id: candidate.tenant_id,
      current_buyer_id: candidate.buyer_id,
    },
  });

  if (createError || !created.user) {
    throw new Error(createError?.message ?? 'Failed to create buyer auth user');
  }

  const { error: updateError } = await supabaseAdmin
    .schema('app')
    .from('buyers')
    .update({ user_id: created.user.id, updated_by: created.user.id })
    .eq('id', candidate.buyer_id);

  if (updateError) {
    throw new Error(`Failed to link buyer auth user: ${updateError.message}`);
  }

  return { user: created.user, email };
}

async function ensureBuyerDelegatePrincipal(candidate: BuyerLoginCandidate): Promise<{ user: User; email: string }> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  if (candidate.user_id) {
    // Same as the buyer-owner path: read the persisted email off buyer_users rather
    // than round-tripping to the Auth Admin API on every returning login.
    if (candidate.buyer_user_id) {
      const { data: row } = await supabaseAdmin
        .schema('app')
        .from('buyer_users')
        .select('email')
        .eq('id', candidate.buyer_user_id)
        .maybeSingle();
      const persistedEmail = (row as { email: string | null } | null)?.email;
      if (persistedEmail) {
        return { user: { id: candidate.user_id } as User, email: persistedEmail };
      }
    }

    // No persisted email yet (row created before this fix, or missing buyer_user_id) —
    // fall back to the Auth Admin API once, and persist it so the next login skips it.
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(candidate.user_id);
    if (error || !data.user) {
      throw new Error(error?.message ?? 'Buyer delegate auth user not found');
    }

    const email = data.user.email ?? syntheticBuyerEmail(candidate.phone, candidate.buyer_user_id ?? candidate.buyer_id);
    if (candidate.buyer_user_id) {
      await supabaseAdmin
        .schema('app')
        .from('buyer_users')
        .update({ email })
        .eq('id', candidate.buyer_user_id);
    }

    return {
      user: data.user,
      email,
    };
  }

  // Delegate rows synced in from an integration (e.g. Zoho contact_persons) have no
  // linked auth user until they first log in — provision one now, same as the buyer
  // owner path already does, and link it back onto the buyer_users row.
  if (!candidate.buyer_user_id) {
    throw new Error('Buyer delegate principal is missing a buyer_users row to link');
  }

  // Keyed off buyer_user_id, not buyer_id — a delegate's phone can legitimately
  // equal the buyer owner's own phone (same person added twice, or shared office
  // line), and the owner's synthetic email is keyed off buyer_id alone. Keying
  // both off the same (phone, buyer_id) pair collides them onto one email,
  // which auth.admin.createUser then rejects as a duplicate.
  const email = syntheticBuyerEmail(candidate.phone, candidate.buyer_user_id);
  const fullName = candidate.contact_name?.trim() || candidate.business_name;

  // Same phone may already have an auth.users identity via another
  // buyers/buyer_users row — reuse it instead of minting a new one.
  const existingUserId = await findExistingAuthUserIdForPhone(candidate.phone);

  if (existingUserId) {
    await supabaseAdmin.auth.admin.updateUserById(existingUserId, {
      user_metadata: {
        full_name: fullName,
        first_name: firstNameFromValue(fullName),
        phone: candidate.phone,
        buyer_id: candidate.buyer_id,
        tenant_id: candidate.tenant_id,
      },
    });

    const { error: linkError } = await supabaseAdmin
      .schema('app')
      .from('buyer_users')
      .update({
        user_id: existingUserId,
        email,
        updated_by: existingUserId,
      })
      .eq('id', candidate.buyer_user_id);

    if (linkError) {
      throw new Error(`Failed to link buyer delegate auth user: ${linkError.message}`);
    }

    return { user: { id: existingUserId } as User, email };
  }

  const password = randomPassword();
  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      first_name: firstNameFromValue(fullName),
      phone: candidate.phone,
      buyer_id: candidate.buyer_id,
      tenant_id: candidate.tenant_id,
    },
    app_metadata: {
      current_tenant_id: candidate.tenant_id,
      current_buyer_id: candidate.buyer_id,
    },
  });

  if (createError || !created.user) {
    throw new Error(createError?.message ?? 'Failed to create buyer delegate auth user');
  }

  const { error: updateError } = await supabaseAdmin
    .schema('app')
    .from('buyer_users')
    .update({
      user_id: created.user.id,
      email,
      updated_by: created.user.id,
    })
    .eq('id', candidate.buyer_user_id);

  if (updateError) {
    throw new Error(`Failed to link buyer delegate auth user: ${updateError.message}`);
  }

  return { user: created.user, email };
}

async function createBuyerSessionForUser(
  userId: string,
  email: string,
  password: string,
  candidate: BuyerLoginCandidate,
  // The phone a real WhatsApp OTP was just verified against (from the OTP
  // store record — phone-otp/verify route ONLY). Omit/undefined for every
  // other caller (switch-buyer, workspaces/enter, the switch-context picker
  // path) so this call never derives or re-derives the claim from
  // candidate.phone (sourced from the mutable app.buyers.phone column) —
  // omitting the key entirely relies on the Admin API's confirmed
  // user_metadata MERGE behavior (see 20260911013323 migration + fix report)
  // to leave whatever otp_verified_phone the user already has untouched.
  otpVerifiedPhone?: string,
) {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const fullName = candidate.contact_name?.trim() || candidate.business_name;
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      first_name: firstNameFromValue(fullName),
      phone: candidate.phone,
      buyer_id: candidate.buyer_id,
      tenant_id: candidate.tenant_id,
    },
    app_metadata: {
      current_tenant_id: candidate.tenant_id,
      current_buyer_id: candidate.buyer_id,
      // SECURITY: otp_verified_phone/otp_verified_phone_at moved from
      // user_metadata to app_metadata (see otp-verified-phone-app-metadata-
      // migration-report.md). user_metadata is client-writable via the
      // public supabase.auth.updateUser({data:...}) call -- any authenticated
      // user could forge this claim for themselves with just the anon key.
      // app_metadata is writable only via the Admin API (this call), so a
      // regular authenticated user cannot self-modify it. Task 11 review,
      // Important #1: otp_verified_phone alone proves a phone was verified at
      // some point, not that it was verified RECENTLY. A stamped-alongside
      // timestamp lets server-side routes (e.g. the document-resubmission
      // intake gate) require the claim to be fresh (see
      // hasFreshOtpVerification below) instead of trusting a claim that could
      // be arbitrarily old. Stamped at exactly the same call, with exactly
      // the same otpVerifiedPhone-only gating, as otp_verified_phone itself
      // -- never set independently of it. Empirically confirmed
      // updateUserById's app_metadata MERGES (does not replace wholesale),
      // same as user_metadata, so omitting these keys when otpVerifiedPhone
      // is undefined leaves any existing claim untouched, and setting them
      // here does not clobber current_tenant_id/current_buyer_id above.
      ...(otpVerifiedPhone ? { otp_verified_phone: otpVerifiedPhone, otp_verified_phone_at: new Date().toISOString() } : {}),
    },
  });

  if (updateError) {
    throw new Error(updateError.message);
  }

  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    throw new Error(signInError?.message ?? 'Failed to create buyer session');
  }

  const { data: refreshData, error: refreshError } = await anonClient.auth.refreshSession({
    refresh_token: signInData.session.refresh_token,
  });

  if (refreshError) {
    throw new Error(refreshError.message);
  }

  return refreshData.session ?? signInData.session;
}

/**
 * Cross-origin session handoff — OTP verified on catalog.useyukti.in (or any
 * host other than the candidate's own tenant) can't set a cookie on the
 * destination tenant's origin directly (third-party cookie context). Instead,
 * mint a single-use, short-TTL magic-link token the destination host redeems
 * client-side (supabaseBrowser.auth.verifyOtp), which sets that origin's own
 * first-party cookie. Same generateLink technique mintSellerSession already
 * uses for a different reason (password-less session creation).
 */
export async function mintBuyerHandoffLink(
  candidate: BuyerLoginCandidate,
  // See createBuyerSessionForUser's otpVerifiedPhone doc — same contract.
  // Pass ONLY the OTP store record's phone, and ONLY when this handoff link
  // is being minted directly off a real OTP verification. Every other
  // caller (workspaces/enter, the switch-context picker path) must omit
  // this so the merge-preserving Admin API call below leaves any existing
  // otp_verified_phone claim untouched.
  otpVerifiedPhone?: string,
): Promise<{ hashedToken: string; buyerId: string | null }> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const principal = candidate.principal_type === 'buyer'
    ? await ensureBuyerOwnerPrincipal(candidate)
    : await ensureBuyerDelegatePrincipal(candidate);

  const fullName = candidate.contact_name?.trim() || candidate.business_name;

  // Ensure the shared auth.users row's email/app_metadata reflect THIS
  // candidate's context before generating the link — the same user id may
  // have been used for a different buyer/tenant context on a prior login.
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(principal.user.id, {
    email: principal.email,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      first_name: firstNameFromValue(fullName),
      phone: candidate.phone,
      buyer_id: candidate.buyer_id,
      tenant_id: candidate.tenant_id,
    },
    app_metadata: {
      current_tenant_id: candidate.tenant_id,
      current_buyer_id: candidate.buyer_id,
      // SECURITY: see createBuyerSessionForUser's matching comment -- same
      // user_metadata -> app_metadata contract, same otpVerifiedPhone-only
      // gating, same confirmed merge (not replace) semantics.
      ...(otpVerifiedPhone ? { otp_verified_phone: otpVerifiedPhone, otp_verified_phone_at: new Date().toISOString() } : {}),
    },
  });
  if (updateError) {
    throw new Error(updateError.message);
  }

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: principal.email,
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(error?.message ?? 'Failed to generate storefront handoff link');
  }

  return { hashedToken: data.properties.hashed_token, buyerId: candidate.buyer_id };
}

export function filterLoginCandidatesToTenant<T extends { tenant_id: string; kind?: string }>(
  candidates: T[],
  tenantId: string,
): T[] {
  return candidates.filter((candidate) => candidate.tenant_id === tenantId && candidate.kind !== 'seller');
}

export async function acquireBuyerForStorefront(
  tenantId: string,
  phone: string,
): Promise<BuyerLoginCandidate> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const normalizedPhone = normalizeIndianPhone(phone);
  const db = supabaseAdmin;
  const { data: tenant, error: tenantError } = await db
    .schema('app')
    .from('tenants')
    .select('id, business_name, slug')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantError) throw new Error(tenantError.message);
  if (!tenant?.id) throw new Error('Tenant not found');

  const tenantMeta = (await loadTenantBuyerAppMetadata([tenantId])).get(tenantId);

  const { data: existing, error: existingError } = await db
    .schema('app')
    .from('buyers')
    .select('id, business_name, contact_name, user_id, buyer_app_enabled')
    .eq('tenant_id', tenantId)
    .eq('phone', normalizedPhone)
    .eq('is_active', true)
    .is('deleted_at', null)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);

  const row = existing as {
    id: string;
    business_name: string;
    contact_name: string | null;
    user_id: string | null;
    buyer_app_enabled: boolean | null;
  } | null;

  if (row) {
    // Never auto-reactivate here just because the phone retried OTP — that
    // would let a seller-suspended buyer, or a still-pending fresh
    // acquisition (see the insert branch below), silently re-enable
    // themselves by retrying. Reactivation is a seller action (Manage
    // Access) or an explicit approval, never a side effect of login.
    if (row.buyer_app_enabled === false) {
      syncBuyerEntrySafe(db as any, row.id);
    }

    return {
      tenant_id: tenantId,
      tenant_name: tenant.business_name as string,
      tenant_slug: tenant.slug as string,
      tenant_whatsapp_number: tenantMeta?.whatsapp_number ?? null,
      tenant_whatsapp_display_name: tenantMeta?.whatsapp_display_name ?? null,
      tenant_logo_url: tenantMeta?.logo_url ?? null,
      buyer_id: row.id,
      role: 'buyer_admin',
      principal_type: 'buyer',
      user_id: row.user_id,
      buyer_user_id: null,
      phone: normalizedPhone,
      business_name: row.business_name,
      contact_name: row.contact_name,
      buyer_app_enabled: row.buyer_app_enabled !== false,
      tenant_app_enabled: true,
    };
  }

  // Fresh self-registration via OTP, no prior seller relationship — defaults
  // closed (buyer_app_enabled: false), pending seller approval. Known buyers
  // (ERP-synced, CSV-imported, seller-added) are provisioned true elsewhere;
  // this path is specifically "a stranger just OTP'd in," which should not
  // be equivalent to a seller-vetted customer until approved.
  //
  // existing_yukti_identity records (once, at creation) whether this phone
  // already had an auth.users identity from another tenant relationship —
  // the intake screen (Yukti_Inbox_Feature-Spec_v1.md §7.1) uses this to
  // choose "new to Yukti" vs "new to this distributor" copy without
  // re-deriving it later.
  const existingUserId = await findExistingAuthUserIdForPhone(normalizedPhone);
  const { data: created, error: insertError } = await db
    .schema('app')
    .from('buyers')
    .insert({
      tenant_id: tenantId,
      business_name: `Customer ${normalizedPhone}`,
      contact_name: null,
      phone: normalizedPhone,
      credit_limit: 0,
      payment_terms_days: 0,
      buyer_app_enabled: false,
      // The column defaults to 'approved' (Task 1's migration assumed
      // seller-added/ERP-synced buyers, the common case) — a fresh
      // storefront self-registration is the one path that must override it,
      // or a genuinely pending buyer reads back as 'approved' and the
      // OnboardingStatusPill (Task 10) has nothing to show. Task 10 review,
      // Critical #1.
      onboarding_status: 'pending_approval',
      is_active: true,
      custom_fields: {
        storefront_self_registered: true,
        existing_yukti_identity: Boolean(existingUserId),
      },
    })
    .select('id, business_name, contact_name, user_id')
    .single();
  if (insertError || !created) {
    throw new Error(insertError?.message ?? 'Failed to create buyer');
  }

  const createdRow = created as {
    id: string;
    business_name: string;
    contact_name: string | null;
    user_id: string | null;
  };

  syncBuyerEntrySafe(db as any, createdRow.id);

  return {
    tenant_id: tenantId,
    tenant_name: tenant.business_name as string,
    tenant_slug: tenant.slug as string,
    tenant_whatsapp_number: tenantMeta?.whatsapp_number ?? null,
    tenant_whatsapp_display_name: tenantMeta?.whatsapp_display_name ?? null,
    tenant_logo_url: tenantMeta?.logo_url ?? null,
    buyer_id: createdRow.id,
    role: 'buyer_admin',
    principal_type: 'buyer',
    user_id: createdRow.user_id,
    buyer_user_id: null,
    phone: normalizedPhone,
    business_name: createdRow.business_name,
    contact_name: createdRow.contact_name,
    buyer_app_enabled: false,
    tenant_app_enabled: true,
  };
}

export const RESUBMIT_DOCUMENTS_PATH = '/resubmit-documents';
const NEEDS_MORE_INFO_PATH_STATUS = 'needs_more_info';

/**
 * Where to send a `buyer_pending` session right after OTP: the resubmission form when the seller
 * asked for more info, /onboarding for a fresh self-registration that hasn't filed its intake form,
 * and /pending for everyone else (intake filed and awaiting approval, declined, or an existing
 * seller/ERP-created buyer whose app access is off and who can request access there).
 *
 * Never the storefront home: the storefront shell sends every pending session on to /pending
 * client-side, so landing on `/` only flashed the (gated, empty) catalog first. Mirrors
 * pendingBuyerDestination (src/lib/buyer-pending-destination.ts) on the client.
 * Yukti_Inbox_Feature-Spec_v1.md §7.1.
 */
export async function resolvePendingBuyerRedirect(buyerId: string): Promise<string> {
  if (!supabaseAdmin) return '/pending';

  const { data } = await supabaseAdmin
    .schema('app')
    .from('buyers')
    .select('custom_fields, onboarding_status')
    .eq('id', buyerId)
    .maybeSingle();

  const row = data as { custom_fields?: Record<string, unknown> | null; onboarding_status?: string | null } | null;
  // Seller asked for more info: the buyer must land on the prefilled resubmission form, or they
  // have no way to answer the request.
  if (row?.onboarding_status === NEEDS_MORE_INFO_PATH_STATUS) return RESUBMIT_DOCUMENTS_PATH;

  const customFields = row?.custom_fields;
  const selfRegistered = customFields?.storefront_self_registered === true;
  const intakeSubmitted = Boolean(customFields?.intake_submitted_at);

  if (selfRegistered && !intakeSubmitted) return '/onboarding';
  return '/pending';
}

export async function mintBuyerSession(
  candidate: BuyerLoginCandidate,
  // See createBuyerSessionForUser's otpVerifiedPhone doc — same contract.
  // Pass ONLY when this session is being minted directly off a real OTP
  // verification (phone-otp/verify or select-context after a genuinely
  // OTP-verified 'verified' record). switch-buyer and any other remint path
  // must omit this.
  otpVerifiedPhone?: string,
): Promise<{ session: Session; user: User }> {
  const principal = candidate.principal_type === 'buyer'
    ? await ensureBuyerOwnerPrincipal(candidate)
    : await ensureBuyerDelegatePrincipal(candidate);

  const password = randomPassword();
  const session = await createBuyerSessionForUser(
    principal.user.id,
    principal.email,
    password,
    candidate,
    otpVerifiedPhone,
  );

  if (supabaseAdmin && candidate.buyer_id) {
    void supabaseAdmin
      .schema('app')
      .from('buyers')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', candidate.buyer_id)
      .then(({ error }) => {
        if (error) console.error('[mintBuyerSession] failed to stamp last_login_at', error);
      });
  }

  return {
    session,
    user: principal.user,
  };
}

const RESUBMISSION_OTP_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * Task 11 review, Important #1: the forced-re-OTP document-resubmission flow
 * (/resubmit-documents) only gated the FORM RENDER on a fresh client-side OTP
 * verify -- neither GET /api/buyer/onboarding/resubmission-profile nor the
 * actual mutation endpoint (POST /api/buyer/onboarding/intake) required OTP
 * freshness server-side, so a stolen/persisted session cookie could curl the
 * intake route directly and resubmit identity documents without ever
 * touching OTP. This defeats the forced-re-OTP design's actual security
 * purpose (Yukti_Public-Signup_Frontend-Spec_v1.md §0b chose forced re-OTP
 * over session-reuse specifically because document resubmission needs a
 * stronger identity guarantee than a plain status check).
 *
 * Reads app_metadata.otp_verified_phone_at -- stamped alongside
 * otp_verified_phone in createBuyerSessionForUser/mintBuyerHandoffLink above,
 * ONLY at a genuine OTP-verify-driven session (re)mint, never on a plain
 * session refresh/reuse -- off THIS request's own session via a
 * request-scoped client built from its own auth cookies, matching the
 * pattern already established in reuse-check/reuse-confirm/
 * existing-profiles/resubmission-profile for reading a caller's own
 * otp_verified_phone claim (never via supabaseAdmin, which has no request
 * session to read). SECURITY: this must read app_metadata, not
 * user_metadata -- user_metadata is client-writable via the public
 * supabase.auth.updateUser({data:...}) call, so any authenticated user could
 * otherwise forge this freshness claim for themselves. Empirically confirmed
 * a request-scoped client's getUser() (own session, non-admin) DOES return
 * the caller's own app_metadata (a user can always read, just not write,
 * their own app_metadata).
 *
 * A caller with no OTP-verified session at all (a seller-added/ERP-synced
 * buyer that never self-registered via phone-OTP) has no otp_verified_phone*
 * claim and therefore always fails freshness here -- correct, since such a
 * buyer has no OTP-based identity guarantee to be "fresh" about in the first
 * place; the enforcement point (submit_buyer_intake caller in
 * app/api/buyer/onboarding/intake/route.ts) only invokes this check when the
 * buyer's onboarding_status is currently 'needs_more_info', a state a
 * seller-added buyer would only reach via the storefront resubmission flow
 * itself, which requires exactly this OTP verification to reach.
 */
export async function hasFreshOtpVerification(request: NextRequest): Promise<boolean> {
  const scoped = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        // Read-only usage -- no response to attach refreshed cookies to.
        setAll: () => {},
      },
    },
  );

  const { data, error } = await scoped.auth.getUser();
  if (error || !data.user) return false;

  const meta = data.user.app_metadata as Record<string, unknown> | null;
  const stampedAt = typeof meta?.otp_verified_phone_at === 'string' ? meta.otp_verified_phone_at : null;
  if (!stampedAt) return false;

  const stampedMs = new Date(stampedAt).getTime();
  if (Number.isNaN(stampedMs)) return false;

  return Date.now() - stampedMs < RESUBMISSION_OTP_FRESHNESS_MS;
}

export async function requireBuyerAccessProfile(request: NextRequest): Promise<BuyerAccessProfile | null> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const context = await getBuyerAppContext(request);
  if (!context.tenant_id) {
    return null;
  }

  const db = supabaseAdmin;
  const tenantPromise = db
    .schema('app')
    .from('tenants')
    .select('id, business_name, slug, settings')
    .eq('id', context.tenant_id)
    .maybeSingle();

  // Pure seller preview — no linked buyer account
  if (context.mode === 'preview' && !context.buyer_id) {
    const { data: tenant, error } = await tenantPromise;
    if (error) throw new Error(error.message);

    return {
      context,
      buyer: null,
      tenant: tenant
        ? {
            id: tenant.id,
            business_name: tenant.business_name,
            slug: tenant.slug,
          }
        : null,
      greeting_name: 'Preview',
    };
  }

  if (context.mode === 'guest') {
    const { data: tenant, error } = await tenantPromise;
    if (error) throw new Error(error.message);
    if (!tenant) return null;

    return {
      context,
      buyer: null,
      tenant: {
        id: tenant.id,
        business_name: tenant.business_name,
        slug: tenant.slug,
      },
      greeting_name: tenant.business_name,
    };
  }

  if (!context.buyer_id) {
    return null;
  }

  let buyerLookup = db
    .schema('app')
    .from('buyers')
    .select('id, tenant_id, business_name, contact_name, email, credit_limit, phone, gstin, buyer_app_enabled, geography, billing_address, custom_fields, whatsapp_consent_at, whatsapp_opt_out_at')
    .eq('id', context.buyer_id)
    .eq('tenant_id', context.tenant_id)
    .eq('is_active', true)
    .is('deleted_at', null);

  // Seller preview bypasses buyer_app_enabled — that gate controls buyer login, not preview.
  // A `buyer_pending` session (self-registered, not yet approved) must also read its OWN
  // row — that's how /api/buyer/me and the intake screen work — but nothing else in this
  // codebase should ever add 'buyer_pending' to a buyer_app_enabled-gated query/policy.
  if (context.mode !== 'preview' && context.role !== 'buyer_pending') {
    buyerLookup = buyerLookup.or('buyer_app_enabled.eq.true,buyer_app_enabled.is.null');
  }

  const [buyerRes, tenantRes, settingsRes] = await Promise.all([
    buyerLookup.maybeSingle(),
    tenantPromise,
    db
      .schema('app')
      .from('tenant_settings')
      .select('tenant_id, settings')
      .eq('tenant_id', context.tenant_id)
      .maybeSingle(),
  ]);

  if (buyerRes.error) throw new Error(buyerRes.error.message);
  if (tenantRes.error) throw new Error(tenantRes.error.message);
  if (settingsRes.error) throw new Error(settingsRes.error.message);

  if (!buyerRes.data) {
    return null;
  }

  // tenant_settings.buyer_app.enabled retired as a login/access gate — buyer
  // app is core MVP now, not a togglable module. app.catalogs.live_at gates
  // whether a storefront is live at all; buyers.buyer_app_enabled (already
  // checked in buyerLookup above) is the per-buyer override. Settings are
  // still fetched above for other fields (whatsapp_number, stock visibility);
  // just no longer used to block access here.
  const greetingName =
    firstNameFromValue(buyerRes.data.contact_name)
    || buyerRes.data.contact_name?.trim()
    || buyerRes.data.business_name;

  return {
    context,
    buyer: buyerRes.data as BuyerRow,
    tenant: tenantRes.data
      ? {
          id: tenantRes.data.id,
          business_name: tenantRes.data.business_name,
          slug: tenantRes.data.slug,
        }
      : null,
    greeting_name: greetingName || null,
  };
}

function buyerMatchesCatalog(
  catalog: BuyerVisibleCatalog,
  buyerId: string,
  buyerDefaultCohortId: string | null,
  explicitCohortIds: Set<string>,
  buyerGeography: { state?: string; city?: string; zone?: string } | null,
) {
  if (catalog.scope_type === 'all') return true;

  const scopeValue = (catalog.scope_value ?? {}) as {
    buyer_id?: string;
    buyer_ids?: string[];
    cohort_id?: string;
    geography?: { state?: string; city?: string; zone?: string };
  };

  if (catalog.scope_type === 'buyer') {
    if (Array.isArray(scopeValue.buyer_ids) && scopeValue.buyer_ids.length > 0) {
      return scopeValue.buyer_ids.includes(buyerId);
    }
    return scopeValue.buyer_id === buyerId;
  }

  if (catalog.scope_type === 'cohort') {
    const cohortId = scopeValue.cohort_id;
    if (!cohortId) return false;
    if (explicitCohortIds.has(cohortId)) return true;
    return buyerDefaultCohortId === cohortId;
  }

  if (catalog.scope_type === 'geography') {
    const geo = scopeValue.geography;
    if (!geo || !buyerGeography) return false;
    if (geo.state && geo.state !== buyerGeography.state) return false;
    if (geo.city && geo.city !== buyerGeography.city) return false;
    if (geo.zone && geo.zone !== buyerGeography.zone) return false;
    return true;
  }

  return false;
}

function isCatalogVisibleOnCurrentIstDay(validTo: string | null, now = new Date()): boolean {
  if (!validTo) return true;

  const validToDate = new Date(validTo);
  if (Number.isNaN(validToDate.getTime())) return false;

  return isoDateInTimeZone(validToDate) >= isoDateInTimeZone(now);
}

// ---------------------------------------------------------------------------
// Seller phone lookup + session minting
// ---------------------------------------------------------------------------

export async function findSellerLoginCandidates(phone: string): Promise<LoginOtpCandidate[]> {
  if (!supabaseAdmin) throw new Error('Server configuration error');

  const normalizedPhone = normalizeIndianPhone(phone);

  // The RPC is not yet in the generated DB types, so we cast through unknown
  const { data, error } = await (supabaseAdmin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('find_seller_candidates_by_phone', { p_phone: normalizedPhone });

  if (error) throw new Error(`Seller lookup failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    user_id: string;
    tenant_id: string;
    tenant_name: string;
    tenant_slug: string;
    role: string;
    location_ids: string[] | null;
    email: string | null;
    full_name: string | null;
  }>;

  const logoByTenant = await loadTenantLogos(rows.map((row) => row.tenant_id));

  return rows.map((row) => ({
    kind: 'seller' as const,
    tenant_id: row.tenant_id,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
    tenant_whatsapp_number: null,
    tenant_whatsapp_display_name: null,
    tenant_logo_url: logoByTenant.get(row.tenant_id) ?? null,
    role: row.role,
    buyer_id: null,
    principal_type: 'seller' as const,
    user_id: row.user_id,
    buyer_user_id: null,
    phone: normalizedPhone,
    business_name: '',
    contact_name: row.full_name,
    email: row.email,
  }));
}

/** Lightweight logo-only batch lookup — used for seller candidates, which
 * don't otherwise need loadTenantBuyerAppMetadata's settings/whatsapp fetch. */
async function loadTenantLogos(tenantIds: string[]): Promise<Map<string, string | null>> {
  const uniqueIds = Array.from(new Set(tenantIds));
  if (!supabaseAdmin || uniqueIds.length === 0) return new Map();

  const { data, error } = await supabaseAdmin
    .schema('app')
    .from('tenants')
    .select('id, logo_url')
    .in('id', uniqueIds);

  if (error) {
    console.error('[loadTenantLogos] lookup failed', error);
    return new Map();
  }

  return new Map(
    ((data ?? []) as Array<{ id: string; logo_url: string | null }>).map((row) => [row.id, row.logo_url]),
  );
}

export async function findAllLoginCandidates(phone: string): Promise<LoginOtpCandidate[]> {
  const [sellers, buyers] = await Promise.all([
    findSellerLoginCandidates(phone),
    findBuyerLoginCandidates(phone),
  ]);

  // Map buyer candidates to the unified LoginOtpCandidate shape. The enabled
  // flags must survive the OTP hop because the post-verify tenant picker uses
  // them to decide between opening the app and requesting access.
  const eligibleBuyers: LoginOtpCandidate[] = buyers
    .filter((c) => c.buyer_app_enabled)
    .map((c) => ({
      kind: 'buyer' as const,
      tenant_id: c.tenant_id,
      tenant_name: c.tenant_name,
      tenant_slug: c.tenant_slug,
      tenant_whatsapp_number: c.tenant_whatsapp_number,
      tenant_whatsapp_display_name: c.tenant_whatsapp_display_name,
      tenant_logo_url: c.tenant_logo_url,
      role: c.role,
      buyer_id: c.buyer_id,
      principal_type: c.principal_type as 'buyer' | 'delegate',
      user_id: c.user_id,
      buyer_user_id: c.buyer_user_id,
      phone: c.phone,
      business_name: c.business_name,
      contact_name: c.contact_name,
      buyer_app_enabled: c.buyer_app_enabled,
      tenant_app_enabled: c.tenant_app_enabled,
    }));

  // Remove buyer entries where the same auth user already appears as a seller
  const sellerUserIds = new Set(sellers.map((s) => s.user_id).filter(Boolean));
  const filteredBuyers = eligibleBuyers.filter(
    (b) => !b.user_id || !sellerUserIds.has(b.user_id),
  );

  // Sellers first
  return [...sellers, ...filteredBuyers];
}

export function toBuyerLoginCandidate(c: LoginOtpCandidate): BuyerLoginCandidate {
  if (c.kind !== 'buyer' || !c.buyer_id) throw new Error('Not a buyer candidate');
  return {
    tenant_id: c.tenant_id,
    tenant_name: c.tenant_name,
    tenant_slug: c.tenant_slug,
    tenant_whatsapp_number: c.tenant_whatsapp_number,
    tenant_whatsapp_display_name: c.tenant_whatsapp_display_name,
    tenant_logo_url: c.tenant_logo_url,
    buyer_id: c.buyer_id,
    role: c.role as 'buyer_admin' | 'buyer_assistant',
    principal_type: c.principal_type as 'buyer' | 'delegate',
    user_id: c.user_id,
    buyer_user_id: c.buyer_user_id,
    phone: c.phone,
    business_name: c.business_name,
    contact_name: c.contact_name,
    buyer_app_enabled: c.buyer_app_enabled !== false,
    tenant_app_enabled: c.tenant_app_enabled !== false,
  };
}

export async function mintSellerSession(
  candidate: LoginOtpCandidate & { kind: 'seller' },
): Promise<{ session: Session; user: User }> {
  if (!supabaseAdmin || !candidate.user_id) {
    throw new Error('Server configuration error or missing user_id for seller');
  }

  // email is domain-owned on tenant_users — no Auth Admin API round-trip needed.
  const { data: tenantUserRow, error: tenantUserError } = await supabaseAdmin
    .schema('app')
    .from('tenant_users')
    .select('email')
    .eq('user_id', candidate.user_id)
    .eq('tenant_id', candidate.tenant_id)
    .maybeSingle();

  let email = (tenantUserRow as { email: string | null } | null)?.email ?? null;

  if (tenantUserError || !email) {
    // Rows created before this column existed may still be null — fall back once
    // and backfill so the next login skips Auth entirely.
    const { data: userData, error: userError } =
      await supabaseAdmin.auth.admin.getUserById(candidate.user_id);
    if (userError || !userData.user?.email) {
      throw new Error(userError?.message ?? 'Seller auth user not found');
    }
    email = userData.user.email;
    await supabaseAdmin
      .schema('app')
      .from('tenant_users')
      .update({ email })
      .eq('user_id', candidate.user_id)
      .eq('tenant_id', candidate.tenant_id);
  }

  const sellerUser = { id: candidate.user_id } as User;

  // Set app_metadata (for the JWT hook) and generate the recovery link in parallel —
  // neither depends on the other's result, only on `email` resolved above. The
  // refreshSession() below still runs after verifyOtp() to pick up the metadata
  // write, since that's a genuine dependency (needs a hook re-run after the write).
  const [, { data: linkData, error: linkError }] = await Promise.all([
    supabaseAdmin.auth.admin.updateUserById(candidate.user_id, {
      app_metadata: {
        current_tenant_id: candidate.tenant_id,
        current_buyer_id: null,
      },
    }),
    // Generate a recovery link server-side — does NOT send any email
    supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email }),
  ]);

  if (linkError || !linkData?.properties?.hashed_token) {
    throw new Error(linkError?.message ?? 'Failed to generate seller recovery link');
  }

  const { hashed_token: hashedToken } = linkData.properties;

  // Exchange the hashed_token for a live session using an anon client
  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  const { data: verifyData, error: verifyError } = await anonClient.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'recovery',
  });

  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? 'Failed to exchange recovery token for session');
  }

  // Best effort: refresh re-runs the custom_access_token_hook so seller claims are
  // embedded directly in the JWT. If Supabase rate-limits refresh, the verified
  // session still works because our request auth path can fall back to getUser()
  // plus workspace lookup from the bearer token.
  const { data: refreshData, error: refreshError } = await anonClient.auth.refreshSession({
    refresh_token: verifyData.session.refresh_token,
  });

  return {
    session: refreshError || !refreshData.session ? verifyData.session : refreshData.session,
    user: verifyData.user ?? sellerUser,
  };
}

// ---------------------------------------------------------------------------

// A buyer enabled in the seller app only joins cohort-scoped campaigns once the membership tick
// (every 15 min) drains their pending `buyer_candidate` row. Until then browse would price from the
// General list while an estimate placed after the tick is campaign-priced. When a published cohort
// campaign targets a cohort the buyer is not (yet) in, flush that ONE buyer's pending membership
// work synchronously (app.flush_buyer_membership) and re-read membership.
// Scope: only cohort-scoped campaigns are handled (buyerMatchesCatalog consults cohort membership
// for no other scope). Results are remembered per server instance for a short TTL so repeated
// calls in one page load cost nothing; 'busy' (tick running) is deliberately not cached.
const MEMBERSHIP_FLUSH_NEGATIVE_TTL_MS = 30_000;
const MEMBERSHIP_FLUSH_NEGATIVE_MAX = 5_000;
const membershipFlushNegativeUntil = new Map<string, number>();

async function flushPendingBuyerMembership(tenantId: string, buyerId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const key = `${tenantId}:${buyerId}`;
  const now = Date.now();
  const skipUntil = membershipFlushNegativeUntil.get(key);
  if (skipUntil !== undefined && skipUntil > now) return false;

  const rememberNothingToDo = () => {
    if (membershipFlushNegativeUntil.size >= MEMBERSHIP_FLUSH_NEGATIVE_MAX) membershipFlushNegativeUntil.clear();
    membershipFlushNegativeUntil.set(key, now + MEMBERSHIP_FLUSH_NEGATIVE_TTL_MS);
  };

  try {
    const { data, error } = await supabaseAdmin
      .schema('app')
      .rpc('flush_buyer_membership', { p_tenant_id: tenantId, p_buyer_id: buyerId });
    if (error) {
      console.error('[getVisibleBuyerCatalogs] flush_buyer_membership failed', error.message);
      rememberNothingToDo();
      return false;
    }
    if (data === 'flushed') {
      membershipFlushNegativeUntil.delete(key);
      return true;
    }
    if (data === 'busy') return false; // tick/another flush is running: retry on the next call
    rememberNothingToDo(); // 'none' | 'failed' (the tick owns retries/backoff)
    return false;
  } catch (err) {
    console.error('[getVisibleBuyerCatalogs] flush_buyer_membership threw', err);
    rememberNothingToDo();
    return false;
  }
}

export async function getVisibleBuyerCatalogs(tenantId: string, buyerId: string): Promise<BuyerVisibleCatalog[]> {
  if (!supabaseAdmin) {
    throw new Error('Server configuration error');
  }

  const db = supabaseAdmin;
  const [catalogsRes, buyerRes, cohortMembershipRes] = await Promise.all([
    db
      .schema('app')
      .from('campaigns')
      .select('id, tenant_id, name, share_token, valid_to, message, created_at, scope_type, scope_value, hero_image_url')
      .eq('tenant_id', tenantId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    db
      .schema('app')
      .from('buyers')
      .select('id, default_cohort_id, geography')
      .eq('id', buyerId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    db
      .schema('app')
      .from('cohort_members_active')
      .select('cohort_id')
      .eq('buyer_id', buyerId),
  ]);

  if (catalogsRes.error) throw new Error(catalogsRes.error.message);
  if (buyerRes.error) throw new Error(buyerRes.error.message);
  if (cohortMembershipRes.error) throw new Error(cohortMembershipRes.error.message);

  let explicitCohorts = new Set(
    ((cohortMembershipRes.data ?? []) as Array<{ cohort_id: string }>).map((row) => row.cohort_id),
  );
  const buyerData = (buyerRes.data as {
    default_cohort_id?: string | null;
    geography?: { state?: string; city?: string; zone?: string } | null;
  } | null);
  const buyerDefaultCohortId = buyerData?.default_cohort_id ?? null;
  const buyerGeography = buyerData?.geography ?? null;
  const catalogs = (catalogsRes.data ?? []) as BuyerVisibleCatalog[];

  const hasUnmatchedCohortCampaign = catalogs.some((catalog) => {
    if (catalog.scope_type !== 'cohort' || !isCatalogVisibleOnCurrentIstDay(catalog.valid_to)) return false;
    const cohortId = ((catalog.scope_value ?? {}) as { cohort_id?: string }).cohort_id;
    return Boolean(cohortId) && !explicitCohorts.has(cohortId as string) && buyerDefaultCohortId !== cohortId;
  });

  if (hasUnmatchedCohortCampaign && (await flushPendingBuyerMembership(tenantId, buyerId))) {
    const refreshed = await db
      .schema('app')
      .from('cohort_members_active')
      .select('cohort_id')
      .eq('buyer_id', buyerId);
    if (!refreshed.error) {
      explicitCohorts = new Set(((refreshed.data ?? []) as Array<{ cohort_id: string }>).map((row) => row.cohort_id));
    }
  }

  return catalogs.filter((catalog) =>
    isCatalogVisibleOnCurrentIstDay(catalog.valid_to)
    && buyerMatchesCatalog(catalog, buyerId, buyerDefaultCohortId, explicitCohorts, buyerGeography),
  );
}
