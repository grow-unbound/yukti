import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheCalls: Array<{ keyParts: string[]; options: { revalidate?: number; tags?: string[] } }> = [];
const revalidateTagMock = vi.fn();
const assembleMock = vi.fn(async () => new Map());
const getVisibleBuyerCatalogsMock = vi.fn();
const getBuyerCatalogContextMock = vi.fn();

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown, keyParts: string[], options: { revalidate?: number; tags?: string[] }) => {
    cacheCalls.push({ keyParts, options });
    return fn;
  },
  revalidateTag: (...a: unknown[]) => revalidateTagMock(...a),
}));
vi.mock('@/lib/supabase', () => ({ supabaseAdmin: null }));
vi.mock('@/lib/server/public-catalog', () => ({
  loadLivePublicCatalog: vi.fn(async () => null),
  getCachedGuestPricingContext: vi.fn(async () => null),
}));
vi.mock('@/lib/server/buyer-assemble-catalog-items', () => ({
  assembleBuyerCatalogItemsForProductIds: (...a: unknown[]) => assembleMock(...(a as [])),
}));
vi.mock('@/lib/server/buyer-brand-visibility', () => ({ resolveBuyerAllowedTenantBrandIds: vi.fn(async () => null) }));
vi.mock('@/lib/server/buyer-access', () => ({
  getVisibleBuyerCatalogs: (...a: unknown[]) => getVisibleBuyerCatalogsMock(...a),
}));
vi.mock('@/lib/server/buyer-catalog-context', () => ({
  getBuyerCatalogContext: (...a: unknown[]) => getBuyerCatalogContextMock(...a),
}));

function emptyDb() {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'in']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return c;
  };
  return {
    schema: () => ({
      from: chain,
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  } as never;
}

describe('home rails cache', () => {
  beforeEach(() => {
    cacheCalls.length = 0;
    revalidateTagMock.mockReset();
  });

  it('caches per tenant + buyer for 5 minutes with buyer-home, buyer, tenant and public-catalog tags', async () => {
    const { loadBuyerHomeReco } = await import('@/lib/server/buyer-home-reco');
    await loadBuyerHomeReco(emptyDb(), 't1', 'b1');
    const call = cacheCalls.find((c) => c.keyParts[0] === 'buyer-home-reco');
    expect(call?.keyParts).toEqual(['buyer-home-reco', 't1', 'b1']);
    expect(call?.options.revalidate).toBe(300);
    expect(call?.options.tags).toEqual(['buyer-home:t1:b1', 'buyer-ctx:t1:b1', 'buyer-ctx:t1', 'public-catalog:t1']);
  });

  it('revalidateBuyerHome drops exactly that buyer\'s home tag', async () => {
    const { revalidateBuyerHome } = await import('@/lib/server/buyer-context-cache');
    revalidateBuyerHome('t1', 'b1');
    expect(revalidateTagMock).toHaveBeenCalledWith('buyer-home:t1:b1');
  });
});

describe('home promotions', () => {
  it('takes product counts from the cached catalog context instead of querying campaign_items', async () => {
    getVisibleBuyerCatalogsMock.mockResolvedValue([
      { id: 'c1', name: 'Sale', share_token: 'tok', valid_to: null, hero_image_url: null },
      { id: 'c2', name: 'Other', share_token: 'tok2', valid_to: null, hero_image_url: 'h.png' },
    ]);
    getBuyerCatalogContextMock.mockResolvedValue({ itemCountByCampaignId: { c1: 12 } });
    const { loadBuyerHomePromotions } = await import('@/lib/server/buyer-home-promotions');
    const out = await loadBuyerHomePromotions({ schema: () => { throw new Error('no db reads expected'); } } as never, 't1', 'b1');
    expect(out.latest_promotions_preview.map((p) => [p.id, p.product_count])).toEqual([['c1', 12], ['c2', 0]]);
  });
});
