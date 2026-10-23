import { formatNumberValue } from '@/lib/utils';
import type { PulseScorecardResponse, PulseWindowMetrics } from '@/types/pulse-v2';

export interface ScorecardTile {
  id: 'demand' | 'invoiced' | 'share' | 'customers' | 'quotes';
  label: string;
  value: string;
  sub?: string;
  delta?: string;
  deltaTone?: 'up' | 'down';
  tone?: 'warn';
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const money = (n: number) => formatNumberValue(n, 'CURRENCY_THRESHOLD');
const count = (n: number) => formatNumberValue(n, 'COUNT');

/** Minimum number of documents/customers in the comparison window before a percentage change is shown. */
export const DELTA_MIN_BASE = 5;

/**
 * Relative change vs the comparison window; undefined when there is no usable base: none, zero, a thin window,
 * or fewer than DELTA_MIN_BASE underlying documents/customers (a swing from 3 to 1 is noise, not a trend).
 */
export function relativeDelta(
  current: number,
  previous: number | null | undefined,
  baseCount: number = DELTA_MIN_BASE,
): { text: string; tone: 'up' | 'down' } | undefined {
  if (previous == null || previous <= 0 || baseCount < DELTA_MIN_BASE) return undefined;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return undefined;
  return { text: `${pct > 0 ? '+' : ''}${pct}% vs previous`, tone: pct > 0 ? 'up' : 'down' };
}

function sharePct(m: PulseWindowMetrics | null): number | null {
  if (!m || m.total_invoiced_value <= 0) return null;
  return (m.app_invoiced_value / m.total_invoiced_value) * 100;
}

function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
}

export function buildScorecardTiles(sc: PulseScorecardResponse, now: Date = new Date()): ScorecardTile[] {
  const cur = sc.current;
  const prev = sc.period.thin ? null : sc.previous;
  const tiles: ScorecardTile[] = [];

  const d1 = relativeDelta(cur.demand_value, prev?.demand_value, prev?.demand_docs ?? 0);
  const demandLabel = cur.primary_demand_kind === 'orders'
    ? 'Orders received'
    : cur.primary_demand_kind === 'estimates'
      ? 'Quotes received'
      : 'Demand received';
  const demandNoun = cur.primary_demand_kind === 'orders'
    ? plural(cur.demand_docs, 'order', 'orders')
    : cur.primary_demand_kind === 'estimates'
      ? plural(cur.demand_docs, 'quote', 'quotes')
      : plural(cur.demand_docs, 'document', 'documents');
  tiles.push({
    id: 'demand',
    label: demandLabel,
    value: money(cur.demand_value),
    sub: `${count(cur.demand_docs)} ${demandNoun} from ${count(cur.demand_buyers)} ${plural(cur.demand_buyers, 'customer', 'customers')}`,
    delta: d1?.text,
    deltaTone: d1?.tone,
  });

  const d2 = relativeDelta(cur.app_invoiced_value, prev?.app_invoiced_value, prev?.app_invoiced_docs ?? 0);
  tiles.push({
    id: 'invoiced',
    label: 'Invoiced from the app',
    value: money(cur.app_invoiced_value),
    sub: `${count(cur.app_invoiced_docs)} ${plural(cur.app_invoiced_docs, 'invoice', 'invoices')} from ${count(cur.app_invoiced_buyers)} ${plural(cur.app_invoiced_buyers, 'customer', 'customers')}`,
    delta: d2?.text,
    deltaTone: d2?.tone,
  });

  const share = sharePct(cur);
  const prevShare = sharePct(prev);
  const shareBase = Math.min(cur.total_invoiced_docs, prev?.total_invoiced_docs ?? 0);
  const shareDelta = share != null && prevShare != null && shareBase >= DELTA_MIN_BASE ? Math.round((share - prevShare) * 10) / 10 : null;
  tiles.push({
    id: 'share',
    label: 'Share of all invoiced',
    value: share == null ? '—' : `${share.toFixed(1)}%`,
    sub: cur.total_invoiced_value > 0 ? `of ${money(cur.total_invoiced_value)} invoiced in total` : 'No invoices in this period',
    delta: shareDelta != null && shareDelta !== 0 ? `${shareDelta > 0 ? '+' : ''}${shareDelta} pts vs previous` : undefined,
    deltaTone: shareDelta != null && shareDelta !== 0 ? (shareDelta > 0 ? 'up' : 'down') : undefined,
  });

  const d4 = relativeDelta(cur.engaged_buyers, prev?.engaged_buyers, prev?.engaged_buyers ?? 0);
  const { new: nNew, returning, reactivated } = sc.quoting_buyers;
  const mix = [nNew > 0 ? `${count(nNew)} new` : null, returning > 0 ? `${count(returning)} returning` : null, reactivated > 0 ? `${count(reactivated)} came back` : null]
    .filter(Boolean)
    .join(' · ');
  tiles.push({
    id: 'customers',
    label: 'Customers who used the app',
    value: count(cur.engaged_buyers),
    sub: mix ? `Ordering: ${mix}` : 'None placed an order yet',
    delta: d4?.text,
    deltaTone: d4?.tone,
  });

  // Open quotes are a state (now), not windowed. The "converted" figure is shown as a count so a closed-quote
  // percentage is never printed when nothing has closed yet (assessment §3).
  const oldest = ageDays(sc.open_quotes.oldest_at, now);
  tiles.push({
    id: 'quotes',
    label: 'Quotes waiting on you',
    value: count(sc.open_quotes.count),
    sub: sc.open_quotes.count > 0
      ? `${money(sc.open_quotes.value)}${oldest != null ? ` · oldest ${oldest} ${plural(oldest, 'day', 'days')}` : ''} · ${count(cur.quotes.converted)} of ${count(cur.quotes.count)} quotes in this period became invoices`
      : `${count(cur.quotes.converted)} of ${count(cur.quotes.count)} quotes in this period became invoices`,
    tone: sc.open_quotes.older_than_48h_count > 0 ? 'warn' : undefined,
  });

  return tiles;
}
