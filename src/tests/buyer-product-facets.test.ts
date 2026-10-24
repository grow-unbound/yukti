import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/buyer-access', () => ({
  getVisibleBuyerCatalogs: vi.fn(),
}));
vi.mock('@/lib/server/buyer-routing', () => ({
  resolveNearestBuyerLocation: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { schema: vi.fn(() => ({ rpc: vi.fn(), from: vi.fn() })) },
}));

import { fetchBuyerBrands, fetchBuyerCategories } from '@/lib/server/buyer-product-data';

function createRpcDb(rows: unknown[]) {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
  return {
    db: { schema: vi.fn(() => ({ rpc })) } as any,
    rpc,
  };
}

describe('buyer product facet SQL pushdown', () => {
  it('shares one facet RPC when categories and brands load concurrently on the same client', async () => {
    const { db, rpc } = createRpcDb([]);
    const params = { db, tenantId: 'tenant-a', allowedTenantBrandIds: ['b2', 'b1'] };

    await Promise.all([
      fetchBuyerCategories(params),
      fetchBuyerBrands({ ...params, allowedTenantBrandIds: ['b1', 'b2'] }),
    ]);

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('passes campaign, visibility, brand, and scalar category scope to one bounded RPC', async () => {
    const { db, rpc } = createRpcDb([
      {
        facet_type: 'category',
        facet_id: 'category-a',
        facet_label: 'Cameras',
        facet_slug: 'cameras',
        image_url: null,
        image_thumb_key: 'categories/cameras/thumb.webp',
        image_medium_key: null,
        product_count: 12,
      },
    ]);

    const categories = await fetchBuyerCategories({
      db,
      tenantId: 'tenant-a',
      allowedTenantBrandIds: ['tenant-brand-a'],
      requestedCampaignId: 'campaign-a',
      brandId: 'master-brand-a',
      categoryId: 'master-category-a',
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_buyer_product_facets_scoped', {
      p_tenant_id: 'tenant-a',
      p_campaign_id: 'campaign-a',
      p_allowed_brand_ids: ['tenant-brand-a'],
      p_brand_scope_id: 'master-brand-a',
      p_category_scope_id: 'master-category-a',
      p_limit: 100,
    });
    expect(categories).toEqual([expect.objectContaining({
      id: 'category-a',
      name: 'Cameras',
      product_count: 12,
    })]);
  });

  it('maps aggregate brand rows without hydrating tenant or master brand universes', async () => {
    const { db, rpc } = createRpcDb([
      {
        facet_type: 'brand',
        facet_id: 'master-brand-a',
        facet_label: 'SecureCam',
        facet_slug: null,
        image_url: 'https://cdn.example/securecam.webp',
        image_thumb_key: null,
        image_medium_key: null,
        product_count: 8,
      },
    ]);

    const brands = await fetchBuyerBrands({ db, tenantId: 'tenant-a' });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(brands).toEqual([{
      id: 'master-brand-a',
      name: 'SecureCam',
      product_count: 8,
      logo_url: 'https://cdn.example/securecam.webp',
    }]);
  });

  it('short-circuits an explicitly empty allowed-brand scope', async () => {
    const { db, rpc } = createRpcDb([]);

    await expect(fetchBuyerCategories({
      db,
      tenantId: 'tenant-a',
      allowedTenantBrandIds: [],
    })).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
