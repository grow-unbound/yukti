import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
      from: (...args: unknown[]) => fromMock(...args),
    })),
  },
}));

import {
  istDateString,
  landingMetricsToPulseContribution,
  loadPulseOpportunities,
  loadPulseOpportunityBuyerPage,
  PULSE_DORMANT_DAYS,
  PULSE_DORMANT_MIN_VALUE,
} from '@/lib/server/pulse-core';

const admin = { tenant_id: 'tenant-1', role: 'seller_admin' };

function dormantRow(overrides: Record<string, unknown> = {}) {
  return {
    buyer_id: 'buyer-1',
    business_name: 'SV Informatics',
    last_invoice_date: '2026-06-12',
    days_since_last_invoice: 106,
    value_12m: '1107286.00',
    invoice_count_12m: 13,
    source_watermark: '2026-09-25T03:45:00.000Z',
    computed_at: '2026-09-25T04:00:00.000Z',
    total_count: 294,
    total_value_12m: '25000000.00',
    ...overrides,
  };
}

function emptyBuilder() {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    gt: vi.fn(() => builder),
    order: vi.fn(() => builder),
    in: vi.fn(() => Promise.resolve({ data: [], error: null })),
    range: vi.fn(() => Promise.resolve({ data: [], error: null })),
  };
  return builder;
}

describe('Pulse core mapping', () => {
  it('maps seller-admin contribution from buyer-app landing metrics without access-enabled filler', () => {
    const response = landingMetricsToPulseContribution({
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
        { id: 'customers_with_access', value: 272, entity_count: 272, secondary_value: 11894, time_basis: 'now' },
        { id: 'app_sourced_demand_qtd', value: 840000, entity_count: 6, document_count: 9, time_basis: 'quarter' },
        { id: 'app_sourced_invoiced_sales_qtd', value: 510000, entity_count: 4, document_count: 5, secondary_value: 4250000, time_basis: 'quarter' },
      ],
    });

    expect(response.source).toBe('app.get_landing_metrics_v4');
    expect(response.cards.map((card) => card.id)).toEqual([
      'yukti_access_enabled',
      'demand_captured',
      'invoiced_from_captured_demand',
      'active_yukti_buyers',
    ]);
    expect(response.cards[0]).toEqual(expect.objectContaining({
      label: 'Customers with Yukti access',
      value: 272,
    }));
    expect(response).not.toHaveProperty('empty_opportunity');
  });
});

describe('Pulse dormant customers opportunity (rolling 90 days)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation(() => emptyBuilder());
    rpcMock.mockResolvedValue({ data: [dormantRow()], error: null });
  });

  it('uses the app dormancy cut-off of 90 days', () => {
    expect(PULSE_DORMANT_DAYS).toBe(90);
  });

  it('reads the exact total and bounded previews from the dormancy RPC with evidence text', async () => {
    const { response, status } = await loadPulseOpportunities(admin, new Date('2026-09-26T05:00:00Z'));

    expect(status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('get_pulse_dormant_buyers', {
      p_tenant_id: 'tenant-1',
      p_as_of: '2026-09-26',
      p_dormant_days: 90,
      p_min_value: PULSE_DORMANT_MIN_VALUE,
      p_limit: 5,
      p_offset: 0,
    });
    const group = response!.groups.find((g) => g.id === 'dormant_customers_90d')!;
    expect(group).toEqual(expect.objectContaining({
      title: 'Dormant customers to win back',
      count: 294,
      time_basis: 'Rolling 90 days',
      evidence: '₹2,50,00,000 last-12-month value · no purchase in 90+ days',
      action_href: '/customers',
    }));
    expect(group.previews[0]).toEqual(expect.objectContaining({
      buyer_id: 'buyer-1',
      name: 'SV Informatics',
      days_since_last_invoice: 106,
      last_invoice_date: '2026-06-12',
      supporting_text: 'Last purchase 106 days ago · ₹11,07,286 last 12m',
      href: '/customers/buyer-1',
    }));
    expect(JSON.stringify(response)).not.toContain('going quiet');
  });

  it('omits the group when no buyer is dormant', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { response } = await loadPulseOpportunities(admin, new Date('2026-09-26T05:00:00Z'));
    expect(response!.groups.map((g) => g.id)).not.toContain('dormant_customers_90d');
  });

  it('surfaces RPC failures as a 500', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { status, response } = await loadPulseOpportunities(admin);
    expect(status).toBe(500);
    expect(response).toBeNull();
  });

  it('never reads calendar-quarter summary rows for dormancy (identical Sep 30 vs Oct 1 IST)', async () => {
    const beforeMidnight = new Date('2026-09-30T18:29:59Z'); // 23:59:59 IST, Sep 30
    const afterMidnight = new Date('2026-09-30T18:30:00Z'); // 00:00:00 IST, Oct 1

    expect(istDateString(beforeMidnight)).toBe('2026-09-30');
    expect(istDateString(afterMidnight)).toBe('2026-10-01');

    const before = await loadPulseOpportunities(admin, beforeMidnight);
    const after = await loadPulseOpportunities(admin, afterMidnight);

    const dormantBefore = before.response!.groups.find((g) => g.id === 'dormant_customers_90d');
    const dormantAfter = after.response!.groups.find((g) => g.id === 'dormant_customers_90d');
    // Rolling window: same group, count and rows on either side of the quarter rollover,
    // even though no Q4 summary rows exist yet after midnight (all summary reads return empty).
    expect(dormantAfter).toEqual(dormantBefore);
    expect(dormantAfter?.count).toBe(294);

    const dormantCalls = rpcMock.mock.calls.filter(([name]) => name === 'get_pulse_dormant_buyers');
    expect(dormantCalls).toHaveLength(2);
    expect(dormantCalls[0][1]).toEqual(expect.objectContaining({ p_as_of: '2026-09-30', p_dormant_days: 90 }));
    expect(dormantCalls[1][1]).toEqual(expect.objectContaining({ p_as_of: '2026-10-01', p_dormant_days: 90 }));
    // Only the (unchanged) activation group touches period summaries; dormancy has no period_start input.
    for (const [, args] of dormantCalls) {
      expect(Object.keys(args as object).sort()).toEqual([
        'p_as_of', 'p_dormant_days', 'p_limit', 'p_min_value', 'p_offset', 'p_tenant_id',
      ]);
    }
  });

  it('pages the buyer sheet with real total, offset cursor and bounded page size', async () => {
    rpcMock.mockResolvedValue({
      data: [dormantRow(), dormantRow({ buyer_id: 'buyer-2', business_name: 'KMR Educational Society', days_since_last_invoice: 113, value_12m: 700000 })],
      error: null,
    });

    const { page, status } = await loadPulseOpportunityBuyerPage(admin, 'dormant_customers_90d', 40, 500, new Date('2026-09-26T05:00:00Z'));

    expect(status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('get_pulse_dormant_buyers', expect.objectContaining({ p_limit: 50, p_offset: 40 }));
    expect(page!.total).toBe(294);
    expect(page!.group.count).toBe(294);
    expect(page!.rows).toHaveLength(2);
    expect(page!.rows[1].supporting_text).toBe('Last purchase 113 days ago · ₹7,00,000 last 12m');
    expect(page!.nextCursor).toBe('42');
  });

  it('ends pagination on the last page', async () => {
    rpcMock.mockResolvedValue({ data: [dormantRow({ total_count: 42 })], error: null });
    const { page } = await loadPulseOpportunityBuyerPage(admin, 'dormant_customers_90d', 41, 20);
    expect(page!.nextCursor).toBeNull();
  });

  it('rejects non-admin claims before touching the database', async () => {
    const claims = { tenant_id: 'tenant-1', role: 'seller_assistant' };
    expect((await loadPulseOpportunities(claims)).status).toBe(403);
    expect((await loadPulseOpportunityBuyerPage(claims, 'dormant_customers_90d', 0, 20)).status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });
});
