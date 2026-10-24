import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('@/lib/flags', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
    })),
  },
}));

import { GET } from '../../app/api/tenant/customers/metrics/route';

describe('customers landing metrics api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      buyer_id: null,
      location_ids: null,
    });
    getFlagMock.mockResolvedValue(true);
    rpcMock.mockResolvedValue({
      data: {
        page_key: 'customers',
        period: {
          period_key: 'this_quarter',
          grain: 'quarter',
          period_start: '2026-04-01',
          period_end_exclusive: '2026-07-01',
          label: 'This Quarter',
        },
        computed_at: '2026-07-01T00:00:00Z',
        source_watermark: null,
        cards: [
          {
            id: 'active_customers',
            value: 10,
            entity_count: 10,
            filter_preset: { purchased_gte: 1, period: 'this_quarter' },
          },
        ],
      },
      error: null,
    });
  });

  it('calls get_landing_kpis for customers this_quarter', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/tenant/customers/metrics'));
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith(
      'get_landing_kpis',
      expect.objectContaining({
        p_tenant_id: 'tenant-1',
        p_page_key: 'customers',
        p_period_key: 'this_quarter',
      }),
    );
    const body = await response.json();
    expect(body.cards[0].id).toBe('active_customers');
  });

  it('returns empty cards when RPC payload is missing', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const response = await GET(new NextRequest('http://localhost:3000/api/tenant/customers/metrics'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cards).toEqual([]);
    expect(body.page_key).toBe('customers');
  });
});
