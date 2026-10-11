import { NextRequest, NextResponse } from 'next/server';
import { getVerifiedClaims } from '@/lib/auth';
import { recordBuyerAppActivitySafe } from '@/lib/server/buyer-app-activity';
import { mintBuyerSession, mintSellerSession, toBuyerLoginCandidate, mintBuyerHandoffLink, resolvePendingBuyerRedirect } from '@/lib/server/buyer-access';
import { buyerOtpStore, type LoginOtpCandidate } from '@/lib/server/buyer-otp-store';
import { stampSellerImplicitWhatsappConsent } from '@/lib/server/whatsapp-consent';
import { requirePhoneConsentRedirect } from '@/lib/server/phone-consent';
import { tenantStorefrontHostForRequest, buildStorefrontHandoffUrl } from '@/lib/storefront-host';
import { isCatalogRequest } from '@/lib/server/catalog-request';
import { STOREFRONT } from '@/lib/storefront-paths';
import { getRequestSupabaseClient } from '@/lib/server/request-supabase';
import { resolveAuthSurfaceFromRequest } from '@/lib/server/auth-surface-server';

async function getCurrentRequestUserId(request: NextRequest): Promise<string | null> {
  const claims = await getVerifiedClaims(request);
  if (claims.sub) return claims.sub;

  const supabase = await getRequestSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * POST /api/auth/phone-otp/select-context
 * Body: { ref_id: string; kind: 'seller'|'buyer'; tenant_id: string; buyer_id: string|null; role: string }
 * Returns: { success: true; redirect: string; session }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      ref_id?: string;
      kind?: string;
      tenant_id?: string;
      buyer_id?: string | null;
      role?: string;
      return_to?: string;
      request_access?: boolean;
    };
    const ref_id: string = (body?.ref_id ?? '').trim();
    const kind: string = (body?.kind ?? '').trim();
    const tenant_id: string = (body?.tenant_id ?? '').trim();
    const buyer_id: string | null = body?.buyer_id ?? null;
    const role: string = (body?.role ?? '').trim();
    const returnTo: string | null = body?.return_to?.trim() || null;
    const requestAccess = body?.request_access === true;
    const surface = resolveAuthSurfaceFromRequest(request).surface;

    if (!ref_id || !kind || !tenant_id || !role) {
      return NextResponse.json(
        { error: 'ref_id, kind, tenant_id, and role are required' },
        { status: 400 },
      );
    }

    const record = await buyerOtpStore.get(ref_id);

    if (!record || record.kind !== 'verified') {
      return NextResponse.json(
        { error: 'Context selection session expired. Please log in again.' },
        { status: 400 },
      );
    }

    if (Date.now() > record.expiresAt) {
      await buyerOtpStore.delete(ref_id);
      return NextResponse.json(
        { error: 'Session expired. Please log in again.' },
        { status: 400 },
      );
    }

    // SECURITY: a record with a stamped creator (created_by_user_id --
    // written by /api/auth/switch-context, an authenticated-caller shortcut,
    // as opposed to a real OTP hash check) may only ever be redeemed by that
    // same caller's own session. Without this, an attacker's own
    // switch-context call could hand back a ref_id whose `candidates` array
    // includes OTHER people's login candidates (e.g. after poisoning their
    // own app.buyers.phone to a victim's phone), and this route would mint
    // a real session for whichever candidate was requested with no check
    // that it belongs to the caller at all.
    if (record.createdByUserId) {
      const currentUserId = await getCurrentRequestUserId(request);
      if (!currentUserId || currentUserId !== record.createdByUserId) {
        return NextResponse.json(
          { error: 'Not authorized to redeem this context selection.' },
          { status: 403 },
        );
      }
    }

    const candidate = record.candidates.find((ctx) =>
      ctx.kind === kind
      && ctx.tenant_id === tenant_id
      && ctx.role === role
      && (kind === 'seller' ? ctx.buyer_id === null : ctx.buyer_id === buyer_id),
    );

    if (!candidate) {
      return NextResponse.json(
        { error: 'Selected account is no longer available. Please log in again.' },
        { status: 400 },
      );
    }

    if ((surface === 'buyer_catalog' || surface === 'tenant_buyer_catalog') && candidate.kind !== 'buyer') {
      return NextResponse.json(
        { error: 'Selected account is not available on this login page.' },
        { status: 400 },
      );
    }

    await buyerOtpStore.delete(ref_id);

    // Only a record written immediately after a real OTP hash check
    // (phone-otp/verify route) may have its phone stamped as
    // otp_verified_phone at mint time. A record written by the
    // switch-context shortcut (record.otpVerified === false) derived its
    // phone from a mutable app.buyers.phone lookup, not a fresh OTP — never
    // let it forge/refresh that claim.
    const otpVerifiedPhone = record.otpVerified ? record.phone : undefined;

    if (candidate.kind === 'seller') {
      const { session, user } = await mintSellerSession(
        candidate as LoginOtpCandidate & { kind: 'seller' },
      );
      await stampSellerImplicitWhatsappConsent(candidate.tenant_id, user.id);
      return NextResponse.json({ success: true, redirect: '/dashboard', session });
    }

    const buyerCandidate = toBuyerLoginCandidate(candidate);

    const currentTenantId = request.headers.get('x-verified-tenant-id');
    const onCatalogHost = isCatalogRequest(request);
    const { supabaseAdmin } = await import('@/lib/supabase');

    const recordSessionStart = (): void => {
      if (supabaseAdmin && candidate.buyer_id) {
        void recordBuyerAppActivitySafe(supabaseAdmin as any, {
          tenantId: candidate.tenant_id,
          buyerId: candidate.buyer_id,
          eventName: 'session_started',
          path: request.nextUrl.pathname,
          context: {
            role: candidate.role,
            principal_type: candidate.principal_type,
          },
        });
      }
    };

    if (!buyerCandidate.buyer_app_enabled) {
      if (!requestAccess) {
        return NextResponse.json(
          { error: 'Buyer app access is not enabled for this account.', access_disabled: true },
          { status: 403 },
        );
      }

      const onboardingPath = await resolvePendingBuyerRedirect(buyerCandidate.buyer_id);
      if (onCatalogHost || currentTenantId !== buyerCandidate.tenant_id) {
        const { hashedToken } = await mintBuyerHandoffLink(buyerCandidate, otpVerifiedPhone);
        const destinationHost = tenantStorefrontHostForRequest(
          request.headers.get('host') ?? '',
          buyerCandidate.tenant_slug,
        );
        const protocol = destinationHost.includes('localhost') ? 'http' : 'https';
        const onboardingUrl = `${protocol}://${destinationHost}${onboardingPath}`;
        recordSessionStart();
        return NextResponse.json({
          success: true,
          handoff_url: buildStorefrontHandoffUrl(destinationHost, hashedToken, onboardingUrl),
        });
      }

      const { session } = await mintBuyerSession(buyerCandidate, otpVerifiedPhone);
      recordSessionStart();
      return NextResponse.json({ success: true, redirect: onboardingPath, session });
    }

    if (onCatalogHost || currentTenantId !== buyerCandidate.tenant_id) {
      const { hashedToken } = await mintBuyerHandoffLink(buyerCandidate, otpVerifiedPhone);
      const destinationHost = tenantStorefrontHostForRequest(
        request.headers.get('host') ?? '',
        buyerCandidate.tenant_slug,
      );
      const handoffUrl = buildStorefrontHandoffUrl(destinationHost, hashedToken, returnTo);

      if (onCatalogHost) {
        recordSessionStart();
        return NextResponse.json({ success: true, handoff_url: handoffUrl });
      }

      return NextResponse.json({ success: true, handoff_url: handoffUrl });
    }

    const { session } = await mintBuyerSession(buyerCandidate, otpVerifiedPhone);
    recordSessionStart();
    // WhatsApp Broadcast Phase C (§4.8, §9): force first-time buyers through
    // the consent checkbox before /buy/home. Phone-level now — a phone that
    // already consented on any other tenant relationship isn't asked again.
    const redirect = await requirePhoneConsentRedirect(candidate.phone) ?? STOREFRONT.home;
    return NextResponse.json({ success: true, redirect, session });
  } catch (err) {
    console.error('[phone-otp/select-context] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
