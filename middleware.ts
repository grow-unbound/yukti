import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
async function tagSentryRequestContext(tenantId: string | null, role: string | null, pathname: string) {
  if (isDev) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.setTag('tenant_id', tenantId ?? 'unknown');
  if (role) Sentry.setTag('role', role);
  Sentry.setTag('route_group', pathname.startsWith('/buy') || pathname === '/' ? 'buyer' : 'seller');
}

/**
 * Captured with a fixed fingerprint (not per-IP/slug) so Sentry groups every
 * hit into ONE recurring issue instead of a new issue per attacker IP —
 * that's what makes a frequency-based alert rule ("this issue fired > N
 * times in 5 min") actually useful instead of noise. See specs for the
 * matching Sentry Alert Rule setup steps (dashboard config, not code).
 */
async function captureRateLimitEvent(
  kind: 'enumeration' | 'browse' | 'search',
  context: { ip: string; slug: string; pathname: string; violationCount?: number },
) {
  if (isDev) return;
  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureMessage(`public-catalog-rate-limit:${kind}`, {
      level: 'warning',
      fingerprint: ['public-catalog-rate-limit', kind],
      tags: { rate_limit_kind: kind, slug: context.slug },
      extra: { ip: context.ip, pathname: context.pathname, violationCount: context.violationCount },
    });
  } catch {
    // Never let alerting itself break the request.
  }
}
import {
  TENANT_FLAGS_COOKIE,
  TENANT_FLAGS_HEADER,
  TENANT_FLAGS_TTL_SECONDS,
  createTenantFlagsToken,
  encodeTenantFlagsHeader,
  verifyTenantFlagsToken,
  type TenantCreateFlags,
} from '@/lib/server/tenant-flags-token';
import { resolveTenantFlags } from '@/lib/server/tenant-flags-resolve';
import type { Database } from '@/types/database';
import {
  WINEYARD_SLUG,
  catalogHostForRequest,
  parseRequestHost,
  sellerAppHostForRequest,
  tenantStorefrontHostForRequest,
  toCanonicalHost,
  withAuthCookieDomain,
} from '@/lib/storefront-host';
import {
  isGuestCatalogApiPath,
  isGuestIsrPagePath,
  isGuestRateLimitedPath,
  isGuestSearchApiPath,
  isGuestStorefrontPagePath,
  isStorefrontPagePath,
  toInternalBuyPath,
  toPublicStorefrontPath,
} from '@/lib/storefront-paths';
import { isNextPrefetchRequest } from '@/lib/next-prefetch';
import { classifyMiddlewareRequest, parseSampleRate } from '@/lib/middleware-cpu-sample';
import { hasSupabaseAuthCookie } from '@/lib/server/supabase-auth-cookie';
import { clientIpFromRequest, consumeEnumerationRateLimit, consumePublicCatalogRateLimit, tooManyRequestsResponse } from '@/lib/server/public-catalog-rate-limit';
import { isPublicCatalogLive, resolveStorefrontTenantBySlug, resolveTenantSlugById } from '@/lib/server/resolve-storefront-tenant';
import { recordViolationAndCheckChallenge } from '@/lib/server/ip-challenge';
import { HUMAN_VERIFIED_COOKIE, verifyHumanVerifiedToken } from '@/lib/server/human-verify-token';

// Kill switch for guest-catalog ISR (plan #4). Off by default — flipping it
// off routes ALL guest traffic back through the existing dynamic /buy/home/*
// tree instantly, no redeploy, if wrong/stale data ever surfaces in prod. The
// existing dynamic tree is never modified by this feature, so this is a safe
// instant rollback, not a partial one.
const GUEST_CATALOG_ISR_ENABLED = process.env.GUEST_CATALOG_ISR_ENABLED === '1';

const PUBLIC_PREFIXES = [
  '/api/auth',
  '/auth',
  '/login',
  '/activate',
  '/verify',
  '/verify-account',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/setup-password',
  '/_next',
  '/favicon.ico',
  '/brand',
  '/ingest',
  '/manifest.webmanifest',
  '/buyer-sw.js',
  '/api/health',
  '/api/public',
  '/api/verify-human',
  '/not-live',
  '/verify-human',
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function applyAuthCookieDomain(cookies: { name: string; value: string; options?: CookieOptions }[]) {
  return cookies.map((cookie) => ({
    ...cookie,
    options: withAuthCookieDomain(cookie.options ?? {}),
  }));
}

function stripVerifiedHeaders(requestHeaders: Headers) {
  requestHeaders.delete('x-verified-tenant-id');
  requestHeaders.delete('x-verified-role');
  requestHeaders.delete('x-verified-buyer-id');
  requestHeaders.delete('x-verified-location-ids');
  requestHeaders.delete('x-verified-user-id');
  requestHeaders.delete('x-verified-storefront-live');
  requestHeaders.delete('x-verified-tenant-slug');
}

function redirectPreservingPath(
  request: NextRequest,
  host: string,
  pathname = request.nextUrl.pathname,
  status: 301 | 307 = 301,
): NextResponse {
  const url = request.nextUrl.clone();
  // `host` may or may not already carry a port (tenantStorefrontHostForRequest /
  // sellerAppHostForRequest now include it for *.localhost; toCanonicalHost's
  // canonical host never does) — normalize both shapes here rather than
  // assuming one.
  const [hostnameOnly, portFromHost] = host.split(':');
  const isLocal = hostnameOnly === 'localhost' || hostnameOnly.endsWith('.localhost');
  const port = portFromHost || (isLocal ? request.nextUrl.port : '');
  url.protocol = isLocal ? (request.nextUrl.protocol === 'https:' ? 'https:' : 'http:') : 'https:';
  url.host = port ? `${hostnameOnly}:${port}` : hostnameOnly;
  url.pathname = pathname;
  return NextResponse.redirect(url, status);
}

function rewriteWithHeaders(request: NextRequest, requestHeaders: Headers, pathname?: string): NextResponse {
  const url = request.nextUrl.clone();
  if (pathname) url.pathname = pathname;
  const res = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  copyStorefrontHeaders(res, requestHeaders);
  return res;
}

function nextWithHeaders(request: NextRequest, requestHeaders: Headers): NextResponse {
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  copyStorefrontHeaders(res, requestHeaders);
  return res;
}

function copyStorefrontHeaders(res: NextResponse, requestHeaders: Headers) {
  const slug = requestHeaders.get('x-verified-tenant-slug');
  const live = requestHeaders.get('x-verified-storefront-live');
  const tenantId = requestHeaders.get('x-verified-tenant-id');
  const subdomain = requestHeaders.get('x-tenant-subdomain');
  if (slug) {
    res.headers.set('x-verified-tenant-slug', slug);
    res.headers.set('x-tenant-subdomain', slug);
  } else if (subdomain !== null) {
    res.headers.set('x-tenant-subdomain', subdomain);
  }
  if (live) res.headers.set('x-verified-storefront-live', live);
  if (tenantId) res.headers.set('x-verified-tenant-id', tenantId);
}

export async function middleware(request: NextRequest) {
  const sampleRate = parseSampleRate(process.env.MIDDLEWARE_CPU_SAMPLE_RATE);
  if (sampleRate === 0 || Math.random() >= sampleRate) return handleRequest(request);

  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const response = await handleRequest(request);
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({
    evt: 'mw_cpu_sample',
    cls: classifyMiddlewareRequest(request.nextUrl.pathname, request.headers),
    cpu_us: cpu.user + cpu.system,
    wall_ms: Math.round(performance.now() - wallStart),
    status: response.status,
    has_session_cookie: hasSupabaseAuthCookie(request.cookies.getAll()),
  }));
  return response;
}

async function handleRequest(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const hostname = request.headers.get('host') ?? '';
  const requestHeaders = new Headers(request.headers);
  stripVerifiedHeaders(requestHeaders);

  const hostKind = parseRequestHost(hostname);
  const canonicalHost = toCanonicalHost(hostKind);
  if (canonicalHost && canonicalHost !== hostname.split(':')[0]) {
    return redirectPreservingPath(request, canonicalHost);
  }

  const tenantLabel = hostKind.kind === 'tenant'
    ? hostKind.slug
    : hostKind.kind === 'app'
      ? 'app'
      : (hostKind.kind === 'reserved' && hostKind.label === 'catalog')
        ? 'catalog'
        : '';
  requestHeaders.set('x-tenant-subdomain', tenantLabel);

  if (pathname === '/' && request.nextUrl.searchParams.has('code')) {
    const callbackUrl = new URL('/api/auth/callback', request.url);
    callbackUrl.searchParams.set('code', request.nextUrl.searchParams.get('code')!);
    return NextResponse.redirect(callbackUrl);
  }

  if (hostKind.kind !== 'tenant' && (pathname === '/orders' || pathname.startsWith('/orders/'))) {
    const url = request.nextUrl.clone();
    url.pathname = pathname === '/orders' ? '/sales-orders' : `/sales-orders/${pathname.slice('/orders/'.length)}`;
    return NextResponse.redirect(url, 301);
  }

  if (hostKind.kind === 'app') {
    return handleAppHost(request, requestHeaders, pathname);
  }

  if (hostKind.kind === 'reserved' && hostKind.label === 'catalog') {
    return handleCatalogHost(request, requestHeaders, pathname);
  }

  if (hostKind.kind === 'tenant') {
    return handleTenantHost(request, requestHeaders, pathname, hostKind.slug);
  }

  if (isPublicRoute(pathname)) {
    return nextWithHeaders(request, requestHeaders);
  }

  return authenticateSellerOrLogin(request, requestHeaders, pathname);
}

/**
 * Host to send buyer traffic on app.useyukti.in to. Prefers the session's own
 * tenant_id; catalog.useyukti.in is the safe fallback for a buyer-role session
 * with stale/unresolvable tenant claims. WINEYARD_SLUG is only a fallback for a
 * session-less legacy /buy/* bookmark from before the subdomain cutover.
 */
async function resolveBuyerRedirectHost(claims: Claims | null, hostHeader: string): Promise<string> {
  const tenantId = claims?.tenant_id;
  if (tenantId) {
    const slug = await resolveTenantSlugById(tenantId);
    if (slug) return tenantStorefrontHostForRequest(hostHeader, slug);
    if (sessionRole(claims)?.startsWith('buyer_')) return catalogHostForRequest(hostHeader);
  }
  return tenantStorefrontHostForRequest(hostHeader, WINEYARD_SLUG);
}

async function handleAppHost(
  request: NextRequest,
  requestHeaders: Headers,
  pathname: string,
): Promise<NextResponse> {
  const isBuyPath = pathname === '/buy' || pathname.startsWith('/buy/');
  const isLoginPath = pathname === '/login';

  if (!isBuyPath && !isLoginPath && isPublicRoute(pathname)) {
    return nextWithHeaders(request, requestHeaders);
  }

  const auth = await readSession(request);
  const hostHeader = request.headers.get('host') ?? '';

  if (isBuyPath) {
    const publicPath = toPublicStorefrontPath(pathname) ?? '/';
    const destinationHost = await resolveBuyerRedirectHost(auth.claims, hostHeader);
    return redirectPreservingPath(request, destinationHost, publicPath);
  }

  if (!auth.claims) {
    if (isLoginPath) {
      return nextWithHeaders(request, requestHeaders);
    }
    return redirectToLogin(request, pathname);
  }

  const role = sessionRole(auth.claims);
  if (role?.startsWith('buyer_')) {
    const response = redirectToCatalogLogin(request, { includeReturnTo: false });
    clearSupabaseAuthCookies(response, request);
    return response;
  }

  if (pathname === '/' || isLoginPath) {
    return redirectPreservingPath(request, hostHeader, '/today', 307);
  }

  return finalizeAuthenticated(request, requestHeaders, auth, pathname, {
    rewritePath: pathname === '/catalog' ? '/catalog-control' : undefined,
  });
}

async function handleCatalogHost(
  request: NextRequest,
  requestHeaders: Headers,
  pathname: string,
): Promise<NextResponse> {
  const isCatalogEntryPath = pathname === '/' || pathname === '/login' || pathname === '/dashboard' || pathname.startsWith('/dashboard/');

  if (isPublicRoute(pathname) && !isCatalogEntryPath) {
    return nextWithHeaders(request, requestHeaders);
  }

  const auth = await readSession(request);
  const hostHeader = request.headers.get('host') ?? '';

  if (!auth.claims) {
    if (pathname === '/login') {
      return nextWithHeaders(request, requestHeaders);
    }
    return redirectToLogin(request, pathname);
  }

  const role = sessionRole(auth.claims);
  if (role?.startsWith('seller_')) {
    return redirectPreservingPath(request, sellerAppHostForRequest(hostHeader), '/today', 307);
  }

  if (isCatalogEntryPath) {
    return redirectPreservingPath(request, hostHeader, '/workspaces', 307);
  }

  return finalizeAuthenticated(request, requestHeaders, auth, pathname);
}

async function handleTenantHost(
  request: NextRequest,
  requestHeaders: Headers,
  pathname: string,
  slug: string,
): Promise<NextResponse> {
  const storefront = await resolveStorefrontTenantBySlug(slug);
  if (storefront) {
    requestHeaders.set('x-verified-tenant-id', storefront.tenantId);
    requestHeaders.set('x-verified-tenant-slug', storefront.slug);
    requestHeaders.set('x-verified-storefront-live', isPublicCatalogLive(storefront) ? '1' : '0');
    requestHeaders.set('x-tenant-subdomain', storefront.slug);
  }

  // No tenant matches this slug at all — a real 404, distinct from a real
  // tenant whose catalog just isn't live yet. Otherwise every unregistered
  // subdomain silently returns the same "not live" page, which is a free
  // oracle for scraping which slugs are real businesses vs gibberish. Rate
  // limited per-IP (not per-slug — the whole point is one IP trying many
  // different, mostly-nonexistent slugs) since this path sits before the
  // per-slug guest limiter below and would otherwise be completely uncapped.
  if (!storefront && pathname !== '/tenant-not-found' && pathname !== '/verify-human' && pathname !== '/api/verify-human') {
    const ip = clientIpFromRequest(request.headers);
    const isApiRequest = isGuestCatalogApiPath(pathname) || pathname.startsWith('/api/');
    const humanCookie = request.cookies.get(HUMAN_VERIFIED_COOKIE)?.value;
    const alreadyVerifiedHuman = humanCookie ? await verifyHumanVerifiedToken(humanCookie, ip) : false;

    if (!alreadyVerifiedHuman) {
      const enumerationLimit = await consumeEnumerationRateLimit(ip);
      if (!enumerationLimit.ok) {
        const { challengeRequired, violationCount } = await recordViolationAndCheckChallenge(ip);
        await captureRateLimitEvent('enumeration', { ip, slug, pathname, violationCount });

        // Repeated hits escalate to an interactive challenge instead of a
        // silent 429 forever — but only for page navigations; a JSON API
        // caller has no way to solve a Turnstile widget, so it keeps getting
        // rate-limited as before.
        if (challengeRequired && !isApiRequest) {
          const challengeUrl = request.nextUrl.clone();
          challengeUrl.pathname = '/verify-human';
          challengeUrl.search = '';
          challengeUrl.searchParams.set('return_to', request.nextUrl.pathname + request.nextUrl.search);
          return NextResponse.redirect(challengeUrl);
        }
        return tooManyRequestsResponse(enumerationLimit.retryAfterSec) as unknown as NextResponse;
      }
    }

    if (isApiRequest) {
      return new NextResponse(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }
    if (!isPublicRoute(pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = '/tenant-not-found';
      return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    }
  }

  if (pathname === '/buy' || pathname.startsWith('/buy/')) {
    const publicPath = toPublicStorefrontPath(pathname) ?? '/';
    const url = request.nextUrl.clone();
    url.pathname = publicPath;
    return NextResponse.redirect(url, 301);
  }

  const live = isPublicCatalogLive(storefront);
  const internalPath = toInternalBuyPath(pathname);
  const guestApi = isGuestCatalogApiPath(pathname);
  const guestPage = isGuestStorefrontPagePath(pathname);
  const storefrontPage = isStorefrontPagePath(pathname);

  const auth = await readSession(request);
  const hasSession = Boolean(auth.claims);
  const role = sessionRole(auth.claims);
  const sessionTenantId = (auth.claims?.tenant_id as string | undefined) ?? null;
  const buyerMatchesHost = Boolean(
    role?.startsWith('buyer_')
    && sessionTenantId
    && storefront
    && sessionTenantId === storefront.tenantId,
  );

  if (pathname === '/login' && buyerMatchesHost) {
    return redirectPreservingPath(request, request.headers.get('host') ?? '', '/', 307);
  }

  if (!live && !buyerMatchesHost && (guestApi || !pathname.startsWith('/api/'))) {
    if (guestApi) {
      return new NextResponse(JSON.stringify({ error: 'Catalog is not live' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }
    return redirectToCatalogLogin(request);
  }

  // Router prefetches of guest PAGES (a landing page prefetches every visible tile) are speculative,
  // not visitor actions: exempt them from the per-visitor limiter. Never exempt API paths - the
  // header is client-controllable, and the edge firewall rule is the flood backstop for those.
  const isPagePrefetch = !guestApi && guestPage && isNextPrefetchRequest(request.headers);
  if (!hasSession && isGuestRateLimitedPath(pathname) && !isPagePrefetch) {
    const kind = isGuestSearchApiPath(pathname, request.nextUrl.search) ? 'search' : 'browse';
    const limited = await consumePublicCatalogRateLimit(clientIpFromRequest(request.headers), slug, kind);
    if (!limited.ok) {
      return tooManyRequestsResponse(limited.retryAfterSec) as unknown as NextResponse;
    }
  }

  if (isPublicRoute(pathname) || (live && (guestPage || guestApi))) {
    if (buyerMatchesHost && auth.claims) {
      attachSessionHeaders(requestHeaders, auth.claims, storefront?.tenantId ?? null);
      const target = live && internalPath && internalPath !== pathname ? internalPath : undefined;
      const res = target
        ? rewriteWithHeaders(request, requestHeaders, target)
        : nextWithHeaders(request, requestHeaders);
      attachAuthCookies(res, auth);
      return res;
    }

    if (
      GUEST_CATALOG_ISR_ENABLED
      && live
      && storefront
      && guestPage
      && isGuestIsrPagePath(pathname)
      // Any query string (share_token, campaign filters, etc.) needs the
      // existing dynamic tree — reading searchParams in a Server Component
      // is itself a dynamic API, and the ISR shell doesn't handle share-token
      // flows at all. Plain guest browsing never needs query params here.
      && !request.nextUrl.search
    ) {
      // True guest (no session, or a session that doesn't match this tenant
      // host) on a page with an ISR twin. Deliberately NOT rewriting here —
      // a middleware-computed NextResponse.rewrite() defeats Next's Full
      // Route Cache/ISR for the destination (confirmed: vercel/next.js#83862
      // — Next matches the PRE-rewrite pathname against the dynamic-route
      // regex table to decide cacheability, so a middleware rewrite always
      // falls back to `private, no-store`; verified empirically against this
      // exact route with next build + next start before this comment was
      // written). Pass the ORIGINAL public pathname through unmodified and
      // let the tenant-scoped `rewrites().afterFiles` rules in
      // next.config.js do the path mapping — those are resolved natively by
      // Next's router, before dynamic-route matching, so ISR applies
      // correctly. Those config rules re-derive the tenant slug from the
      // same Host header middleware already verified — nothing else changes
      // here, so there's no separate value to compute in this branch.
      const res = nextWithHeaders(request, requestHeaders);
      attachAuthCookies(res, auth);
      return res;
    }

    const target = live && internalPath && internalPath !== pathname ? internalPath : undefined;
    const res = target
      ? rewriteWithHeaders(request, requestHeaders, target)
      : nextWithHeaders(request, requestHeaders);
    attachAuthCookies(res, auth);
    return res;
  }

  if (!hasSession) {
    return redirectToLogin(request, pathname);
  }

  if (role?.startsWith('seller_')) {
    // appHost may already carry a port (sellerAppHostForRequest includes it for
    // *.localhost) — same normalization as redirectPreservingPath.
    const appHost = sellerAppHostForRequest(request.headers.get('host') ?? '');
    const appUrl = request.nextUrl.clone();
    const [appHostnameOnly, appPortFromHost] = appHost.split(':');
    const isLocal = appHostnameOnly.endsWith('.localhost');
    const appPort = appPortFromHost || (isLocal ? request.nextUrl.port : '');
    appUrl.protocol = isLocal ? (request.nextUrl.protocol === 'https:' ? 'https:' : 'http:') : 'https:';
    appUrl.host = appPort ? `${appHostnameOnly}:${appPort}` : appHostnameOnly;
    if (pathname === '/' || storefrontPage) {
      // Seller browsing the public catalog stays; Open Catalog is the guest view.
      if (live && (storefrontPage || guestApi)) {
        const target = internalPath && internalPath !== pathname ? internalPath : undefined;
        const res = target
          ? rewriteWithHeaders(request, requestHeaders, target)
          : nextWithHeaders(request, requestHeaders);
        attachAuthCookies(res, auth);
        return res;
      }
    }
    return NextResponse.redirect(appUrl);
  }

  return finalizeAuthenticated(request, requestHeaders, auth, pathname, {
    rewritePath: internalPath && internalPath !== pathname ? internalPath : undefined,
    hostTenantId: storefront?.tenantId ?? null,
  });
}

type Claims = {
  sub?: string;
  tenant_id?: string;
  user_role?: string;
  role?: string;
  buyer_id?: string;
  location_ids?: unknown;
};

type SessionRead = {
  claims: Claims | null;
  refreshedAuthCookies: { name: string; value: string; options?: CookieOptions }[];
};

async function readSession(request: NextRequest): Promise<SessionRead> {
  const refreshedAuthCookies: SessionRead['refreshedAuthCookies'] = [];
  // No Supabase auth cookie => nothing to verify. Anonymous public-catalog visitors (the bulk of guest
  // traffic), static-ish requests and analytics beacons skip building a client + getClaims().
  if (!hasSupabaseAuthCookie(request.cookies.getAll())) {
    return { claims: null, refreshedAuthCookies };
  }
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            request.cookies.set(name, value);
            refreshedAuthCookies.push({ name, value, options });
          }
        },
      },
    },
  );

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims) {
    return { claims: null, refreshedAuthCookies };
  }
  return { claims: claimsData.claims as Claims, refreshedAuthCookies };
}

function sessionRole(claims: Claims | null): string | null {
  if (!claims) return null;
  return (claims.user_role as string) ?? (claims.role as string) ?? null;
}

function attachSessionHeaders(requestHeaders: Headers, claims: Claims, hostTenantId: string | null) {
  const tenantId = hostTenantId ?? (claims.tenant_id as string) ?? null;
  const role = sessionRole(claims);
  const buyerId = (claims.buyer_id as string) ?? null;
  const locationIds = Array.isArray(claims.location_ids)
    ? claims.location_ids.filter((value): value is string => typeof value === 'string')
    : null;
  if (tenantId) requestHeaders.set('x-verified-tenant-id', tenantId);
  if (role) requestHeaders.set('x-verified-role', role);
  if (buyerId) requestHeaders.set('x-verified-buyer-id', buyerId);
  if (locationIds) requestHeaders.set('x-verified-location-ids', JSON.stringify(locationIds));
  if (claims.sub) requestHeaders.set('x-verified-user-id', claims.sub);
}

function attachAuthCookies(res: NextResponse, auth: SessionRead) {
  for (const cookie of applyAuthCookieDomain(auth.refreshedAuthCookies)) {
    res.cookies.set(cookie.name, cookie.value, cookie.options);
  }
}

function redirectToLogin(request: NextRequest, pathname: string): NextResponse {
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname + (request.nextUrl.search || ''));
  return NextResponse.redirect(loginUrl);
}

function redirectToCatalogLogin(
  request: NextRequest,
  options: { includeReturnTo?: boolean } = {},
): NextResponse {
  const catalogHost = catalogHostForRequest(request.headers.get('host') ?? '');
  const [hostnameOnly, portFromHost] = catalogHost.split(':');
  const isLocal = hostnameOnly === 'localhost' || hostnameOnly.endsWith('.localhost');
  const protocol = isLocal ? (request.nextUrl.protocol === 'https:' ? 'https:' : 'http:') : 'https:';
  const url = new URL(`${protocol}//${portFromHost ? `${hostnameOnly}:${portFromHost}` : hostnameOnly}/login`);
  if (options.includeReturnTo !== false) {
    url.searchParams.set('return_to', request.url);
  }
  return NextResponse.redirect(url);
}

function isChunkLikeCookieName(cookieName: string, key: string): boolean {
  return cookieName === key || cookieName.startsWith(`${key}.`);
}

function supabaseAuthStorageKey(): string | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return null;
  try {
    const hostname = new URL(supabaseUrl).hostname;
    const projectRef = hostname.split('.')[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
}

function clearSupabaseAuthCookies(response: NextResponse, request: NextRequest) {
  const storageKey = supabaseAuthStorageKey();
  const storageKeys = storageKey
    ? [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]
    : [];
  const cookieNames = new Set<string>();

  for (const cookie of request.cookies.getAll()) {
    if (
      storageKeys.some((key) => isChunkLikeCookieName(cookie.name, key))
      || /^sb-[a-z0-9-]+-auth-token(?:[.][0-9]+)?$/i.test(cookie.name)
    ) {
      cookieNames.add(cookie.name);
    }
  }

  for (const key of storageKeys) {
    cookieNames.add(key);
  }

  for (const name of cookieNames) {
    response.cookies.set(name, '', withAuthCookieDomain({
      path: '/',
      sameSite: 'lax' as const,
      maxAge: 0,
    }));
  }
}

async function authenticateSellerOrLogin(
  request: NextRequest,
  requestHeaders: Headers,
  pathname: string,
): Promise<NextResponse> {
  if (isPublicRoute(pathname)) {
    return nextWithHeaders(request, requestHeaders);
  }
  const auth = await readSession(request);
  if (!auth.claims) return redirectToLogin(request, pathname);
  const role = sessionRole(auth.claims);
  return finalizeAuthenticated(request, requestHeaders, auth, pathname, {
    rewritePath: role?.startsWith('seller_') && pathname === '/catalog' ? '/catalog-control' : undefined,
  });
}

async function finalizeAuthenticated(
  request: NextRequest,
  requestHeaders: Headers,
  auth: SessionRead,
  pathname: string,
  opts?: { rewritePath?: string; hostTenantId?: string | null },
): Promise<NextResponse> {
  const claims = auth.claims!;
  const tenantId = opts?.hostTenantId ?? ((claims.tenant_id as string) ?? null);
  const role = sessionRole(claims);
  const buyerId = (claims.buyer_id as string) ?? null;
  const locationIds = Array.isArray(claims.location_ids)
    ? claims.location_ids.filter((value): value is string => typeof value === 'string')
    : null;

  await tagSentryRequestContext(tenantId, role, pathname);
  attachSessionHeaders(requestHeaders, claims, opts?.hostTenantId ?? null);

  const buyerPreviewCookie = request.cookies.get('buyer_preview')?.value;
  if (buyerPreviewCookie) {
    requestHeaders.set('x-buyer-preview', buyerPreviewCookie);
  }

  let freshTenantFlags: { flags: Record<string, boolean>; createFlags: TenantCreateFlags } | null = null;
  if (tenantId && role?.startsWith('seller_')) {
    const flagsCookie = request.cookies.get(TENANT_FLAGS_COOKIE)?.value;
    const verified = flagsCookie ? await verifyTenantFlagsToken(flagsCookie, tenantId) : null;
    let flagsData: { flags: Record<string, boolean>; createFlags: TenantCreateFlags } | null = verified;
    if (!flagsData) {
      try {
        freshTenantFlags = await resolveTenantFlags(tenantId);
        flagsData = freshTenantFlags;
      } catch {
        // leave header unset
      }
    }
    if (flagsData) {
      requestHeaders.set(TENANT_FLAGS_HEADER, encodeTenantFlagsHeader(flagsData));
    }
  }

  const isBuyerSafeZone =
    pathname.startsWith('/buy')
    || isStorefrontPagePath(pathname)
    || pathname.startsWith('/workspaces')
    || pathname.startsWith('/consent')
    || pathname.startsWith('/onboarding')
    || pathname.startsWith('/pending')
    || pathname.startsWith('/api')
    || pathname.startsWith('/auth')
    || isPublicRoute(pathname);
  if (!isBuyerSafeZone && role?.startsWith('buyer_')) {
    const home = new URL('/', request.url);
    return NextResponse.redirect(home);
  }

  const finalized = opts?.rewritePath
    ? rewriteWithHeaders(request, requestHeaders, opts.rewritePath)
    : nextWithHeaders(request, requestHeaders);
  attachAuthCookies(finalized, auth);
  if (freshTenantFlags && tenantId) {
    const token = await createTenantFlagsToken(tenantId, freshTenantFlags);
    finalized.cookies.set(TENANT_FLAGS_COOKIE, token, withAuthCookieDomain({
      httpOnly: true,
      path: '/',
      maxAge: TENANT_FLAGS_TTL_SECONDS,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
    }));
  }
  return finalized;
}

export const config = {
  runtime: 'nodejs',
  // Static matcher (Next requires a literal). Skipped: framework assets, the PostHog proxy (/ingest),
  // and files with a static extension that are NOT under /api. The extension exclusion must be anchored
  // at the END of the path; the previous `\\.svg` form only matched paths STARTING with ".svg", so
  // /brand/*.svg and /logo.png still ran the whole middleware. API paths never skip: skipping would also
  // skip stripVerifiedHeaders, letting a client forge x-verified-* headers.
  // /manifest.webmanifest is deliberately NOT excluded (tenant-branded, needs x-tenant-subdomain).
  matcher: [
    '/((?!_next/static|_next/image|_next/webpack-hmr|favicon\\.ico|robots\\.txt|sitemap\\.xml|ingest(?:/|$)|(?!api/).*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?|ttf|otf)$).*)',
  ],
};
