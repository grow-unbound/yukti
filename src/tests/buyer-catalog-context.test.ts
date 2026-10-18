import { beforeEach, describe, expect, it, vi } from 'vitest';

const revalidateTagMock = vi.fn();

vi.mock('@/lib/supabase', () => ({ supabaseAdmin: null }));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
}));

import {
  allowedTenantBrandIdsFrom,
  hasUnmatchedCohortCampaign,
  parseBuyerCatalogContext,
  visibleCampaignsFrom,
} from '@/lib/server/buyer-catalog-context';
import {
  buyerContextBuyerTag,
  buyerContextTenantTag,
  withBuyerContextRevalidation,
} from '@/lib/server/buyer-context-cache';

const campaign = (over: Record<string, unknown>) => ({
  id: 'c1',
  tenant_id: 't1',
  name: 'Sale',
  share_token: 'tok',
  valid_to: null,
  message: null,
  created_at: '2026-10-01T00:00:00.000Z',
  scope_type: 'all',
  scope_value: null,
  hero_image_url: null,
  item_count: 4,
  ...over,
});

const raw = (over: Record<string, unknown> = {}) => ({
  buyer: { default_cohort_id: 'co-default', geography: { state: 'KA' }, explicit_cohort_ids: ['co-1'] },
  campaigns: [],
  cohorts: [],
  public_catalog: null,
  ...over,
});

describe('parseBuyerCatalogContext', () => {
  it('splits item counts off the campaigns and maps the public catalog', () => {
    const ctx = parseBuyerCatalogContext(
      raw({
        campaigns: [campaign({ id: 'a', item_count: '7' })],
        public_catalog: {
          id: 'cat', tenant_id: 't1', include_all: true, pricing_mode: 'base_selling_rate', price_list_id: null,
          access_mode: 'public_link', collect_target_unit_price_range: false, product_display_mode: null,
          live_at: '2026-09-01T00:00:00Z',
        },
      }),
    );
    expect(ctx.itemCountByCampaignId).toEqual({ a: 7 });
    expect(ctx.campaigns[0]).not.toHaveProperty('item_count');
    expect(ctx.publicCatalog).toMatchObject({ id: 'cat', tenantId: 't1', productDisplayMode: 'sku_list', accessMode: 'public_link' });
    expect(ctx.buyer).toEqual({ defaultCohortId: 'co-default', geography: { state: 'KA' }, explicitCohortIds: ['co-1'] });
  });

  it('accepts explicit JSON nulls inside buyer geography (prod buyers store {"city": null})', () => {
    const ctx = parseBuyerCatalogContext(
      raw({
        buyer: {
          default_cohort_id: null,
          geography: { city: null, state: 'Telangana', zone: null, pincode: null },
          explicit_cohort_ids: [],
        },
      }),
    );
    expect(ctx.buyer?.geography).toMatchObject({ state: 'Telangana', city: undefined, zone: undefined });
  });

  it('allows a missing buyer and rejects malformed payloads', () => {
    expect(parseBuyerCatalogContext(raw({ buyer: null })).buyer).toBeNull();
    expect(() => parseBuyerCatalogContext({ campaigns: 'x' })).toThrow();
  });
});

describe('visibleCampaignsFrom / hasUnmatchedCohortCampaign', () => {
  const now = new Date('2026-10-11T10:00:00+05:30');

  it('keeps all-scope, matching cohort/buyer/geography, drops others and ended', () => {
    const ctx = parseBuyerCatalogContext(
      raw({
        campaigns: [
          campaign({ id: 'all' }),
          campaign({ id: 'cohort-yes', scope_type: 'cohort', scope_value: { cohort_id: 'co-1' } }),
          campaign({ id: 'cohort-default', scope_type: 'cohort', scope_value: { cohort_id: 'co-default' } }),
          campaign({ id: 'cohort-no', scope_type: 'cohort', scope_value: { cohort_id: 'co-x' } }),
          campaign({ id: 'buyer-me', scope_type: 'buyer', scope_value: { buyer_id: 'b1' } }),
          campaign({ id: 'buyer-other', scope_type: 'buyer', scope_value: { buyer_ids: ['b2'] } }),
          campaign({ id: 'geo-yes', scope_type: 'geography', scope_value: { geography: { state: 'KA' } } }),
          campaign({ id: 'geo-no', scope_type: 'geography', scope_value: { geography: { state: 'TN' } } }),
          campaign({ id: 'ended', valid_to: '2026-10-09T00:00:00.000Z' }),
          campaign({ id: 'ends-today-ist', valid_to: '2026-10-11T00:00:00.000Z' }),
        ],
      }),
    );
    expect(visibleCampaignsFrom(ctx, 'b1', now).map((c) => c.id)).toEqual([
      'all', 'cohort-yes', 'cohort-default', 'buyer-me', 'geo-yes', 'ends-today-ist',
    ]);
    expect(hasUnmatchedCohortCampaign(ctx, now)).toBe(true);
  });

  it('reports no unmatched cohort campaign when the buyer is in every targeted cohort', () => {
    const ctx = parseBuyerCatalogContext(
      raw({ campaigns: [campaign({ scope_type: 'cohort', scope_value: { cohort_id: 'co-1' } })] }),
    );
    expect(hasUnmatchedCohortCampaign(ctx, new Date('2026-10-11T10:00:00+05:30'))).toBe(false);
  });
});

describe('allowedTenantBrandIdsFrom', () => {
  it('is unrestricted (null) without cohorts, without rows, or with any open allow-list', () => {
    expect(allowedTenantBrandIdsFrom(parseBuyerCatalogContext(raw({ buyer: null })))).toBeNull();
    expect(
      allowedTenantBrandIdsFrom(parseBuyerCatalogContext(raw({ buyer: { default_cohort_id: null, geography: null, explicit_cohort_ids: [] } }))),
    ).toBeNull();
    expect(allowedTenantBrandIdsFrom(parseBuyerCatalogContext(raw({ cohorts: [] })))).toBeNull();
    expect(
      allowedTenantBrandIdsFrom(parseBuyerCatalogContext(raw({
        cohorts: [{ id: 'a', allowed_tenant_brand_ids: ['x'] }, { id: 'b', allowed_tenant_brand_ids: null }],
      }))),
    ).toBeNull();
  });

  it('returns the de-duplicated union of restricted allow-lists', () => {
    const ctx = parseBuyerCatalogContext(raw({
      cohorts: [{ id: 'a', allowed_tenant_brand_ids: ['x', 'y'] }, { id: 'b', allowed_tenant_brand_ids: ['y', 'z'] }],
    }));
    expect(allowedTenantBrandIdsFrom(ctx)?.sort()).toEqual(['x', 'y', 'z']);
  });
});

describe('cache tags and revalidation wrapper', () => {
  beforeEach(() => {
    revalidateTagMock.mockReset();
  });

  it('tags always carry the tenant (and buyer) id', () => {
    expect(buyerContextTenantTag('t1')).toBe('buyer-ctx:t1');
    expect(buyerContextBuyerTag('t1', 'b1')).toBe('buyer-ctx:t1:b1');
  });

  it('revalidates the tenant tag after a successful mutation', async () => {
    const handler = withBuyerContextRevalidation(async (_req: Request) => new Response('{}', { status: 200 }));
    await handler(new Request('http://x', { headers: { 'x-verified-tenant-id': 't1' } }));
    expect(revalidateTagMock).toHaveBeenCalledWith('buyer-ctx:t1');
  });

  it('does not revalidate on error responses or without a tenant', async () => {
    const bad = withBuyerContextRevalidation(async (_req: Request) => new Response('{}', { status: 400 }));
    await bad(new Request('http://x', { headers: { 'x-verified-tenant-id': 't1' } }));
    const ok = withBuyerContextRevalidation(async (_req: Request) => new Response('{}', { status: 200 }));
    await ok(new Request('http://x'));
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it('never fails the mutation when revalidateTag throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    revalidateTagMock.mockImplementation(() => { throw new Error('boom'); });
    const handler = withBuyerContextRevalidation(async (_req: Request) => new Response('{}', { status: 200 }));
    const res = await handler(new Request('http://x', { headers: { 'x-verified-tenant-id': 't1' } }));
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
