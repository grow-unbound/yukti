import { formatDate, formatNumberValue } from '@/lib/utils';
import type { InboxEntry, InboxEntryType } from './inbox-types';

export const ENTRY_TYPE_LABEL: Record<InboxEntryType, string> = {
  business_approval: 'New account',
  new_user_login: 'New visitor',
  new_enquiry: 'Open enquiry',
  new_order_confirmation: 'New order',
  order_dispatch_needed: 'Confirmed, not dispatched',
  invoice_due: 'Invoice due',
  invoice_overdue: 'Invoice overdue',
  credit_limit_breach: 'Over credit limit',
  whatsapp_buyer_message: 'WhatsApp message',
  email_buyer_message: 'Email',
};

/** Approval entry raised by an existing buyer (app access disabled) tapping "Request access". */
export const EXISTING_BUYER_ACCESS_LABEL = 'Existing customer · app access';

export function isExistingBuyerAccessEntry(entry: Pick<InboxEntry, 'metadata'>): boolean {
  return entry.metadata?.request_kind === 'existing_buyer_access';
}

/** Type label, specialised for existing-buyer access requests (the SQL summary stays generic). */
export function entryTypeLabel(entry: Pick<InboxEntry, 'entry_type' | 'metadata'>): string {
  if (isExistingBuyerAccessEntry(entry)) return EXISTING_BUYER_ACCESS_LABEL;
  return ENTRY_TYPE_LABEL[entry.entry_type] ?? entry.entry_type;
}

export interface ExistingBuyerPeriodPair<T> {
  current: T;
  previous: T;
}

export interface ExistingBuyerContext {
  sales: ExistingBuyerPeriodPair<{ invoice_value: number; invoice_count: number }>;
  demand: { kind: 'orders' | 'estimates' | 'none' } & ExistingBuyerPeriodPair<{ value: number; count: number }>;
  dues: {
    receivable_amount: number;
    receivable_invoice_count: number;
    overdue_amount: number;
    overdue_invoice_count: number;
    credit_limit: number;
    credit_available: number | null;
  };
  /** Where each section's numbers came from: the metrics summaries, or a live single-buyer query. */
  sources: { period: 'summary' | 'live'; dues: 'summary' | 'live' };
  /** Stalest summary timestamp used; null when every section was computed live. */
  computed_at: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Sales / demand / dues snapshot app.request_buyer_app_access stored on the entry, or null. */
export function readExistingBuyerContext(entry: Pick<InboxEntry, 'metadata'>): ExistingBuyerContext | null {
  if (!isExistingBuyerAccessEntry(entry)) return null;
  const ctx = asRecord(entry.metadata?.buyer_context);
  if (Object.keys(ctx).length === 0) return null;
  const sales = asRecord(ctx.sales);
  const demand = asRecord(ctx.demand);
  const dues = asRecord(ctx.dues);
  const sale = (v: unknown) => ({ invoice_value: num(asRecord(v).invoice_value), invoice_count: num(asRecord(v).invoice_count) });
  const dem = (v: unknown) => ({ value: num(asRecord(v).value), count: num(asRecord(v).count) });
  const kind = demand.kind === 'orders' || demand.kind === 'estimates' ? demand.kind : 'none';
  const creditAvailable = dues.credit_available;
  return {
    sales: { current: sale(sales.current), previous: sale(sales.previous) },
    demand: { kind, current: dem(demand.current), previous: dem(demand.previous) },
    dues: {
      receivable_amount: num(dues.receivable_amount),
      receivable_invoice_count: num(dues.receivable_invoice_count),
      overdue_amount: num(dues.overdue_amount),
      overdue_invoice_count: num(dues.overdue_invoice_count),
      credit_limit: num(dues.credit_limit),
      credit_available: creditAvailable == null ? null : num(creditAvailable),
    },
    sources: {
      period: asRecord(ctx.sources).period === 'live' ? 'live' : 'summary',
      dues: asRecord(ctx.sources).dues === 'live' ? 'live' : 'summary',
    },
    computed_at: typeof ctx.computed_at === 'string' ? ctx.computed_at : null,
  };
}

export function buildEntryAmountLabel(entry: InboxEntry): string | null {
  if (entry.amount == null) return null;
  // Every entry type we sync is INR; a few synthetic types (credit_limit_breach) don't
  // carry a currency in metadata at all, so treat unset as INR rather than falling back
  // to a bare, symbol-less number.
  return formatNumberValue(entry.amount, !entry.currency || entry.currency === 'INR' ? 'CURRENCY_EXACT' : 'COUNT');
}

/** Type label + aging + count-formatted amount — never a currency symbol. */
export function buildEntrySubtitleParts(entry: InboxEntry): string[] {
  const parts: string[] = [entryTypeLabel(entry)];
  const amountLabel = buildEntryAmountLabel(entry);
  if (amountLabel) parts.push(amountLabel);
  return parts;
}

function numericMeta(entry: InboxEntry, key: string): number | null {
  const raw = entry.metadata?.[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function shortDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(date);
}

function ageLabel(entry: InboxEntry): string | null {
  const daysFromDue = numericMeta(entry, 'days_from_due');
  if (daysFromDue != null) {
    if (entry.entry_type === 'invoice_due') {
      if (daysFromDue === 0) return 'due today';
      if (daysFromDue === 1) return 'due tomorrow';
      return `due in ${daysFromDue} days`;
    }
    const overdueDays = Math.abs(daysFromDue);
    if (overdueDays === 1) return '1 day overdue';
    return `${overdueDays} days overdue`;
  }
  const dueDate = shortDate(entry.metadata?.due_date);
  return dueDate ? `due ${dueDate}` : null;
}

/** Amount first: "₹X overdue · N invoices", "₹X due in 7 days · N invoices", or "₹X due · N invoices · Z overdue" when mixed. */
export function buildDuesSummaryLine(total: number, invoiceCount: number, overdueCount: number): string {
  const totalLabel = formatNumberValue(total, 'CURRENCY_EXACT');
  const invoiceLabel = `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}`;
  if (invoiceCount > 0 && overdueCount === invoiceCount) return `${totalLabel} overdue · ${invoiceLabel}`;
  if (overdueCount === 0) return `${totalLabel} due in 7 days · ${invoiceLabel}`;
  return `${totalLabel} due · ${invoiceLabel} · ${overdueCount} overdue`;
}

/** "₹X over your ₹Y limit" — names both numbers so it isn't read against the wrong total (Dues, outstanding). */
export function buildCreditLimitSupportingLine(entry: InboxEntry): string | null {
  const overLimit = numericMeta(entry, 'over_limit_amount') ?? entry.amount;
  if (overLimit == null) return null;
  const overLabel = formatNumberValue(overLimit, 'CURRENCY_EXACT');
  const creditLimit = numericMeta(entry, 'credit_limit');
  return creditLimit != null ? `${overLabel} over your ${formatNumberValue(creditLimit, 'CURRENCY_EXACT')} limit` : `${overLabel} over limit`;
}

/**
 * Detail-view over-limit line from live open invoices (the entry's own numbers are a snapshot
 * from the last refresh). `changeNote` is set only when the live figure differs from that snapshot.
 */
export function buildLiveCreditLimitLine(
  entry: InboxEntry,
  liveOutstanding: number,
): { line: string; changeNote: string | null } | null {
  const creditLimit = numericMeta(entry, 'credit_limit');
  if (creditLimit == null) return null;
  const money = (value: number) => formatNumberValue(value, 'CURRENCY_EXACT');
  const liveOver = liveOutstanding - creditLimit;
  const line = liveOver > 0 ? `${money(liveOver)} over your ${money(creditLimit)} limit` : `Now within your ${money(creditLimit)} limit`;

  const snapshotOutstanding = numericMeta(entry, 'outstanding_balance');
  const snapshotOver = numericMeta(entry, 'over_limit_amount') ?? entry.amount;
  const changed = snapshotOutstanding != null && Math.round(snapshotOutstanding) !== Math.round(liveOutstanding);
  const changeNote = changed && snapshotOver != null ? `Was ${money(snapshotOver)} over when flagged` : null;
  return { line, changeNote };
}

export function buildListSupportingLine(entries: InboxEntry[]): string {
  if (entries.length === 0) return '';
  const collections = entries.filter((entry) => entry.entry_type === 'invoice_due' || entry.entry_type === 'invoice_overdue');
  if (collections.length > 0) {
    const total = collections.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
    const overdueCount = collections.filter((entry) => entry.entry_type === 'invoice_overdue').length;
    return buildDuesSummaryLine(total, collections.length, overdueCount);
  }

  const primary = entries[0];
  if (primary.entry_type === 'credit_limit_breach') {
    return buildCreditLimitSupportingLine(primary) ?? '';
  }
  if (primary.entry_type === 'business_approval') return 'New account';
  if (primary.entry_type === 'new_user_login') return 'New visitor';
  if (primary.entry_type === 'whatsapp_buyer_message') {
    const text = typeof primary.metadata.last_inbound_text === 'string' ? primary.metadata.last_inbound_text.trim() : '';
    return text || 'Buyer message';
  }
  if (primary.entry_type === 'email_buyer_message') {
    const subject = typeof primary.metadata.subject === 'string' ? primary.metadata.subject.trim() : '';
    return ['Email', subject].filter(Boolean).join(' · ');
  }
  if (primary.entry_type === 'invoice_due' || primary.entry_type === 'invoice_overdue') {
    return [buildEntryAmountLabel(primary), ageLabel(primary)].filter(Boolean).join(' · ');
  }
  const amount = buildEntryAmountLabel(primary);
  return [amount, entryTypeLabel(primary)].filter(Boolean).join(' · ');
}

export function buildDocumentDateLabel(entry: InboxEntry): string | null {
  if (entry.entry_type === 'invoice_due' || entry.entry_type === 'invoice_overdue') {
    return ageLabel(entry);
  }
  const createdAt = entry.created_at ? formatDate(entry.created_at) : null;
  return createdAt ? `Created ${createdAt}` : null;
}

/**
 * "₹1,800 – ₹2,000" when both bounds are given, "Max ₹1,500" / "Min ₹5,000"
 * when the buyer only gave one side, exact value when min === max. Null when
 * neither bound exists. A naive `${money(min)} – ${money(max)}` renders
 * "– – ₹1,500" or "₹5,000 – –" whenever only one bound is set -- this covers
 * that case explicitly instead of leaning on formatNumberValue's null output.
 */
export function buildTargetRangeLabel(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) {
    return min === max ? formatNumberValue(min, 'CURRENCY_EXACT') : `${formatNumberValue(min, 'CURRENCY_EXACT')} – ${formatNumberValue(max, 'CURRENCY_EXACT')}`;
  }
  return max != null ? `Max ${formatNumberValue(max, 'CURRENCY_EXACT')}` : `Min ${formatNumberValue(min!, 'CURRENCY_EXACT')}`;
}

export function getInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'IN'
  );
}
