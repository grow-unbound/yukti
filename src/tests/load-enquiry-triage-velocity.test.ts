import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT = 'tenant-1';
const ESTIMATE = 'est-1';
const PRODUCT = 'prod-1';

const rows: Record<string, unknown[]> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const fromTables: string[] = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };

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
      return rpcResult;
    }),
  }),
};

vi.mock('@/lib/server/warehouse-inventory', () => ({
  loadInventoryAvailabilityMap: vi.fn(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, 20]))),
}));

describe('loadEnquiryTriage velocity', () => {
  beforeEach(async () => {
    const { resetVelocityCacheForTests } = await import('@/lib/server/load-enquiry-triage');
    resetVelocityCacheForTests();
    rpcCalls.length = 0;
    fromTables.length = 0;
    rpcResult = {
      data: [{ tenant_product_id: PRODUCT, invoice_units_90d: 90, last_invoice_at: '2026-10-05T04:30:00.000Z' }],
      error: null,
    };
    rows.estimates = [{
      id: ESTIMATE, tenant_id: TENANT, buyer_id: 'buyer-1', location_id: 'loc-1', estimate_number: 'EST-1',
      status: 'new_enquiry', total_amount: 100, notes: null, estimate_type: 'enquiry', price_visibility: 'show_price',
    }];
    rows.estimate_items = [{
      id: 'li-1', tenant_product_id: PRODUCT, qty: 5, unit_price: 100, item_order: 0,
      buyer_target_unit_price_min: null, buyer_target_unit_price_max: null, buyer_note: null,
    }];
    rows.tenant_products = [{
      id: PRODUCT, internal_sku: 'SKU-1', name_override: 'Thing', master_product_id: null,
      tenant_brand_id: null, tenant_category_id: null,
    }];
  });

  it('derives units/week, days of cover and last invoice from get_product_velocity_90d, never the dropped snapshot', async () => {
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');
    const payload = await loadEnquiryTriage(db as never, TENANT, ESTIMATE);

    expect(rpcCalls.filter((c) => c.fn === 'get_product_velocity_90d')).toEqual([
      { fn: 'get_product_velocity_90d', args: { p_tenant_id: TENANT, p_product_ids: [PRODUCT] } },
    ]);
    expect(fromTables).not.toContain('metrics_product_snapshot');

    const line = payload?.lines[0];
    // 90 units / 90 days = 1/day = 7 per week; 20 available / 1 per day = 20 days of cover
    expect(line?.velocity).toEqual({
      unitsPerWeek: 7,
      daysCover: 20,
      lastInvoiceAt: '2026-10-05T04:30:00.000Z',
    });
  });

  it('degrades to "no velocity" instead of failing when the RPC errors', async () => {
    rpcResult = { data: null, error: { message: 'boom' } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');

    const payload = await loadEnquiryTriage(db as never, TENANT, ESTIMATE);

    expect(payload?.lines[0]?.velocity).toEqual({ unitsPerWeek: 0, daysCover: null, lastInvoiceAt: null });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('serves repeat triage views from the per-tenant cache instead of re-running the RPC', async () => {
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');
    await loadEnquiryTriage(db as never, TENANT, ESTIMATE);
    const second = await loadEnquiryTriage(db as never, TENANT, ESTIMATE);

    expect(rpcCalls.filter((c) => c.fn === 'get_product_velocity_90d')).toHaveLength(1);
    expect(second?.lines[0]?.velocity).toEqual({
      unitsPerWeek: 7,
      daysCover: 20,
      lastInvoiceAt: '2026-10-05T04:30:00.000Z',
    });
  });

  it('does not share cached velocity across tenants', async () => {
    const { loadEnquiryTriage } = await import('@/lib/server/load-enquiry-triage');
    await loadEnquiryTriage(db as never, TENANT, ESTIMATE);
    rows.estimates = [{ ...(rows.estimates[0] as Record<string, unknown>), tenant_id: 'tenant-2' }];
    await loadEnquiryTriage(db as never, 'tenant-2', ESTIMATE);

    expect(rpcCalls.filter((c) => c.fn === 'get_product_velocity_90d').map((c) => c.args.p_tenant_id))
      .toEqual([TENANT, 'tenant-2']);
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
});
