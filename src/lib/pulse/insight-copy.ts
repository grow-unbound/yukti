import type { Insight } from '@/lib/pulse/insights';

const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n))}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** English templates for each textKey. Slots come only from `evidence`; add locales by keying on textKey. */
export function insightText(insight: Insight): string {
  const e = insight.evidence;
  switch (insight.textKey) {
    case 'pulse.insight.open_quotes_aging':
      return `${e.n} ${plural(e.n, 'quote', 'quotes')} worth ${inr(e.value ?? 0)} ${plural(e.n, 'has', 'have')} waited over 2 days${e.ageDays != null ? `. Oldest: ${e.ageDays} ${plural(e.ageDays, 'day', 'days')}` : ''}.`;
    case 'pulse.insight.browse_no_quote':
      return `${e.n} ${plural(e.n, 'customer', 'customers')} browsed but did not order (${e.pct}% of customers who used the app).`;
    case 'pulse.insight.activity_change':
      return `${e.n} ${e.direction === 'down' ? 'fewer' : 'more'} ${plural(e.n, 'customer', 'customers')} used the app than in the previous ${e.windowDays ?? ''} days (${e.pct}%).`.replace('  ', ' ');
    case 'pulse.insight.reactivated':
      return `${e.n} ${plural(e.n, 'customer', 'customers')} who had gone quiet ordered again.`;
    case 'pulse.insight.large_quote_gap':
      return `Large quotes (${inr(e.value ?? 0)} and above) became invoices ${e.pct}% of the time, against ${e.pctOther}% for smaller ones. ${e.n} large ${plural(e.n, 'quote', 'quotes')} in this period.`;
    case 'pulse.insight.brand_concentration':
      return `${e.label} is ${e.pct}% of what was invoiced through the app, across ${e.n} brands.`;
  }
}
