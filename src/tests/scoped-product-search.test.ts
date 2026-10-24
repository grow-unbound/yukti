import { describe, expect, it, vi } from 'vitest';

import { BUYER_SCOPED_PRODUCT_COLUMNS, searchScopedProducts } from '@/lib/server/scoped-product-search';

describe('searchScopedProducts', () => {
  it('treats an explicitly empty allowed-brand scope as deny-all', async () => {
    const rpc = vi.fn();
    const result = await searchScopedProducts({
      db: { schema: () => ({ rpc }) } as any,
      tenantId: 'tenant-a',
      query: 'cable',
      limit: 20,
      allowedBrandIds: [],
    });

    expect(result).toEqual({ rows: [], total: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('pushes campaign membership into the scoped product RPC with no embedding param', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await searchScopedProducts({
      db: { schema: () => ({ rpc }) } as any,
      tenantId: 'tenant-a',
      campaignId: 'campaign-a',
      query: 'camera',
      limit: 20,
      offset: 40,
    });

    expect(rpc).toHaveBeenCalledWith('search_products_scoped', expect.objectContaining({
      p_tenant_id: 'tenant-a',
      p_campaign_id: 'campaign-a',
      p_offset: 40,
    }));
    const [, calledArgs] = rpc.mock.calls[0];
    expect(calledArgs).not.toHaveProperty('p_query_embedding');
  });

  it('keeps buyer category scope scalar at the shared SQL seam', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await searchScopedProducts({
      db: { schema: () => ({ rpc }) } as any,
      tenantId: 'tenant-a',
      categoryScopeId: 'master-category-a',
      query: 'cable',
      limit: 20,
    });

    expect(rpc).toHaveBeenCalledWith('search_products_scoped', expect.objectContaining({
      p_category_scope_id: 'master-category-a',
      p_category_ids: null,
      p_ids: null,
    }));
  });

  it('recovers a stable total for an empty later page with one bounded probe', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ total_count: 73 }], error: null });

    const result = await searchScopedProducts({
      db: { schema: () => ({ rpc }) } as any,
      tenantId: 'tenant-a',
      query: 'cable',
      limit: 20,
      offset: 80,
    });

    expect(result).toEqual({ rows: [], total: 73 });
    expect(rpc).toHaveBeenNthCalledWith(2, 'search_products_scoped', expect.objectContaining({
      p_limit: 1,
      p_offset: 0,
    }));
  });
});

describe('searchScopedProducts column filter', () => {
  it('asks PostgREST for only the given columns, and everything when none are given', async () => {
    const select = vi.fn().mockResolvedValue({ data: [], error: null });
    const rpc = vi.fn(() => Object.assign(Promise.resolve({ data: [], error: null }), { select }));
    const db = { schema: () => ({ rpc }) } as any;

    await searchScopedProducts({ db, tenantId: 'tenant-a', limit: 20, columns: BUYER_SCOPED_PRODUCT_COLUMNS });
    expect(select).toHaveBeenCalledWith(BUYER_SCOPED_PRODUCT_COLUMNS.join(','));

    select.mockClear();
    await searchScopedProducts({ db, tenantId: 'tenant-a', limit: 20 });
    expect(select).not.toHaveBeenCalled();
  });

  it('buyer column list never ships seller-only columns and keeps everything the buyer mapping reads', () => {
    const cols: readonly string[] = BUYER_SCOPED_PRODUCT_COLUMNS;
    expect(cols).not.toContain('cost_price');
    for (const needed of [
      'tenant_product_id', 'product_name', 'sku', 'brand_id', 'brand_name', 'category_id', 'category_name',
      'tax_pct', 'on_hand', 'unit_price', 'mrp', 'base_selling_price', 'default_uom', 'pack_size', 'total_count',
      'image_urls', 'r2_small_key', 'r2_medium_key', 'r2_large_key', 'brand_logo_url',
      'category_image_thumb_key', 'category_image_medium_key',
      'family_image_urls', 'family_r2_small_key', 'family_r2_medium_key', 'family_r2_large_key',
    ]) {
      expect(cols).toContain(needed);
    }
  });
});
