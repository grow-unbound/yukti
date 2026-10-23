import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, getTokenMock } = vi.hoisted(() => ({ getSessionMock: vi.fn(), getTokenMock: vi.fn() }));

vi.mock('@/lib/supabase-browser', () => ({ supabaseBrowser: { auth: { getSession: getSessionMock } } }));
vi.mock('@/lib/auth-client-store', () => ({
  getClientAccessToken: () => getTokenMock(),
  clearClientAuthSnapshot: vi.fn(),
  setClientAuthSnapshot: vi.fn(),
}));
const { readWarehouseMock } = vi.hoisted(() => ({ readWarehouseMock: vi.fn() }));
vi.mock('@/lib/buyer-delivery-warehouse', () => ({ readGuestDeliveryWarehouseId: () => readWarehouseMock() }));

import { apiFetch, clearApiAuthCache, fetchWithRateLimitRetry, parseRetryAfterSeconds } from '@/lib/api-fetch';

const WH = '4f1c2b7e-9d3a-4c11-8a55-0b6f3a9e1d20';
const ok = () => new Response('{}', { status: 200 });
const limited = (retryAfter?: string) =>
  new Response('{}', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });

describe('apiFetch guest twin routing', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    clearApiAuthCache();
    getTokenMock.mockReturnValue(null);
    getSessionMock.mockResolvedValue({ data: { session: null } });
    readWarehouseMock.mockReturnValue(null);
  });

  it('sends anonymous catalog GETs to the cacheable twin EVEN when fresh (CDN TTL bounds staleness), without no-store', async () => {
    await apiFetch('/api/buyer/catalog?limit=40', { fresh: true });
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe('/api/public/g/catalog?limit=40');
    expect(init.cache).toBeUndefined();
  });

  it('adds the visitor delivery warehouse to the twin URL (part of the cache key)', async () => {
    readWarehouseMock.mockReturnValue(WH);
    await apiFetch('/api/buyer/products/p1', { fresh: true });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/public/g/products/p1?wh=${WH}`);
  });

  it('keeps authenticated calls on the private route, revalidating (no-cache, ETag-friendly) for fresh', async () => {
    getTokenMock.mockReturnValue('jwt-token');
    await apiFetch('/api/buyer/catalog?limit=40', { fresh: true });
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe('/api/buyer/catalog?limit=40');
    expect(init.cache).toBe('no-cache');
    expect(init.headers.Authorization).toBe('Bearer jwt-token');
  });

  it('never rewrites tokenized/campaign queries', async () => {
    await apiFetch('/api/buyer/catalog?share_token=abc');
    await apiFetch('/api/buyer/catalog?limit=40&campaign_id=c1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/buyer/catalog?share_token=abc');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/buyer/catalog?limit=40&campaign_id=c1');
  });
});

describe('graceful 429 handling', () => {
  it('parses Retry-After with a safe default', () => {
    expect(parseRetryAfterSeconds('5')).toBe(5);
    expect(parseRetryAfterSeconds('2.2')).toBe(3);
    expect(parseRetryAfterSeconds(null)).toBe(2);
    expect(parseRetryAfterSeconds('soon')).toBe(2);
    expect(parseRetryAfterSeconds('0')).toBe(2);
  });

  it('waits the server-provided delay then retries a GET once', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited('3')).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const res = await fetchWithRateLimitRetry('/x', { method: 'GET' }, sleep);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(3000);
    expect(sleep.mock.calls[0][0]).toBeLessThan(3500);
  });

  it('gives up after ONE retry (no loops)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(limited('1'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRateLimitRetry('/x', {}, vi.fn().mockResolvedValue(undefined));
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not wait out a long limit: surfaces it so the UI can show its error state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(limited('45'));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn();
    const res = await fetchWithRateLimitRetry('/x', {}, sleep);
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never retries non-GET requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(limited('1'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRateLimitRetry('/x', { method: 'POST' }, vi.fn());
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
