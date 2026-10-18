import { describe, expect, it } from 'vitest';
import { deriveSalesOrderDisplayTotals, mapSalesOrderDetailToComposerLines } from '@/lib/sales-orders/tenant-order-detail';
import type { SalesOrderDetail } from '@/types/tenant-sales-orders';

// Order lines whose stored line_total/subtotal are ex-GST (Zoho sync-back) while unit_price is inclusive.
function makeOrder(overrides: Partial<SalesOrderDetail> = {}): SalesOrderDetail {
  const line = (id: string, qty: number, unit_price: number, line_total: number, disc_pct = 0) => ({
    id, tenant_product_id: `tp-${id}`, name: `P${id}`, sku: `S${id}`, brand: 'B', brand_initials: 'B',
    qty, unit_price, line_total, disc_pct, tax_rate: 18, tax_pct: 18, on_hand: 10, hsn_code: null, unit: 'pcs',
  });
  return {
    subtotal: 3203.4, tax_amount: 576.6, total_amount: 3780, discount_flat: 0, freight: 0, round_off: 0,
    lines: [line('1', 1, 1300, 1101.7), line('2', 2, 1240, 2101.7)],
    ...overrides,
  } as unknown as SalesOrderDetail;
}

describe('sales order display derivation', () => {
  it('maps lines to qty x unit_price less discount, ignoring stored line_total', () => {
    const order = makeOrder();
    order.lines[1] = { ...order.lines[1], disc_pct: 10 };
    const lines = mapSalesOrderDetailToComposerLines(order);
    expect(lines.map((l) => l.line_total)).toEqual([1300, 2232]);
  });

  it('inclusive: subtotal is the line sum, tax 0, total equals subtotal', () => {
    const totals = deriveSalesOrderDisplayTotals(makeOrder(), true);
    expect(totals).toMatchObject({ subtotal: 3780, tax_amount: 0, grand_total: 3780, gst_inclusive: true });
  });

  it('exclusive: keeps the stored tax and folds freight, discount and round-off into the total', () => {
    const totals = deriveSalesOrderDisplayTotals(
      makeOrder({ tax_amount: 680, discount_flat: 80, freight: 50, round_off: 0.5 } as Partial<SalesOrderDetail>),
      false,
    );
    expect(totals).toMatchObject({ subtotal: 3780, tax_amount: 680, grand_total: 4430.5, gst_inclusive: false });
  });
});
