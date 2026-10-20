import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('@/lib/flags', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));

vi.mock('@/lib/server/seller-location-access', () => ({
  applySellerLocationScope: (query: unknown) => query,
  loadAccessibleSellerLocations: async () => [],
}));

type QueryResult = { data?: unknown; error?: unknown };

const dbResponses: Record<string, QueryResult[]> = {};
const queryInstances = new Map<string, ReturnType<typeof createQuery>>();

function nextResult(key: string): QueryResult {
  const queue = dbResponses[key] ?? [];
  if (queue.length <= 1) return queue[0] ?? {};
  return queue.shift() ?? {};
}

function createQuery(key: string) {
  const query = {
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    gt: vi.fn(),
    or: vi.fn(),
    not: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    limit: vi.fn(),
    gte: vi.fn(),
    maybeSingle: vi.fn(),
    then: (onFulfilled: (value: { data: unknown; error: unknown }) => unknown) => {
      const result = nextResult(key);
      return Promise.resolve(onFulfilled({ data: result.data ?? null, error: result.error ?? null }));
    },
  };

  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.gt.mockReturnValue(query);
  query.or.mockReturnValue(query);
  query.not.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.range.mockImplementation(async () => {
    const result = nextResult(key);
    return { data: result.data ?? null, error: result.error ?? null, count: 0 };
  });
  query.limit.mockReturnValue(query);
  query.gte.mockReturnValue(query);
  query.maybeSingle.mockImplementation(async () => {
    const result = nextResult(key);
    return { data: result.data ?? null, error: result.error ?? null };
  });
  queryInstances.set(key, query);

  return query;
}

const fromMock = vi.fn((schemaName: string, tableName: string) => ({
  select: vi.fn(() => createQuery(`${schemaName}.${tableName}`)),
}));
const rpcMock = vi.fn((fnName: string) => {
  const result = nextResult(`rpc.${fnName}`);
  return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
});
const schemaMock = vi.fn((schemaName: string) => ({
  from: vi.fn((tableName: string) => fromMock(schemaName, tableName)),
  rpc: vi.fn((fnName: string, args: unknown) => rpcMock(fnName, args)),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: (...args: unknown[]) => schemaMock(...args),
  },
}));

import { GET as getCustomerDetail } from '../../app/api/tenant/customers/[id]/route';
import { GET as getCustomerDocuments } from '../../app/api/tenant/customers/[id]/documents/route';
import { GET as getOutstandingInvoices } from '../../app/api/tenant/customers/[id]/outstanding-invoices/route';

function setBootstrapDefaults() {
  dbResponses['app.buyers'] = [
    {
      data: {
        id: 'buyer-1',
        tenant_id: 'tenant-1',
        business_name: 'Singh Hospitality',
        contact_name: 'R Singh',
        phone: '9876543210',
        email: 'ops@singh.co',
        gstin: '29ABCDE1234F1Z5',
        gst_treatment: 'regular',
        billing_address: null,
        shipping_address: null,
        is_active: true,
        buyer_app_enabled: true,
        credit_limit: 100000,
        payment_terms_days: 21,
        default_cohort_id: 'cohort-1',
        default_price_list_id: 'pl-1',
        geography: { city: 'Bengaluru', state: 'Karnataka', pincode: '560001', zone: 'South' },
        created_at: '2021-05-10T00:00:00Z',
        whatsapp_opt_out_at: null,
      },
    },
  ];
  dbResponses['app.buyer_users'] = [{ data: [] }];
  dbResponses['app.cohort_members'] = [
    { data: [{ cohort_id: 'cohort-1', cohorts: { name: 'Premium', deleted_at: null } }] },
  ];
  dbResponses['app.price_list_assignments'] = [
    { data: { price_list_id: 'pl-1' } },
    { data: [{ price_list_id: 'pl-1' }, { price_list_id: 'pl-2' }] },
  ];
  dbResponses['app.price_lists'] = [{ data: { id: 'pl-1', name: 'North Premium Pricing' } }];
  dbResponses['app.invoices'] = [{ data: { total_amount: 84200, invoice_date: '2026-07-16', created_at: '2026-07-16T00:00:00Z' } }];
  dbResponses['app.estimates'] = [{ data: null }];
  dbResponses['app.orders'] = [{ data: null }];
  dbResponses['app.buyer_app_activity'] = [{ data: null }];
  dbResponses['rpc.metrics_v4_primary_demand_kind'] = [{ data: 'orders' }];
  dbResponses['rpc.existing_buyer_context_snapshot'] = [
    {
      data: {
        sales: { current: { invoice_value: 250000, invoice_count: 4 }, previous: { invoice_value: 200000, invoice_count: 3 } },
        demand: { kind: 'orders', current: { value: 188000, count: 3 }, previous: { value: 150000, count: 2 } },
        app_engagement: { value: 50000, count: 2 },
        dues: {
          receivable_amount: 64000,
          receivable_invoice_count: 2,
          overdue_amount: 12000,
          overdue_invoice_count: 1,
          credit_limit: 100000,
          credit_available: 36000,
        },
      },
    },
  ];
}

describe('customer detail bootstrap route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(dbResponses)) delete dbResponses[key];
    queryInstances.clear();
    setBootstrapDefaults();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      buyer_id: null,
      location_ids: null,
    });
    getFlagMock.mockResolvedValue(true);
  });

  it('returns a metrics-first bootstrap payload with tab badges and no eager document arrays', async () => {
    const response = await getCustomerDetail(
      new NextRequest('http://localhost:3000/api/tenant/customers/buyer-1'),
      { params: Promise.resolve({ id: 'buyer-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tab_badges).toEqual({
      price_lists_assigned: 2,
    });
    expect(body.meta_strip_4.sales_qtd_value).toBe(250000);
    expect(body.meta_strip_4.sales_qtd_count).toBe(4);
    expect(body.meta_strip_4.sales_qtd_trend_pct).toBe(25);
    expect(body.meta_strip_4.receivable_amount).toBe(64000);
    expect(body.meta_strip_4.overdue_amount).toBe(12000);
    expect(body.meta_strip_4.overdue_invoice_count).toBe(1);
    expect(body.meta_strip_4.demand_qtd_value).toBe(188000);
    expect(body.meta_strip_4.app_engagement_value).toBe(50000);
    expect(body.meta_strip_4.app_engagement_count).toBe(2);
    expect(body.price_lists).toEqual({ assigned_count: 2 });
    expect(body.header.subtitle_meta.last_activity_kind).toBe('sale');
    expect(body.details.default_price_list_id).toBe('pl-1');
    expect(body.details.assigned_price_list).toBe('North Premium Pricing');
    expect(body.orders).toBeUndefined();
    expect(body.estimates).toBeUndefined();
    expect(body.invoices).toBeUndefined();
    expect(body.activity).toBeUndefined();
  });
});

describe('customer documents route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(dbResponses)) delete dbResponses[key];
    queryInstances.clear();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      buyer_id: null,
      location_ids: null,
    });
    dbResponses['app.buyers'] = [{ data: { id: 'buyer-1' } }];
    dbResponses['app.orders'] = [{ data: [], error: null }];
    dbResponses['app.order_items'] = [{ data: [] }];
  });

  it('applies the documents route default period bound when no period is provided', async () => {
    await getCustomerDocuments(
      new NextRequest('http://localhost:3000/api/tenant/customers/buyer-1/documents?kind=order'),
      { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) },
    );

    expect(queryInstances.get('app.orders')?.or).toHaveBeenCalled();
  });

  it('filters explicit trailing 90 day order requests using order_date with created_at fallback', async () => {
    await getCustomerDocuments(
      new NextRequest('http://localhost:3000/api/tenant/customers/buyer-1/documents?kind=order&period=last90'),
      { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) },
    );

    expect(queryInstances.get('app.orders')?.or).toHaveBeenCalledWith(
      'order_date.gte.2026-04-22T00:00:00.000Z,order_date.lt.2026-07-21T00:00:00.000Z,and(order_date.is.null,created_at.gte.2026-04-22T00:00:00.000Z,created_at.lt.2026-07-21T00:00:00.000Z)',
    );
    expect(queryInstances.get('app.orders')?.order).toHaveBeenCalledWith('order_date', {
      ascending: false,
      nullsFirst: false,
    });
  });

  it('honors an explicit trailing 90 day period for invoices using invoice_date fallback semantics', async () => {
    dbResponses['app.invoices'] = [{ data: [], error: null }];
    dbResponses['app.invoice_items'] = [{ data: [] }];

    await getCustomerDocuments(
      new NextRequest('http://localhost:3000/api/tenant/customers/buyer-1/documents?kind=invoice&period=last90'),
      { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) },
    );

    expect(queryInstances.get('app.invoices')?.or).toHaveBeenCalledWith(
      'invoice_date.gte.2026-04-22T00:00:00.000Z,invoice_date.lt.2026-07-21T00:00:00.000Z,and(invoice_date.is.null,created_at.gte.2026-04-22T00:00:00.000Z,created_at.lt.2026-07-21T00:00:00.000Z)',
    );
  });
});

describe('customer outstanding invoices route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(dbResponses)) delete dbResponses[key];
    queryInstances.clear();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_assistant',
      buyer_id: null,
      location_ids: ['loc-1'],
    });
    getFlagMock.mockResolvedValue(true);
    dbResponses['app.buyers'] = [{ data: { id: 'buyer-1' } }];
    dbResponses['app.invoices'] = [{
      data: [
        {
          id: 'inv-1',
          invoice_number: 'INV-001',
          invoice_date: '2026-07-10',
          due_date: '2026-07-18',
          total_amount: 1000,
          outstanding_balance: 400,
          location_id: 'loc-2',
          status: 'sent',
          place_of_supply: 'Karnataka',
        },
      ],
    }];
    dbResponses['app.locations'] = [{ data: [{ id: 'loc-2', name: 'Warehouse South' }] }];
  });

  it('returns outstanding invoices across customer locations for assistants', async () => {
    const response = await getOutstandingInvoices(
      new NextRequest('http://localhost:3000/api/tenant/customers/buyer-1/outstanding-invoices'),
      { params: Promise.resolve({ id: 'buyer-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(queryInstances.get('app.invoices')?.in).not.toHaveBeenCalled();
    expect(queryInstances.get('app.invoices')?.eq).toHaveBeenCalledWith('buyer_id', 'buyer-1');
    expect(body.invoices).toEqual([
      expect.objectContaining({
        id: 'inv-1',
        location_id: 'loc-2',
        location_name: 'Warehouse South',
        outstanding_amount: 400,
        status: 'overdue',
      }),
    ]);
  });
});
