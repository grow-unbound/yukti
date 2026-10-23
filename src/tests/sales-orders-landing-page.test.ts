import { beforeEach, describe, expect, it, vi } from 'vitest';

const getVerifiedClaimsMock = vi.fn();
const getAuthUserDisplayNameMapMock = vi.fn();
const ordersCallState = { count: 0 };
const ordersKpiCallState = { count: 0 };

interface QueryState {
  buyers: Array<{ id: string; business_name: string; geography: Record<string, unknown> | null }>;
  monthOrders: Array<{
    id: string;
    location_id: string | null;
    order_number: string;
    buyer_id: string;
    status: string;
    source: string | null;
    campaign_id: string | null;
    estimate_id: string | null;
    placed_by: string | null;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    order_date: string | null;
    placed_at: string;
    created_at: string;
  }>;
  prevOrders?: Array<{ id: string; total_amount: number }>;
  orderItems: Array<{ order_id: string }>;
  catalogs: Array<{ id: string; name: string }>;
  estimates: Array<{ id: string; estimate_number: string | null }>;
  currentKpis: Array<Record<string, unknown>>;
  previousKpis: Array<Record<string, unknown>>;
}

const queryState: QueryState = {
  buyers: [],
  monthOrders: [],
  orderItems: [],
  catalogs: [],
  estimates: [],
  currentKpis: [],
  previousKpis: [],
};

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/lib/server/seller-features', () => ({
  getInAppCreateFlags: vi.fn().mockResolvedValue({ create_sales_orders: true }),
}));

vi.mock('@/lib/server/auth-user-directory', () => ({
  getAuthUserDisplayNameMap: (...args: unknown[]) => getAuthUserDisplayNameMapMock(...args),
}));

vi.mock('@/lib/server/seller-location-access', () => ({
  applySellerLocationScope: <T extends { in?: (column: string, values: string[]) => T }>(
    query: T,
    claims: { location_ids?: string[] | null; role?: string | null },
  ) => {
    if (claims.role === 'seller_assistant' && claims.location_ids?.length && query.in) {
      return query.in('location_id', claims.location_ids);
    }
    return query;
  },
  getSellerLocationScope: vi.fn(),
  isSellerLocationSelectionAllowed: vi.fn(() => true),
  loadAccessibleSellerLocations: vi.fn(async (_db: unknown, _tenantId: string, claims: { location_ids?: string[] | null }) => {
    const all = [
      { id: 'loc-1', name: 'North Hub' },
      { id: 'loc-2', name: 'South Hub' },
    ];
    return claims.location_ids?.length ? all.filter((row) => claims.location_ids?.includes(row.id)) : all;
  }),
  resolveDefaultSellerLocationId: vi.fn(() => 'loc-1'),
}));

vi.mock('@/lib/supabase', () => {
  class QueryMock {
    private table: string;
    private conditions: Array<{ kind: 'eq' | 'in'; column: string; value: unknown }> = [];
    private head = false;
    private limitValue: number | null = null;

    constructor(table: string) {
      this.table = table;
    }

    select(_columns?: string, options?: { head?: boolean }) {
      this.head = options?.head === true;
      return this;
    }
    eq(column: string, value: unknown) {
      this.conditions.push({ kind: 'eq', column, value });
      return this;
    }
    is() {
      return this;
    }
    gte() {
      return this;
    }
    lt() {
      return this;
    }
    order() {
      return this;
    }
    or() {
      return this;
    }
    ilike() {
      return this;
    }
    limit() {
      this.limitValue = arguments[0] as number;
      return this;
    }
    in() {
      this.conditions.push({ kind: 'in', column: arguments[0] as string, value: arguments[1] });
      return this;
    }

    then(resolve: (value: { data: unknown; error: null; count?: number }) => void) {
      const applyFilters = (rows: Array<Record<string, unknown>>) => {
        let result = [...rows];
        for (const condition of this.conditions) {
          if (condition.kind === 'eq') {
            result = result.filter((row) => !(condition.column in row) || row[condition.column] === condition.value);
            continue;
          }
          const values = Array.isArray(condition.value) ? condition.value : [];
          result = result.filter((row) => values.includes(row[condition.column]));
        }
        return result;
      };

      if (this.table === 'buyers') return resolve({ data: queryState.buyers, error: null });
      if (this.table === 'orders_month') {
        const rows = applyFilters(queryState.monthOrders as Array<Record<string, unknown>>);
        const limitedRows = this.limitValue != null ? rows.slice(0, this.limitValue) : rows;
        return resolve({ data: this.head ? null : limitedRows, error: null, count: rows.length });
      }
      if (this.table === 'order_items') return resolve({ data: applyFilters(queryState.orderItems as Array<Record<string, unknown>>), error: null });
      if (this.table === 'campaigns') return resolve({ data: queryState.catalogs, error: null });
      if (this.table === 'estimates') return resolve({ data: queryState.estimates, error: null });
      if (this.table === 'kpi_orders_current') return resolve({ data: applyFilters(queryState.currentKpis), error: null });
      if (this.table === 'kpi_orders_previous') return resolve({ data: applyFilters(queryState.previousKpis), error: null });
      return resolve({ data: [], error: null });
    }
  }

  const from = vi.fn((table: string) => {
    if (table === 'buyers') return new QueryMock('buyers');
    if (table === 'order_items') return new QueryMock('order_items');
    if (table === 'campaigns') return new QueryMock('campaigns');
    if (table === 'estimates') return new QueryMock('estimates');
    if (table === 'kpi_orders_daily') {
      ordersKpiCallState.count += 1;
      return new QueryMock(ordersKpiCallState.count === 1 ? 'kpi_orders_current' : 'kpi_orders_previous');
    }
    if (table === 'orders') {
      ordersCallState.count += 1;
      return new QueryMock('orders_month');
    }
    return new QueryMock('unknown');
  });
  const sum = (rows: Array<Record<string, unknown>>, key: string) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const scopedRows = (rows: Array<Record<string, unknown>>, args?: { p_location_ids?: string[] | null }) => {
    const locationIds = args?.p_location_ids ?? null;
    return locationIds?.length
      ? rows.filter((row) => row.scope === 'location' && locationIds.includes(String(row.location_id)))
      : rows.filter((row) => row.scope === 'tenant');
  };
  const rpc = vi.fn(async (name: string, args?: { p_location_ids?: string[] | null }) => {
    if (name !== 'metrics_v2_transaction_landing') return { data: null, error: null };
    const current = scopedRows(queryState.currentKpis, args);
    const previous = scopedRows(queryState.previousKpis, args);
    const orders = sum(current, 'orders_count');
    const previousOrders = sum(previous, 'orders_count');
    const gmv = sum(current, 'gmv');
    return {
      data: {
        kpis: {
          orders_mtd: orders,
          orders_prev_mtd: previousOrders,
          orders_growth_pct: previousOrders > 0 ? Math.round(((orders - previousOrders) / previousOrders) * 100) : 0,
          gmv_mtd: gmv,
          gmv_prev_mtd: sum(previous, 'gmv'),
          aov: orders > 0 ? gmv / orders : 0,
          pending_dispatch_count: sum(current, 'confirmed_count'),
          received_count: sum(current, 'received_count'),
          delivered_count: sum(current, 'delivered_count'),
          buyers_mtd: sum(current, 'buyers_count'),
        },
      },
      error: null,
    };
  });

  return {
    supabaseAdmin: {
      schema: vi.fn(() => ({ from, rpc })),
    },
  };
});

import { NextRequest } from 'next/server';
import { GET } from '../../app/api/tenant/orders/route';

describe('sales orders landing API route', () => {
  beforeEach(() => {
    getVerifiedClaimsMock.mockReset();
    getAuthUserDisplayNameMapMock.mockReset();
    ordersCallState.count = 0;
    ordersKpiCallState.count = 0;
    getAuthUserDisplayNameMapMock.mockResolvedValue(new Map([
      ['seller-1', 'Priya Shah'],
      ['buyer-user-1', 'Asha Singh'],
      ['seller-2', 'Ravi Nair'],
    ]));

    queryState.buyers = [
      { id: 'buyer-1', business_name: 'Buyer One', geography: { city: 'Bengaluru' } },
      { id: 'buyer-2', business_name: 'Buyer Two', geography: { city: 'Mysuru' } },
      { id: 'buyer-3', business_name: 'Buyer Three', geography: { city: 'Hubli' } },
    ];

    queryState.monthOrders = [
      { id: 'o1', location_id: 'loc-1', order_number: 'DF-1', buyer_id: 'buyer-1', status: 'confirmed', source: 'cockpit_manual', campaign_id: 'cat-1', estimate_id: 'est-1', placed_by: 'seller-1', subtotal: 8475, tax_amount: 1525, total_amount: 10000, order_date: '2026-05-18', placed_at: '2026-05-20T00:00:00.000Z', created_at: '2026-05-20T00:00:00.000Z' },
      { id: 'o2', location_id: 'loc-2', order_number: 'DF-2', buyer_id: 'buyer-2', status: 'received', source: 'buyer_app', campaign_id: 'cat-2', estimate_id: null, placed_by: 'buyer-user-1', subtotal: 25424, tax_amount: 4576, total_amount: 30000, order_date: '2026-05-21', placed_at: '2026-05-21T00:00:00.000Z', created_at: '2026-05-21T00:00:00.000Z' },
      { id: 'o3', location_id: 'loc-1', order_number: 'DF-3', buyer_id: 'buyer-3', status: 'dispatched', source: 'csv_import', campaign_id: null, estimate_id: null, placed_by: 'seller-2', subtotal: 42373, tax_amount: 7627, total_amount: 50000, order_date: '2026-05-22', placed_at: '2026-05-22T00:00:00.000Z', created_at: '2026-05-22T00:00:00.000Z' },
      { id: 'o4', location_id: null, order_number: 'DF-4', buyer_id: 'buyer-1', status: 'cancelled', source: 'cockpit_manual', campaign_id: null, estimate_id: null, placed_by: 'seller-1', subtotal: 16949, tax_amount: 3051, total_amount: 20000, order_date: '2026-05-23', placed_at: '2026-05-23T00:00:00.000Z', created_at: '2026-05-23T00:00:00.000Z' },
      { id: 'o5', location_id: 'loc-2', order_number: 'DF-5', buyer_id: 'buyer-2', status: 'partially_dispatched', source: 'buyer_app', campaign_id: 'cat-2', estimate_id: null, placed_by: 'buyer-user-1', subtotal: 12712, tax_amount: 2288, total_amount: 15000, order_date: '2026-05-24', placed_at: '2026-05-24T00:00:00.000Z', created_at: '2026-05-24T00:00:00.000Z' },
      { id: 'o6', location_id: 'loc-1', order_number: 'DF-6', buyer_id: 'buyer-3', status: 'invoiced', source: 'csv_import', campaign_id: null, estimate_id: null, placed_by: 'seller-2', subtotal: 6780, tax_amount: 1220, total_amount: 8000, order_date: '2026-05-25', placed_at: '2026-05-25T00:00:00.000Z', created_at: '2026-05-25T00:00:00.000Z' },
      { id: 'o7', location_id: 'loc-1', order_number: 'DF-7', buyer_id: 'buyer-1', status: 'partially_invoiced', source: 'cockpit_manual', campaign_id: 'cat-1', estimate_id: null, placed_by: 'seller-1', subtotal: 7627, tax_amount: 1373, total_amount: 9000, order_date: '2026-05-26', placed_at: '2026-05-26T00:00:00.000Z', created_at: '2026-05-26T00:00:00.000Z' },
    ];

    queryState.prevOrders = [
      { id: 'p1', total_amount: 20000 },
      { id: 'p2', total_amount: 20000 },
    ];

    queryState.orderItems = [
      { order_id: 'o1' },
      { order_id: 'o2' },
      { order_id: 'o2' },
      { order_id: 'o3' },
      { order_id: 'o4' },
      { order_id: 'o5' },
      { order_id: 'o6' },
      { order_id: 'o7' },
    ];

    queryState.catalogs = [
      { id: 'cat-1', name: 'Summer Sell-in' },
      { id: 'cat-2', name: 'Monsoon Promo' },
    ];

    queryState.estimates = [
      { id: 'est-1', estimate_number: 'EST-2042' },
    ];
    queryState.currentKpis = [
      {
        scope: 'tenant',
        location_id: null,
        orders_count: 7,
        buyers_count: 3,
        gmv: 142000,
        confirmed_count: 1,
        received_count: 1,
        delivered_count: 0,
      },
      {
        scope: 'location',
        location_id: 'loc-1',
        orders_count: 4,
        buyers_count: 2,
        gmv: 77000,
        confirmed_count: 1,
        received_count: 0,
        delivered_count: 0,
      },
      {
        scope: 'location',
        location_id: 'loc-2',
        orders_count: 2,
        buyers_count: 1,
        gmv: 45000,
        confirmed_count: 0,
        received_count: 1,
        delivered_count: 0,
      },
    ];
    queryState.previousKpis = [
      {
        scope: 'tenant',
        location_id: null,
        orders_count: 2,
        buyers_count: 2,
        gmv: 40000,
        confirmed_count: 0,
        received_count: 0,
        delivered_count: 0,
      },
      {
        scope: 'location',
        location_id: 'loc-1',
        orders_count: 1,
        buyers_count: 1,
        gmv: 20000,
        confirmed_count: 0,
        received_count: 0,
        delivered_count: 0,
      },
      {
        scope: 'location',
        location_id: 'loc-2',
        orders_count: 1,
        buyers_count: 1,
        gmv: 20000,
        confirmed_count: 0,
        received_count: 0,
        delivered_count: 0,
      },
    ];
  });

  it('aggregates MTD numbers, maps received to Received neutral, and caps callouts', async () => {
    getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-a', role: 'seller_admin' });

    const res = await GET(new NextRequest('http://localhost/api/tenant/orders'));
    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.kpis).toBeUndefined();
    expect(body.todays_read).toBeUndefined();

    const receivedRow = body.orders.find((r: { order_id: string }) => r.order_id === 'DF-2');
    expect(receivedRow.status.label).toBe('Received');
    expect(receivedRow.status.tone).toBe('neutral');
    expect(receivedRow.status.filter_chip).toBe('Received');

    const invoicedRow = body.orders.find((r: { order_id: string }) => r.order_id === 'DF-6');
    expect(invoicedRow.status.label).toBe('Invoiced');
    expect(invoicedRow.status.tone).toBe('success');
    expect(invoicedRow.status.filter_chip).toBe('Invoiced');

    const partialInv = body.orders.find((r: { order_id: string }) => r.order_id === 'DF-7');
    expect(partialInv.status.label).toBe('Invoiced');
    expect(partialInv.status.tone).toBe('success');
    expect(partialInv.status.filter_chip).toBe('Invoiced');

    const convertedRow = body.orders.find((r: { order_id: string }) => r.order_id === 'DF-1');
    expect(convertedRow.buyer_name).toBe('Buyer One');
    expect(convertedRow.buyer_initials).toBe('BO');
    expect(convertedRow.source_label).toBe('EST-2042');
    expect(convertedRow.source_detail).toBe('');
    expect(convertedRow.catalog_name).toBe('Summer Sell-in');
    expect(convertedRow.subtotal).toBe(8475);
    expect(convertedRow.tax_amount).toBe(1525);
    expect(convertedRow.total_amount).toBe(10000);
    expect(convertedRow.placed_at).toBe('2026-05-18');

    const buyerAppRow = body.orders.find((r: { order_id: string }) => r.order_id === 'DF-2');
    expect(buyerAppRow.buyer_name).toBe('Buyer Two');
    expect(buyerAppRow.source_label).toBe('BUYER_APP');
    expect(buyerAppRow.source_detail).toBe('');

    expect(body.filters.groups.some((group: { key: string }) => group.key === 'attention')).toBe(true);
  });

  it('returns 403 for non-seller roles', async () => {
    getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-a', role: 'buyer_admin' });

    const res = await GET(new NextRequest('http://localhost/api/tenant/orders'));
    expect(res.status).toBe(403);
  });

  it('filters orders to the assistant location scope', async () => {
    getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-a', role: 'seller_assistant', location_ids: ['loc-1'] });

    const res = await GET(new NextRequest('http://localhost/api/tenant/orders'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.orders).toHaveLength(4);
    expect(body.orders.every((row: { id: string }) => ['o1', 'o3', 'o6', 'o7'].includes(row.id))).toBe(true);
    expect(body.kpis).toBeUndefined();
  });
});
