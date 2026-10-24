import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { etagFor, jsonWithEtag } from '@/lib/server/buyer-etag';

const PRICED = { 'Cache-Control': 'private, max-age=0, must-revalidate' };

function get(ifNoneMatch?: string, method = 'GET') {
  return new NextRequest('http://localhost/api/buyer/catalog', {
    method,
    headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
  });
}

describe('jsonWithEtag', () => {
  it('returns the body with a weak ETag, the caller cache policy and a Vary on auth', async () => {
    const res = jsonWithEtag(get(), { items: [{ id: 'p1', price: 10 }] }, PRICED);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(PRICED['Cache-Control']);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Vary')).toBe('Authorization, Cookie');
    expect(res.headers.get('ETag')).toBe(etagFor(JSON.stringify({ items: [{ id: 'p1', price: 10 }] })));
    expect(await res.json()).toEqual({ items: [{ id: 'p1', price: 10 }] });
  });

  it('answers an unchanged body with an empty 304 that keeps the cache policy', async () => {
    const body = { items: [{ id: 'p1', price: 10 }] };
    const etag = jsonWithEtag(get(), body, PRICED).headers.get('ETag')!;
    const res = jsonWithEtag(get(etag), body, PRICED);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('Cache-Control')).toBe(PRICED['Cache-Control']);
    expect(res.headers.get('ETag')).toBe(etag);
  });

  it('accepts a list / weak-prefixed validator and never 304s a changed price', async () => {
    const etag = jsonWithEtag(get(), { price: 10 }, PRICED).headers.get('ETag')!;
    expect(jsonWithEtag(get(`"other", ${etag}`), { price: 10 }, PRICED).status).toBe(304);
    expect(jsonWithEtag(get(etag.replace(/^W\//, '')), { price: 10 }, PRICED).status).toBe(304);
    expect(jsonWithEtag(get(etag), { price: 11 }, PRICED).status).toBe(200);
  });

  it('only short-circuits GET', () => {
    const etag = jsonWithEtag(get(), { a: 1 }, PRICED).headers.get('ETag')!;
    expect(jsonWithEtag(get(etag, 'HEAD'), { a: 1 }, PRICED).status).toBe(200);
  });
});
