import { formatNumberValue } from '@/lib/utils';
import type { PulseActGroup, PulseActGroupId, PulseActRow } from '@/types/pulse-v2';

export interface ActGroupCopy {
  title: string;
  description: string;
  actionLabel: string;
  actionHref: string;
  evidence: (g: Pick<PulseActGroup, 'count' | 'value'>) => string;
  rowMeta: (r: PulseActRow) => string;
}

const money = (n: number) => formatNumberValue(n, 'CURRENCY_THRESHOLD');
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const day = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : null;

export const ACT_GROUP_ORDER: PulseActGroupId[] = ['quotes_waiting', 'browse_no_quote', 'went_quiet', 'valuable_without_access'];

/** Owner-language copy per act-now group (no vendor names, no internal metric jargon). */
export const ACT_GROUP_COPY: Record<PulseActGroupId, ActGroupCopy> = {
  quotes_waiting: {
    title: 'Quotes waiting on you',
    description: 'Quotes sent more than 2 days ago that have not been invoiced.',
    actionLabel: 'Open Inbox',
    actionHref: '/inbox',
    evidence: (g) => `${money(g.value)} across ${formatNumberValue(g.count, 'COUNT')} ${plural(g.count, 'customer', 'customers')}`,
    rowMeta: (r) => `${money(r.value)} · ${r.n} ${plural(r.n, 'quote', 'quotes')}${day(r.last_day) ? ` · waiting since ${day(r.last_day)}` : ''}`,
  },
  browse_no_quote: {
    title: 'Browsed, never ordered',
    description: 'Customers who looked through the catalogue in this period but did not place a quote.',
    actionLabel: 'Open customers',
    actionHref: '/customers',
    evidence: (g) => `${formatNumberValue(g.count, 'COUNT')} ${plural(g.count, 'customer', 'customers')} to follow up`,
    rowMeta: (r) => `Browsed on ${r.n} ${plural(r.n, 'day', 'days')}${day(r.last_day) ? ` · last ${day(r.last_day)}` : ''}`,
  },
  went_quiet: {
    title: 'Customers who went quiet',
    description: 'Customers who ordered through the app before and have not used it for 30+ days.',
    actionLabel: 'Open customers',
    actionHref: '/customers',
    evidence: (g) => `${money(g.value)} ordered before by ${formatNumberValue(g.count, 'COUNT')} ${plural(g.count, 'customer', 'customers')}`,
    rowMeta: (r) => `${money(r.value)} ordered before${day(r.last_day) ? ` · last seen ${day(r.last_day)}` : ''}`,
  },
  valuable_without_access: {
    title: 'Customers to bring onto the app',
    description: 'High-value customers who still order the old way and do not have app access.',
    actionLabel: 'Open access management',
    actionHref: '/buyer-app/access',
    evidence: (g) => `${money(g.value)} invoiced to ${formatNumberValue(g.count, 'COUNT')} ${plural(g.count, 'customer', 'customers')} without access`,
    rowMeta: (r) => `${money(r.value)} invoiced · ${r.n} ${plural(r.n, 'invoice', 'invoices')}`,
  },
};
