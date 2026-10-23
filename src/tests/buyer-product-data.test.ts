import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@/lib/server/buyer-access', () => ({
  getVisibleBuyerCatalogs: vi.fn(),
}));

vi.mock('@/lib/server/buyer-brand-visibility', () => ({
  resolveBuyerAllowedTenantBrandIds: vi.fn(),
}));

vi.mock('@/lib/server/buyer-location-selection', () => ({
  getSelectedBuyerDeliveryFromRequest: vi.fn(),
}));

vi.mock('@/lib/server/buyer-routing', () => ({
  resolveNearestBuyerLocation: vi.fn(),
}));

vi.mock('@/lib/server/scoped-product-search', () => ({
  BUYER_SCOPED_PRODUCT_COLUMNS: ['tenant_product_id', 'total_count'],
  searchScopedProducts: vi.fn(),
}));

vi.mock('@/lib/server/public-catalog', () => ({
  TENANT_PRODUCT_PUBLIC_SELECT: 'id, internal_sku, name_override',
  getCachedGuestPricingContext: vi.fn(),
  resolveGuestPricingContext: vi.fn(),
  loadLivePublicCatalog: vi.fn(),
  loadAssignedPriceListPrices: vi.fn(async () => new Map()),
  guestUnitPrice: vi.fn(() => null),
}));

vi.mock('@/lib/r2-url', () => ({
  r2Url: vi.fn(() => null),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { schema: vi.fn(() => ({ rpc: vi.fn(), from: vi.fn() })) },
}));

import { enrichBuyerProducts, resolveBuyerProductScopeContext } from '@/lib/server/buyer-product-data';
import { resolveBuyerAllowedTenantBrandIds } from '@/lib/server/buyer-brand-visibility';
import { loadLivePublicCatalog, resolveGuestPricingContext } from '@/lib/server/public-catalog';
import { searchScopedProducts } from '@/lib/server/scoped-product-search';

describe('buyer product enrichment', () => {
  it('returns nothing for a product id search_products_scoped/load_products_scoped did not resolve', async () => {
    // is_active/deleted_at filtering now happens inside the RPC's own SQL
    // (search_products_scoped / load_products_scoped), not a separate JS
    // query — an id the RPC doesn't return (inactive, deleted, wrong tenant)
    // simply isn't in `rows`, and enrichBuyerProducts must not fabricate one.
    vi.mocked(searchScopedProducts).mockResolvedValue({ rows: [], total: 0 });

    const settingsMaybeSingle = vi.fn(async () => ({ data: null }));
    const settingsEq = vi.fn(() => ({ maybeSingle: settingsMaybeSingle }));
    const settingsSelect = vi.fn(() => ({ eq: settingsEq }));
    const from = vi.fn((table: string) =>
      table === 'tenant_settings' ? { select: settingsSelect } : { select: vi.fn() },
    );
    const schema = vi.fn(() => ({ from }));
    const db = { schema } as any;

    const result = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['product-1'],
    });

    expect(result.size).toBe(0);
    expect(searchScopedProducts).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', ids: ['product-1'] }),
    );
  });

  it('enriches from pre-fetched scopedRows without calling searchScopedProducts again', async () => {
    vi.mocked(searchScopedProducts).mockClear();

    const settingsMaybeSingle = vi.fn(async () => ({ data: null }));
    const settingsEq = vi.fn(() => ({ maybeSingle: settingsMaybeSingle }));
    const settingsSelect = vi.fn(() => ({ eq: settingsEq }));
    const from = vi.fn((table: string) =>
      table === 'tenant_settings' ? { select: settingsSelect } : { select: vi.fn() },
    );
    const rpc = vi.fn(async () => ({ data: [{ tenant_product_id: 'product-1', unit_price: 100 }], error: null }));
    const schema = vi.fn(() => ({ from, rpc }));
    const db = { schema } as any;

    const result = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['product-1'],
      scopedRows: [{
        tenant_product_id: 'product-1',
        product_name: 'Widget',
        sku: 'W-1',
        brand_id: null,
        brand_name: 'Brand',
        category_id: null,
        category_name: '',
        hsn_code: null,
        tax_pct: 18,
        on_hand: 0,
        reorder_point: 0,
        unit_price: 100,
        mrp: 120,
        base_selling_price: 100,
        cost_price: null,
        default_uom: null,
        pack_size: null,
        created_at: new Date().toISOString(),
        search_rank: 0,
        total_count: 1,
        image_urls: [],
        r2_small_key: null,
        r2_medium_key: null,
        r2_large_key: null,
        brand_logo_url: null,
        category_image_thumb_key: null,
        category_image_medium_key: null,
      }],
    });

    expect(result.size).toBe(1);
    expect(result.get('product-1')?.display_name).toBe('Widget');
    expect(result.get('product-1')?.price).toBe(100);
    expect(searchScopedProducts).not.toHaveBeenCalled();
  });
});

const scopedRow = (id: string, unitPrice: number, base = 100) => ({
  tenant_product_id: id,
  product_name: `Widget ${id}`,
  sku: id,
  brand_id: null,
  brand_name: 'Brand',
  category_id: null,
  category_name: '',
  hsn_code: null,
  tax_pct: 18,
  on_hand: 0,
  reorder_point: 0,
  unit_price: unitPrice,
  mrp: 120,
  base_selling_price: base,
  cost_price: null,
  default_uom: null,
  pack_size: null,
  created_at: new Date().toISOString(),
  search_rank: 0,
  total_count: 1,
  image_urls: [],
  r2_small_key: null,
  r2_medium_key: null,
  r2_large_key: null,
  brand_logo_url: null,
  category_image_thumb_key: null,
  category_image_medium_key: null,
});

function pricingDb(batchPrices: Record<string, number> = {}) {
  const settingsMaybeSingle = vi.fn(async () => ({ data: null }));
  const settingsEq = vi.fn(() => ({ maybeSingle: settingsMaybeSingle }));
  const settingsSelect = vi.fn(() => ({ eq: settingsEq }));
  const from = vi.fn((table: string) =>
    table === 'tenant_settings' ? { select: settingsSelect } : { select: vi.fn() },
  );
  const rpc = vi.fn(async (_fn: string, args: { p_tenant_product_ids: string[]; p_qty: number }) => ({
    data: args.p_tenant_product_ids.map((id) => ({ tenant_product_id: id, unit_price: batchPrices[id] ?? 999 })),
    error: null,
  }));
  return { db: { schema: vi.fn(() => ({ from, rpc })) } as any, rpc };
}

describe('buyer product enrichment — price once', () => {
  it('uses the scoped RPC price for qty-1 lines and skips resolve_prices_batch', async () => {
    const { db, rpc } = pricingDb();
    const result = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['p1', 'p2'],
      scopedRows: [scopedRow('p1', 80), scopedRow('p2', 0, 100)],
      scopedRowsPricedForBuyer: true,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(result.get('p1')?.price).toBe(80);
    expect(result.get('p2')?.price).toBe(0); // SQL falls back to 0, same as the batch path did
  });

  it('still calls resolve_prices_batch for quantity-tiered lines only', async () => {
    const { db, rpc } = pricingDb({ p2: 70 });
    const result = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['p1', 'p2'],
      qtyByProductId: new Map([['p2', 10]]),
      scopedRows: [scopedRow('p1', 80), scopedRow('p2', 95)],
      scopedRowsPricedForBuyer: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_tenant_product_ids: ['p2'], p_qty: 10, p_buyer_id: 'buyer-1' });
    expect(result.get('p1')?.price).toBe(80);
    expect(result.get('p2')?.price).toBe(70);
  });

  it('keeps the batch call when the rows were not priced for this buyer', async () => {
    const { db, rpc } = pricingDb({ p1: 60 });
    const result = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['p1'],
      scopedRows: [scopedRow('p1', 100)],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.get('p1')?.price).toBe(60);
  });

  it('fetches its own rows WITH the buyer id and then skips the batch call', async () => {
    vi.mocked(searchScopedProducts).mockResolvedValue({ rows: [scopedRow('p1', 55)], total: 1 });
    const { db, rpc } = pricingDb();
    const result = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['p1'],
    });
    expect(searchScopedProducts).toHaveBeenLastCalledWith(expect.objectContaining({ buyerId: 'buyer-1', ids: ['p1'] }));
    expect(rpc).not.toHaveBeenCalled();
    expect(result.get('p1')?.price).toBe(55);
  });

  it('never trusts the scoped price for a guest/no-buyer call and applies the campaign override on top', async () => {
    const { db, rpc } = pricingDb();
    const guest = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: null,
      tenantProductIds: ['p1'],
      scopedRows: [scopedRow('p1', 55, 100)],
      scopedRowsPricedForBuyer: true,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(guest.get('p1')?.price).toBe(100); // base price, not the (buyer-less) row unit_price

    const withCampaign = await enrichBuyerProducts(db, {
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      tenantProductIds: ['p1'],
      scopedRows: [scopedRow('p1', 80)],
      scopedRowsPricedForBuyer: true,
      campaignByProductId: new Map([['p1', {
        campaign_id: 'c1', campaign_name: 'Sale', campaign_valid_until: null, campaign_price: 60,
      }]]),
    });
    expect(withCampaign.get('p1')?.price).toBe(60);
    expect(withCampaign.get('p1')?.resolved_price).toBe(80);
  });
});

describe('buyer product scope context', () => {
  it('downgrades pending buyer sessions to public guest catalog scope', async () => {
    const publicCatalog = {
      id: 'catalog-1',
      tenantId: 'tenant-1',
      includeAll: true,
      pricingMode: 'base_selling_rate' as const,
      priceListId: null,
      accessMode: 'public_link' as const,
      collectTargetUnitPriceRange: false,
      productDisplayMode: 'sku_list' as const,
      liveAt: '2026-09-25T00:00:00.000Z',
    };
    const guestPricing = {
      mode: 'base_selling_rate' as const,
      priceListId: null,
      excludedProductIds: [],
    };

    vi.mocked(loadLivePublicCatalog).mockResolvedValue(publicCatalog);
    vi.mocked(resolveGuestPricingContext).mockResolvedValue(guestPricing);
    vi.mocked(resolveBuyerAllowedTenantBrandIds).mockResolvedValue(['brand-private']);

    const context = await resolveBuyerProductScopeContext({} as any, {
      headers: new Headers(),
      cookies: { get: () => undefined },
    } as any, {
      context: {
        tenant_id: 'tenant-1',
        buyer_id: 'buyer-pending',
        role: 'buyer_pending',
        mode: 'buyer',
      },
      buyer: {
        id: 'buyer-pending',
        tenant_id: 'tenant-1',
        business_name: 'Pending Buyer',
        contact_name: null,
        credit_limit: null,
        phone: '9999999999',
        gstin: null,
        buyer_app_enabled: false,
      },
      tenant: null,
      greeting_name: null,
    });

    expect(context.buyerId).toBeNull();
    expect(context.allowedTenantBrandIds).toBeNull();
    expect(context.guestPricing).toEqual(guestPricing);
    expect(context.publicCatalog).toEqual(publicCatalog);
    expect(resolveBuyerAllowedTenantBrandIds).not.toHaveBeenCalled();
  });

  it('does not expose public catalog context to pending buyers for approved-only catalogs', async () => {
    vi.mocked(loadLivePublicCatalog).mockResolvedValue({
      id: 'catalog-1',
      tenantId: 'tenant-1',
      includeAll: true,
      pricingMode: 'base_selling_rate',
      priceListId: null,
      accessMode: 'approved_buyers_only',
      collectTargetUnitPriceRange: false,
      productDisplayMode: 'sku_list',
      liveAt: '2026-09-25T00:00:00.000Z',
    });
    vi.mocked(resolveGuestPricingContext).mockClear();

    const context = await resolveBuyerProductScopeContext({} as any, {
      headers: new Headers(),
      cookies: { get: () => undefined },
    } as any, {
      context: {
        tenant_id: 'tenant-1',
        buyer_id: 'buyer-pending',
        role: 'buyer_pending',
        mode: 'buyer',
      },
      buyer: {
        id: 'buyer-pending',
        tenant_id: 'tenant-1',
        business_name: 'Pending Buyer',
        contact_name: null,
        credit_limit: null,
        phone: '9999999999',
        gstin: null,
        buyer_app_enabled: false,
      },
      tenant: null,
      greeting_name: null,
    });

    expect(context.buyerId).toBeNull();
    expect(context.guestPricing).toBeNull();
    expect(context.publicCatalog).toBeNull();
    expect(resolveGuestPricingContext).not.toHaveBeenCalled();
  });
});
