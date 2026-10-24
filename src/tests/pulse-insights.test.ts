import { describe, expect, it } from 'vitest';
import { buildInsights, INSIGHT_MIN } from '@/lib/pulse/insights';
import { insightText } from '@/lib/pulse/insight-copy';
import type { PulseActNowResponse, PulseFunnelResponse, PulsePatternsResponse, PulseScorecardResponse, PulseSellThroughResponse, PulseWindowMetrics } from '@/types/pulse-v2';

const metrics = (over: Partial<PulseWindowMetrics> = {}): PulseWindowMetrics => ({
  primary_demand_kind: 'estimates', demand_value: 0, demand_docs: 0, demand_buyers: 0,
  quotes: { count: 0, converted: 0, lost: 0, open: 0 }, median_quote: null, avg_lines: null,
  app_invoiced_value: 0, app_invoiced_docs: 0, app_invoiced_buyers: 0, total_invoiced_value: 0, total_invoiced_docs: 0,
  engaged_buyers: 0, ...over,
});

const scorecard = (over: Partial<PulseScorecardResponse> = {}): PulseScorecardResponse => ({
  period: { key: 'mtd', label: 'This month', thin: false },
  window: { from: '2026-10-01', to_excl: '2026-10-19' },
  compare_window: { from: '2026-09-01', to_excl: '2026-09-19' },
  current: metrics({ engaged_buyers: 100 }), previous: metrics({ engaged_buyers: 100 }),
  open_quotes: { count: 0, value: 0, oldest_at: null, older_than_48h_count: 0, older_than_48h_value: 0 },
  quoting_buyers: { new: 0, returning: 0, reactivated: 0 }, generated_at: '2026-10-18T00:00:00Z', ...over,
});

const act = (groups: PulseActNowResponse['groups']): PulseActNowResponse => ({
  period: { key: 'mtd', label: 'This month', thin: false }, window: { from: '2026-10-01', to_excl: '2026-10-19' }, groups, generated_at: '',
});
const funnel = (users: number): PulseFunnelResponse => ({
  period: { key: 'mtd', label: 'This month', thin: false }, window: { from: '2026-10-01', to_excl: '2026-10-19' }, capped: false,
  funnel: { users, browsed: users, quoted: 0, invoiced: 0 }, days: [], generated_at: '',
});

const NOW = new Date('2026-10-18T00:00:00Z');

describe('pulse insights guards', () => {
  it('open_quotes_aging needs the minimum number of old quotes', () => {
    const few = scorecard({ open_quotes: { count: 9, value: 1, oldest_at: '2026-10-01T00:00:00Z', older_than_48h_count: INSIGHT_MIN.openQuotes - 1, older_than_48h_value: 1 } });
    expect(buildInsights({ scorecard: few, actNow: null, funnel: null, now: NOW })).toEqual([]);
    const enough = scorecard({ open_quotes: { count: 9, value: 310000, oldest_at: '2026-10-01T00:00:00Z', older_than_48h_count: 8, older_than_48h_value: 310000 } });
    const [i] = buildInsights({ scorecard: enough, actNow: null, funnel: null, now: NOW });
    expect(i.id).toBe('open_quotes_aging');
    expect(i.evidence.ageDays).toBe(17);
    expect(insightText(i)).toBe('8 quotes worth ₹3,10,000 have waited over 2 days. Oldest: 17 days.');
  });

  it('browse_no_quote needs both an absolute floor and a share of users', () => {
    const g = (count: number) => act([{ id: 'browse_no_quote', count, value: 0, previews: [] }]);
    expect(buildInsights({ scorecard: null, actNow: g(19), funnel: funnel(40) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: g(25), funnel: funnel(400) })).toEqual([]); // 6%
    const [i] = buildInsights({ scorecard: null, actNow: g(25), funnel: funnel(100) });
    expect(i.evidence).toMatchObject({ n: 25, pct: 25 });
  });

  it('activity_change is suppressed for thin windows, no compare, tiny bases and small moves', () => {
    const cur = metrics({ engaged_buyers: 60 });
    const prev = metrics({ engaged_buyers: 100 });
    expect(buildInsights({ scorecard: scorecard({ period: { key: 'mtd', label: '', thin: true }, current: cur, previous: prev }), actNow: null, funnel: null })).toEqual([]);
    expect(buildInsights({ scorecard: scorecard({ current: cur, previous: null, compare_window: null }), actNow: null, funnel: null })).toEqual([]);
    expect(buildInsights({ scorecard: scorecard({ current: metrics({ engaged_buyers: 5 }), previous: metrics({ engaged_buyers: 10 }) }), actNow: null, funnel: null })).toEqual([]);
    expect(buildInsights({ scorecard: scorecard({ current: metrics({ engaged_buyers: 105 }), previous: prev }), actNow: null, funnel: null })).toEqual([]);
    const [i] = buildInsights({ scorecard: scorecard({ current: cur, previous: prev }), actNow: null, funnel: null });
    expect(i).toMatchObject({ id: 'activity_change', severity: 'watch', evidence: { n: 40, pct: 40, direction: 'down', windowDays: 18 } });
    expect(insightText(i)).toBe('40 fewer customers used the app than in the previous 18 days (40%).');
  });

  it('reactivated needs a minimum and orders insights by urgency', () => {
    const sc = scorecard({
      quoting_buyers: { new: 0, returning: 0, reactivated: 3 },
      open_quotes: { count: 6, value: 5000, oldest_at: '2026-10-10T00:00:00Z', older_than_48h_count: 6, older_than_48h_value: 5000 },
    });
    const ids = buildInsights({ scorecard: sc, actNow: null, funnel: null, now: NOW }).map((i) => i.id);
    expect(ids).toEqual(['open_quotes_aging', 'reactivated']);
    expect(buildInsights({ scorecard: scorecard({ quoting_buyers: { new: 0, returning: 0, reactivated: 2 } }), actNow: null, funnel: null })).toEqual([]);
  });

  it('never emits anything from empty input', () => {
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null })).toEqual([]);
  });
});

const P = { key: 'mtd' as const, label: 'This month', thin: false };
const W = { from: '2026-10-01', to_excl: '2026-10-19' };
const patterns = (large: [number, number], small: [number, number]): PulsePatternsResponse => ({
  period: P, window: W, weekdays: [], generated_at: '',
  quote_sizes: {
    threshold: 50000,
    large: { count: large[0], converted: large[1], lost: 0, open: 0 },
    small: { count: small[0], converted: small[1], lost: 0, open: 0 },
  },
});
const brandsOf = (rows: Array<[string, number]>, items = rows.length, capped = false): PulseSellThroughResponse => ({
  period: P, window: W, dimension: 'brand', capped, generated_at: '',
  rows: rows.map(([name, v]) => ({ id: name, name, quoted_value: v, quoted_qty: 1, quoted_docs: 1, invoiced_value: v, invoiced_qty: 1, invoiced_docs: 1 })),
  totals: { quoted_value: rows.reduce((n, r) => n + r[1], 0), invoiced_value: rows.reduce((n, r) => n + r[1], 0), items },
});

describe('large_quote_gap', () => {
  it('fires when large quotes close well below small ones, with enough of both', () => {
    const [i] = buildInsights({ scorecard: null, actNow: null, funnel: null, patterns: patterns([10, 2], [40, 24]) });
    expect(i.id).toBe('large_quote_gap');
    expect(insightText(i)).toContain('20%');
    expect(insightText(i)).toContain('60%');
  });
  it('stays silent on small samples, a narrow gap, or when large quotes do better', () => {
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, patterns: patterns([4, 0], [40, 24]) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, patterns: patterns([10, 5], [40, 24]) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, patterns: patterns([10, 8], [40, 24]) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, patterns: null })).toEqual([]);
  });
});

describe('brand_concentration', () => {
  it('fires when one brand is at least half of invoiced value across three or more brands', () => {
    const [i] = buildInsights({ scorecard: null, actNow: null, funnel: null, brands: brandsOf([['CP Plus', 58000], ['Seagate', 22000], ['Hikvision', 20000]]) });
    expect(i.id).toBe('brand_concentration');
    expect(insightText(i)).toBe('CP Plus is 58% of what was invoiced through the app, across 3 brands.');
  });
  it('stays silent below the share, the brand count, the value floor, or when capped', () => {
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, brands: brandsOf([['A', 40000], ['B', 30000], ['C', 30000]]) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, brands: brandsOf([['A', 90000], ['B', 10000]]) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, brands: brandsOf([['A', 900], ['B', 50], ['C', 50]]) })).toEqual([]);
    expect(buildInsights({ scorecard: null, actNow: null, funnel: null, brands: brandsOf([['A', 90000], ['B', 5000], ['C', 5000]], 3, true) })).toEqual([]);
  });
});
