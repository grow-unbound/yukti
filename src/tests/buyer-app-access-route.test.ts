import { beforeEach, describe, expect, it, vi } from 'vitest';

// `after()` only works inside a request scope; run the callback inline so tests can assert on it.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: unknown) => {
    void (typeof task === 'function' ? (task as () => unknown)() : task);
  },
}));

const flushBuyerMembershipsNowMock = vi.fn().mockResolvedValue({});
vi.mock('@/lib/server/buyer-membership-flush', () => ({
  flushBuyerMembershipsNow: (...args: unknown[]) => flushBuyerMembershipsNowMock(...args),
}));
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();
const rpcMock = vi.fn();
const fromMock = vi.fn();
const queueBuyerAppEnabledMessagesMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
  decodeJWTPayload: vi.fn(),
}));

vi.mock('@/lib/flags', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));

vi.mock('@/lib/server/buyer-app-enable-notify', () => ({
  queueBuyerAppEnabledMessages: (...args: unknown[]) => queueBuyerAppEnabledMessagesMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
      from: (...args: unknown[]) => fromMock(...args),
    })),
  },
}));

import { GET, PATCH } from '../../app/api/tenant/buyer-app/access/route';

const rpcResponse = {
  summary_authoritative: false,
  kpis: null,
  buyers: [
    {
      id: 'buyer-3',
      business_name: 'Alpha Retail',
      contact_name: 'Asha',
      phone: '9999999991',
      city: 'Hyderabad',
      state: 'Telangana',
      buyer_app_enabled: false,
      last_app_order_at: null,
      offline_spend_mtd: 10_000,
      total_spend_mtd: 10_000,
      app_gmv_mtd: 0,
      is_suggested: true,
      is_inactive: false,
    },
  ],
  filtered_count: 1,
  has_more: false,
  limit: 25,
  offset: 25,
};

describe('GET /api/tenant/buyer-app/access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      buyer_id: null,
      location_ids: null,
    });
    getFlagMock.mockResolvedValue(true);
    rpcMock.mockResolvedValue({ data: rpcResponse, error: null });
  });

  it('pushes search, derived segment, recency, sort, and pagination into the RPC', async () => {
    const response = await GET(new NextRequest(
      'http://localhost:3000/api/tenant/buyer-app/access'
      + '?limit=25&offset=25&q=alp&status=suggested&last_ordered=dormant&sort=offline_spend',
    ));

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('search_buyer_app_access_v4', {
      p_tenant_id: 'tenant-1',
      p_query: 'alp',
      p_segment: 'suggested',
      p_last_ordered: 'dormant',
      p_sort: 'offline_spend',
      p_location_ids: null,
      p_limit: 25,
      p_offset: 25,
      p_include_summary: false,
    });
    expect(await response.json()).toEqual(rpcResponse);
  });

  it('passes assistant location scope directly to the authoritative RPC', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_assistant',
      buyer_id: null,
      location_ids: ['loc-1', 'loc-2'],
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/tenant/buyer-app/access?status=inactive'),
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith(
      'search_buyer_app_access_v4',
      expect.objectContaining({
        p_segment: 'inactive',
        p_location_ids: ['loc-1', 'loc-2'],
        p_include_summary: false,
      }),
    );
  });

  it('requests authoritative counts only for the unfiltered first page', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/tenant/buyer-app/access?limit=25'),
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith(
      'search_buyer_app_access_v4',
      expect.objectContaining({
        p_query: null,
        p_segment: 'all',
        p_offset: 0,
        p_include_summary: true,
      }),
    );
  });

  it('rejects unknown filters before reaching the database', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/tenant/buyer-app/access?status=unknown'),
    );

    expect(response.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('returns an empty scoped response without querying for an unassigned assistant', async () => {
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_assistant',
      buyer_id: null,
      location_ids: [],
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/tenant/buyer-app/access?limit=20'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      summary_authoritative: true,
      buyers: [],
      filtered_count: 0,
      has_more: false,
      limit: 20,
      offset: 0,
    }));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tenant/buyer-app/access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      buyer_id: null,
      location_ids: null,
    });
    getFlagMock.mockResolvedValue(true);
    queueBuyerAppEnabledMessagesMock.mockResolvedValue({
      sent_count: 1,
      eligible_count: 1,
      skipped_count: 0,
    });
  });

  it('queues WhatsApp only when enabling previously disabled buyers', async () => {
    let buyersCallCount = 0;
    const disabledLookup = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({
        data: [{ id: '00000000-0000-4000-8000-000000000001' }],
        error: null,
      }),
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({
        data: [{ id: '00000000-0000-4000-8000-000000000001' }],
        error: null,
      }),
    };
    const auditInsert = {
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    fromMock.mockImplementation((table: string) => {
      if (table === 'buyers') {
        buyersCallCount += 1;
        return buyersCallCount === 1 ? disabledLookup : updateChain;
      }
      if (table === 'audit_log') {
        return auditInsert;
      }
      return {};
    });

    const response = await PATCH(new NextRequest('http://localhost:3000/api/tenant/buyer-app/access', {
      method: 'PATCH',
      body: JSON.stringify({
        buyer_ids: ['00000000-0000-4000-8000-000000000001'],
        enabled: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated_count: 1,
      whatsapp_sent_count: 1,
      whatsapp_eligible_count: 1,
    });
    expect(queueBuyerAppEnabledMessagesMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      ['00000000-0000-4000-8000-000000000001'],
    );
    // newly enabled buyers join their campaign audiences immediately, not at the next 15-min tick
    expect(flushBuyerMembershipsNowMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      ['00000000-0000-4000-8000-000000000001'],
    );
  });

  it('does not queue WhatsApp when disabling access', async () => {
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({
        data: [{ id: '00000000-0000-4000-8000-000000000001' }],
        error: null,
      }),
    };
    const auditInsert = {
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    fromMock.mockImplementation((table: string) => {
      if (table === 'buyers') return updateChain;
      if (table === 'audit_log') return auditInsert;
      return {};
    });

    const response = await PATCH(new NextRequest('http://localhost:3000/api/tenant/buyer-app/access', {
      method: 'PATCH',
      body: JSON.stringify({
        buyer_ids: ['00000000-0000-4000-8000-000000000001'],
        enabled: false,
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated_count: 1,
      whatsapp_sent_count: 0,
      whatsapp_eligible_count: 0,
    });
    expect(queueBuyerAppEnabledMessagesMock).not.toHaveBeenCalled();
    expect(flushBuyerMembershipsNowMock).not.toHaveBeenCalled();
  });
});
