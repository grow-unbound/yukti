'use client';

import { supabaseBrowser } from '@/lib/supabase-browser';
import { clearClientAuthSnapshot, getClientAccessToken, setClientAuthSnapshot } from '@/lib/auth-client-store';
import { appendWarehouseParam, toGuestPublicUrl } from '@/lib/guest-public-api';
import { readGuestDeliveryWarehouseId } from '@/lib/buyer-delivery-warehouse';

type CachedAuth = {
  token: string;
  expiresAtMs: number;
};

let authCache: CachedAuth | null = null;

export function clearApiAuthCache(): void {
  authCache = null;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const now = Date.now();
  if (authCache && now < authCache.expiresAtMs) {
    return { Authorization: `Bearer ${authCache.token}` };
  }

  const cachedToken = getClientAccessToken();
  if (cachedToken) {
    authCache = {
      token: cachedToken,
      expiresAtMs: now + 25_000,
    };
    return { Authorization: `Bearer ${cachedToken}` };
  }

  const { data: { session } } = await supabaseBrowser.auth.getSession();
  if (!session?.access_token) {
    authCache = null;
    clearClientAuthSnapshot();
    return {};
  }

  const expiresAtMs = (session.expires_at ? session.expires_at * 1000 : now + 30_000) - 5_000;
  authCache = {
    token: session.access_token,
    expiresAtMs,
  };
  setClientAuthSnapshot({ accessToken: session.access_token });

  return { Authorization: `Bearer ${session.access_token}` };
}

export type ApiFetchInit = RequestInit & {
  /**
   * Always revalidate with the server (`cache: 'no-cache'`) — use for auth-gated views that must reflect the
   * latest status. Unlike `no-store` this keeps the validator, so routes that send an ETag answer an unchanged
   * page with an empty 304 instead of the full body (matters on 3G/4G).
   */
  fresh?: boolean;
};

// A 429 from the storefront limiter carries an accurate Retry-After (seconds left in the window).
// For a few seconds, waiting and retrying once turns a scary error into a brief pause; anything longer
// is surfaced to the caller (their error state has a retry button).
const RATE_LIMIT_MAX_AUTO_WAIT_SECONDS = 8;
const RATE_LIMIT_DEFAULT_WAIT_SECONDS = 2;

export function parseRetryAfterSeconds(header: string | null): number {
  if (!header) return RATE_LIMIT_DEFAULT_WAIT_SECONDS;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : RATE_LIMIT_DEFAULT_WAIT_SECONDS;
}

export async function fetchWithRateLimitRetry(
  target: string,
  init: RequestInit,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  const response = await fetch(target, init);
  const isGet = (init.method ?? 'GET').toUpperCase() === 'GET';
  if (response.status !== 429 || !isGet) return response;

  const waitSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
  if (waitSeconds > RATE_LIMIT_MAX_AUTO_WAIT_SECONDS) return response;
  await sleep(waitSeconds * 1000 + Math.floor(Math.random() * 400));
  if (init.signal?.aborted) return response;
  return fetch(target, init);
}

export async function apiFetch(url: string, init?: ApiFetchInit): Promise<Response> {
  const { fresh, ...requestInit } = init ?? {};
  const authHeaders = await getAuthHeaders();
  const isGet = (requestInit.method ?? 'GET').toUpperCase() === 'GET';

  // Anonymous storefront visitors (no session) read the catalog through the guest-only, CDN-cacheable
  // twin of the /api/buyer/* GETs, INCLUDING `fresh` calls: for a guest the CDN TTL (30-120 s) is the
  // staleness bound and `no-store` would only push every browse to the origin. The visitor's delivery
  // warehouse travels as ?wh= (part of the cache key) because a cacheable route cannot read cookies.
  // Credentialed calls, non-GETs and tokenized/campaign queries keep the private per-buyer route.
  const guestTwin = !authHeaders.Authorization && isGet ? toGuestPublicUrl(url) : null;
  const target = guestTwin ? appendWarehouseParam(guestTwin, readGuestDeliveryWarehouseId()) : url;

  return fetchWithRateLimitRetry(target, {
    ...requestInit,
    cache: guestTwin ? requestInit.cache : fresh ? 'no-cache' : requestInit.cache,
    headers: {
      ...authHeaders,
      ...requestInit.headers,
    },
  });
}

export async function apiPost<T>(url: string, body: T, init?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetch(url, {
    method: 'POST',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function apiPatch<T>(url: string, body: T, init?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetch(url, {
    method: 'PATCH',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function apiDelete(url: string, init?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetch(url, {
    method: 'DELETE',
    ...init,
    headers: {
      ...authHeaders,
      ...init?.headers,
    },
  });
}
