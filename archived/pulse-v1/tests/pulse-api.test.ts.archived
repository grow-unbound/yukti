import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const rpcMock = vi.fn();
const fromMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });
});
const requireSellerServerTenantIdMock = vi.fn();
const getSellerServerClaimsMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('next/navigation', () => ({
  redirect: (...args: [string]) => redirectMock(...args),
}));

vi.mock('@/lib/server/seller-server-claims', () => ({
  requireSellerServerTenantId: (...args: unknown[]) => requireSellerServerTenantIdMock(...args),
  getSellerServerClaims: (...args: unknown[]) => getSellerServerClaimsMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
      from: (...args: unknown[]) => fromMock(...args),
    })),
  },
}));

import { GET as getContribution } from '../../app/api/tenant/pulse/contribution/route';
import BuyerAppPage from '../../app/(seller)/buyer-app/page';
import BuyerAppAccessPage from '../../app/(seller)/buyer-app/access/page';
import { GET as getDemandSignals } from '../../app/api/tenant/pulse/demand-signals/route';
import { GET as getOpportunities } from '../../app/api/tenant/pulse/opportunities/route';
import { GET as getOpportunityBuyers } from '../../app/api/tenant/pulse/opportunities/[id]/buyers/route';

const rpcPortfolio = {
  as_of: '2026-09-22T04:00:00.000Z',
  source_watermark: '2026-09-22T03:45:00.000Z',
  primary_demand_kind: 'orders',
  metrics: [
    {
      id: 'app_sourced_demand_value_share',
      time_basis: 'QTD',
      available: true,
      count: 2,
      meta: { app_demand_value_90d: 200000 },
    },
    {
      id: 'customers_submitting_app_demand',
      time_basis: 'QTD',
      available: true,
      count: 2,
    },
  ],
  actions: [
    {
      id: 'valuable_assisted_customers_without_access',
      time_basis: 'NOW + QTD',
      available: true,
      count: 1,
      meta: { rows: [{ buyer_id: 'buyer-1', name: 'Alpha Retail', invoice_value_qtd: 150000, invoice_count_qtd: 3 }] },
    },
  ],
  explore: [],
};

describe('Pulse API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      location_ids: null,
    });
    getSellerServerClaimsMock.mockResolvedValue({ tenant_id: 'tenant-1', role: 'seller_admin', location_ids: null });
    rpcMock.mockImplementation((name: string) => Promise.resolve(
      name === 'get_pulse_dormant_buyers'
        ? {
          data: [{
            buyer_id: 'buyer-quiet', business_name: 'Quiet Retail', last_invoice_date: '2026-06-10', days_since_last_invoice: 108,
            value_12m: 90000, invoice_count_12m: 3, source_watermark: '2026-09-21T03:45:00.000Z', computed_at: '2026-09-21T04:00:00.000Z',
            total_count: 4, total_value_12m: 400000,
          }],
          error: null,
        }
        : { data: rpcPortfolio, error: null },
    ));
    fromMock.mockImplementation((table: string) => {
      const filters = new Map<string, unknown>();
      const builder: any = {
        select: vi.fn(() => builder),
        eq: vi.fn((key: string, value: unknown) => {
          filters.set(key, value);
          return builder;
        }),
        is: vi.fn(() => builder),
        gt: vi.fn(() => builder),
        gte: vi.fn(() => builder),
        order: vi.fn(() => builder),
        range: vi.fn(() => {
          if (table === 'metrics_buyer_period_summary' && filters.get('period_start') === '2026-07-01') {
            return Promise.resolve({
              data: [{ buyer_id: 'buyer-1', invoice_value: 150000, invoice_count: 3, source_watermark: '2026-09-22T03:45:00.000Z', computed_at: '2026-09-22T04:00:00.000Z' }],
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        }),
        in: vi.fn(() => {
          if (table === 'buyers' && filters.get('buyer_app_enabled') === false) {
            return Promise.resolve({ data: [{ id: 'buyer-1', business_name: 'Alpha Retail' }], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        }),
      };
      return builder;
    });
    requireSellerServerTenantIdMock.mockResolvedValue('tenant-1');
  });

  it('loads seller-admin contribution from landing metrics instead of the heavier portfolio RPC', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      location_ids: null,
    });
    rpcMock.mockResolvedValueOnce({
      data: {
        page_key: 'buyer_app',
        period: {
          period_key: 'this_quarter',
          grain: 'quarter',
          period_start: '2026-07-01',
          period_end_exclusive: '2026-10-01',
          label: 'This Quarter',
        },
        computed_at: '2026-09-22T04:00:00.000Z',
        source_watermark: '2026-09-22T03:45:00.000Z',
        cards: [
          { id: 'app_sourced_demand_qtd', value: 200000, entity_count: 2, document_count: 2, time_basis: 'quarter' },
        ],
      },
      error: null,
    });

    const response = await getContribution(new NextRequest('http://localhost/api/tenant/pulse/contribution'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe('app.get_landing_metrics_v4');
    expect(rpcMock).toHaveBeenCalledWith('get_landing_metrics_v4', expect.objectContaining({
      p_tenant_id: 'tenant-1',
      p_page_key: 'buyer_app',
      p_period_key: 'this_quarter',
      p_scope_kind: 'tenant',
      p_scope_id: null,
    }));
  });

  it('returns opportunities through an independently callable boundary', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      location_ids: null,
    });

    const response = await getOpportunities(new NextRequest('http://localhost/api/tenant/pulse/opportunities'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.groups[0].id).toBe('valuable_assisted_customers_without_access');
    expect(response.headers.get('Server-Timing')).toContain('pulse_opportunities_api');
  });

  it('loads seller-admin opportunities from bounded summary tables instead of the broad portfolio RPC', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      location_ids: null,
    });

    const response = await getOpportunities(new NextRequest('http://localhost/api/tenant/pulse/opportunities'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe('app.metrics_buyer_period_summary');
    expect(body.groups.map((group: { id: string }) => group.id)).toEqual([
      'valuable_assisted_customers_without_access',
      'dormant_customers_90d',
    ]);
    expect(body.groups[0].previews[0]).toEqual(expect.objectContaining({
      buyer_id: 'buyer-1',
      supporting_text: '₹1,50,000 · 3 invoices',
    }));
    expect(body.groups[1]).toEqual(expect.objectContaining({ count: 4, time_basis: 'Rolling 90 days' }));
    expect(body.groups[1].previews[0].supporting_text).toBe('Last purchase 108 days ago · ₹90,000 last 12m');
    expect(rpcMock).not.toHaveBeenCalledWith('get_buyer_app_dashboard_v4', expect.anything());
    expect(rpcMock).toHaveBeenCalledWith('get_pulse_dormant_buyers', expect.objectContaining({ p_tenant_id: 'tenant-1' }));
    expect(fromMock).toHaveBeenCalledWith('metrics_buyer_period_summary');
    expect(fromMock).toHaveBeenCalledWith('buyers');
  });

  it('loads demand signals from the local landing snapshot boundary', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        page_key: 'pulse_demand_signals',
        computed_at: new Date().toISOString(),
        source_watermark: new Date().toISOString(),
        cards: [
          {
            id: 'missing_assortment',
            rows: [],
            meta: {
              product_views: 81,
              cart_adds: 0,
              searches: 0,
              zero_result_searches: 0,
              query_window_start: '2026-09-17T03:10:06.189Z',
              query_window_end: '2026-09-24T03:10:06.189Z',
            },
          },
          {
            id: 'conversion_gaps',
            rows: [{ id: 'product-1', label: 'NVR', count: 12, unique_count: 4, source_channel: 'storefront' }],
          },
          { id: 'stock_mismatch', rows: [] },
        ],
      },
      error: null,
    });

    const response = await getDemandSignals(new NextRequest('http://localhost/api/tenant/pulse/demand-signals'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.page_key).toBe('pulse_demand_signals');
    expect(body.conversion_gaps).toHaveLength(1);
    expect(body.missing_assortment).toEqual([]);
    expect(body.stock_mismatch).toEqual([]);
    expect(body.stale).toBe(false);
    expect(rpcMock).toHaveBeenCalledWith('get_landing_metrics_v4', expect.objectContaining({
      p_tenant_id: 'tenant-1',
      p_page_key: 'pulse_demand_signals',
      p_period_key: 'today',
      p_scope_kind: 'tenant',
      p_scope_id: null,
    }));
    expect(response.headers.get('Server-Timing')).toContain('pulse_demand_signals_api');
  });

  it('returns a paginated opportunity buyer resultset for the slide-over', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      location_ids: null,
    });

    const response = await getOpportunityBuyers(
      new NextRequest('http://localhost/api/tenant/pulse/opportunities/valuable_assisted_customers_without_access/buyers?limit=1'),
      { params: Promise.resolve({ id: 'valuable_assisted_customers_without_access' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.group.id).toBe('valuable_assisted_customers_without_access');
    expect(body.rows).toEqual([
      expect.objectContaining({
        buyer_id: 'buyer-1',
        supporting_text: '₹1,50,000 · 3 invoices',
      }),
    ]);
    expect(body.nextCursor).toBeNull();
    expect(response.headers.get('Server-Timing')).toContain('pulse_opportunity_buyers_api');
  });

  it('returns the dormant buyer sheet page and 404s retired opportunity ids', async () => {
    const ok = await getOpportunityBuyers(
      new NextRequest('http://localhost/api/tenant/pulse/opportunities/dormant_customers_90d/buyers?limit=20'),
      { params: Promise.resolve({ id: 'dormant_customers_90d' }) },
    );
    const body = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.total).toBe(4);
    expect(body.rows[0].buyer_id).toBe('buyer-quiet');
    expect(body.nextCursor).toBe('1');

    for (const id of ['previously_submitted_app_demand_now_inactive', 'access_enabled_but_never_used', 'used_app_but_no_demand']) {
      const gone = await getOpportunityBuyers(
        new NextRequest(`http://localhost/api/tenant/pulse/opportunities/${id}/buyers`),
        { params: Promise.resolve({ id }) },
      );
      expect(gone.status).toBe(404);
    }
  });

  it('rejects non-seller roles before the RPC', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'buyer_admin',
      location_ids: null,
    });

    const response = await getContribution(new NextRequest('http://localhost/api/tenant/pulse/contribution'));

    expect(response.status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('redirects the archived buyer-app analytics page to Pulse for admins', async () => {
    await expect(BuyerAppPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(requireSellerServerTenantIdMock).toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith('/pulse');
  });

  it('sends assistants from the archived buyer-app page to Inbox, not Pulse', async () => {
    getSellerServerClaimsMock.mockResolvedValue({ tenant_id: 'tenant-1', role: 'seller_assistant', location_ids: ['loc-1'] });
    await expect(BuyerAppPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/inbox');
  });

  it('preserves the buyer-app access management page', async () => {
    expect(BuyerAppAccessPage).toBeTypeOf('function');
  });
});
