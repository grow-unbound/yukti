// Deterministic insight engine (assessment §6). Rules own their guards (minimum n, comparable windows, spread);
// templates are keyed so copy can move to i18n later. Numbers and claims never come from a model.
import type {
  PulseActGroup,
  PulseActNowResponse,
  PulseFunnelResponse,
  PulsePatternsResponse,
  PulseScorecardResponse,
  PulseSellThroughResponse,
} from '@/types/pulse-v2';

export type InsightSeverity = 'act' | 'watch' | 'info';
export type InsightId = 'open_quotes_aging' | 'browse_no_quote' | 'activity_change' | 'reactivated' | 'large_quote_gap' | 'brand_concentration';

export interface Insight {
  id: InsightId;
  severity: InsightSeverity;
  textKey: `pulse.insight.${InsightId}`;
  evidence: {
    n: number;
    value?: number;
    pct?: number;
    pctOther?: number;
    ageDays?: number;
    windowDays?: number;
    direction?: 'up' | 'down';
    label?: string;
  };
  action: { labelKey: string; href: string };
}

/** Guard constants, kept in one place so thresholds are reviewable and tested. */
export const INSIGHT_MIN = {
  openQuotes: 5,
  browseBuyers: 20,
  browseShare: 0.2,
  activityBase: 20,
  activityChange: 0.2,
  reactivated: 3,
  largeQuotes: 5,
  smallQuotes: 5,
  largeQuoteGapPts: 0.15,
  brandShare: 0.5,
  brandCount: 3,
  brandInvoicedValue: 10_000,
} as const;

export interface InsightInput {
  scorecard: PulseScorecardResponse | null;
  actNow: PulseActNowResponse | null;
  funnel: PulseFunnelResponse | null;
  /** Brand-dimension sell-through for the same window (null while loading or when capped). */
  brands?: PulseSellThroughResponse | null;
  patterns?: PulsePatternsResponse | null;
  now?: Date;
}

const DAY_MS = 86_400_000;

function group(actNow: PulseActNowResponse | null, id: PulseActGroup['id']): PulseActGroup | null {
  return actNow?.groups.find((g) => g.id === id) ?? null;
}

type Rule = (input: InsightInput) => Insight | null;

const openQuotesAging: Rule = ({ scorecard, now }) => {
  const open = scorecard?.open_quotes;
  if (!open || open.older_than_48h_count < INSIGHT_MIN.openQuotes) return null;
  const ageDays = open.oldest_at ? Math.max(0, Math.floor(((now ?? new Date()).getTime() - new Date(open.oldest_at).getTime()) / DAY_MS)) : undefined;
  return {
    id: 'open_quotes_aging',
    severity: 'act',
    textKey: 'pulse.insight.open_quotes_aging',
    evidence: { n: open.older_than_48h_count, value: open.older_than_48h_value, ageDays },
    action: { labelKey: 'pulse.action.open_inbox', href: '/inbox' },
  };
};

const browseNoQuote: Rule = ({ actNow, funnel }) => {
  const g = group(actNow, 'browse_no_quote');
  const users = funnel?.funnel?.users ?? 0;
  if (!g || g.count < INSIGHT_MIN.browseBuyers || users <= 0 || g.count / users < INSIGHT_MIN.browseShare) return null;
  return {
    id: 'browse_no_quote',
    severity: 'act',
    textKey: 'pulse.insight.browse_no_quote',
    evidence: { n: g.count, pct: Math.round((g.count / users) * 100) },
    action: { labelKey: 'pulse.action.see_customers', href: '/pulse?group=browse_no_quote' },
  };
};

const activityChange: Rule = ({ scorecard }) => {
  if (!scorecard || scorecard.period.thin || !scorecard.previous) return null;
  const prev = scorecard.previous.engaged_buyers;
  const cur = scorecard.current.engaged_buyers;
  if (prev < INSIGHT_MIN.activityBase) return null;
  const change = (cur - prev) / prev;
  if (Math.abs(change) < INSIGHT_MIN.activityChange) return null;
  const windowDays = scorecard.compare_window
    ? Math.round((Date.parse(scorecard.compare_window.to_excl) - Date.parse(scorecard.compare_window.from)) / DAY_MS)
    : undefined;
  return {
    id: 'activity_change',
    severity: change < 0 ? 'watch' : 'info',
    textKey: 'pulse.insight.activity_change',
    evidence: { n: Math.abs(cur - prev), pct: Math.round(Math.abs(change) * 100), windowDays, direction: change < 0 ? 'down' : 'up' },
    action: { labelKey: 'pulse.action.see_funnel', href: '/pulse#funnel' },
  };
};

const reactivated: Rule = ({ scorecard }) => {
  const n = scorecard?.quoting_buyers.reactivated ?? 0;
  if (n < INSIGHT_MIN.reactivated) return null;
  return {
    id: 'reactivated',
    severity: 'info',
    textKey: 'pulse.insight.reactivated',
    evidence: { n },
    action: { labelKey: 'pulse.action.see_customers', href: '/customers' },
  };
};

const largeQuoteGap: Rule = ({ patterns }) => {
  const sizes = patterns?.quote_sizes;
  if (!sizes || sizes.large.count < INSIGHT_MIN.largeQuotes || sizes.small.count < INSIGHT_MIN.smallQuotes) return null;
  const large = sizes.large.converted / sizes.large.count;
  const small = sizes.small.converted / sizes.small.count;
  if (small - large < INSIGHT_MIN.largeQuoteGapPts) return null;
  return {
    id: 'large_quote_gap',
    severity: 'act',
    textKey: 'pulse.insight.large_quote_gap',
    evidence: { n: sizes.large.count, value: sizes.threshold, pct: Math.round(large * 100), pctOther: Math.round(small * 100) },
    action: { labelKey: 'pulse.action.open_inbox', href: '/inbox' },
  };
};

const brandConcentration: Rule = ({ brands }) => {
  if (!brands || brands.capped || !brands.totals) return null;
  const { invoiced_value: total, items } = brands.totals;
  const topBrand = brands.rows[0];
  if (items < INSIGHT_MIN.brandCount || total < INSIGHT_MIN.brandInvoicedValue || !topBrand) return null;
  const share = topBrand.invoiced_value / total;
  if (share < INSIGHT_MIN.brandShare) return null;
  return {
    id: 'brand_concentration',
    severity: 'watch',
    textKey: 'pulse.insight.brand_concentration',
    evidence: { n: items, pct: Math.round(share * 100), label: topBrand.name },
    action: { labelKey: 'pulse.action.see_sales', href: '/pulse#what-sells' },
  };
};

const RULES: Rule[] = [openQuotesAging, browseNoQuote, largeQuoteGap, activityChange, brandConcentration, reactivated];
const SEVERITY_ORDER: Record<InsightSeverity, number> = { act: 0, watch: 1, info: 2 };

/** All insights that pass their guards, most urgent first, at most `limit`. */
export function buildInsights(input: InsightInput, limit = 4): Insight[] {
  return RULES.map((rule) => rule(input))
    .filter((i): i is Insight => i !== null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, limit);
}
