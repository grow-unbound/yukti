import { formatNumberValue } from '@/lib/utils';
import type { EnquirySummary, EnquiryTriageLine } from './enquiry-triage';

/** "₹13,570 · 3 items · Cabernet Sauvignon +2 more" -- the Inbox list row's preview line for an
 * enquiry. The total is the live estimate total (0 until the seller quotes a hidden-price enquiry). */
export function buildEnquiryPreviewLine(lines: EnquiryTriageLine[], totalAmount?: number | null): string {
  if (lines.length === 0) return 'No items';
  const itemLabel = `${lines.length} item${lines.length === 1 ? '' : 's'}`;
  const first = lines[0]!.name;
  const rest = lines.length - 1;
  const preview = rest > 0 ? `${first} +${rest} more` : first;
  const total = totalAmount != null && totalAmount > 0 ? `${formatNumberValue(totalAmount, 'CURRENCY_EXACT')} · ` : '';
  return `${total}${itemLabel} · ${preview}`;
}

export function enquiryHasAtRiskLine(lines: EnquiryTriageLine[]): boolean {
  return lines.some((line) => line.stock.tone !== 'ok');
}

/** Same preview line as `buildEnquiryPreviewLine`, from the list endpoint's summary (no per-line payload). */
export function buildEnquirySummaryLine(summary: Pick<EnquirySummary, 'lineCount' | 'firstLineName' | 'totalAmount'>): string {
  if (summary.lineCount === 0) return 'No items';
  const itemLabel = `${summary.lineCount} item${summary.lineCount === 1 ? '' : 's'}`;
  const rest = summary.lineCount - 1;
  const first = summary.firstLineName ?? 'Product';
  const preview = rest > 0 ? `${first} +${rest} more` : first;
  const total = summary.totalAmount != null && summary.totalAmount > 0 ? `${formatNumberValue(summary.totalAmount, 'CURRENCY_EXACT')} · ` : '';
  return `${total}${itemLabel} · ${preview}`;
}
