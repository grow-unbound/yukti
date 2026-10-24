import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT = 'tenant-1';
const ESTIMATE = 'est-1';
const PRODUCT = 'prod-1';
const ALT = 'prod-2';

const rows: Record<string, unknown[]> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const fromTables: string[] = [];
let velocityResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };

class Query {
  constructor(private table: string) {}
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  async maybeSingle() { return { data: (rows[this.table] ?? [])[0] ?? null, error: null }; }
  then<T>(resolve: (v: { data: unknown[]; error: null }) => T) {
    return Promise.resolve({ data: rows[this.table] ?? [], error: null }).then(resolve);
  }
}

const db = {
  schema: () => ({
    from: (table: string) => {
      fromTables.push(table);
      return new Query(table);
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'resolve_prices_batch') {
        return { data: (args.p_tenant_product_ids as string[]).map((id) => ({ tenant_product_id: id, unit_price: 480 })), error: null };
      }
      return velocityResult;
    }),
  }),
};

// Only the pool candidate is in stock (20); the line product itself has 2 on hand.
vi.mock('@/lib/server/warehouse-inventory', () => ({
  loadInventoryAvailabilityMap: vi.fn(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === PRODUCT ? 2 : 20]))),
}));

const velocityCalls = () => rpcCalls.filter((c) => c.fn === 'get_product_velocity_90d');

describe('enquiry triage loaders', () => {
  beforeEach(async () => {
    const { resetVelocityCacheForTests } = await import('@/lib/server/load-enquiry-triage');
    resetVelocityCacheForTests();
    rpcCalls.length = 0;
    fromTables.length = 0;
    velocityResult = {
      data: [{ tenant_product_id: ALT, invoice_units_90d: 90, last_invoice_at: '2026-10-05T04:30:00.000Z' }],
      error: null,
    };
    rows.estimates = [{
      id: ESTIMATE, tenant_id: TENANT, buyer_id: 'buyer-1', location_id: 'loc-1', estimate_number: 'EST-1',
      status: 'new_enquiry', total_amount: 100, notes: null, estimate_type: 'enquiry', price_visibility: 'show_price',
    }];
    rows.estimate_items = [{
      id: 'li-1', estimate_id: ESTIMATE, tenant_product_id: PRODUCT, qty: 5, unit_price: 100, item_order: 0,
      buyer_target_unit_price_min: null, buyer_target_unit_price_max: null, buyer_note: null,
    }];
    rows.tenant_products = [{
      id: PRODUCT, internal_sku: 'SKU-1', name_override: 'Thing', master_product_id: null,
      tenant_brand_id: null, tenant_category_id: 'cat-1', base_selling_price: 120,
    }, {
      id: ALT, internal_sku: 'SKU-2', name_override: 'Other', master_product_id: null,
      tenant_brand_id: null, tenant_category_id: 'cat-1',
    }];
    rows.catalogs = [];
  });

  it('lean triage runs no velocity RPC and no price resolution, and carries the base rate', async () => {
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');
    const payload = await loadEnquiryTriage(db as never, TENANT, ESTIMATE);

    expect(rpcCalls).toEqual([]);
    expect(fromTables).not.toContain('metrics_product_snapshot');
    expect(payload?.lines[0]).toMatchObject({ baseRate: 120, resolvedPrice: null, unitPrice: 100 });
    expect(payload?.lines[0]).not.toHaveProperty('velocity');
    expect(payload?.lines[0]).not.toHaveProperty('alternates');
  });

  it('resolves the buyer price per qty only when prices are hidden and target ranges are collected', async () => {
    rows.estimates = [{ ...(rows.estimates[0] as Record<string, unknown>), estimate_type: 'without_price' }];
    rows.catalogs = [{ pricing_mode: 'hide_price_collect_enquiry', collect_target_unit_price_range: true }];
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');
    const payload = await loadEnquiryTriage(db as never, TENANT, ESTIMATE);

    expect(rpcCalls).toEqual([
      { fn: 'resolve_prices_batch', args: { p_tenant_product_ids: [PRODUCT], p_buyer_id: 'buyer-1', p_qty: 5 } },
    ]);
    expect(payload?.lines[0]?.resolvedPrice).toBe(480);

    rpcCalls.length = 0;
    rows.catalogs = [{ pricing_mode: 'hide_price_collect_enquiry', collect_target_unit_price_range: false }];
    await loadEnquiryTriage(db as never, TENANT, ESTIMATE);
    expect(rpcCalls).toEqual([]);
  });

  it('returns header adjustments, line discount and product image so the panel needs no estimate-detail fetch', async () => {
    rows.estimates = [{
      ...(rows.estimates[0] as Record<string, unknown>),
      tax_amount: 18, discount_flat: 5, freight: 7, round_off: -0.5, notes: 'Ships Friday',
    }];
    rows.estimate_items = [{ ...(rows.estimate_items[0] as Record<string, unknown>), disc_pct: 10 }];
    rows.tenant_products = [{ ...(rows.tenant_products[0] as Record<string, unknown>), image_urls: ['https://cdn.example.com/a.jpg'] }];
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');
    const payload = await loadEnquiryTriage(db as never, TENANT, ESTIMATE);

    expect(payload).toMatchObject({ taxAmount: 18, discountFlat: 5, freight: 7, roundOff: -0.5, notes: 'Ships Friday' });
    expect(payload?.lines[0]?.discPct).toBe(10);
    expect(payload?.lines[0]?.imageUrl).toEqual(expect.stringContaining('a.jpg'));
  });

  it('alternates: velocity only for in-stock pool candidates (never the line product), plus buyer prices', async () => {
    const { loadEnquiryAlternates } = await import('@/lib/server/load-enquiry-triage');
    const payload = await loadEnquiryAlternates(db as never, TENANT, ESTIMATE, 'li-1');

    expect(velocityCalls()).toEqual([
      { fn: 'get_product_velocity_90d', args: { p_tenant_id: TENANT, p_product_ids: [ALT] } },
    ]);
    expect(payload?.alternates).toHaveLength(1);
    // 90 units / 90 days = 1/day = 7 per week; 20 available / 1 per day = 20 days of cover
    expect(payload?.alternates[0]).toMatchObject({
      tenantProductId: ALT,
      buyerPrice: 480,
      velocity: { unitsPerWeek: 7, daysCover: 20, lastInvoiceAt: '2026-10-05T04:30:00.000Z' },
    });
    expect(rpcCalls.filter((c) => c.fn === 'resolve_prices_batch')).toHaveLength(1);
  });

  it('alternates degrade to "no velocity" instead of failing when the RPC errors', async () => {
    velocityResult = { data: null, error: { message: 'boom' } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { loadEnquiryAlternates } = await import('@/lib/server/load-enquiry-triage');
    const payload = await loadEnquiryAlternates(db as never, TENANT, ESTIMATE, 'li-1');

    expect(payload?.alternates[0]?.velocity).toEqual({ unitsPerWeek: 0, daysCover: null, lastInvoiceAt: null });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('alternates serve repeat views from the per-tenant cache and never share it across tenants', async () => {
    const { loadEnquiryAlternates } = await import('@/lib/server/load-enquiry-triage');
    await loadEnquiryAlternates(db as never, TENANT, ESTIMATE, 'li-1');
    await loadEnquiryAlternates(db as never, TENANT, ESTIMATE, 'li-1');
    expect(velocityCalls()).toHaveLength(1);

    await loadEnquiryAlternates(db as never, 'tenant-2', ESTIMATE, 'li-1');
    expect(velocityCalls().map((c) => c.args.p_tenant_id)).toEqual([TENANT, 'tenant-2']);
  });

  it('summaries: one batch with count, first item, total and stock-gap flag, no RPCs', async () => {
    rows.estimates = [{ id: ESTIMATE, location_id: 'loc-1', estimate_number: 'EST-1', total_amount: 100 }];
    const { loadEnquirySummaries } = await import('@/lib/server/load-enquiry-triage');
    const out = await loadEnquirySummaries(db as never, TENANT, [{ entryId: 'e1', estimateId: ESTIMATE }]);

    expect(rpcCalls).toEqual([]);
    expect(out).toEqual([{
      entryId: 'e1', estimateId: ESTIMATE, estimateNumber: 'EST-1', totalAmount: 100,
      lineCount: 1, firstLineName: 'Thing', atRisk: true, // qty 5 > 2 on hand
    }]);
  });
});
