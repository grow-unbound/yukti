import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

const {
  getClaimsMock,
  resolveStorefrontMock,
  resolveTenantSlugMock,
  consumeRateLimitMock,
  consumeEnumerationRateLimitMock,
  recordViolationMock,
  verifyHumanVerifiedMock,
  hasAuthCookieMock,
} = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  resolveStorefrontMock: vi.fn(),
  resolveTenantSlugMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  consumeEnumerationRateLimitMock: vi.fn(),
  recordViolationMock: vi.fn(),
  verifyHumanVerifiedMock: vi.fn(),
  hasAuthCookieMock: vi.fn(),
}));

// Existing tests emulate sessions through getClaimsMock without setting real cookies, so the cookie
// gate defaults to "has a session cookie"; the fast-path tests below flip it to false.
vi.mock('@/lib/server/supabase-auth-cookie', () => ({
  hasSupabaseAuthCookie: (...args: unknown[]) => hasAuthCookieMock(...args),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getClaims: getClaimsMock,
    },
  })),
}));

vi.mock('@/lib/server/resolve-storefront-tenant', () => ({
  resolveStorefrontTenantBySlug: (...args: unknown[]) => resolveStorefrontMock(...args),
  isPublicCatalogLive: (record: { liveAt: string | null } | null) => Boolean(record?.liveAt),
  resolveTenantSlugById: (...args: unknown[]) => resolveTenantSlugMock(...args),
}));

vi.mock('@/lib/server/public-catalog-rate-limit', () => ({
  clientIpFromRequest: () => '203.0.113.1',
  consumePublicCatalogRateLimit: (...args: unknown[]) => consumeRateLimitMock(...args),
  consumeEnumerationRateLimit: (...args: unknown[]) => consumeEnumerationRateLimitMock(...args),
  tooManyRequestsResponse: (retryAfterSec: number) =>
    new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec), 'Cache-Control': 'private, no-store' },
    }),
}));

vi.mock('@/lib/server/ip-challenge', () => ({
  recordViolationAndCheckChallenge: (...args: unknown[]) => recordViolationMock(...args),
}));

vi.mock('@/lib/server/human-verify-token', () => ({
  HUMAN_VERIFIED_COOKIE: 'df_human_verified',
  verifyHumanVerifiedToken: (...args: unknown[]) => verifyHumanVerifiedMock(...args),
}));

function tenantRequest(path: string, host = 'wineyard.useyukti.in') {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

function catalogRequest(path: string, host = 'catalog.useyukti.in') {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

describe('middleware auth redirects', () => {
  beforeEach(() => {
    getClaimsMock.mockReset();
    hasAuthCookieMock.mockReset();
    hasAuthCookieMock.mockReturnValue(true);
    resolveStorefrontMock.mockReset();
    resolveTenantSlugMock.mockReset();
    resolveTenantSlugMock.mockResolvedValue(null);
    consumeRateLimitMock.mockReset();
    consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    consumeEnumerationRateLimitMock.mockReset();
    consumeEnumerationRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    recordViolationMock.mockReset();
    recordViolationMock.mockResolvedValue({ challengeRequired: false, violationCount: 1 });
    verifyHumanVerifiedMock.mockReset();
    verifyHumanVerifiedMock.mockResolvedValue(false);
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-wy',
      slug: 'wineyard',
      catalogId: 'cat-1',
      liveAt: '2026-09-01T00:00:00.000Z',
      pricingMode: 'base_selling_rate',
      priceListId: null,
    });
  });

  it('allows anonymous access to /activate without redirecting to /login', async () => {
    const { middleware } = await import('../../../middleware');
    const response = await middleware(new NextRequest('http://localhost/activate'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects to /login when the session is missing', async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: { message: 'Auth session missing' },
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(new NextRequest('http://localhost/dashboard'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/login?next=%2Fdashboard');
  });

  it('redirects app host root to login when the session is missing', async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: { message: 'Auth session missing' },
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/', 'app.useyukti.in'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.useyukti.in/login?next=%2F');
  });

  it('redirects app host root to Today for authenticated sellers', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'seller-user-1', tenant_id: 'tenant-1', user_role: 'seller_admin' } },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/', 'app.useyukti.in'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.useyukti.in/today');
  });

  it('redirects authenticated sellers away from app login to Today', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'seller-user-1', tenant_id: 'tenant-1', user_role: 'seller_admin' } },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/login', 'app.useyukti.in'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.useyukti.in/today');
  });

  it('redirects to /login when the JWT fails signature verification', async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: { message: 'invalid signature' },
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(new NextRequest('http://localhost/buy/catalog'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/login?next=%2Fbuy%2Fcatalog');
  });

  it('forwards verified location ids from the verified claims', async () => {
    getClaimsMock.mockResolvedValue({
      data: {
        claims: {
          sub: 'seller-user-1',
          tenant_id: 'tenant-1',
          user_role: 'seller_assistant',
          location_ids: ['loc-1', 'loc-2'],
        },
      },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(new NextRequest('http://localhost/sales-orders'));

    expect(response.headers.get('x-tenant-subdomain')).toBe('');
  });

  it('redirects legacy seller /orders only on the seller host', async () => {
    const { middleware } = await import('../../../middleware');
    const response = await middleware(new NextRequest('http://localhost/orders'));

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('http://localhost/sales-orders');
  });

  it('lets guests browse a live tenant host without login', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rewrites authenticated buyer /orders on a tenant host to the buyer orders page', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/orders'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toContain('/buy/orders');
  });

  it('lets a guest reach the delivery-location picker without being bounced to /login (BuyerSelectionGate sends every visitor there, guests included, before rendering home)', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/location?returnTo=%2F'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();

    const apiResponse = await middleware(tenantRequest('/api/buyer/nearest-location?lat=1&lng=2'));
    expect(apiResponse.status).not.toBe(404);
    expect(apiResponse.headers.get('location')).toBeNull();
  });

  it('serves tenant hosts on *.localhost without 301ing to useyukti.in', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(
      new NextRequest('http://wineyard.localhost:3000/', { headers: { host: 'wineyard.localhost:3000' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('301s app.localhost/buy/home to wineyard.localhost', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(
      new NextRequest('http://app.localhost:3000/buy/home', { headers: { host: 'app.localhost:3000' } }),
    );
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('http://wineyard.localhost:3000/');
  });

  it('301s /buy/home on a tenant host to /', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/buy/home'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://wineyard.useyukti.in/');
  });

  it('301s app.useyukti.in/buy/home to the WineYard storefront', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/buy/home', 'app.useyukti.in'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://wineyard.useyukti.in/');
  });

  it('clears buyer-only sessions on the seller app host and redirects to catalog login', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const request = tenantRequest('/dashboard', 'app.useyukti.in');
    request.cookies.set('sb-test-ref-auth-token', 'stale-buyer-session');
    request.cookies.set('sb-test-ref-auth-token.0', 'stale-buyer-session-chunk');

    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://catalog.useyukti.in/login');
    const setCookie = response.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('sb-test-ref-auth-token=;');
    expect(setCookie).toContain('sb-test-ref-auth-token.0=;');
    expect(setCookie).toContain('Max-Age=0');
    expect(resolveTenantSlugMock).not.toHaveBeenCalled();
  });

  it('clears buyer-only sessions on app login and redirects to catalog login', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const request = tenantRequest('/login', 'app.useyukti.in');
    request.cookies.set('sb-test-ref-auth-token', 'stale-buyer-session');

    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://catalog.useyukti.in/login');
    expect(response.headers.getSetCookie().join('\n')).toContain('sb-test-ref-auth-token=;');
  });

  it('clears buyer-only sessions on app / before seller bootstrap can render buyer UI', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b2', tenant_id: 'tenant-acme', user_role: 'buyer_admin', buyer_id: 'buyer-2' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const request = tenantRequest('/', 'app.useyukti.in');
    request.cookies.set('sb-test-ref-auth-token', 'stale-buyer-session');

    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://catalog.useyukti.in/login');
    expect(response.headers.getSetCookie().join('\n')).toContain('sb-test-ref-auth-token=;');
  });

  it('clears buyer-only sessions on app.localhost and redirects to catalog.localhost', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b3', tenant_id: 'tenant-unknown', user_role: 'buyer_admin', buyer_id: 'buyer-3' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const request = new NextRequest('http://app.localhost:3000/', { headers: { host: 'app.localhost:3000' } });
    request.cookies.set('sb-test-ref-auth-token', 'stale-buyer-session');

    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://catalog.localhost:3000/login');
    expect(response.headers.getSetCookie().join('\n')).toContain('sb-test-ref-auth-token=;');
  });

  it('clears buyer-only sessions on app.yukti.so preview and redirects to catalog.yukti.so', async () => {
    const original = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    try {
      getClaimsMock.mockResolvedValue({
        data: { claims: { sub: 'b4', tenant_id: 'tenant-unknown', user_role: 'buyer_admin', buyer_id: 'buyer-4' } },
        error: null,
      });
      const { middleware } = await import('../../../middleware');
      const request = tenantRequest('/today', 'app.yukti.so');
      request.cookies.set('sb-test-ref-auth-token', 'stale-buyer-session');

      const response = await middleware(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://catalog.yukti.so/login');
      expect(response.headers.getSetCookie().join('\n')).toContain('sb-test-ref-auth-token=;');
    } finally {
      if (original === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = original;
      }
    }
  });

  it('does not serve products on an unpublished tenant host', async () => {
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-x',
      slug: 'acme',
      catalogId: 'cat-1',
      liveAt: null,
      pricingMode: null,
      priceListId: null,
    });
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const page = await middleware(tenantRequest('/', 'acme.useyukti.in'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe(
      'https://catalog.useyukti.in/login?return_to=https%3A%2F%2Facme.useyukti.in%2F',
    );
    const api = await middleware(tenantRequest('/api/buyer/catalog', 'acme.useyukti.in'));
    expect(api.status).toBe(404);
  });

  it('guest-only cacheable twin: never served for an unpublished tenant host, unknown slug, or over the rate limit', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');

    // Unpublished tenant: middleware (which runs before any CDN cache) answers 404, so a previously
    // cached 200 for this host can never be served once the catalog is taken offline.
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-x', slug: 'acme', catalogId: 'cat-1', liveAt: null, pricingMode: null, priceListId: null,
    });
    const notLive = await middleware(tenantRequest('/api/public/g/catalog', 'acme.useyukti.in'));
    expect(notLive.status).toBe(404);
    expect(notLive.headers.get('Cache-Control')).toBe('private, no-store');

    // Unknown slug: same real 404 as /api/buyer/catalog, no oracle.
    resolveStorefrontMock.mockResolvedValue(null);
    const unknown = await middleware(tenantRequest('/api/public/g/catalog', 'gibberish.useyukti.in'));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });

    // Enumeration limiter still applies to the twin path.
    consumeEnumerationRateLimitMock.mockResolvedValue({ ok: false, retryAfterSec: 45 });
    const limited = await middleware(tenantRequest('/api/public/g/catalog', 'probe-slug.useyukti.in'));
    expect(limited.status).toBe(429);
  });

  it('preserves yukti.so in unpublished tenant return_to on Vercel preview', async () => {
    const original = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    try {
      resolveStorefrontMock.mockResolvedValue({
        tenantId: 'tenant-x',
        slug: 'wineyard',
        catalogId: 'cat-1',
        liveAt: null,
        pricingMode: null,
        priceListId: null,
      });
      getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
      const { middleware } = await import('../../../middleware');
      const response = await middleware(tenantRequest('/orders', 'wineyard.yukti.so'));

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        'https://catalog.yukti.so/login?return_to=https%3A%2F%2Fwineyard.yukti.so%2Forders',
      );
    } finally {
      if (original === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = original;
      }
    }
  });

  it('preserves localhost and port in unpublished tenant return_to', async () => {
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-x',
      slug: 'wineyard',
      catalogId: 'cat-1',
      liveAt: null,
      pricingMode: null,
      priceListId: null,
    });
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(
      new NextRequest('http://wineyard.localhost:3000/orders', {
        headers: { host: 'wineyard.localhost:3000' },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://catalog.localhost:3000/login?return_to=http%3A%2F%2Fwineyard.localhost%3A3000%2Forders',
    );
  });

  it('redirects anonymous unpublished tenant pages to catalog login, not tenant-local login', async () => {
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-x',
      slug: 'acme',
      catalogId: 'cat-1',
      liveAt: null,
      pricingMode: null,
      priceListId: null,
    });
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');

    const ordersPage = await middleware(tenantRequest('/orders', 'acme.useyukti.in'));
    expect(ordersPage.status).toBe(307);
    expect(ordersPage.headers.get('location')).toBe(
      'https://catalog.useyukti.in/login?return_to=https%3A%2F%2Facme.useyukti.in%2Forders',
    );

    const loginPage = await middleware(tenantRequest('/login', 'acme.useyukti.in'));
    expect(loginPage.status).toBe(307);
    expect(loginPage.headers.get('location')).toBe(
      'https://catalog.useyukti.in/login?return_to=https%3A%2F%2Facme.useyukti.in%2Flogin',
    );
  });

  it('lets an authenticated buyer reach their tenant experience even when the public catalog is not live', async () => {
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-wy',
      slug: 'wineyard',
      catalogId: 'cat-1',
      liveAt: null,
      pricingMode: null,
      priceListId: null,
    });
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const page = await middleware(tenantRequest('/', 'wineyard.useyukti.in'));
    expect(page.status).toBe(200);
    expect(page.headers.get('x-middleware-rewrite')).toContain('/buy/home');

    const api = await middleware(tenantRequest('/api/buyer/catalog', 'wineyard.useyukti.in'));
    expect(api.status).toBe(200);
    expect(api.headers.get('location')).toBeNull();
  });

  it('redirects authenticated buyers from tenant login back to the tenant home screen', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/login'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://wineyard.useyukti.in/');
  });

  it('serves public brand assets without rewriting them as authenticated buyer brand pages', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });

    const { middleware } = await import('../../../middleware');
    const mark = await middleware(tenantRequest('/brand/mark-ink.svg'));
    expect(mark.status).toBe(200);
    expect(mark.headers.get('x-middleware-rewrite')).toBeNull();

    const appIcon = await middleware(tenantRequest('/brand/app-icon-copper.svg'));
    expect(appIcon.status).toBe(200);
    expect(appIcon.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('rewrites to a real 404 page for a slug with no matching tenant at all — not the not-live page', async () => {
    resolveStorefrontMock.mockResolvedValue(null);
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const page = await middleware(tenantRequest('/', 'gibberish.useyukti.in'));
    expect(page.headers.get('x-middleware-rewrite')).toContain('/tenant-not-found');

    const api = await middleware(tenantRequest('/api/buyer/catalog', 'gibberish.useyukti.in'));
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'Not found' });
  });

  it('rate-limits slug-enumeration probes against nonexistent tenants, per-IP', async () => {
    resolveStorefrontMock.mockResolvedValue(null);
    consumeEnumerationRateLimitMock.mockResolvedValue({ ok: false, retryAfterSec: 45 });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/', 'another-gibberish-slug.useyukti.in'));
    expect(response.status).toBe(429);
    expect(consumeEnumerationRateLimitMock).toHaveBeenCalledWith('203.0.113.1');
  });

  it('escalates to a Turnstile challenge redirect (not another 429) once violations cross the threshold, for page requests', async () => {
    resolveStorefrontMock.mockResolvedValue(null);
    consumeEnumerationRateLimitMock.mockResolvedValue({ ok: false, retryAfterSec: 45 });
    recordViolationMock.mockResolvedValue({ challengeRequired: true, violationCount: 3 });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/some-page', 'yet-another-gibberish.useyukti.in'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toContain('/verify-human');
    expect(location).toContain('return_to=%2Fsome-page');
  });

  it('does not escalate an API request to the challenge redirect — keeps returning 429', async () => {
    resolveStorefrontMock.mockResolvedValue(null);
    consumeEnumerationRateLimitMock.mockResolvedValue({ ok: false, retryAfterSec: 45 });
    recordViolationMock.mockResolvedValue({ challengeRequired: true, violationCount: 5 });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/api/buyer/catalog', 'yet-more-gibberish.useyukti.in'));
    expect(response.status).toBe(429);
  });

  it('skips the enumeration limiter entirely once a valid human-verified cookie is present', async () => {
    resolveStorefrontMock.mockResolvedValue(null);
    verifyHumanVerifiedMock.mockResolvedValue(true);
    const { middleware } = await import('../../../middleware');
    const request = tenantRequest('/', 'gibberish-but-verified.useyukti.in');
    request.cookies.set('df_human_verified', 'some-signed-token');
    const response = await middleware(request);
    expect(consumeEnumerationRateLimitMock).not.toHaveBeenCalled();
    // Still a real 404 — verification bypasses the rate limit, not the not-found result.
    expect(response.headers.get('x-middleware-rewrite')).toContain('/tenant-not-found');
  });

  it('rate-limits anonymous catalog GETs', async () => {
    consumeRateLimitMock.mockResolvedValue({ ok: false, retryAfterSec: 30 });
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/api/buyer/catalog'));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
  });

  it('does not spend rate-limit budget on router PREFETCH requests of guest pages (landing tile storm)', async () => {
    consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');

    const prefetch = (path: string, headers: Record<string, string>) =>
      new NextRequest(`https://wineyard.useyukti.in${path}`, { headers: { host: 'wineyard.useyukti.in', ...headers } });

    // 40 tile prefetches (brand/category/product) on one landing view: none may be counted.
    for (let i = 0; i < 40; i += 1) {
      await middleware(prefetch(`/product/id-${i}`, { 'next-router-prefetch': '1', rsc: '1' }));
    }
    await middleware(prefetch('/brand/abc', { purpose: 'prefetch' }));
    expect(consumeRateLimitMock).not.toHaveBeenCalled();

    // A real navigation to the same page IS counted (one hit).
    await middleware(prefetch('/product/id-1', { rsc: '1' }));
    expect(consumeRateLimitMock).toHaveBeenCalledTimes(1);
    expect(consumeRateLimitMock).toHaveBeenCalledWith(expect.any(String), 'wineyard', 'browse');
  });

  it('never lets the client-controllable prefetch header bypass the limiter on API routes', async () => {
    consumeRateLimitMock.mockResolvedValue({ ok: false, retryAfterSec: 30 });
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(
      new NextRequest('https://wineyard.useyukti.in/api/buyer/catalog', {
        headers: { host: 'wineyard.useyukti.in', 'next-router-prefetch': '1' },
      }),
    );
    expect(response.status).toBe(429);
    expect(consumeRateLimitMock).toHaveBeenCalledTimes(1);
  });

  it('anonymous requests (no Supabase auth cookie) skip client construction and getClaims entirely', async () => {
    hasAuthCookieMock.mockReturnValue(false);
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-wy', slug: 'wineyard', catalogId: 'cat-1', liveAt: '2026-09-01T00:00:00Z', pricingMode: 'assigned_price_list', priceListId: null,
    });
    consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/product/abc', 'wineyard.useyukti.in'));
    expect(response.status).toBeLessThan(400);
    expect(getClaimsMock).not.toHaveBeenCalled();
  });

  it('requests that carry a session cookie still verify claims', async () => {
    hasAuthCookieMock.mockReturnValue(true);
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    resolveStorefrontMock.mockResolvedValue({
      tenantId: 'tenant-wy', slug: 'wineyard', catalogId: 'cat-1', liveAt: '2026-09-01T00:00:00Z', pricingMode: 'assigned_price_list', priceListId: null,
    });
    consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    const { middleware } = await import('../../../middleware');
    await middleware(tenantRequest('/product/abc', 'wineyard.useyukti.in'));
    expect(getClaimsMock).toHaveBeenCalledTimes(1);
  });

  it('matcher: skips real static files and the PostHog proxy, but never API routes or tenant-branded/page routes', async () => {
    const { config } = await import('../../../middleware');
    const re = new RegExp(`^${config.matcher[0]}$`);
    const runs = (p: string) => re.test(p);
    for (const p of ['/brand/app-icon-copper.svg', '/logo.png', '/images/hero.webp', '/buyer-sw.js', '/ingest', '/ingest/i/v0/e/', '/_next/static/a.js', '/_next/image', '/favicon.ico', '/robots.txt']) {
      expect(runs(p), `${p} should skip middleware`).toBe(false);
    }
    for (const p of ['/', '/login', '/product/abc', '/brand/e1cb16b7-97de-438b-bb4d-f2a95a092aae', '/category/x', '/manifest.webmanifest', '/api/buyer/catalog', '/api/public/g/catalog', '/api/tenant/export.txt', '/api/tenant/report.js', '/api/tenant/logo.png', '/ingestion-report']) {
      expect(runs(p), `${p} must still run middleware`).toBe(true);
    }
  });

  describe('CPU sampling flag', () => {
    it('logs nothing when MIDDLEWARE_CPU_SAMPLE_RATE is unset', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
      const { middleware } = await import('../../../middleware');
      await middleware(catalogRequest('/login'));
      expect(spy.mock.calls.filter((c) => String(c[0]).includes('mw_cpu_sample'))).toHaveLength(0);
      spy.mockRestore();
    });

    it('logs one PII-free JSON line per request at rate 1', async () => {
      const original = process.env.MIDDLEWARE_CPU_SAMPLE_RATE;
      process.env.MIDDLEWARE_CPU_SAMPLE_RATE = '1';
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        hasAuthCookieMock.mockReturnValue(false);
        const { middleware } = await import('../../../middleware');
        await middleware(catalogRequest('/login?return_to=https%3A%2F%2Fsecret.example%2Fx'));
        const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('mw_cpu_sample'));
        expect(lines).toHaveLength(1);
        const record = JSON.parse(lines[0]);
        expect(record).toMatchObject({ evt: 'mw_cpu_sample', cls: 'page', has_session_cookie: false });
        expect(typeof record.cpu_us).toBe('number');
        expect(typeof record.wall_ms).toBe('number');
        expect(lines[0]).not.toContain('secret.example');
        expect(lines[0]).not.toContain('return_to');
      } finally {
        spy.mockRestore();
        if (original === undefined) delete process.env.MIDDLEWARE_CPU_SAMPLE_RATE;
        else process.env.MIDDLEWARE_CPU_SAMPLE_RATE = original;
      }
    });
  });

  it('301s yukti.so tenant hosts to useyukti.in', async () => {
    const { middleware } = await import('../../../middleware');
    const response = await middleware(tenantRequest('/', 'wineyard.yukti.so'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://wineyard.useyukti.in/');
  });

  it('serves yukti.so hosts on Vercel preview without canonicalizing to useyukti.in', async () => {
    const original = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    try {
      getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
      const { middleware } = await import('../../../middleware');

      const appResponse = await middleware(tenantRequest('/', 'app.yukti.so'));
      expect(appResponse.status).toBe(307);
      expect(appResponse.headers.get('location')).toBe('https://app.yukti.so/login?next=%2F');

      const tenantResponse = await middleware(tenantRequest('/', 'wineyard.yukti.so'));
      expect(tenantResponse.headers.get('location')).toBeNull();
      expect(tenantResponse.headers.get('x-tenant-subdomain')).toBe('wineyard');
    } finally {
      if (original === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = original;
      }
    }
  });
});

describe('catalog host middleware', () => {
  beforeEach(() => {
    getClaimsMock.mockReset();
    resolveStorefrontMock.mockReset();
    resolveTenantSlugMock.mockReset();
    resolveTenantSlugMock.mockResolvedValue(null);
    consumeRateLimitMock.mockReset();
    consumeRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    consumeEnumerationRateLimitMock.mockReset();
    consumeEnumerationRateLimitMock.mockResolvedValue({ ok: true, retryAfterSec: 0 });
    recordViolationMock.mockReset();
    recordViolationMock.mockResolvedValue({ challengeRequired: false, violationCount: 1 });
    verifyHumanVerifiedMock.mockReset();
    verifyHumanVerifiedMock.mockResolvedValue(false);
  });

  it('redirects unauthenticated catalog / to /login', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(catalogRequest('/'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://catalog.useyukti.in/login?next=%2F');
  });

  it('allows public /login on catalog host without auth', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(catalogRequest('/login'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects buyer session on catalog / to /workspaces', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(catalogRequest('/'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://catalog.useyukti.in/workspaces');
  });

  it('redirects buyer session on catalog /login to /workspaces', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 'b1', tenant_id: 'tenant-wy', user_role: 'buyer_admin', buyer_id: 'buyer-1' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(catalogRequest('/login'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://catalog.useyukti.in/workspaces');
  });

  it('redirects seller session on catalog host to app.useyukti.in', async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: 's1', tenant_id: 'tenant-wy', user_role: 'seller_admin' } },
      error: null,
    });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(catalogRequest('/workspaces'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.useyukti.in/today');
  });

  it('serves catalog.localhost without canonical redirect', async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
    const { middleware } = await import('../../../middleware');
    const response = await middleware(
      new NextRequest('http://catalog.localhost:3000/login', { headers: { host: 'catalog.localhost:3000' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('serves catalog.yukti.so on Vercel preview without canonicalizing to catalog.useyukti.in', async () => {
    const original = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    try {
      getClaimsMock.mockResolvedValue({ data: null, error: { message: 'missing' } });
      const { middleware } = await import('../../../middleware');
      const response = await middleware(catalogRequest('/', 'catalog.yukti.so'));

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://catalog.yukti.so/login?next=%2F');
    } finally {
      if (original === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = original;
      }
    }
  });

  it('redirects seller session on catalog.yukti.so preview to app.yukti.so', async () => {
    const original = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    try {
      getClaimsMock.mockResolvedValue({
        data: { claims: { sub: 's1', tenant_id: 'tenant-wy', user_role: 'seller_admin' } },
        error: null,
      });
      const { middleware } = await import('../../../middleware');
      const response = await middleware(catalogRequest('/workspaces', 'catalog.yukti.so'));

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://app.yukti.so/today');
    } finally {
      if (original === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = original;
      }
    }
  });
});
