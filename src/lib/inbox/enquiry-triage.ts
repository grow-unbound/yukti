export type EnquiryStockTone = 'ok' | 'warning' | 'danger';

export interface EnquiryStockStatus {
  tone: EnquiryStockTone;
  label: string;
  shortBy: number;
}

export interface EnquiryVelocity {
  /** Units invoiced per week, derived from the precomputed 90-day snapshot. */
  unitsPerWeek: number;
  daysCover: number | null;
  lastInvoiceAt: string | null;
}

export interface EnquiryAlternate {
  tenantProductId: string;
  name: string;
  sku: string;
  brandName: string | null;
  available: number;
  velocity: EnquiryVelocity;
  sameBrand: boolean;
  sameCategory: boolean;
  /** What this buyer would actually pay for it (app.resolve_price) -- null if it couldn't be resolved. */
  buyerPrice: number | null;
}

/**
 * `priced` — seller has a unit price and it's in stock.
 * `priced_oos` — seller has a unit price, but the line is out of stock.
 * `target_only` — no seller price yet, but the buyer gave a target range.
 * `awaiting_quote` — no seller price, no buyer target either.
 */
export type EnquiryLinePriceState = 'priced' | 'target_only' | 'awaiting_quote' | 'priced_oos';

export function deriveLinePriceState(line: {
  unitPrice: number | null;
  targetMin: number | null;
  targetMax: number | null;
  stockTone: EnquiryStockTone;
}): EnquiryLinePriceState {
  if (line.unitPrice != null) return line.stockTone === 'danger' ? 'priced_oos' : 'priced';
  return line.targetMin != null || line.targetMax != null ? 'target_only' : 'awaiting_quote';
}

export interface EnquiryTriageLine {
  id: string;
  tenantProductId: string;
  name: string;
  sku: string;
  brandName: string | null;
  qty: number;
  /** Seller-side unit price; null when the enquiry was raised against hidden pricing. */
  unitPrice: number | null;
  targetMin: number | null;
  targetMax: number | null;
  buyerNote: string | null;
  onHand: number;
  stock: EnquiryStockStatus;
  /** What this buyer would actually pay for this product at this qty right now
   * (app.resolve_price precedence) -- a reference for the seller to quote
   * against, distinct from `unitPrice` (whatever price the seller has or
   * hasn't already set on this enquiry line). Null when there's no buyer to
   * resolve a price for (e.g. a guest-originated enquiry). */
  resolvedPrice: number | null;
  velocity: EnquiryVelocity;
  alternates: EnquiryAlternate[];
  priceState: EnquiryLinePriceState;
}

export interface EnquiryTriagePayload {
  estimateId: string;
  estimateNumber: string;
  status: string;
  hiddenPricing: boolean;
  collectTargetUnitPriceRange: boolean;
  totalAmount: number | null;
  notes: string | null;
  lines: EnquiryTriageLine[];
}

const SNAPSHOT_WINDOW_WEEKS = 90 / 7;

/** Mirrors `stockStatusForLine` in document-composer/LinesTable (kept in sync by test). */
export function enquiryStockStatus(qty: number, onHand: number): EnquiryStockStatus {
  if (!Number.isFinite(onHand)) return { tone: 'ok', label: 'In stock', shortBy: 0 };
  if (onHand <= 0) return { tone: 'danger', label: 'Out of stock', shortBy: Math.max(qty, 0) };
  if (qty > onHand) return { tone: 'warning', label: `Short by ${qty - onHand}`, shortBy: qty - onHand };
  return { tone: 'ok', label: 'In stock', shortBy: 0 };
}

export function deriveVelocity(snapshot: {
  invoice_units_90d?: unknown;
  days_cover?: unknown;
  last_invoice_at?: unknown;
} | null | undefined): EnquiryVelocity {
  const units = Number(snapshot?.invoice_units_90d ?? 0);
  const cover = snapshot?.days_cover == null ? null : Number(snapshot.days_cover);
  return {
    unitsPerWeek: Number.isFinite(units) ? Math.round((units / SNAPSHOT_WINDOW_WEEKS) * 10) / 10 : 0,
    daysCover: cover != null && Number.isFinite(cover) ? cover : null,
    lastInvoiceAt: typeof snapshot?.last_invoice_at === 'string' ? snapshot.last_invoice_at : null,
  };
}

export interface AlternateCandidate {
  tenantProductId: string;
  name: string;
  sku: string;
  brandId: string | null;
  brandName: string | null;
  categoryId: string | null;
  available: number;
  velocity: EnquiryVelocity;
}

/** Same-category first, then same-brand, then fastest-selling; only candidates that can cover the requested qty. */
export function pickAlternates(
  line: { tenantProductId: string; brandId: string | null; categoryId: string | null; qty: number },
  candidates: AlternateCandidate[],
  limit = 3,
): EnquiryAlternate[] {
  return candidates
    .filter((c) => c.tenantProductId !== line.tenantProductId && c.available >= line.qty)
    .map((c) => ({
      c,
      sameBrand: line.brandId != null && c.brandId === line.brandId,
      sameCategory: line.categoryId != null && c.categoryId === line.categoryId,
    }))
    .sort((a, b) =>
      Number(b.sameCategory) - Number(a.sameCategory)
      || Number(b.sameBrand) - Number(a.sameBrand)
      || b.c.velocity.unitsPerWeek - a.c.velocity.unitsPerWeek)
    .slice(0, limit)
    .map(({ c, sameBrand, sameCategory }) => ({
      tenantProductId: c.tenantProductId,
      name: c.name,
      sku: c.sku,
      brandName: c.brandName,
      available: c.available,
      velocity: c.velocity,
      sameBrand,
      sameCategory,
      buyerPrice: null,
    }));
}
