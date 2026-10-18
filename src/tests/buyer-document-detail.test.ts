import { describe, expect, it, vi } from 'vitest';

import { loadBuyerDocumentLineItems } from '@/lib/buyer-documents/load-buyer-transaction-detail';

class QueryMock {
  private parentIdColumn: string | null = null;
  private inIds: string[] = [];

  constructor(
    private readonly table: string,
    private readonly rows: Record<string, unknown[]>,
  ) {}

  select() { return this; }
  eq(column: string, value: string) {
    if (column === 'estimate_id' || column === 'order_id' || column === 'invoice_id') {
      this.parentIdColumn = value;
    }
    return this;
  }
  is() { return this; }
  in(_column: string, values: string[]) {
    this.inIds = values;
    return this;
  }

  then(resolve: (value: { data: unknown; error: null }) => void) {
    if (this.table === 'estimate_items' || this.table === 'order_items' || this.table === 'invoice_items') {
      resolve({
        data: this.rows[this.table] ?? [],
        error: null,
      });
      return;
    }

    if (this.table === 'tenant_products') {
      resolve({
        data: (this.rows.tenant_products ?? []).filter((row) => this.inIds.includes(String((row as Record<string, unknown>).id))),
        error: null,
      });
      return;
    }

    if (this.table === 'products') {
      resolve({
        data: (this.rows.products ?? []).filter((row) => this.inIds.includes(String((row as Record<string, unknown>).id))),
        error: null,
      });
      return;
    }

    resolve({ data: [], error: null });
  }
}

function makeDb(rows: Record<string, unknown[]>) {
  return {
    schema: (schema: string) => ({
      from: (table: string) => new QueryMock(table, rows),
      schema,
    }),
  };
}

describe('loadBuyerDocumentLineItems', () => {
  it('resolves product names without selecting a nonexistent tenant_products.name column', async () => {
    const items = await loadBuyerDocumentLineItems(
      makeDb({
        estimate_items: [
          {
            tenant_product_id: 'tp-1',
            qty: 2,
            unit_price: 500,
            tax_rate: 18,
            line_total: 1000,
          },
        ],
        tenant_products: [
          {
            id: 'tp-1',
            internal_sku: 'SKU-1',
            name_override: 'Override name',
            master_product_id: 'mp-1',
            default_uom: 'PCS',
          },
        ],
        products: [
          { id: 'mp-1', name: 'Master name' },
        ],
      }),
      'tenant-1',
      'estimates',
      'est-1',
    );

    expect(items).toEqual([
      {
        tenant_product_id: 'tp-1',
        product_name: 'Override name',
        internal_sku: 'SKU-1',
        unit: 'PCS',
        qty: 2,
        unit_price: 500,
        tax_rate: 18,
        line_total: 1000,
        disc_pct: null,
        buyer_target_unit_price_min: null,
        buyer_target_unit_price_max: null,
        image_url: null,
      },
    ]);
  });

  it('falls back to the master product name for invoice items', async () => {
    const items = await loadBuyerDocumentLineItems(
      makeDb({
        invoice_items: [
          {
            tenant_product_id: 'tp-2',
            qty: 1,
            unit_price: 1200,
            tax_rate: null,
            line_total: 1200,
          },
        ],
        tenant_products: [
          {
            id: 'tp-2',
            internal_sku: 'SKU-2',
            name_override: null,
            master_product_id: 'mp-2',
            default_uom: null,
          },
        ],
        products: [
          { id: 'mp-2', name: 'Master fallback' },
        ],
      }),
      'tenant-1',
      'invoices',
      'inv-1',
    );

    expect(items[0]?.product_name).toBe('Master fallback');
    expect(items[0]?.unit).toBeNull();
  });
});
