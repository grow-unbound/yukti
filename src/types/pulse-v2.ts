import type { PulsePeriodKey, PulseWindow } from '@/lib/pulse/period';

/** Payloads of app.get_pulse_* (computed at request time from raw tables). */

export interface PulseWindowMetrics {
  primary_demand_kind: 'estimates' | 'orders' | 'none';
  demand_value: number;
  demand_docs: number;
  demand_buyers: number;
  quotes: { count: number; converted: number; lost: number; open: number };
  median_quote: number | null;
  avg_lines: number | null;
  app_invoiced_value: number;
  app_invoiced_docs: number;
  app_invoiced_buyers: number;
  total_invoiced_value: number;
  total_invoiced_docs: number;
  engaged_buyers: number;
}

export interface PulseOpenQuotes {
  count: number;
  value: number;
  oldest_at: string | null;
  older_than_48h_count: number;
  older_than_48h_value: number;
}

export interface PulseScorecardResponse {
  period: { key: PulsePeriodKey; label: string; thin: boolean };
  window: { from: string; to_excl: string };
  compare_window: { from: string; to_excl: string } | null;
  current: PulseWindowMetrics;
  previous: PulseWindowMetrics | null;
  open_quotes: PulseOpenQuotes;
  quoting_buyers: { new: number; returning: number; reactivated: number };
  generated_at: string;
}

export type PulseActGroupId = 'quotes_waiting' | 'browse_no_quote' | 'went_quiet' | 'valuable_without_access';

export interface PulseActRow {
  buyer_id: string;
  name: string;
  value: number;
  n: number;
  last_day: string | null;
}

export interface PulseActGroup {
  id: PulseActGroupId;
  count: number;
  value: number;
  previews: PulseActRow[];
}

export interface PulseActNowResponse {
  period: { key: PulsePeriodKey; label: string; thin: boolean };
  window: { from: string; to_excl: string };
  groups: PulseActGroup[];
  generated_at: string;
}

export interface PulseActBuyersPage {
  id: PulseActGroupId;
  total: number;
  value: number;
  rows: PulseActRow[];
  nextOffset: number | null;
}

export interface PulseFunnelResponse {
  period: { key: PulsePeriodKey; label: string; thin: boolean };
  window: { from: string; to_excl: string };
  /** Present when the window exceeds the activity cap: the funnel is skipped and the UI explains why. */
  capped: boolean;
  funnel: { users: number; browsed: number; quoted: number; invoiced: number } | null;
  days: Array<{ day: string; active_buyers: number; quotes: number; quote_value: number }>;
  generated_at: string;
}

export type { PulseWindow };

export type PulseSellDimension = 'category' | 'brand' | 'product';

export interface PulseSellRow {
  id: string | null;
  name: string;
  quoted_value: number;
  quoted_qty: number;
  quoted_docs: number;
  invoiced_value: number;
  invoiced_qty: number;
  invoiced_docs: number;
}

export interface PulseSellThroughResponse {
  period: { key: PulsePeriodKey; label: string; thin: boolean };
  window: { from: string; to_excl: string };
  dimension: PulseSellDimension;
  /** The line-level view covers at most 92 days; longer windows are skipped and the UI explains why. */
  capped: boolean;
  rows: PulseSellRow[];
  totals: { quoted_value: number; invoiced_value: number; items: number } | null;
  generated_at: string;
}

export interface PulseCustomerRow {
  buyer_id: string;
  name: string;
  invoiced_value: number;
  invoiced_docs: number;
  quoted_value: number;
  quoted_docs: number;
  last_day: string | null;
}

export interface PulseCustomersResponse {
  period: { key: PulsePeriodKey; label: string; thin: boolean };
  window: { from: string; to_excl: string };
  top: PulseCustomerRow[];
  summary: {
    buyers: number;
    invoicing_buyers: number;
    repeat_buyers: number;
    invoiced_value: number;
    top3_invoiced_value: number;
    avg_invoice: number | null;
    median_invoice: number | null;
  };
  generated_at: string;
}

export interface PulseQuoteOutcomes {
  count: number;
  converted: number;
  lost: number;
  open: number;
}

export interface PulsePatternsResponse {
  period: { key: PulsePeriodKey; label: string; thin: boolean };
  window: { from: string; to_excl: string };
  /** dow follows ISO: 1 = Monday ... 7 = Sunday. */
  weekdays: Array<{ dow: number; quotes: number; value: number }>;
  quote_sizes: { threshold: number; large: PulseQuoteOutcomes; small: PulseQuoteOutcomes };
  generated_at: string;
}
