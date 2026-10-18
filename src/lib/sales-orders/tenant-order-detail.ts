import type { EstimateComposerLineRow } from '@/components/seller/document-composer/LinesTable';
import { computeDisplayDocumentTotals, computeLineTaxableAmount, roundMoney } from '@/lib/gst';
import type { SalesOrderActivityRow, SalesOrderDetail, SalesOrderUiStatus } from '@/types/tenant-sales-orders';

export interface SalesOrderStepperTimestamps {
  received?: string;
  confirmed?: string;
  dispatched?: string;
  delivered?: string;
  cancelled?: string;
}

const DB_TO_UI: Record<string, SalesOrderUiStatus | undefined> = {
  draft: 'received',
  open: 'received',
  received: 'received',
  confirmed: 'confirmed',
  partially_invoiced: 'confirmed',
  partially_dispatched: 'dispatched',
  dispatched: 'dispatched',
  delivered: 'delivered',
  invoiced: 'delivered',
  overdue: 'confirmed',
  void: 'cancelled',
  cancelled: 'cancelled',
};

export function toSalesOrderUiStatus(dbStatus: string): SalesOrderUiStatus | null {
  return DB_TO_UI[dbStatus] ?? null;
}

export function formatEstimateChipLabel(estimateNumber: string | null): string {
  if (estimateNumber && estimateNumber.trim().length > 0) {
    return estimateNumber.startsWith('EST-') ? estimateNumber : `EST-${estimateNumber}`;
  }
  return 'EST-—';
}

export function channelLabel(source: string | null): string {
  if (source === 'buyer_app') return 'Buyer app';
  if (source === 'cockpit_manual') return 'Seller cockpit';
  if (source === 'csv_import') return 'CSV import';
  return '—';
}

function activityTimestamp(value: string | number | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return new Date(value).toISOString();
}

export function buildActivityFromAudit(
  orderId: string,
  orderNumber: string,
  placedAt: string | number | null,
  linesCount: number,
  units: number,
  catalogName: string | null,
  channel: string,
  audits: Array<{ id: string | number; action: string; diff: unknown; ts: string; actor_user_id: string | null }>,
): SalesOrderActivityRow[] {
  const rows: SalesOrderActivityRow[] = [];

  rows.push({
    id: `placed-${orderId}`,
    kind: 'placed',
    title: 'Order placed',
    detail: `${linesCount} lines · ${units} units · via ${catalogName ?? '—'}`,
    who: channel,
    at: activityTimestamp(placedAt),
    tone: 'neutral',
  });

  const sorted = [...audits].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  for (const entry of sorted) {
    const diff = entry.diff as Record<string, unknown> | null;
    const status = typeof diff?.status === 'string' ? diff.status : null;

    if (entry.action === 'status_change' && status === 'confirmed') {
      rows.push({
        id: String(entry.id),
        kind: 'confirmed',
        title: 'Order confirmed',
        detail: `Stock reserved · order ${orderNumber}`,
        who: 'Seller',
        at: entry.ts,
        tone: 'accent',
      });
      continue;
    }
    if (entry.action === 'status_change' && status === 'dispatched') {
      rows.push({
        id: String(entry.id),
        kind: 'dispatched',
        title: 'Dispatched',
        detail: 'Order marked dispatched',
        who: 'Seller',
        at: entry.ts,
      });
      continue;
    }
    if (entry.action === 'status_change' && status === 'delivered') {
      rows.push({
        id: String(entry.id),
        kind: 'delivered',
        title: 'Delivered',
        detail: 'Order marked delivered',
        who: 'Seller',
        at: entry.ts,
        tone: 'success',
      });
      continue;
    }
    if (entry.action === 'status_change' && status === 'cancelled') {
      rows.push({
        id: String(entry.id),
        kind: 'cancelled',
        title: 'Order cancelled',
        detail: typeof diff?.notes === 'string' ? String(diff.notes) : 'Order was cancelled',
        who: 'Seller',
        at: entry.ts,
        tone: 'danger',
      });
      continue;
    }
    if (entry.action === 'update') {
      rows.push({
        id: String(entry.id),
        kind: 'line_edited',
        title: 'Line edited',
        detail: 'Order lines were updated',
        who: 'Seller',
        at: entry.ts,
      });
    }
  }

  // Newest-first: sort by at descending
  return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export interface LifecycleIsoTimestamps {
  received_at: string | null;
  confirmed_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

/** Raw ISO-ish timestamps from audit trail when lifecycle columns are null. */
export function extractLifecycleIsoFromAudits(
  placedAt: string | null,
  audits: Array<{ action: string; diff: unknown; ts: string }>,
): LifecycleIsoTimestamps {
  const out: LifecycleIsoTimestamps = {
    received_at: placedAt,
    confirmed_at: null,
    dispatched_at: null,
    delivered_at: null,
    cancelled_at: null,
  };
  const chronological = [...audits].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  for (const entry of chronological) {
    const diff = entry.diff as Record<string, unknown> | null;
    const status = typeof diff?.status === 'string' ? diff.status : null;
    if (entry.action !== 'status_change' || !status) continue;
    const ts = entry.ts;
    if (status === 'received') out.received_at = out.received_at ?? ts;
    if (status === 'confirmed') out.confirmed_at = ts;
    if (status === 'dispatched' || status === 'partially_dispatched') out.dispatched_at = ts;
    if (status === 'delivered' || status === 'invoiced' || status === 'partially_invoiced') out.delivered_at = ts;
    if (status === 'cancelled') out.cancelled_at = ts;
  }
  return out;
}

export function mergeLifecycleColumns(
  row: {
    received_at: string | null;
    confirmed_at: string | null;
    dispatched_at: string | null;
    delivered_at: string | null;
    cancelled_at: string | null;
  },
  auditDerived: LifecycleIsoTimestamps,
): LifecycleIsoTimestamps {
  return {
    received_at: row.received_at ?? auditDerived.received_at,
    confirmed_at: row.confirmed_at ?? auditDerived.confirmed_at,
    dispatched_at: row.dispatched_at ?? auditDerived.dispatched_at,
    delivered_at: row.delivered_at ?? auditDerived.delivered_at,
    cancelled_at: row.cancelled_at ?? auditDerived.cancelled_at,
  };
}

export function extractStepperTimestamps(
  placedAt: string | null,
  audits: Array<{ action: string; diff: unknown; ts: string }>,
): SalesOrderStepperTimestamps {
  const out: SalesOrderStepperTimestamps = {};
  if (placedAt) {
    out.received = new Date(placedAt).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  const chronological = [...audits].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  for (const entry of chronological) {
    const diff = entry.diff as Record<string, unknown> | null;
    const status = typeof diff?.status === 'string' ? diff.status : null;
    if (entry.action !== 'status_change' || !status) continue;
    const label = new Date(entry.ts).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    if (status === 'confirmed') out.confirmed = label;
    if (status === 'dispatched' || status === 'partially_dispatched') out.dispatched = label;
    if (status === 'delivered' || status === 'invoiced') out.delivered = label;
    if (status === 'cancelled') out.cancelled = label;
  }
  return out;
}

export function pickInvoiceForOrder(
  invoices: Array<{
    id: string;
    invoice_number: string;
    invoice_date: string;
    status: string;
    subtotal: number | null;
    tax_amount: number | null;
    total_amount: number | null;
  }>,
): (typeof invoices)[0] | null {
  if (invoices.length === 0) return null;
  return [...invoices].sort((a, b) => new Date(b.invoice_date).getTime() - new Date(a.invoice_date).getTime())[0] ?? null;
}

export function productDisplayName(
  nameOverride: string | null,
  masterName: string | null,
): string {
  if (nameOverride && nameOverride.trim()) return nameOverride.trim();
  if (masterName && masterName.trim()) return masterName.trim();
  return 'Product';
}

function brandHueFromIndex(index: number): 'teal' | 'ember' | 'cream' {
  if (index % 3 === 0) return 'teal';
  if (index % 3 === 1) return 'ember';
  return 'cream';
}

function initialsForBrand(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '—';
}

export function mapSalesOrderDetailToComposerLines(detail: SalesOrderDetail): EstimateComposerLineRow[] {
  return detail.lines.map((line, index) => ({
    id: line.id,
    tenant_product_id: line.tenant_product_id,
    product_name: line.name,
    sku: line.sku,
    brand_name: line.brand,
    brand_initials: line.brand_initials || initialsForBrand(line.brand),
    brand_hue: line.brand_hue ?? brandHueFromIndex(index),
    image_url: line.image_url ?? null,
    hsn_code: line.hsn_code,
    on_hand: line.on_hand,
    qty: line.qty,
    unit_price: line.unit_price,
    mrp: 0,
    base_selling_price: line.unit_price,
    disc_pct: line.disc_pct,
    tax_pct: line.tax_pct ?? line.tax_rate ?? 0,
    // Price captured on the order line; stored line_total can be ex-GST after the Zoho sync-back.
    line_total: roundMoney(computeLineTaxableAmount({ qty: line.qty, unit_price: line.unit_price, disc_pct: line.disc_pct })),
    scheme_tag: line.scheme_tag ?? null,
    diff: 'clean',
    default_uom: line.unit,
  }));
}

/** Header totals derived from line unit prices; tax is 0 for GST-inclusive tenants, else the stored tax. */
export function deriveSalesOrderDisplayTotals(detail: SalesOrderDetail, gstInclusive: boolean) {
  const discountFlat = detail.discount_flat ?? 0;
  const freight = detail.freight ?? 0;
  const roundOff = detail.round_off ?? 0;
  const display = computeDisplayDocumentTotals(
    detail.lines.map((line) => ({ qty: line.qty, unit_price: line.unit_price, disc_pct: line.disc_pct })),
    { gstInclusive, taxAmount: detail.tax_amount, discount_flat: discountFlat, freight, round_off: roundOff },
  );
  return {
    subtotal: display.subtotal,
    discount_flat: discountFlat,
    freight,
    taxable_amount: Math.max(display.subtotal - discountFlat, 0),
    tax_amount: display.tax_amount,
    grand_total: display.grand_total,
    round_off: roundOff,
    total_units: detail.lines.reduce((sum, line) => sum + line.qty, 0),
    gst_inclusive: gstInclusive,
  };
}
