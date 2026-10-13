import { beforeEach, describe, expect, it, vi } from 'vitest';

// Dynamic imports after vi.resetModules() are slow on cold start — allow 15s per test.
vi.setConfig({ testTimeout: 30_000 });

const findAllLoginCandidatesMock = vi.fn();
const findBuyerLoginCandidatesMock = vi.fn();
const findSellerLoginCandidatesMock = vi.fn();
const sendLoginOtpWhatsappMock = vi.fn();
const mintBuyerSessionMock = vi.fn();
const mintSellerSessionMock = vi.fn();
const recordBuyerAppActivitySafeMock = vi.fn();
const acquireBuyerForStorefrontMock = vi.fn();
const mintBuyerHandoffLinkMock = vi.fn();
const resolvePendingBuyerRedirectMock = vi.fn();
const getTenantBrandingBySlugMock = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/server/buyer-access', () => ({
  findAllLoginCandidates: (...args: unknown[]) => findAllLoginCandidatesMock(...args),
  findBuyerLoginCandidates: (...args: unknown[]) => findBuyerLoginCandidatesMock(...args),
  findSellerLoginCandidates: (...args: unknown[]) => findSellerLoginCandidatesMock(...args),
  mintBuyerSession: (...args: unknown[]) => mintBuyerSessionMock(...args),
  mintSellerSession: (...args: unknown[]) => mintSellerSessionMock(...args),
  toBuyerLoginCandidate: (c: unknown) => c,
  filterLoginCandidatesToTenant: (candidates: Array<{ tenant_id: string; kind?: string }>, tenantId: string) =>
    candidates.filter((candidate) => candidate.tenant_id === tenantId && candidate.kind !== 'seller'),
  acquireBuyerForStorefront: (...args: unknown[]) => acquireBuyerForStorefrontMock(...args),
  mintBuyerHandoffLink: (...args: unknown[]) => mintBuyerHandoffLinkMock(...args),
  resolvePendingBuyerRedirect: (...args: unknown[]) => resolvePendingBuyerRedirectMock(...args),
}));

vi.mock('@/lib/server/whatsapp', () => ({
  sendLoginOtpWhatsapp: (...args: unknown[]) => sendLoginOtpWhatsappMock(...args),
}));

vi.mock('@/lib/server/buyer-app-activity', () => ({
  recordBuyerAppActivitySafe: (...args: unknown[]) => recordBuyerAppActivitySafeMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { schema: vi.fn() },
}));

vi.mock('@/lib/server/phone-consent', () => ({
  // Tests below aren't exercising consent behavior — treat every phone as
  // already consented so redirects reflect the storefront-home logic being
  // tested, not an incidental lookup-error fallback.
  requirePhoneConsentRedirect: async () => null,
  hasPhoneConsented: async () => true,
  stampPhoneConsent: async () => {},
}));

vi.mock('@/lib/server/tenant-branding', () => ({
  getTenantBrandingBySlug: (...args: unknown[]) => getTenantBrandingBySlugMock(...args),
}));

const otpMemory = vi.hoisted(() => {
  const { createHash } = require('crypto') as typeof import('crypto');
  const store = new Map<string, Record<string, unknown>>();
  function hash(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
  }
  return {
    store,
    hash,
    api: {
      async sendCooldownRemainingMs(): Promise<number> {
        return 0;
      },
      async insert(record: { kind: string; otp?: string }): Promise<string> {
        const ref = `ref-${store.size + 1}`;
        const stored = record.kind === 'pending'
          ? { ...record, otp: hash(record.otp ?? '') }
          : { ...record };
        store.set(ref, stored);
        return ref;
      },
      async get(ref: string) {
        return store.get(ref) ?? null;
      },
      async set(ref: string, record: Record<string, unknown>) {
        store.set(ref, record);
      },
      async delete(ref: string) {
        store.delete(ref);
      },
    },
  };
});

vi.mock('@/lib/server/buyer-otp-store', () => ({
  hashOtp: otpMemory.hash,
  buyerOtpStore: otpMemory.api,
  writeVerifiedCandidatesRecord: (
    phone: string,
    candidates: unknown[],
  ) => otpMemory.api.insert({
    kind: 'verified',
    phone,
    expiresAt: Date.now() + 60_000,
    candidates,
  } as never),
}));

const eligibleBuyerCandidate = {
  kind: 'buyer' as const,
  tenant_id: 'tenant-1',
  tenant_name: 'Tenant One',
  tenant_slug: 'tenant-one',
  tenant_whatsapp_number: '9876500000',
  tenant_whatsapp_display_name: 'Tenant One',
  buyer_id: 'buyer-1',
  role: 'buyer_admin',
  principal_type: 'buyer',
  user_id: null,
  buyer_user_id: null,
  phone: '9876543210',
  business_name: 'Buyer One',
  contact_name: 'Rajan Mehta',
  buyer_app_enabled: true,
  tenant_app_enabled: true,
};

const sellerCandidate = {
  kind: 'seller' as const,
  tenant_id: 'tenant-1',
  tenant_name: 'Tenant One',
  tenant_slug: 'tenant-one',
  tenant_whatsapp_number: null,
  tenant_whatsapp_display_name: null,
  tenant_logo_url: null,
  buyer_id: null,
  role: 'seller_admin',
  principal_type: 'seller',
  user_id: 'seller-user-1',
  buyer_user_id: null,
  phone: '9876543210',
  business_name: '',
  contact_name: 'Seller One',
};

describe('buyer phone otp routes', () => {
  beforeEach(() => {
    vi.resetModules();
    findAllLoginCandidatesMock.mockReset();
    findBuyerLoginCandidatesMock.mockReset();
    findSellerLoginCandidatesMock.mockReset();
    findAllLoginCandidatesMock.mockResolvedValue([]);
    findBuyerLoginCandidatesMock.mockResolvedValue([]);
    findSellerLoginCandidatesMock.mockResolvedValue([]);
    sendLoginOtpWhatsappMock.mockReset();
    sendLoginOtpWhatsappMock.mockResolvedValue(undefined);
    mintBuyerSessionMock.mockReset();
    mintSellerSessionMock.mockReset();
    recordBuyerAppActivitySafeMock.mockReset();
    acquireBuyerForStorefrontMock.mockReset();
    mintBuyerHandoffLinkMock.mockReset();
    resolvePendingBuyerRedirectMock.mockReset();
    resolvePendingBuyerRedirectMock.mockResolvedValue('/onboarding');
    getTenantBrandingBySlugMock.mockReset();
    getTenantBrandingBySlugMock.mockResolvedValue({
      tenantId: 'tenant-1',
      slug: 'tenant-one',
      businessName: 'Tenant One',
      tagline: null,
      logoUrl: null,
      whatsappNumber: '9876500000',
      isLive: true,
    });
    otpMemory.store.clear();
  });

  it('sends OTP only for registered enabled buyer principals', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registered).toBe(true);
    expect(body.outcome).toBe('otp_sent');
    expect(typeof body.ref_id).toBe('string');
    expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
  });

  it('sends OTP for unknown phones on a tenant host so verify can acquire', async () => {
    findAllLoginCandidatesMock.mockResolvedValue([]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-verified-tenant-id': 'tenant-1',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registered).toBe(true);
    expect(body.outcome).toBe('otp_sent');
    expect(typeof body.ref_id).toBe('string');
    expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
  });

  it('returns unregistered for unknown numbers', async () => {
    findAllLoginCandidatesMock.mockResolvedValue([]);
    findBuyerLoginCandidatesMock.mockResolvedValue([]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registered).toBe(false);
    expect(body.outcome).toBe('unregistered');
    expect(body.ref_id).toBeNull();
    expect(body.message).toBe("We couldn't find your number");
    expect(body.seller_name).toBeNull();
    expect(body.seller_whatsapp_number).toBeNull();
  });

  it('does not send OTP for buyer-only phones on the seller app host', async () => {
    findSellerLoginCandidatesMock.mockResolvedValue([]);
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('https://app.useyukti.in/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: 'app.useyukti.in',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registered).toBe(false);
    expect(body.outcome).toBe('buyer_moved');
    expect(body.catalog_url).toBe('https://catalog.useyukti.in/login');
    expect(sendLoginOtpWhatsappMock).not.toHaveBeenCalled();
    expect(findSellerLoginCandidatesMock).toHaveBeenCalledTimes(1);
    expect(findBuyerLoginCandidatesMock).toHaveBeenCalledTimes(1);
    expect(findAllLoginCandidatesMock).not.toHaveBeenCalled();
    expect(otpMemory.store.size).toBe(0);
  });

  it('sends OTP for seller-only phones on the seller app host', async () => {
    findSellerLoginCandidatesMock.mockResolvedValue([sellerCandidate]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('https://app.useyukti.in/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: 'app.useyukti.in',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();
    const stored = await otpMemory.api.get(body.ref_id);

    expect(response.status).toBe(200);
    expect(body.registered).toBe(true);
    expect(body.outcome).toBe('otp_sent');
    expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
    expect(findSellerLoginCandidatesMock).toHaveBeenCalledTimes(1);
    expect(findBuyerLoginCandidatesMock).not.toHaveBeenCalled();
    expect(findAllLoginCandidatesMock).not.toHaveBeenCalled();
    expect((stored?.candidates as unknown[])).toHaveLength(1);
    expect((stored?.candidates as Array<{ kind: string }>)[0].kind).toBe('seller');
  });

  it('sends OTP only for seller candidates when a phone has mixed seller and buyer accounts on the seller app host', async () => {
    findSellerLoginCandidatesMock.mockResolvedValue([sellerCandidate]);
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('https://app.useyukti.in/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: 'app.useyukti.in',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();
    const stored = await otpMemory.api.get(body.ref_id);

    expect(response.status).toBe(200);
    expect(body.outcome).toBe('otp_sent');
    expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
    expect(findSellerLoginCandidatesMock).toHaveBeenCalledTimes(1);
    expect(findBuyerLoginCandidatesMock).not.toHaveBeenCalled();
    expect(findAllLoginCandidatesMock).not.toHaveBeenCalled();
    expect((stored?.candidates as unknown[])).toHaveLength(1);
    expect((stored?.candidates as Array<{ kind: string }>)[0].kind).toBe('seller');
  });

  it('sends OTP only for buyer candidates on the catalog host', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('https://catalog.useyukti.in/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: 'catalog.useyukti.in',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();
    const stored = await otpMemory.api.get(body.ref_id);

    expect(response.status).toBe(200);
    expect(body.outcome).toBe('otp_sent');
    expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
    expect(findBuyerLoginCandidatesMock).toHaveBeenCalledTimes(1);
    expect(findSellerLoginCandidatesMock).not.toHaveBeenCalled();
    expect(findAllLoginCandidatesMock).not.toHaveBeenCalled();
    expect((stored?.candidates as unknown[])).toHaveLength(1);
    expect((stored?.candidates as Array<{ kind: string }>)[0].kind).toBe('buyer');
  });

  it('keeps disabled buyer accounts in catalog OTP candidates so tenant login can offer request access', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([
      {
        ...eligibleBuyerCandidate,
        buyer_id: 'buyer-disabled',
        buyer_app_enabled: false,
        tenant_app_enabled: true,
      },
    ]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('https://catalog.useyukti.in/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: 'catalog.useyukti.in',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();
    const stored = await otpMemory.api.get(body.ref_id);

    expect(response.status).toBe(200);
    expect(body.outcome).toBe('otp_sent');
    expect((stored?.candidates as Array<{ buyer_id: string; buyer_app_enabled: boolean }>)).toEqual([
      expect.objectContaining({ buyer_id: 'buyer-disabled', buyer_app_enabled: false }),
    ]);
  });

  it('returns seller disabled metadata when tenant disabled buyer app', async () => {
    // findAllLoginCandidates filters out ineligible — returns empty
    findAllLoginCandidatesMock.mockResolvedValue([]);
    // findBuyerLoginCandidates returns the blocked candidate for messaging
    findBuyerLoginCandidatesMock.mockResolvedValue([
      {
        ...eligibleBuyerCandidate,
        tenant_name: 'Acme Corp',
        tenant_slug: 'acme',
        buyer_app_enabled: true,
        tenant_app_enabled: false,
      },
    ]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registered).toBe(false);
    expect(body.outcome).toBe('seller_disabled');
    expect(body.ref_id).toBeNull();
    expect(body.seller_name).toBe('Acme Corp');
    expect(body.seller_whatsapp_number).toBe('9876500000');
    expect(body.message).toContain('Acme Corp');
    expect(body.message).toContain('Yukti buyer-app');
  });

  it('still sends an OTP when only the buyer app is disabled, so verify lands them on /pending', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([
      {
        ...eligibleBuyerCandidate,
        tenant_name: 'Acme Corp',
        tenant_slug: 'acme',
        buyer_app_enabled: false,
        tenant_app_enabled: true,
      },
    ]);

    const { POST } = await import('../../../app/api/auth/phone-otp/send/route');
    const response = await POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210', return_to: 'https://acme.useyukti.in/buy/home' }),
    }) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.registered).toBe(true);
    expect(body.outcome).toBe('otp_sent');
    expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
  });

  it('verifies OTP and mints a session for a single buyer context', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);
    mintBuyerSessionMock.mockResolvedValue({
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    });

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    // Simulate OTP happening directly on tenant-1's own storefront host — the
    // still-supported local flow, as opposed to catalog.useyukti.in (no
    // x-verified-tenant-id header there), which triggers the cross-origin
    // handoff instead of a same-origin session mint.
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'x-verified-tenant-id': 'tenant-1' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { 'x-verified-tenant-id': 'tenant-1' },
      body: JSON.stringify({ ref_id: sendBody.ref_id, otp: pending && pending.kind === 'pending' ? pending.otp : '000000' }),
    }), {
      nextUrl: new URL('http://localhost/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    // On a tenant host (x-verified-tenant-id present) the storefront root path
    // is '/' — the '/buy/home' legacy path is only the fallback for a bare
    // host with no tenant context.
    expect(body.redirect).toBe('/');
    expect(body.session.access_token).toBe('access-token');
    expect(mintBuyerSessionMock).toHaveBeenCalledTimes(1);
    expect(recordBuyerAppActivitySafeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        buyerId: 'buyer-1',
        eventName: 'session_started',
      }),
    );
  });

  it('acquires a buyer on tenant-host verify when candidate has no buyer_id', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([]);
    acquireBuyerForStorefrontMock.mockResolvedValue({
      ...eligibleBuyerCandidate,
      buyer_id: 'acquired-1',
      business_name: 'Customer 9876543210',
    });
    mintBuyerSessionMock.mockResolvedValue({
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    });

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-verified-tenant-id': 'tenant-1',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-verified-tenant-id': 'tenant-1',
      },
      body: JSON.stringify({ ref_id: sendBody.ref_id, otp: pending && pending.kind === 'pending' ? pending.otp : '000000' }),
    }), {
      nextUrl: new URL('http://localhost/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.redirect).toBe('/');
    expect(acquireBuyerForStorefrontMock).toHaveBeenCalledWith('tenant-1', '9876543210');
    expect(mintBuyerSessionMock).toHaveBeenCalledTimes(1);
  });

  it('hands off to the tenant\'s own origin instead of minting a session when verified off-tenant-host (e.g. catalog.useyukti.in)', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);
    mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-abc', buyerId: 'buyer-1' });

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    // No x-verified-tenant-id header — simulates catalog.useyukti.in or a bare
    // host, where the request isn't scoped to any one tenant.
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ ref_id: sendBody.ref_id, otp: pending && pending.kind === 'pending' ? pending.otp : '000000' }),
    }), {
      nextUrl: new URL('http://localhost/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.handoff_url).toContain('/auth/storefront-handoff?token_hash=token-abc');
    expect(body.handoff_url).toContain(eligibleBuyerCandidate.tenant_slug);
    expect(body.session).toBeUndefined();
    expect(body.redirect).toBeUndefined();
    expect(mintBuyerHandoffLinkMock).toHaveBeenCalledTimes(1);
    expect(mintBuyerSessionMock).not.toHaveBeenCalled();
  });

  it('carries a validated return_to through to the handoff URL as `next`', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);
    mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-abc', buyerId: 'buyer-1' });

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({
        ref_id: sendBody.ref_id,
        otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
        return_to: `https://${eligibleBuyerCandidate.tenant_slug}.useyukti.in/product/55`,
      }),
    }), {
      nextUrl: new URL('http://localhost/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.handoff_url).toContain('next=%2Fproduct%2F55');
  });

  it('skips workspace picker on catalog when return_to matches one of multiple buyer tenants', async () => {
    const otherTenant = {
      ...eligibleBuyerCandidate,
      tenant_id: 'tenant-2',
      tenant_slug: 'tenant-two',
      tenant_name: 'Tenant Two',
      buyer_id: 'buyer-2',
    };
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate, otherTenant]);
    mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-abc', buyerId: 'buyer-1' });

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({
        ref_id: sendBody.ref_id,
        otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
        return_to: 'https://tenant-one.useyukti.in/',
      }),
    }), {
      nextUrl: new URL('http://catalog.useyukti.in/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.handoff_url).toContain('tenant-one');
    expect(body.session).toBeUndefined();
    expect(body.contexts).toBeUndefined();
    expect(body.ref_id).toBeUndefined();
    expect(mintBuyerSessionMock).not.toHaveBeenCalled();
  });

  it('shows tenant account picker when return_to tenant has multiple accounts, including disabled ones', async () => {
    const disabledSameTenant = {
      ...eligibleBuyerCandidate,
      buyer_id: 'buyer-disabled',
      business_name: 'Disabled Buyer',
      buyer_app_enabled: false,
    };
    const otherTenant = {
      ...eligibleBuyerCandidate,
      tenant_id: 'tenant-2',
      tenant_slug: 'tenant-two',
      tenant_name: 'Tenant Two',
      buyer_id: 'buyer-2',
    };
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate, disabledSameTenant, otherTenant]);

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({
        ref_id: sendBody.ref_id,
        otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
        return_to: 'https://tenant-one.useyukti.in/',
      }),
    }), {
      nextUrl: new URL('http://catalog.useyukti.in/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.contexts).toHaveLength(2);
    expect(body.contexts.map((ctx: { buyer_id: string }) => ctx.buyer_id)).toEqual(['buyer-1', 'buyer-disabled']);
    expect(body.return_to).toBe('https://tenant-one.useyukti.in/');
    expect(body.handoff_url).toBeUndefined();
    expect(mintBuyerHandoffLinkMock).not.toHaveBeenCalled();
  });

  it('drops a return_to that does not resolve to the destination tenant host', async () => {
    findBuyerLoginCandidatesMock.mockResolvedValue([eligibleBuyerCandidate]);
    mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-abc', buyerId: 'buyer-1' });

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'catalog.useyukti.in' },
      body: JSON.stringify({
        ref_id: sendBody.ref_id,
        otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
        return_to: 'https://evil.example.com/phish',
      }),
    }), {
      nextUrl: new URL('http://localhost/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.handoff_url).not.toContain('next=');
    expect(body.handoff_url).not.toContain('evil.example.com');
  });

  it('mints a restricted session and routes to /onboarding for a fresh self-registration pending approval (buyer_app_enabled: false)', async () => {
    findAllLoginCandidatesMock.mockResolvedValue([]);
    acquireBuyerForStorefrontMock.mockResolvedValue({
      ...eligibleBuyerCandidate,
      buyer_id: 'acquired-2',
      business_name: 'Customer 9876543210',
      buyer_app_enabled: false,
    });
    mintBuyerSessionMock.mockResolvedValue({
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    });
    resolvePendingBuyerRedirectMock.mockResolvedValue('/onboarding');

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-verified-tenant-id': 'tenant-1',
      },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-verified-tenant-id': 'tenant-1',
      },
      body: JSON.stringify({ ref_id: sendBody.ref_id, otp: pending && pending.kind === 'pending' ? pending.otp : '000000' }),
    }), {
      nextUrl: new URL('http://localhost/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.redirect).toBe('/onboarding');
    expect(body.session).toEqual({ access_token: 'access-token', refresh_token: 'refresh-token' });
    expect(mintBuyerSessionMock).toHaveBeenCalledTimes(1);
    expect(resolvePendingBuyerRedirectMock).toHaveBeenCalledWith('acquired-2');
  });

  it('hands a fresh self-registration verified on the catalog host off to the tenant /onboarding (no catalog-host session)', async () => {
    // Phone already has a buyer at an unrelated tenant, but none at tenant-one (return_to).
    findBuyerLoginCandidatesMock.mockResolvedValue([
      { ...eligibleBuyerCandidate, tenant_id: 'tenant-2', tenant_slug: 'tenant-two', tenant_name: 'Tenant Two', buyer_id: 'buyer-2' },
    ]);
    acquireBuyerForStorefrontMock.mockResolvedValue({
      ...eligibleBuyerCandidate,
      buyer_id: 'acquired-3',
      business_name: 'Customer 9876543210',
      buyer_app_enabled: false,
    });
    mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-new', buyerId: 'acquired-3' });
    resolvePendingBuyerRedirectMock.mockResolvedValue('/onboarding');

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({
        ref_id: sendBody.ref_id,
        otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
        return_to: 'https://tenant-one.useyukti.in/',
      }),
    }), {
      nextUrl: new URL('http://catalog.useyukti.in/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session).toBeUndefined();
    expect(body.redirect).toBeUndefined();
    expect(body.handoff_url).toContain('tenant-one');
    expect(body.handoff_url).toContain('token_hash=token-new');
    expect(body.handoff_url).toContain('next=%2Fonboarding');
    expect(mintBuyerSessionMock).not.toHaveBeenCalled();
  });

  it('hands a single not-yet-approved account at the return_to tenant off to tenant /onboarding instead of a one-item picker', async () => {
    const pendingSameTenant = {
      ...eligibleBuyerCandidate,
      buyer_id: 'buyer-pending',
      business_name: 'Customer 9876543210',
      buyer_app_enabled: false,
    };
    findBuyerLoginCandidatesMock.mockResolvedValue([pendingSameTenant]);
    mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-pending', buyerId: 'buyer-pending' });
    resolvePendingBuyerRedirectMock.mockResolvedValue('/onboarding');

    const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
    const sendResponse = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({ phoneNumber: '9876543210' }),
    }) as any);
    const sendBody = await sendResponse.json();

    const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
    const storeModule = await import('@/lib/server/buyer-otp-store');
    const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
    const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
      method: 'POST',
      headers: { host: 'catalog.useyukti.in' },
      body: JSON.stringify({
        ref_id: sendBody.ref_id,
        otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
        return_to: 'https://tenant-one.useyukti.in/',
      }),
    }), {
      nextUrl: new URL('http://catalog.useyukti.in/api/auth/phone-otp/verify'),
    });
    const response = await verifyRoute.POST(verifyRequest as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.contexts).toBeUndefined();
    expect(body.handoff_url).toContain('tenant-one');
    expect(body.handoff_url).toContain('token_hash=token-pending');
    expect(body.handoff_url).toContain('next=%2Fonboarding');
    expect(mintBuyerSessionMock).not.toHaveBeenCalled();
  });

  describe('brand-new phone on the catalog host', () => {
    const catalogSend = async (body: Record<string, unknown>) => {
      const sendRoute = await import('../../../app/api/auth/phone-otp/send/route');
      const res = await sendRoute.POST(new Request('http://localhost/api/auth/phone-otp/send', {
        method: 'POST',
        headers: { host: 'catalog.useyukti.in' },
        body: JSON.stringify({ phoneNumber: '9876543210', ...body }),
      }) as any);
      return res.json();
    };

    it('sends an OTP when return_to names a live storefront, so the user can onboard there', async () => {
      const body = await catalogSend({ return_to: 'https://tenant-one.useyukti.in/' });

      expect(body.registered).toBe(true);
      expect(body.outcome).toBe('otp_sent');
      expect(body.ref_id).toBeTruthy();
      expect(sendLoginOtpWhatsappMock).toHaveBeenCalledTimes(1);
    });

    it('still returns unregistered (no OTP) when there is no return_to', async () => {
      const body = await catalogSend({});

      expect(body.registered).toBe(false);
      expect(body.outcome).toBe('unregistered');
      expect(sendLoginOtpWhatsappMock).not.toHaveBeenCalled();
    });

    it('still returns unregistered when return_to points at a storefront that is not live', async () => {
      getTenantBrandingBySlugMock.mockResolvedValue({
        tenantId: 'tenant-1', slug: 'tenant-one', businessName: 'Tenant One', tagline: null,
        logoUrl: null, whatsappNumber: null, isLive: false,
      });
      const body = await catalogSend({ return_to: 'https://tenant-one.useyukti.in/' });

      expect(body.outcome).toBe('unregistered');
      expect(sendLoginOtpWhatsappMock).not.toHaveBeenCalled();
    });

    it('still returns unregistered when return_to does not resolve to any tenant', async () => {
      getTenantBrandingBySlugMock.mockResolvedValue(null);
      const body = await catalogSend({ return_to: 'https://nope.useyukti.in/' });

      expect(body.outcome).toBe('unregistered');
      expect(sendLoginOtpWhatsappMock).not.toHaveBeenCalled();
    });

    it('completes end to end: OTP verify hands the new phone off to the tenant /onboarding', async () => {
      acquireBuyerForStorefrontMock.mockResolvedValue({
        ...eligibleBuyerCandidate,
        buyer_id: 'acquired-4',
        business_name: 'Customer 9876543210',
        buyer_app_enabled: false,
      });
      mintBuyerHandoffLinkMock.mockResolvedValue({ hashedToken: 'token-e2e', buyerId: 'acquired-4' });
      resolvePendingBuyerRedirectMock.mockResolvedValue('/onboarding');

      const sendBody = await catalogSend({ return_to: 'https://tenant-one.useyukti.in/' });

      const verifyRoute = await import('../../../app/api/auth/phone-otp/verify/route');
      const storeModule = await import('@/lib/server/buyer-otp-store');
      const pending = await storeModule.buyerOtpStore.get(sendBody.ref_id);
      const verifyRequest = Object.assign(new Request('http://localhost/api/auth/phone-otp/verify', {
        method: 'POST',
        headers: { host: 'catalog.useyukti.in' },
        body: JSON.stringify({
          ref_id: sendBody.ref_id,
          otp: pending && pending.kind === 'pending' ? pending.otp : '000000',
          return_to: 'https://tenant-one.useyukti.in/',
        }),
      }), { nextUrl: new URL('http://catalog.useyukti.in/api/auth/phone-otp/verify') });
      const body = await (await verifyRoute.POST(verifyRequest as any)).json();

      expect(body.handoff_url).toContain('token_hash=token-e2e');
      expect(body.handoff_url).toContain('next=%2Fonboarding');
      expect(acquireBuyerForStorefrontMock).toHaveBeenCalledWith('tenant-1', '9876543210');
    });
  });
});
