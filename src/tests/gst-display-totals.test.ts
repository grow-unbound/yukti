import { describe, expect, it } from 'vitest';
import { computeDisplayDocumentTotals } from '@/lib/gst';

describe('computeDisplayDocumentTotals', () => {
  const lines = [{ qty: 3, unit_price: 1050, disc_pct: 0 }];

  it('inclusive: subtotal is the qty x price sum, tax is 0 and total equals subtotal', () => {
    expect(computeDisplayDocumentTotals(lines, { gstInclusive: true, taxAmount: 480.5 })).toEqual({
      subtotal: 3150,
      tax_amount: 0,
      grand_total: 3150,
    });
  });

  it('exclusive: uses the backend tax amount on top of the summed lines', () => {
    expect(computeDisplayDocumentTotals(lines, { gstInclusive: false, taxAmount: 567 })).toEqual({
      subtotal: 3150,
      tax_amount: 567,
      grand_total: 3717,
    });
  });

  it('applies line discount, document discount, freight and round-off; null tax counts as 0', () => {
    const result = computeDisplayDocumentTotals(
      [{ qty: 2, unit_price: 100, disc_pct: 10 }, { qty: 1, unit_price: 50 }],
      { gstInclusive: false, taxAmount: null, discount_flat: 30, freight: 20, round_off: -0.5 },
    );
    expect(result).toEqual({ subtotal: 230, tax_amount: 0, grand_total: 219.5 });
  });
});
