import { NextRequest, NextResponse } from 'next/server';
import { getPostHogClient } from '@/lib/posthog-server';
import { recordBuyerAppActivitySafe } from '@/lib/server/buyer-app-activity';
import { mintBuyerSession, mintSellerSession, toBuyerLoginCandidate, acquireBuyerForStorefront, mintBuyerHandoffLink, resolvePendingBuyerRedirect } from '@/lib/server/buyer-access';
import { buyerOtpStore, writeVerifiedCandidatesRecord, hashOtp, type LoginOtpCandidate } from '@/lib/server/buyer-otp-store';
import { stampSellerImplicitWhatsappConsent } from '@/lib/server/whatsapp-consent';
import { requirePhoneConsentRedirect } from '@/lib/server/phone-consent';
import { tenantStorefrontHostForRequest, buildStorefrontHandoffUrl } from '@/lib/storefront-host';
import { isCatalogRequest } from '@/lib/server/catalog-request';
import {
  dedupeBuyerAccountCandidates,
  filterBuyerCandidatesForReturnTo,
  pickPreferredBuyerCandidate,
  tenantSlugFromReturnTo,
} from '@/lib/server/catalog-return-to';
import { getTenantBrandingBySlug } from '@/lib/server/tenant-branding';
import { resolveAuthSurfaceFromRequest } from '@/lib/server/auth-surface-server';

const MAX_ATTEMPTS = 5;

/**
 * POST /api/auth/phone-otp/verify
 * Body: { ref_id: string; otp: string }
 * Returns:
 *   single match    → { success: true; redirect: string; session }
 *   multiple matches → { success: true; contexts: LoginOtpContext[]; ref_id: string }
 *   error            → { error: string } with appropriate status
 *
 * Seller accounts are always preferred over buyer accounts for the same phone number.
 * When more than one account remains after that preference, the client is
 * handed a short-lived `verified` OTP record's ref_id and shows
 * a context-selection screen (see /login/select-context and
 * /api/auth/phone-otp/select-context) instead of guessing.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { ref_id?: string; otp?: string; return_to?: string };
    const ref_id: string = (body?.ref_id ?? '').trim();
    const otp: string = (body?.otp ?? '').trim();
    const returnTo = body?.return_to?.trim() || null;
    const surface = resolveAuthSurfaceFromRequest(request).surface;
    const isBuyerSurface = surface === 'buyer_catalog' || surface === 'tenant_buyer_catalog';

    if (!ref_id || !otp) {
      return NextResponse.json({ error: 'ref_id and otp are required' }, { status: 400 });
    }

    const record = await buyerOtpStore.get(ref_id);

    if (!record || record.kind !== 'pending') {
      return NextResponse.json({ error: 'Invalid or expired OTP session' }, { status: 400 });
    }

    if (Date.now() > record.expiresAt) {
      await buyerOtpStore.delete(ref_id);
      return NextResponse.json({ error: 'OTP has expired. Request a new one.' }, { status: 400 });
    }

    record.attempts += 1;

    if (record.attempts > MAX_ATTEMPTS) {
      await buyerOtpStore.delete(ref_id);
      return NextResponse.json(
        { error: 'Too many incorrect attempts. Request a new OTP.' },
        { status: 429 },
      );
    }

    // record.otp holds sha256(otp) for sessions created after the hash-at-rest
    // migration; the plaintext fallback covers any session still in flight from
    // just before that deploy (10-minute TTL, so this window is short-lived).
    if (record.otp !== hashOtp(otp) && record.otp !== otp) {
      // Save updated attempt count before responding
      await buyerOtpStore.set(ref_id, record);
      return NextResponse.json(
        { error: `Incorrect OTP. ${MAX_ATTEMPTS - record.attempts} attempt(s) remaining.` },
        { status: 400 },
      );
    }

    await buyerOtpStore.delete(ref_id);

    if (record.candidates.length === 0) {
      return NextResponse.json(
        { error: 'No account found for this number.' },
        { status: 403 },
      );
    }

    try {
      const ph = getPostHogClient();
      const first = record.candidates[0];
      ph.capture({
        distinctId: first.buyer_id ?? first.tenant_id,
        event: 'otp_verified',
        properties: {
          candidate_kind: first.kind,
          tenant_count: record.candidates.length,
          tenant_id: first.tenant_id,
          role: first.role,
        },
      });
      await ph.flush();
    } catch {
      // non-blocking
    }

    // Show every distinct account linked to this phone — findAllLoginCandidates
    // already dedups true same-account collisions (a buyer row whose user_id
    // matches an existing seller). No kind-level priority beyond that: a seller
    // at one tenant and a buyer at an unrelated tenant should both be offered.
    const effectiveCandidates = isBuyerSurface
      ? record.candidates.filter((candidate) => candidate.kind === 'buyer')
      : record.candidates;

    if (effectiveCandidates.length === 0) {
      return NextResponse.json(
        { error: 'No buyer account found for this number.' },
        { status: 403 },
      );
    }

    const onCatalogHost = isCatalogRequest(request);
    if (onCatalogHost && returnTo) {
      const tenantScoped = dedupeBuyerAccountCandidates(filterBuyerCandidatesForReturnTo(effectiveCandidates, returnTo));
      // A single tenant-scoped account is never a "pick one" situation — including a not-yet-approved
      // one, which mintCandidateSession hands off to the tenant host's /onboarding or /pending.
      if (tenantScoped.length === 1) {
        return buildMintedCandidateResponse(request, tenantScoped[0], returnTo, record.phone);
      }

      if (tenantScoped.length > 0) {
        const verifiedRefId = await writeVerifiedCandidatesRecord(record.phone, tenantScoped, true);
        if (!verifiedRefId) {
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }
        return NextResponse.json({ success: true, contexts: tenantScoped, ref_id: verifiedRefId, return_to: returnTo });
      }

      const tenantSlug = tenantSlugFromReturnTo(returnTo);
      const tenant = tenantSlug ? await getTenantBrandingBySlug(tenantSlug) : null;
      if (tenant?.tenantId) {
        const acquisitionCandidate: LoginOtpCandidate = {
          kind: 'buyer',
          tenant_id: tenant.tenantId,
          tenant_name: tenant.businessName,
          tenant_slug: tenant.slug,
          tenant_whatsapp_number: tenant.whatsappNumber,
          tenant_whatsapp_display_name: tenant.businessName,
          tenant_logo_url: tenant.logoUrl,
          role: 'buyer_admin',
          buyer_id: null,
          principal_type: 'buyer',
          user_id: null,
          buyer_user_id: null,
          phone: record.phone,
          business_name: '',
          contact_name: null,
          buyer_app_enabled: false,
          tenant_app_enabled: true,
        };
        return buildMintedCandidateResponse(request, acquisitionCandidate, returnTo, record.phone);
      }
    }

    if (effectiveCandidates.length > 1) {
      // otpVerified: true — this record is written immediately after the
      // OTP hash check above succeeded, for the literal phone the OTP was
      // sent to. select-context uses this flag to allow the eventual
      // session mint to stamp otp_verified_phone.
      const verifiedRefId = await writeVerifiedCandidatesRecord(record.phone, effectiveCandidates, true);
      if (!verifiedRefId) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
      }
      return NextResponse.json({ success: true, contexts: effectiveCandidates, ref_id: verifiedRefId });
    }

    const candidate = effectiveCandidates[0];
    return buildMintedCandidateResponse(request, candidate, returnTo, record.phone);
  } catch (err) {
    console.error('[phone-otp/verify] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function buildMintedCandidateResponse(
  request: NextRequest,
  candidate: LoginOtpCandidate,
  returnTo: string | null,
  // The OTP store record's phone — the literal number a real OTP was just
  // verified against. Threaded through to the mint calls below so the
  // otp_verified_phone claim can be stamped at the moment of genuine
  // verification, never re-derived from any database column.
  otpVerifiedPhone: string,
): Promise<NextResponse> {
  const result = await mintCandidateSession(request, candidate, returnTo, otpVerifiedPhone);
  if ('handoffUrl' in result) {
    if ('session' in result && result.session) {
      return NextResponse.json({
        success: true,
        handoff_url: result.handoffUrl,
        session: result.session,
      });
    }
    return NextResponse.json({ success: true, handoff_url: result.handoffUrl });
  }
  return NextResponse.json({ success: true, redirect: result.redirect, session: result.session });
}

type MintResult =
  | { pending: false; session: unknown; redirect: string }
  | { pending: false; handoffUrl: string; session?: unknown };

async function mintCandidateSession(
  request: NextRequest,
  candidate: LoginOtpCandidate,
  returnTo: string | null = null,
  // The OTP store record's phone — pass-through only, never re-derived.
  // See buildMintedCandidateResponse's doc.
  otpVerifiedPhone?: string,
): Promise<MintResult> {
  if (candidate.kind === 'seller') {
    const { session, user } = await mintSellerSession(
      candidate as LoginOtpCandidate & { kind: 'seller' },
    );
    await stampSellerImplicitWhatsappConsent(candidate.tenant_id, user.id);
    return { pending: false, session, redirect: '/dashboard' };
  }

  const storefrontHome = request.headers.get('x-verified-tenant-id') ? '/' : '/buy/home';
  const buyerCandidate = candidate.buyer_id
    ? toBuyerLoginCandidate(candidate)
    : await acquireBuyerForStorefront(candidate.tenant_id, candidate.phone);

  // Not yet approved (fresh self-registration, or a still-suspended known
  // buyer) — mint a real (but restricted) session anyway. custom_access_token_hook
  // grants a `buyer_pending` role for this case (tenant_id + buyer_id claims,
  // nothing else) so the buyer can revisit the intake/blocked screens without
  // re-OTPing, while every buyer_app_enabled-gated RLS policy still shuts them
  // out of priced catalog/orders/invoices. Yukti_Inbox_Feature-Spec_v1.md §7.1.
  if (!buyerCandidate.buyer_app_enabled) {
    // Pending buyers only make sense on their own tenant host (/api/buyer/me needs
    // tenant context, which the catalog host doesn't have). When OTP was verified
    // anywhere else, hand the session off to the tenant host and land on the
    // intake/pending screen there — same as select-context does.
    if (isCatalogRequest(request) || request.headers.get('x-verified-tenant-id') !== buyerCandidate.tenant_id) {
      const pendingPath = await resolvePendingBuyerRedirect(buyerCandidate.buyer_id);
      const { hashedToken } = await mintBuyerHandoffLink(buyerCandidate, otpVerifiedPhone);
      const destinationHost = tenantStorefrontHostForRequest(
        request.headers.get('host') ?? '',
        buyerCandidate.tenant_slug,
      );
      const protocol = destinationHost.includes('localhost') ? 'http' : 'https';
      const handoffUrl = buildStorefrontHandoffUrl(
        destinationHost,
        hashedToken,
        `${protocol}://${destinationHost}${pendingPath}`,
      );
      return { pending: false, handoffUrl };
    }

    const { session } = await mintBuyerSession(buyerCandidate, otpVerifiedPhone);
    const redirect = await resolvePendingBuyerRedirect(buyerCandidate.buyer_id);
    return { pending: false, session, redirect };
  }

  const currentTenantId = request.headers.get('x-verified-tenant-id');
  const onCatalogHost = isCatalogRequest(request);

  if (currentTenantId !== buyerCandidate.tenant_id) {
    const destinationHost = tenantStorefrontHostForRequest(
      request.headers.get('host') ?? '',
      buyerCandidate.tenant_slug,
    );

    if (onCatalogHost) {
      const { hashedToken } = await mintBuyerHandoffLink(buyerCandidate, otpVerifiedPhone);
      const handoffUrl = buildStorefrontHandoffUrl(destinationHost, hashedToken, returnTo);
      const { supabaseAdmin } = await import('@/lib/supabase');
      if (supabaseAdmin && buyerCandidate.buyer_id) {
        void recordBuyerAppActivitySafe(supabaseAdmin as any, {
          tenantId: buyerCandidate.tenant_id,
          buyerId: buyerCandidate.buyer_id,
          eventName: 'session_started',
          path: request.nextUrl.pathname,
          context: {
            role: buyerCandidate.role,
            principal_type: buyerCandidate.principal_type,
          },
        });
      }
      return { pending: false, handoffUrl };
    }

    const { hashedToken } = await mintBuyerHandoffLink(buyerCandidate, otpVerifiedPhone);
    const handoffUrl = buildStorefrontHandoffUrl(destinationHost, hashedToken, returnTo);
    return { pending: false, handoffUrl };
  }

  const { session } = await mintBuyerSession(buyerCandidate, otpVerifiedPhone);
  const { supabaseAdmin } = await import('@/lib/supabase');
  if (supabaseAdmin && buyerCandidate.buyer_id) {
    void recordBuyerAppActivitySafe(supabaseAdmin as any, {
      tenantId: buyerCandidate.tenant_id,
      buyerId: buyerCandidate.buyer_id,
      eventName: 'session_started',
      path: request.nextUrl.pathname,
      context: {
        role: buyerCandidate.role,
        principal_type: buyerCandidate.principal_type,
      },
    });
  }
  const redirect = await requirePhoneConsentRedirect(buyerCandidate.phone) ?? storefrontHome;
  return { pending: false, session, redirect };
}
