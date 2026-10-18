import { describe, expect, it } from 'vitest';
import { buildScorecardTiles, relativeDelta } from '@/lib/pulse/scorecard-tiles';
import type { PulseScorecardResponse, PulseWindowMetrics } from '@/types/pulse-v2';

const m = (o: Partial<PulseWindowMetrics> = {}): PulseWindowMetrics => ({
  demand_value: 100000, demand_docs: 10, demand_buyers: 4, quotes: { count: 10, converted: 7, lost: 0, open: 3 }, median_quote: 5000, avg_lines: 3,
  app_invoiced_value: 50000, app_invoiced_docs: 5, app_invoiced_buyers: 3, total_invoiced_value: 200000, total_invoiced_docs: 20, engaged_buyers: 30, ...o,
});
const sc = (o: Partial<PulseScorecardResponse> = {}): PulseScorecardResponse => ({
  period: { key: 'mtd', label: 'This month', thin: false }, window: { from: '2026-10-01', to_excl: '2026-10-19' },
  compare_window: { from: '2026-09-01', to_excl: '2026-09-19' }, current: m(), previous: m({ demand_value: 50000, engaged_buyers: 20, app_invoiced_value: 25000 }),
  open_quotes: { count: 3, value: 40000, oldest_at: '2026-10-10T00:00:00Z', older_than_48h_count: 3, older_than_48h_value: 40000 },
  quoting_buyers: { new: 2, returning: 1, reactivated: 1 }, generated_at: '', ...o,
});

describe('relativeDelta', () => {
  it('needs a positive base and a real change', () => {
    expect(relativeDelta(10, null)).toBeUndefined();
    expect(relativeDelta(10, 0)).toBeUndefined();
    expect(relativeDelta(10, 10)).toBeUndefined();
    expect(relativeDelta(150, 100)).toEqual({ text: '+50% vs previous', tone: 'up' });
    expect(relativeDelta(50, 100)).toEqual({ text: '-50% vs previous', tone: 'down' });
  });
});

describe('buildScorecardTiles', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  it('produces five owner-language tiles with deltas against the comparison window', () => {
    const tiles = buildScorecardTiles(sc(), now);
    expect(tiles.map((t) => t.id)).toEqual(['demand', 'invoiced', 'share', 'customers', 'quotes']);
    expect(tiles[0].delta).toBe('+100% vs previous');
    expect(tiles[2].value).toBe('25.0%');
    expect(tiles[3].sub).toBe('Ordering: 2 new · 1 returning · 1 came back');
    expect(tiles[4].tone).toBe('warn');
    expect(tiles[4].sub).toContain('oldest 8 days');
    expect(tiles.map((t) => t.label).join(' ')).not.toMatch(/PostHog|DAU|WAU|MAU|Yukti/);
  });

  it('suppresses every delta for thin windows and when there is no comparison', () => {
    expect(buildScorecardTiles(sc({ period: { key: 'mtd', label: '', thin: true } }), now).every((t) => t.delta === undefined)).toBe(true);
    expect(buildScorecardTiles(sc({ previous: null, compare_window: null }), now).every((t) => t.delta === undefined)).toBe(true);
  });

  it('shows a dash instead of a percentage when nothing was invoiced', () => {
    const tiles = buildScorecardTiles(sc({ current: m({ total_invoiced_value: 0, app_invoiced_value: 0 }) }), now);
    expect(tiles[2].value).toBe('—');
    expect(tiles[2].sub).toBe('No invoices in this period');
  });

  it('never prints a conversion percentage; reports converted of total instead', () => {
    const tiles = buildScorecardTiles(sc({ current: m({ quotes: { count: 4, converted: 4, lost: 0, open: 0 } }), open_quotes: { count: 0, value: 0, oldest_at: null, older_than_48h_count: 0, older_than_48h_value: 0 } }), now);
    expect(tiles[4].sub).toBe('4 of 4 quotes in this period became invoices');
    expect(tiles[4].sub).not.toContain('%');
    expect(tiles[4].tone).toBeUndefined();
  });
});
