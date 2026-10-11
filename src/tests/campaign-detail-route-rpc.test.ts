import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const CAMPAIGN_ID = '2b589a49-58b8-4068-b219-721d3850cc3d';
const TENANT_ID = 'd601c35c-1a78-4506-a556-a82118d72893';

const inCalls: Array<{ table: string; column: string; size: number }> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

const rpcPayloads: Record<string, { data: unknown; error: { message: string } | null }> = {};

const tableRows: Record<string, unknown> = {};

class Query {
  constructor(private table: string) {}
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  order() { return this; }
  limit() { return this; }
  in(column: string, values: unknown) {
    inCalls.push({ table: this.table, column, size: Array.isArray(values) ? values.length : 0 });
    return this;
  }
  private rows() { return tableRows[this.table] ?? []; }
  async maybeSingle() { return { data: Array.isArray(this.rows()) ? (this.rows() as unknown[])[0] ?? null : this.rows(), error: null }; }
  async single() { return { data: (this.rows() as unknown[])[0] ?? null, error: null }; }
  then<T>(resolve: (value: { data: unknown; error: null }) => T) {
    return Promise.resolve({ data: this.rows(), error: null }).then(resolve);
  }
}

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: vi.fn(async () => ({ tenant_id: TENANT_ID, role: 'seller_admin', sub: 'user-1' })),
}));

vi.mock('@/lib/posthog-server', () => ({ getPostHogClient: vi.fn(() => null) }));
vi.mock('@/lib/server/dashboard-cache', () => ({ revalidateSellerDashboardCache: vi.fn() }));
vi.mock('@/lib/server/public-catalog-cache', () => ({ revalidatePublicCatalogCache: vi.fn() }));
vi.mock('@/lib/server/seller-features', () => ({
  getInAppCreateFlags: vi.fn(async () => ({ create_sales_orders: true, create_enquiries: true })),
}));
vi.mock('@/lib/server/catalog-composer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCatalogComposerPayload: vi.fn(async () => ({ products: [] })),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: (schemaName: string) => {
      if (schemaName !== 'app') throw new Error(`Unexpected schema: ${schemaName}`);
      return {
        from: (table: string) => new Query(table),
        rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return rpcPayloads[fn] ?? { data: [], error: null };
        }),
      };
    },
  },
}));

function request() {
  return new NextRequest(`http://localhost/api/tenant/catalogs/${CAMPAIGN_ID}`);
}

describe('GET /api/tenant/catalogs/[id] — server-side audience and line items', () => {
  beforeEach(() => {
    inCalls.length = 0;
    rpcCalls.length = 0;
    for (const key of Object.keys(rpcPayloads)) delete rpcPayloads[key];

    tableRows.campaigns = [{
      id: CAMPAIGN_ID,
      tenant_id: TENANT_ID,
      name: 'Super September Sale',
      scope_type: 'cohort',
      scope_value: { cohort_id: 'cohort-1' },
      valid_from: '2026-09-11T03:04:05.837Z',
      valid_to: '2026-10-31T18:29:59.000Z',
      status: 'published',
      share_token: 'tok',
      message: null,
      hero_image_url: null,
      created_by: null,
      created_at: '2026-09-11T03:06:14.000Z',
      buyer_target_mode: 'customer_group',
      buyer_filter_rules: null,
      product_membership_mode: 'automatic',
      dynamic_rules: null,
      pricing_source: 'pricelist',
      price_list_id: 'pl-error',
      pricing_strategy: 'edit_each',
      strategy_value: null,
    }];
    tableRows.campaign_items = [{
      id: 'ci-1', tenant_product_id: 'prod-1', price_override: 650, display_order: 0,
      created_at: '2026-09-11T03:06:14.000Z', valid_from: '2026-09-11T03:06:14.000Z', deleted_at: null,
    }];
    tableRows.orders = [];
    tableRows.estimates = [
      { id: 'est-1', buyer_id: 'buyer-1', total_amount: 650, status: 'sent', converted_to_order_id: null, estimate_date: '2026-10-09', created_at: '2026-10-09T09:38:06.799Z' },
      { id: 'est-void', buyer_id: 'buyer-2', total_amount: 100, status: 'void', converted_to_order_id: null, estimate_date: '2026-10-09', created_at: '2026-10-09T10:00:00.000Z' },
    ];
    tableRows.metrics_campaign_period_summary = [];

    rpcPayloads.filter_campaign_views_by_audience_at_view_time = { data: [], error: null };
    rpcPayloads.get_campaign_audience_buyers = {
      data: {
        member_count: 519,
        selected_cohort_id: 'cohort-1',
        selected_cohort_name: 'All Dealers Technicians 24092026',
        truncated: false,
        buyers: [
          { id: 'buyer-1', business_name: 'EYE VISION', geography: { city: 'Hyderabad' }, tier: null },
          { id: 'buyer-2', business_name: 'APR TECHNOLOGIES', geography: { city: 'Hyderabad' }, tier: null },
        ],
      },
      error: null,
    };
    rpcPayloads.get_campaign_attributed_line_items = {
      data: {
        truncated: false,
        orders: [],
        estimates: [
          { parent_id: 'est-1', tenant_product_id: 'prod-1', qty: 1, line_total: 650, unit_price: 650 },
          // belongs to a void estimate: must not be attributed
          { parent_id: 'est-void', tenant_product_id: 'prod-1', qty: 1, line_total: 100, unit_price: 100 },
        ],
      },
      error: null,
    };
  });

  it('loads audience and line items through the RPCs and sends no id lists in request URLs', async () => {
    const { GET } = await import('../../app/api/tenant/catalogs/[id]/route');
    const res = await GET(request(), { params: Promise.resolve({ id: CAMPAIGN_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(rpcCalls.map((c) => c.fn)).toEqual(expect.arrayContaining([
      'get_campaign_audience_buyers',
      'get_campaign_attributed_line_items',
    ]));
    expect(rpcCalls.find((c) => c.fn === 'get_campaign_attributed_line_items')?.args).toEqual({
      p_tenant_id: TENANT_ID,
      p_campaign_id: CAMPAIGN_ID,
    });
    // regression: 459 products / 562 estimates / 519 buyers as GET .in() filters returned HTTP 400
    expect(inCalls.filter((c) => c.size > 50)).toEqual([]);

    expect(body.header.selected_cohort).toMatchObject({
      id: 'cohort-1',
      name: 'All Dealers Technicians 24092026',
      member_count: 519,
    });
    expect(body.meta_strip_4.target_buyer_count).toBe(519);
    expect(body.buyers[0]).toMatchObject({ buyer_id: 'buyer-1', buyer_name: 'EYE VISION', spend: 650, orders: 1 });
    expect(body.buyers.find((b: { buyer_id: string }) => b.buyer_id === 'buyer-2')).toMatchObject({ spend: 0, orders: 0 });
  });

  it('fails loudly instead of under-counting when the line-item RPC reports truncation', async () => {
    rpcPayloads.get_campaign_attributed_line_items = {
      data: { truncated: true, orders: [], estimates: [] },
      error: null,
    };
    const { GET } = await import('../../app/api/tenant/catalogs/[id]/route');
    const res = await GET(request(), { params: Promise.resolve({ id: CAMPAIGN_ID }) });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/too many line items/i);
  });

  it('returns a clear error when the audience RPC fails', async () => {
    rpcPayloads.get_campaign_audience_buyers = { data: null, error: { message: 'boom' } };
    const { GET } = await import('../../app/api/tenant/catalogs/[id]/route');
    const res = await GET(request(), { params: Promise.resolve({ id: CAMPAIGN_ID }) });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to load buyers');
  });
});
