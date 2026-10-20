import { describe, expect, it } from 'vitest';
import { buildReviewText, escapeHtml, renderReviewHtml, type PulseReviewData } from '@/lib/pulse/review';
import type { PulseScorecardResponse, PulseWindowMetrics } from '@/types/pulse-v2';

const m = (over: Partial<PulseWindowMetrics> = {}): PulseWindowMetrics => ({
  demand_value: 250000, demand_docs: 20, demand_buyers: 12,
  quotes: { count: 20, converted: 8, lost: 0, open: 12 }, median_quote: 3000, avg_lines: 3,
  app_invoiced_value: 120000, app_invoiced_docs: 9, app_invoiced_buyers: 7, total_invoiced_value: 600000, total_invoiced_docs: 40,
  engaged_buyers: 30, ...over,
});
const scorecard: PulseScorecardResponse = {
  period: { key: 'mtd', label: 'This month', thin: false },
  window: { from: '2026-10-01', to_excl: '2026-10-19' }, compare_window: null,
  current: m(), previous: null,
  open_quotes: { count: 12, value: 90000, oldest_at: '2026-10-01T00:00:00Z', older_than_48h_count: 12, older_than_48h_value: 90000 },
  quoting_buyers: { new: 5, returning: 6, reactivated: 1 }, generated_at: '',
};
const data = (name = 'Acme <Traders>'): PulseReviewData => ({
  businessName: name, periodLabel: 'This month', rangeLabel: '1 Oct – 18 Oct', compareLabel: null, generatedAt: new Date('2026-10-18T10:00:00Z'),
  scorecard, insights: [], actNow: null, funnel: null, categories: null, brands: null, customers: null,
});

describe('pulse review', () => {
  it('escapes markup in every interpolated string', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    const html = renderReviewHtml(data());
    expect(html).toContain('Acme &lt;Traders&gt;');
    expect(html).not.toContain('<Traders>');
  });

  it('is self-contained: no scripts and no external requests', () => {
    const html = renderReviewHtml(data());
    expect(html).not.toMatch(/<script|<link|src=|http:\/\/|https:\/\//i);
  });

  it('uses owner language, never vendor or internal metric names', () => {
    const html = renderReviewHtml(data());
    expect(html).not.toMatch(/posthog|DAU|WAU|MAU/i);
  });

  it('text summary carries the headline numbers and the period', () => {
    const text = buildReviewText({ periodLabel: 'This month', rangeLabel: '1 Oct – 18 Oct', scorecard, insights: [] });
    expect(text.startsWith('App review, This month (1 Oct – 18 Oct)')).toBe(true);
    expect(text).toContain('Share of all invoiced: 20.0%');
  });
});
