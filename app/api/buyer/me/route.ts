import { hasOpenExistingBuyerAccessRequest } from '@/lib/server/buyer-access-accounts';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerAppMode } from '@/types/buyer';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { loadBuyerCreditSnapshot } from '@/lib/server/buyer-credit';
import { normalizeIndianPhone } from '@/lib/phone';
import { BUYER_ROLES, SELLER_ROLES } from '@/constants';
import { getCachedGuestPricingContext, loadLivePublicCatalog, type CatalogPricingMode } from '@/lib/server/public-catalog';
import { resolvePendingSessionOnboardingStatus } from '@/lib/server/buyer-onboarding-status';
import { hasPhoneConsented } from '@/lib/server/phone-consent';

interface BuyerMeResponse {
  mode: BuyerAppMode;
  buyer_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  gstin: string | null;
  session_person_name: string | null;
  session_person_kind: 'buyer' | 'buyer_user' | 'preview' | 'guest';
  credit_limit: number;
  credit_used: number;
  open_orders_count: number;
  seller_preview: boolean;
  support_whatsapp_number: string | null;
  tenant: {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    outlets: Array<{
      location_id: string;
      name: string;
      is_default: boolean;
      city: string;
      state: string;
      pincode: string;
      formatted_address: string;
      lat: number | null;
      lng: number | null;
      warehouse_id: string;
      warehouse_name: string;
    }>;
  };
  greeting_name?: string | null;
  order_features: {
    enquiries: boolean;
    sales_orders: boolean;
    invoices: boolean;
    create_enquiries: boolean;
    create_sales_orders: boolean;
  };
  business_policy: {
    credit_enabled: boolean;
    gst_inclusive: boolean;
    gst_rate: number;
  };
  stock_visibility: {
    enabled: boolean;
    block_order_on_oos: boolean;
  };
  buyer_catalog?: {
    id: string | null;
    pricing_mode: CatalogPricingMode | null;
    access_mode: 'public_link' | 'approved_buyers_only' | null;
    public_browse_allowed: boolean;
    collect_target_unit_price_range: boolean;
  };
  // WhatsApp Broadcast Phase C (§4.8): true when this buyer has never completed
  // the explicit consent checkbox — the buyer-side client redirects to /consent
  // until this clears. Always false for seller preview (no real buyer row).
  whatsapp_consent_required: boolean;
  /** Guest-only. The tenant's public-catalog pricing mode — null for buyer/preview. */
  guest_pricing_mode?: CatalogPricingMode | null;
  /** mode:'pending' only — self-registered, awaiting seller approval. */
  pending?: {
    intake_submitted: boolean;
    /** True for a buyer who signed up via the storefront; false for a seller/ERP-created buyer whose app access is disabled. */
    self_registered: boolean;
    /** True while an existing (non-self-registered) buyer's access request is still open (unresolved inbox entry). */
    access_requested: boolean;
    is_returning_yukti_user: boolean;
    seller_whatsapp_number: string | null;
    prefill_full_name: string | null;
    prefill_email: string | null;
    /**
     * Task 10: the buyer's actual onboarding_status column value, sourced
     * from app.get_buyer_onboarding_status() (Task 6) rather than re-derived
     * here — see that RPC for the authoritative shape. Null only if the RPC
     * call itself failed (non-blocking; the rest of the pending payload is
     * still returned) or before intake is submitted, when the row may not
     * yet have progressed past the DB default.
     */
    onboarding_status: 'pending_approval' | 'needs_more_info' | 'approved' | 'declined' | null;
    /** Populated only when onboarding_status === 'needs_more_info'. */
    missing_fields: string[] | null;
    declined_reason: string | null;
  };
}

function createRequestScopedClient(request: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        // Read-only usage — no response to attach refreshed cookies to.
        setAll: () => {},
      },
    },
  );
}

const OPEN_STATUSES = ['draft', 'received', 'confirmed', 'partially_dispatched', 'dispatched'];

function canEditBusiness(role: string | null | undefined): boolean {
  return role === 'buyer_admin' || (SELLER_ROLES as readonly string[]).includes((role ?? '') as any);
}

function canEditPhone(role: string | null | undefined): boolean {
  return (BUYER_ROLES as readonly string[]).includes((role ?? '') as any)
    || (SELLER_ROLES as readonly string[]).includes((role ?? '') as any);
}

function normalizePatchBody(body: Record<string, unknown>) {
  const next: {
    business_name?: string;
    contact_name?: string;
    gstin?: string | null;
    phone?: string;
  } = {};

  if (typeof body.business_name === 'string') {
    next.business_name = body.business_name.trim();
  }
  if (typeof body.contact_name === 'string') {
    next.contact_name = body.contact_name.trim();
  }
  if (typeof body.gstin === 'string') {
    const gstin = body.gstin.trim().toUpperCase();
    next.gstin = gstin.length > 0 ? gstin : null;
  }
  if (typeof body.phone === 'string') {
    next.phone = normalizeIndianPhone(body.phone);
  }

  return next;
}

function getAddressField(address: unknown, key: 'line1' | 'line2' | 'city' | 'state' | 'pincode'): string {
  if (!address || typeof address !== 'object') return '';
  const value = (address as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function formatAddress(address: unknown): string {
  return [
    getAddressField(address, 'line1'),
    getAddressField(address, 'line2'),
    getAddressField(address, 'city'),
    getAddressField(address, 'state'),
    getAddressField(address, 'pincode'),
  ].filter(Boolean).join(', ');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const profile = await requireBuyerAccessProfile(request, { includeTenant: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const context = profile.context;
    const db = supabaseAdmin;
    const buyerId = profile.buyer?.id ?? context.buyer_id;

    // Fetch tenant settings to surface order features and business policy
    const { data: tsRow } = await db
      .schema('app')
      .from('tenant_settings')
      .select('settings')
      .eq('tenant_id', context.tenant_id)
      .maybeSingle();

    const rawSettings = (tsRow as { settings?: Record<string, unknown> } | null)?.settings ?? {};
    const liveCatalog = await loadLivePublicCatalog(db, context.tenant_id!);
    const buyerCatalog = {
      id: liveCatalog?.id ?? null,
      pricing_mode: liveCatalog?.pricingMode ?? null,
      access_mode: liveCatalog?.accessMode ?? null,
      public_browse_allowed: liveCatalog?.accessMode === 'public_link',
      collect_target_unit_price_range: liveCatalog?.collectTargetUnitPriceRange ?? false,
    };
    const rawOrders = (rawSettings.orders ?? {}) as Record<string, unknown>;
    const rawFeatures = (rawOrders.features ?? {}) as Record<string, unknown>;
    const rawPolicy = (rawSettings.business_policy ?? {}) as Record<string, unknown>;
    const rawBusiness = (rawSettings.business ?? {}) as Record<string, unknown>;
    const rawBuyerApp = (rawSettings.buyer_app ?? {}) as Record<string, unknown>;

    const orderFeatures = {
      enquiries: rawFeatures.enquiries === true,
      sales_orders: rawFeatures.sales_orders === true,
      invoices: rawFeatures.invoices === true,
      create_enquiries: rawFeatures.create_enquiries !== false,
      create_sales_orders: rawFeatures.create_sales_orders !== false,
    };
    const businessPolicy = {
      credit_enabled: rawPolicy.credit_enabled !== false,
      gst_inclusive: rawPolicy.gst_inclusive === true,
      gst_rate: typeof rawPolicy.gst_rate === 'number' ? rawPolicy.gst_rate : 18,
    };
    const tenantLogoUrl = typeof rawBusiness.logo_url === 'string' && rawBusiness.logo_url.trim().length > 0
      ? rawBusiness.logo_url.trim()
      : null;
    const stockVisibility = {
      enabled: rawBuyerApp.stock_visibility_enabled === true,
      block_order_on_oos: rawBuyerApp.block_order_on_oos === true,
    };

    // Pure seller preview (no linked buyer account)
    if (context.mode === 'preview' && !context.buyer_id) {
      if (!profile.tenant) {
        return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
      }

      const tenant = profile.tenant;
      const payload: BuyerMeResponse = {
        mode: 'preview',
        buyer_id: 'preview',
        business_name: 'Buyer app preview',
        contact_name: 'Preview user',
        phone: '—',
        gstin: null,
        session_person_name: 'Preview user',
        session_person_kind: 'preview',
        credit_limit: 0,
        credit_used: 0,
        open_orders_count: 0,
        seller_preview: true,
        support_whatsapp_number: process.env.WHATSAPP_ADMIN_NUMBER ?? null,
        tenant: {
          id: tenant.id,
          name: tenant.business_name,
          slug: tenant.slug,
          logo_url: tenantLogoUrl,
          outlets: [],
        },
        greeting_name: 'Preview',
        order_features: orderFeatures,
        business_policy: businessPolicy,
        stock_visibility: stockVisibility,
        buyer_catalog: buyerCatalog,
        whatsapp_consent_required: false,
      };

      return NextResponse.json(payload, { headers: BUYER_CACHE_PERSONAL });
    }

    if (context.mode === 'guest') {
      if (!profile.tenant) {
        return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
      }

      const tenant = profile.tenant;
      const guestPricing = await getCachedGuestPricingContext(context.tenant_id!);
      const payload: BuyerMeResponse = {
        mode: 'guest',
        buyer_id: 'guest',
        business_name: tenant.business_name,
        contact_name: '',
        phone: '—',
        gstin: null,
        session_person_name: null,
        session_person_kind: 'guest',
        credit_limit: 0,
        credit_used: 0,
        open_orders_count: 0,
        seller_preview: false,
        support_whatsapp_number: process.env.WHATSAPP_ADMIN_NUMBER ?? null,
        tenant: {
          id: tenant.id,
          name: tenant.business_name,
          slug: tenant.slug,
          logo_url: tenantLogoUrl,
          outlets: [],
        },
        greeting_name: tenant.business_name,
        order_features: orderFeatures,
        business_policy: businessPolicy,
        stock_visibility: stockVisibility,
        buyer_catalog: buyerCatalog,
        whatsapp_consent_required: false,
        guest_pricing_mode: guestPricing?.mode ?? null,
      };

      return NextResponse.json(payload, { headers: BUYER_CACHE_PERSONAL });
    }

    if (!buyerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Self-registered, not yet approved by the seller (Yukti_Inbox_Feature-Spec_v1.md
    // §7.1). Short-circuits before any of the buyer_app_enabled-assuming queries
    // below (orders, credit, outlets) — a pending buyer has none of that yet.
    if (profile.buyer && profile.buyer.buyer_app_enabled === false) {
      if (!profile.tenant) {
        return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
      }
      const tenant = profile.tenant;
      const buyer = profile.buyer;
      const customFields = buyer.custom_fields ?? {};
      const tenantBuyerApp = (rawBuyerApp ?? {}) as Record<string, unknown>;
      const sellerWhatsappNumber =
        typeof tenantBuyerApp.whatsapp_number === 'string' && tenantBuyerApp.whatsapp_number.trim()
          ? tenantBuyerApp.whatsapp_number.trim()
          : null;

      let prefillFullName: string | null = null;
      let prefillEmail: string | null = null;
      if (customFields.existing_yukti_identity === true && context.sub) {
        const { data: otherBuyer } = await db
          .schema('app')
          .from('buyers')
          .select('contact_name, email')
          .eq('user_id', context.sub)
          .neq('id', buyer.id)
          .not('contact_name', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const row = otherBuyer as { contact_name: string | null; email: string | null } | null;
        prefillFullName = row?.contact_name?.trim() || null;
        prefillEmail = row?.email?.trim() || null;
      }

      // Task 10: surface the authoritative onboarding_status/missing_fields by
      // calling Task 6's app.get_buyer_onboarding_status() RPC rather than
      // re-deriving the same data from buyer.custom_fields a second way. The
      // RPC is SECURITY DEFINER and reads app.jwt_buyer_id()/app.jwt_tenant_id()
      // off the caller's own JWT claims (populated by custom_access_token_hook
      // for a buyer_pending session) — it must be invoked via a request-scoped
      // client carrying this request's own auth cookies, not supabaseAdmin
      // (service-role calls carry no buyer_id/tenant_id claims), matching the
      // pattern already used in app/api/buyer/onboarding/existing-profiles.
      let onboardingStatus: 'pending_approval' | 'needs_more_info' | 'approved' | 'declined' | null = null;
      let missingFields: string[] | null = null;
      let declinedReason: string | null = null;
      try {
        const scoped = createRequestScopedClient(request);
        const { data: statusData, error: statusError } = await scoped
          .schema('app')
          .rpc('get_buyer_onboarding_status');
        if (statusError) {
          console.error('[GET /api/buyer/me] get_buyer_onboarding_status rpc failed:', statusError);
        } else {
          const row = statusData as {
            onboarding_status?: string | null;
            missing_fields?: string[] | null;
            declined_reason?: string | null;
          } | null;
          onboardingStatus = (row?.onboarding_status ?? null) as typeof onboardingStatus;
          missingFields = row?.missing_fields ?? null;
          declinedReason = row?.declined_reason ?? null;
        }
      } catch (rpcError) {
        console.error('[GET /api/buyer/me] get_buyer_onboarding_status rpc threw:', rpcError);
      }

      // Task 10 review, Minor #1 (scoped in the follow-up review fix): only a
      // genuinely self-registered buyer awaiting approval should ever have
      // their onboarding_status normalized to 'pending_approval' — a
      // seller-created/CSV-imported buyer with buyer_app_enabled=false is
      // legitimately 'approved' (or null) and must not be relabeled as still
      // verifying. See resolvePendingSessionOnboardingStatus's doc.
      const isSelfRegistered = customFields.storefront_self_registered === true;

      // "Request sent" must mean an access request is still OPEN for this buyer. custom_fields.
      // access_requested_at is never cleared, so a buyer approved once and disabled again would
      // otherwise see "Request sent" forever with no way to ask again (the RPC reopens a resolved
      // entry, but only if the UI offers the button). Same open-entry rule as
      // app.request_buyer_app_access's already_requested check.
      let accessRequestOpen = false;
      if (!isSelfRegistered) {
        try {
          accessRequestOpen = await hasOpenExistingBuyerAccessRequest(db, context.tenant_id!, buyer.id);
        } catch (lookupError) {
          // Non-critical for the rest of the pending payload; the account list is the source of truth.
          console.error('[GET /api/buyer/me] open access-request lookup failed:', lookupError);
        }
      }

      onboardingStatus = resolvePendingSessionOnboardingStatus(onboardingStatus, isSelfRegistered);

      const payload: BuyerMeResponse = {
        mode: 'pending',
        buyer_id: buyer.id,
        business_name: buyer.business_name,
        contact_name: buyer.contact_name ?? '',
        phone: buyer.phone ?? '—',
        gstin: buyer.gstin ?? null,
        session_person_name: buyer.contact_name?.trim() || null,
        session_person_kind: 'buyer',
        credit_limit: 0,
        credit_used: 0,
        open_orders_count: 0,
        seller_preview: false,
        support_whatsapp_number: process.env.WHATSAPP_ADMIN_NUMBER ?? null,
        tenant: {
          id: tenant.id,
          name: tenant.business_name,
          slug: tenant.slug,
          logo_url: tenantLogoUrl,
          outlets: [],
        },
        greeting_name: null,
        order_features: orderFeatures,
        business_policy: businessPolicy,
        stock_visibility: stockVisibility,
        buyer_catalog: buyerCatalog,
        whatsapp_consent_required: false,
        pending: {
          intake_submitted: Boolean(customFields.intake_submitted_at),
          self_registered: isSelfRegistered,
          access_requested: accessRequestOpen,
          is_returning_yukti_user: customFields.existing_yukti_identity === true,
          seller_whatsapp_number: sellerWhatsappNumber,
          prefill_full_name: prefillFullName,
          prefill_email: prefillEmail,
          onboarding_status: onboardingStatus,
          missing_fields: onboardingStatus === 'needs_more_info' ? missingFields : null,
          declined_reason: onboardingStatus === 'declined' ? declinedReason : null,
        },
      };

      return NextResponse.json(payload, { headers: BUYER_CACHE_PERSONAL });
    }

    const tenantId = context.tenant_id!;
    const buyerUserIdentityPromise = context.sub
      ? db
        .schema('app')
        .from('buyer_users')
        .select('first_name, last_name')
        .eq('buyer_id', buyerId)
        .eq('user_id', context.sub)
        .eq('is_active', true)
        .is('deleted_at', null)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null });

    const [ordersRes, creditSnapshot, outletsRes, buyerUserIdentityRes] = await Promise.all([
      db
        .schema('app')
        .from('orders')
        .select('id, total_amount, status')
        .eq('tenant_id', tenantId)
        .eq('buyer_id', buyerId)
        .in('status', OPEN_STATUSES)
        .is('deleted_at', null),
      loadBuyerCreditSnapshot(db as any, {
        tenantId,
        buyerId,
        creditLimit: Number(profile.buyer?.credit_limit ?? 0),
      }),
      db
        .schema('app')
        .from('warehouses')
        .select(
          'id, name, is_default, lat, lng, location_id, locations!inner(id, name, is_default, address, lat, lng, deleted_at)',
        )
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .not('location_id', 'is', null)
        .limit(500)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true }),
      buyerUserIdentityPromise,
    ]);

    if (!profile.buyer) {
      return NextResponse.json({ error: 'Buyer not found' }, { status: 404 });
    }

    if (!profile.tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    if (ordersRes.error) {
      console.error('[GET /api/buyer/me] orders query error:', ordersRes.error);
      return NextResponse.json({ error: 'Failed to compute credit used' }, { status: 500 });
    }

    if (outletsRes.error) {
      console.error('[GET /api/buyer/me] outlets query error:', outletsRes.error);
      return NextResponse.json({ error: 'Failed to load ordering outlets' }, { status: 500 });
    }
    if (buyerUserIdentityRes.error) {
      console.error('[GET /api/buyer/me] buyer user identity query error:', buyerUserIdentityRes.error);
      return NextResponse.json({ error: 'Failed to load buyer session identity' }, { status: 500 });
    }

    const buyer = profile.buyer;
    const tenant = profile.tenant;
    const phoneHasConsented = buyer.phone ? await hasPhoneConsented(buyer.phone) : true;
    const openOrders = ordersRes.data ?? [];
    const openOrdersCount = openOrders.length;
    const buyerUserIdentity = (buyerUserIdentityRes.data as {
      first_name?: string | null;
      last_name?: string | null;
    } | null);
    const buyerUserFullName = [buyerUserIdentity?.first_name, buyerUserIdentity?.last_name]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' ')
      .trim();
    const sessionPersonName = buyerUserFullName || buyer.contact_name?.trim() || null;
    const sessionPersonKind: BuyerMeResponse['session_person_kind'] = buyerUserFullName ? 'buyer_user' : 'buyer';
    const outletsByLocation = new Map<string, BuyerMeResponse['tenant']['outlets'][number]>();

    for (const row of (outletsRes.data ?? []) as Array<Record<string, unknown>>) {
      const location = row.locations;
      if (!location || typeof location !== 'object') continue;

      const locationId = typeof (location as Record<string, unknown>).id === 'string'
        ? (location as Record<string, unknown>).id as string
        : null;
      if (!locationId || outletsByLocation.has(locationId)) continue;
      if ((location as Record<string, unknown>).deleted_at) continue;

      const lat = typeof (location as Record<string, unknown>).lat === 'number'
        ? (location as Record<string, unknown>).lat as number
        : (typeof row.lat === 'number' ? row.lat as number : null);
      const lng = typeof (location as Record<string, unknown>).lng === 'number'
        ? (location as Record<string, unknown>).lng as number
        : (typeof row.lng === 'number' ? row.lng as number : null);
      const address = (location as Record<string, unknown>).address;

      outletsByLocation.set(locationId, {
        location_id: locationId,
        name: typeof (location as Record<string, unknown>).name === 'string'
          ? (location as Record<string, unknown>).name as string
          : typeof row.name === 'string'
            ? row.name as string
            : 'Outlet',
        is_default: (location as Record<string, unknown>).is_default === true,
        city: getAddressField(address, 'city'),
        state: getAddressField(address, 'state'),
        pincode: getAddressField(address, 'pincode'),
        formatted_address: formatAddress(address),
        lat,
        lng,
        warehouse_id: String(row.id),
        warehouse_name: typeof row.name === 'string' ? row.name : 'Warehouse',
      });
    }
    const payload: BuyerMeResponse = {
      mode: context.mode,
      buyer_id: buyer.id,
      business_name: buyer.business_name,
      contact_name: buyer.contact_name ?? '',
      phone: buyer.phone ?? '—',
      gstin: buyer.gstin ?? null,
      session_person_name: sessionPersonName,
      session_person_kind: sessionPersonKind,
      credit_limit: Number(buyer.credit_limit ?? 0),
      credit_used: creditSnapshot.credit_used,
      open_orders_count: openOrdersCount,
      seller_preview: false,
      support_whatsapp_number: process.env.WHATSAPP_ADMIN_NUMBER ?? null,
      tenant: {
        id: tenant.id,
        name: tenant.business_name,
        slug: tenant.slug,
        logo_url: tenantLogoUrl,
        outlets: Array.from(outletsByLocation.values()),
      },
      greeting_name: profile.greeting_name,
      order_features: orderFeatures,
      business_policy: businessPolicy,
      stock_visibility: stockVisibility,
      buyer_catalog: buyerCatalog,
      whatsapp_consent_required: !phoneHasConsented,
    };

    return NextResponse.json(payload, { headers: BUYER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/buyer/me] unexpected error:', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const profile = await requireBuyerAccessProfile(request, { includeTenant: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    if (!profile.buyer || profile.context.mode === 'preview') {
      return NextResponse.json({ error: 'Buyer not found' }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const tenantId = profile.context.tenant_id;
    const buyerId = profile.buyer.id;
    const role = profile.context.role ?? null;
    const previousPhone = profile.buyer.phone ?? null;
    const businessAllowed = canEditBusiness(role);
    const phoneAllowed = canEditPhone(role);

    if (!businessAllowed && !phoneAllowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const normalized = normalizePatchBody(body);
    const updateData: Record<string, unknown> = {};

    if (businessAllowed) {
      if (normalized.business_name !== undefined) updateData.business_name = normalized.business_name;
      if (normalized.contact_name !== undefined) updateData.contact_name = normalized.contact_name;
      if (normalized.gstin !== undefined) updateData.gstin = normalized.gstin;
    }

    if (phoneAllowed && normalized.phone !== undefined) {
      updateData.phone = normalized.phone;
    }
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No editable fields provided' }, { status: 400 });
    }

    if ('business_name' in updateData && typeof updateData.business_name === 'string' && updateData.business_name.length === 0) {
      return NextResponse.json({ error: 'Business name is required' }, { status: 422 });
    }

    if ('phone' in updateData) {
      const phone = String(updateData.phone ?? '');
      if (!/^[0-9]{10}$/.test(phone)) {
        return NextResponse.json({ error: 'Phone must be 10 digits' }, { status: 422 });
      }
    }

    if ('gstin' in updateData && updateData.gstin !== null && typeof updateData.gstin === 'string' && !/^[0-9A-Z]{15}$/i.test(updateData.gstin)) {
      return NextResponse.json({ error: 'GSTIN must be 15 alphanumeric characters' }, { status: 422 });
    }
    const db = supabaseAdmin as any;

    if ('phone' in updateData && updateData.phone !== previousPhone) {
      const { data: phoneMatch, error: phoneError } = await db
        .schema('app')
        .from('buyers')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('phone', updateData.phone)
        .eq('is_active', true)
        .is('deleted_at', null)
        .neq('id', buyerId)
        .maybeSingle();

      if (phoneError) {
        return NextResponse.json({ error: 'Failed to validate phone number' }, { status: 500 });
      }

      if (phoneMatch) {
        return NextResponse.json({ error: 'A buyer with this phone number already exists.' }, { status: 409 });
      }

      // Defense-in-depth (paired with the switch-buyer fix in
      // app/api/auth/switch-buyer/route.ts): the check above only scans
      // app.buyers, so it previously let an attacker rewrite their own
      // app.buyers.phone to collide with an existing same-tenant delegate's
      // app.buyer_users.phone — a collision switch-buyer's pre-fix
      // resolveCallerPhone/findBuyerLoginCandidates chain trusted as proof of
      // that delegate's identity. buyer_users has no tenant_id column, so the
      // tenant scope is resolved via a second lookup against app.buyers
      // rather than a single-query embed.
      const { data: buyerUserPhoneRows, error: buyerUserPhoneError } = await db
        .schema('app')
        .from('buyer_users')
        .select('buyer_id')
        .eq('phone', updateData.phone)
        .eq('is_active', true)
        .is('deleted_at', null)
        .neq('buyer_id', buyerId);

      if (buyerUserPhoneError) {
        return NextResponse.json({ error: 'Failed to validate phone number' }, { status: 500 });
      }

      const otherBuyerIds = Array.from(
        new Set((buyerUserPhoneRows ?? []).map((row: { buyer_id: string }) => row.buyer_id)),
      ).filter(Boolean);

      if (otherBuyerIds.length > 0) {
        const { data: tenantBuyerUserMatch, error: tenantBuyerUserMatchError } = await db
          .schema('app')
          .from('buyers')
          .select('id')
          .eq('tenant_id', tenantId)
          .in('id', otherBuyerIds)
          .is('deleted_at', null)
          .limit(1)
          .maybeSingle();

        if (tenantBuyerUserMatchError) {
          return NextResponse.json({ error: 'Failed to validate phone number' }, { status: 500 });
        }

        if (tenantBuyerUserMatch) {
          return NextResponse.json({ error: 'A buyer with this phone number already exists.' }, { status: 409 });
        }
      }
    }

    const { error: updateError } = await db
      .schema('app')
      .from('buyers')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', buyerId)
      .eq('tenant_id', tenantId);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
    }

    if ('phone' in updateData && updateData.phone !== previousPhone) {
      const { error: buyerUsersError } = await db
        .schema('app')
        .from('buyer_users')
        .update({
          phone: updateData.phone,
          updated_at: new Date().toISOString(),
        })
        .eq('buyer_id', buyerId)
        .eq('is_active', true)
        .is('deleted_at', null);

      if (buyerUsersError) {
        return NextResponse.json({ error: 'Failed to update login phone number' }, { status: 500 });
      }
    }

    const response = await GET(request);
    if (!response.ok) {
      return NextResponse.json({ error: 'Profile updated, but refresh failed' }, { status: 500 });
    }
    return response;
  } catch (error) {
    console.error('[PATCH /api/buyer/me] unexpected error:', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
