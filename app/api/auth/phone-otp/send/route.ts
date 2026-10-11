import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { normalizeSupportedWhatsappLookupPhone } from '@/lib/phone';
import {
  findAllLoginCandidates,
  findBuyerLoginCandidates,
  findSellerLoginCandidates,
  type BuyerLoginCandidate,
} from '@/lib/server/buyer-access';
import { buyerOtpStore, type LoginOtpCandidate } from '@/lib/server/buyer-otp-store';
import { sendLoginOtpWhatsapp } from '@/lib/server/whatsapp';
import { AUTH_LOGIN_COPY, buildRequestAccessMessage } from '@/constants/auth-login-copy';
import { isCatalogRequest } from '@/lib/server/catalog-request';
import { catalogLoginUrlForRequest, parseRequestHost } from '@/lib/storefront-host';
import { tenantSlugFromReturnTo } from '@/lib/server/catalog-return-to';
import { getTenantBrandingBySlug } from '@/lib/server/tenant-branding';
import { resolveAuthSurfaceFromRequest } from '@/lib/server/auth-surface-server';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_SEND_COOLDOWN_MS = 45 * 1000; // 45 seconds between sends to the same phone

type PhoneOtpSendResponse =
  | { ref_id: string; registered: true; outcome: 'otp_sent'; message: string }
  | {
      ref_id: null;
      registered: false;
      outcome: 'unregistered' | 'seller_disabled' | 'buyer_disabled' | 'buyer_moved';
      message: string;
      seller_name: string | null;
      seller_whatsapp_number: string | null;
      buyer_name: string | null;
      catalog_url?: string;
    };

function toLoginOtpBuyerCandidate(candidate: BuyerLoginCandidate): LoginOtpCandidate {
  return {
    kind: 'buyer',
    tenant_id: candidate.tenant_id,
    tenant_name: candidate.tenant_name,
    tenant_slug: candidate.tenant_slug,
    tenant_whatsapp_number: candidate.tenant_whatsapp_number,
    tenant_whatsapp_display_name: candidate.tenant_whatsapp_display_name,
    tenant_logo_url: candidate.tenant_logo_url,
    role: candidate.role,
    buyer_id: candidate.buyer_id,
    principal_type: candidate.principal_type,
    user_id: candidate.user_id,
    buyer_user_id: candidate.buyer_user_id,
    phone: candidate.phone,
    business_name: candidate.business_name,
    contact_name: candidate.contact_name,
    buyer_app_enabled: candidate.buyer_app_enabled,
    tenant_app_enabled: candidate.tenant_app_enabled,
  };
}

function isEligibleBuyer(candidate: BuyerLoginCandidate): boolean {
  return Boolean(candidate.buyer_app_enabled && candidate.tenant_app_enabled);
}

function tenantSlugMatches(candidate: BuyerLoginCandidate, tenantSlug: string | null): boolean {
  if (!tenantSlug) return true;
  return candidate.tenant_slug?.toLowerCase() === tenantSlug.toLowerCase();
}

/**
 * POST /api/auth/phone-otp/send
 * Body: { phoneNumber: string, return_to?: string }
 *
 * Seller sessions are only discoverable on app.{suffix}. catalog.{suffix} and
 * tenant.{suffix} resolve buyer candidates only, even if a seller enters their
 * phone number there.
 */
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json() as { phoneNumber?: string; return_to?: string; tenantSlug?: string | null };
    const raw: string = (payload?.phoneNumber ?? '').trim();
    const phone = normalizeSupportedWhatsappLookupPhone(raw);
    if (!raw || !phone) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }

    const hostSurface = resolveAuthSurfaceFromRequest(request);
    const surface = hostSurface.surface;
    const isBuyerSurface = surface === 'buyer_catalog' || surface === 'tenant_buyer_catalog';
    const tenantSlug = hostSurface.tenantSlug ?? payload.tenantSlug ?? null;
    const returnTo = typeof payload?.return_to === 'string' ? payload.return_to : null;
    const returnToSlug = tenantSlugFromReturnTo(returnTo);
    const hostTenantId = request.headers.get('x-verified-tenant-id');
    const onCatalogHost = isCatalogRequest(request) || isBuyerSurface;
    const hostHeader = request.headers.get('host') ?? '';
    const hostKind = parseRequestHost(hostHeader);
    const onAppHost = surface === 'supplier_workspace' || request.headers.get('x-tenant-subdomain') === 'app' || hostKind.kind === 'app';

    let buyerCandidatesForMessages: Awaited<ReturnType<typeof findBuyerLoginCandidates>> | null = null;
    const allCandidatesRaw = await (async (): Promise<LoginOtpCandidate[] | PhoneOtpSendResponse> => {
      if (isBuyerSurface) {
        const buyerCandidates = await findBuyerLoginCandidates(phone);
        buyerCandidatesForMessages = buyerCandidates;
        return buyerCandidates
          .filter((candidate) => {
            if (hostTenantId) return candidate.tenant_id === hostTenantId && isEligibleBuyer(candidate);
            if (tenantSlug) return tenantSlugMatches(candidate, tenantSlug) && isEligibleBuyer(candidate);
            return isEligibleBuyer(candidate);
          })
          .map(toLoginOtpBuyerCandidate);
      }

      if (hostTenantId) {
        const buyerCandidates = await findBuyerLoginCandidates(phone);
        buyerCandidatesForMessages = buyerCandidates;
        return buyerCandidates
          .filter((candidate) => candidate.tenant_id === hostTenantId && isEligibleBuyer(candidate))
          .map(toLoginOtpBuyerCandidate);
      }

      if (onAppHost) {
        const sellerCandidates = await findSellerLoginCandidates(phone);
        if (sellerCandidates.length > 0) return sellerCandidates;

        const buyerCandidates = await findBuyerLoginCandidates(phone);
        buyerCandidatesForMessages = buyerCandidates;
        if (buyerCandidates.length > 0) {
          const catalogUrl = catalogLoginUrlForRequest(hostHeader);
          return {
            ref_id: null,
            registered: false,
            outcome: 'buyer_moved',
            message: `Buyer login has moved to ${catalogUrl}.`,
            seller_name: null,
            seller_whatsapp_number: null,
            buyer_name: null,
            catalog_url: catalogUrl,
          };
        }
        return [];
      }

      return await findAllLoginCandidates(phone);
    })();

    if (!Array.isArray(allCandidatesRaw)) {
      return NextResponse.json(allCandidatesRaw);
    }

    const allCandidates = onCatalogHost
      ? allCandidatesRaw.filter((candidate) => candidate.kind === 'buyer')
      : allCandidatesRaw;

    const cooldownRemaining = await buyerOtpStore.sendCooldownRemainingMs(phone, OTP_SEND_COOLDOWN_MS, OTP_TTL_MS);
    if (cooldownRemaining > 0) {
      return NextResponse.json(
        { error: 'Please wait before requesting another OTP', retry_after_ms: cooldownRemaining },
        { status: 429 },
      );
    }

    // Brand-new phone arriving through a tenant storefront is an access request
    // for that distributor, not an unscoped unknown number.
    let acquisitionTenantId: string | null = hostTenantId;
    const acquisitionSlug = tenantSlug ?? returnToSlug;
    if (allCandidates.length === 0 && !acquisitionTenantId && onCatalogHost && acquisitionSlug) {
      const lookedUp = buyerCandidatesForMessages ?? await findBuyerLoginCandidates(phone);
      buyerCandidatesForMessages = lookedUp;
      const hasAccountAtTenant = lookedUp.some((candidate) => tenantSlugMatches(candidate, acquisitionSlug));
      if (!hasAccountAtTenant) {
        const tenant = await getTenantBrandingBySlug(acquisitionSlug);
        if (tenant?.tenantId && tenant.isLive) acquisitionTenantId = tenant.tenantId;
      }
    }

    if (allCandidates.length === 0 && acquisitionTenantId) {
      const tenant = acquisitionSlug ? await getTenantBrandingBySlug(acquisitionSlug) : null;
      const otp = String(crypto.randomInt(100000, 999999));
      const ref_id = await buyerOtpStore.insert({
        kind: 'pending',
        otp,
        phone,
        expiresAt: Date.now() + OTP_TTL_MS,
        attempts: 0,
        candidates: [{
          kind: 'buyer',
          tenant_id: acquisitionTenantId,
          tenant_name: tenant?.businessName ?? '',
          tenant_slug: tenant?.slug ?? acquisitionSlug ?? '',
          tenant_whatsapp_number: tenant?.whatsappNumber ?? null,
          tenant_whatsapp_display_name: tenant?.businessName ?? null,
          tenant_logo_url: tenant?.logoUrl ?? null,
          role: 'buyer_admin',
          buyer_id: null,
          principal_type: 'buyer',
          user_id: null,
          buyer_user_id: null,
          phone,
          business_name: '',
          contact_name: null,
          buyer_app_enabled: false,
          tenant_app_enabled: true,
        }],
      });
      if (!ref_id) {
        return NextResponse.json({ error: 'Failed to create OTP session' }, { status: 500 });
      }
      await sendLoginOtpWhatsapp(phone, otp);
      const acquireBody: PhoneOtpSendResponse = { ref_id, registered: true, outcome: 'otp_sent', message: 'OTP sent' };
      return NextResponse.json(acquireBody);
    }

    if (allCandidates.length === 0) {
      const buyerCandidates = buyerCandidatesForMessages ?? await findBuyerLoginCandidates(phone);
      const scopedBuyerCandidates = buyerCandidates.filter((candidate) => {
        if (hostTenantId) return candidate.tenant_id === hostTenantId;
        if (tenantSlug) return tenantSlugMatches(candidate, tenantSlug);
        return true;
      });

      if (scopedBuyerCandidates.length === 0) {
        const responseBody: PhoneOtpSendResponse = {
          ref_id: null,
          registered: false,
          outcome: 'unregistered',
          message: AUTH_LOGIN_COPY.resolution.unregistered.title,
          seller_name: null,
          seller_whatsapp_number: null,
          buyer_name: null,
        };
        return NextResponse.json(responseBody);
      }

      const tenantBlocked = scopedBuyerCandidates.filter((candidate) => !candidate.tenant_app_enabled);
      const buyerBlocked = scopedBuyerCandidates.filter((candidate) => candidate.tenant_app_enabled && !candidate.buyer_app_enabled);
      const blockedCandidate = tenantBlocked[0] ?? buyerBlocked[0] ?? null;

      if (blockedCandidate) {
        const sellerName = blockedCandidate.tenant_name;
        const sellerWhatsappNumber = blockedCandidate.tenant_whatsapp_number ?? null;
        const buyerName = blockedCandidate.contact_name?.trim() || blockedCandidate.business_name || null;
        const outcome = tenantBlocked.length > 0 ? 'seller_disabled' : 'buyer_disabled';
        const message = buildRequestAccessMessage({ sellerName, buyerName });

        const responseBody: PhoneOtpSendResponse = {
          ref_id: null,
          registered: false,
          outcome,
          message,
          seller_name: sellerName,
          seller_whatsapp_number: sellerWhatsappNumber,
          buyer_name: buyerName,
        };
        return NextResponse.json(responseBody);
      }

      const responseBody: PhoneOtpSendResponse = {
        ref_id: null,
        registered: false,
        outcome: 'unregistered',
        message: AUTH_LOGIN_COPY.resolution.unregistered.title,
        seller_name: null,
        seller_whatsapp_number: null,
        buyer_name: null,
      };
      return NextResponse.json(responseBody);
    }

    const otp = String(crypto.randomInt(100000, 999999));
    const ref_id = await buyerOtpStore.insert({
      kind: 'pending',
      otp,
      phone,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      candidates: allCandidates,
    });

    if (!ref_id) {
      return NextResponse.json({ error: 'Failed to create OTP session' }, { status: 500 });
    }

    await sendLoginOtpWhatsapp(phone, otp);

    const responseBody: PhoneOtpSendResponse = { ref_id, registered: true, outcome: 'otp_sent', message: 'OTP sent' };
    return NextResponse.json(responseBody);
  } catch (err) {
    console.error('[phone-otp/send] unexpected error:', err);
    Sentry.captureException(err, { tags: { area: 'whatsapp_otp' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
