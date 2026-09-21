import { describe, expect, it } from 'vitest';
import { classifyMiddlewareRequest, parseSampleRate } from '@/lib/middleware-cpu-sample';

const h = (init: Record<string, string> = {}) => new Headers(init);

describe('parseSampleRate', () => {
  it('defaults to off and clamps to [0,1]', () => {
    expect(parseSampleRate(undefined)).toBe(0);
    expect(parseSampleRate('')).toBe(0);
    expect(parseSampleRate('abc')).toBe(0);
    expect(parseSampleRate('-1')).toBe(0);
    expect(parseSampleRate('0.05')).toBe(0.05);
    expect(parseSampleRate('7')).toBe(1);
  });
});

describe('classifyMiddlewareRequest', () => {
  it('buckets paths into coarse classes without exposing ids', () => {
    expect(classifyMiddlewareRequest('/ingest/i/v0/e/', h())).toBe('ingest');
    expect(classifyMiddlewareRequest('/manifest.webmanifest', h())).toBe('manifest');
    expect(classifyMiddlewareRequest('/api/public/g/catalog', h())).toBe('guest_api');
    expect(classifyMiddlewareRequest('/api/buyer/catalog', h())).toBe('guest_api');
    expect(classifyMiddlewareRequest('/api/tenant/invoices', h())).toBe('api');
    expect(classifyMiddlewareRequest('/product/abc', h({ 'next-router-prefetch': '1' }))).toBe('page_prefetch');
    expect(classifyMiddlewareRequest('/product/abc', h())).toBe('page');
    expect(classifyMiddlewareRequest('/_next/data/x.json', h())).toBe('other');
  });
});
