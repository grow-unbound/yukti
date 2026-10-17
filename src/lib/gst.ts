export interface GstLineInput {
  qty: number;
  unit_price: number;
  disc_pct?: number | null;
  tax_pct?: number | null;
  gst_rate?: number | null;
  diff?: 'clean' | 'added' | 'changed' | 'removed';
}

export interface GstTotals {
  subtotal: number;
  tax_amount: number;
  total: number;
}

export function roundMoney(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

export function resolveLineTaxRate(line: Pick<GstLineInput, 'tax_pct' | 'gst_rate'>, fallbackRate = 0): number {
  const rate = line.tax_pct ?? line.gst_rate ?? fallbackRate;
  return Number.isFinite(rate) ? Number(rate) : 0;
}

export function computeLineTaxableAmount(line: Pick<GstLineInput, 'qty' | 'unit_price' | 'disc_pct'>): number {
  return line.qty * line.unit_price * (1 - Number(line.disc_pct ?? 0) / 100);
}

export function computeLineGrossAmount(
  line: Pick<GstLineInput, 'qty' | 'unit_price' | 'disc_pct' | 'tax_pct' | 'gst_rate'>,
  gstInclusive = false,
  fallbackRate = 0,
): number {
  const taxable = computeLineTaxableAmount(line);
  if (gstInclusive) {
    return roundMoney(taxable);
  }
  const taxRate = resolveLineTaxRate(line, fallbackRate);
  return roundMoney(taxable + taxable * (taxRate / 100));
}

export function computeDocumentTotals(
  lines: GstLineInput[],
  gstInclusive = false,
  fallbackRate = 0,
): GstTotals {
  const activeLines = lines.filter((line) => line.diff !== 'removed');
  const subtotal = activeLines.reduce((sum, line) => sum + computeLineTaxableAmount(line), 0);
  const tax_amount = gstInclusive
    ? 0
    : activeLines.reduce((sum, line) => {
        const taxable = computeLineTaxableAmount(line);
        return sum + taxable * (resolveLineTaxRate(line, fallbackRate) / 100);
      }, 0);
  return {
    subtotal: roundMoney(subtotal),
    tax_amount: roundMoney(tax_amount),
    total: roundMoney(subtotal + tax_amount),
  };
}

/**
 * Display totals for a document: lines are qty x price (less line discount), subtotal is their sum,
 * tax is 0 when rates are GST-inclusive (shown as "Included") else the backend tax amount, total = subtotal + tax.
 * Stored line_total/subtotal can be ex-GST after a Zoho sync-back, so display derives them from the lines.
 */
export function computeDisplayDocumentTotals(
  lines: Array<Pick<GstLineInput, 'qty' | 'unit_price' | 'disc_pct'>>,
  options: {
    gstInclusive: boolean;
    taxAmount?: number | null;
    discount_flat?: number | null;
    freight?: number | null;
    round_off?: number | null;
  },
): { subtotal: number; tax_amount: number; grand_total: number } {
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + roundMoney(computeLineTaxableAmount(line)), 0));
  const tax_amount = options.gstInclusive ? 0 : roundMoney(options.taxAmount ?? 0);
  const grand_total = roundMoney(
    Math.max(subtotal - (options.discount_flat ?? 0), 0) + tax_amount + (options.freight ?? 0) + (options.round_off ?? 0),
  );
  return { subtotal, tax_amount, grand_total };
}

export function computeBuyerCartTotals(
  items: Array<{
    quantity: number;
    unit_price: number;
    disc_pct?: number | null;
    gst_rate?: number | null;
  }>,
  gstInclusive: boolean,
  fallbackRate = 0,
): GstTotals {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price * (1 - Number(item.disc_pct ?? 0) / 100), 0);
  const tax_amount = gstInclusive
    ? 0
    : items.reduce((sum, item) => {
        const taxable = item.quantity * item.unit_price * (1 - Number(item.disc_pct ?? 0) / 100);
        const rate = Number.isFinite(item.gst_rate ?? fallbackRate) ? Number(item.gst_rate ?? fallbackRate) : 0;
        return sum + taxable * (rate / 100);
      }, 0);
  return {
    subtotal: roundMoney(subtotal),
    tax_amount: roundMoney(tax_amount),
    total: roundMoney(subtotal + tax_amount),
  };
}
