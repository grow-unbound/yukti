import { firstStoredImageUrl } from '@/lib/r2-url';
import { productDisplayName } from '@/lib/sales-orders/tenant-order-detail';

type DbClient = {
  schema: (name: 'app' | 'catalog') => Record<string, (...args: unknown[]) => Promise<unknown>>;
};

export interface BuyerDocumentLineItem {
  tenant_product_id: string;
  product_name: string;
  internal_sku: string | null;
  unit: string | null;
  image_url: string | null;
  qty: number;
  unit_price: number | null;
  tax_rate: number | null;
  line_total: number | null;
  disc_pct: number | null;
  buyer_target_unit_price_min?: number | null;
  buyer_target_unit_price_max?: number | null;
}

interface RawDocumentLineItem {
  tenant_product_id: string;
  qty: number | string;
  unit_price: number | string | null;
  tax_rate: number | string | null;
  line_total: number | string | null;
  disc_pct?: number | string | null;
  buyer_target_unit_price_min?: number | string | null;
  buyer_target_unit_price_max?: number | string | null;
  deleted_at?: string | null;
}

interface TenantProductRow {
  id: string;
  internal_sku: string | null;
  name_override: string | null;
  master_product_id: string | null;
  default_uom: string | null;
  image_urls?: unknown;
}

export async function loadBuyerDocumentLineItems(
  db: DbClient,
  tenantId: string,
  parentTable: 'estimates' | 'orders' | 'invoices',
  parentId: string,
): Promise<BuyerDocumentLineItem[]> {
  const d = db as any;
  const childTable =
    parentTable === 'estimates'
      ? 'estimate_items'
      : parentTable === 'orders'
        ? 'order_items'
        : 'invoice_items';
  const parentIdColumn =
    parentTable === 'estimates'
      ? 'estimate_id'
      : parentTable === 'orders'
        ? 'order_id'
        : 'invoice_id';

  // buyer_target_* columns exist only on estimate_items (hidden-price enquiries);
  // selecting them from order_items/invoice_items fails with "column does not exist".
  const itemColumns =
    parentTable === 'estimates'
      ? 'tenant_product_id, qty, unit_price, tax_rate, line_total, disc_pct, buyer_target_unit_price_min, buyer_target_unit_price_max, deleted_at'
      : 'tenant_product_id, qty, unit_price, tax_rate, line_total, disc_pct, deleted_at';

  const { data: itemRows, error: itemError } = await d
    .schema('app')
    .from(childTable)
    .select(itemColumns)
    .eq(parentIdColumn, parentId)
    .is('deleted_at', null);

  if (itemError) {
    throw itemError;
  }

  const rawItems = ((itemRows ?? []) as RawDocumentLineItem[]).filter((row) => !row.deleted_at);
  const productIds = Array.from(new Set(rawItems.map((row) => row.tenant_product_id).filter(Boolean)));

  const { data: tenantProducts, error: productsError } = productIds.length > 0
    ? await d
        .schema('app')
        .from('tenant_products')
        .select('id, internal_sku, name_override, master_product_id, default_uom, image_urls')
        .eq('tenant_id', tenantId)
        .in('id', productIds)
        .is('deleted_at', null)
    : { data: [], error: null };

  if (productsError) {
    throw productsError;
  }

  const tenantProductRows = (tenantProducts ?? []) as TenantProductRow[];
  const masterProductIds = Array.from(
    new Set(
      tenantProductRows
        .map((row) => row.master_product_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );

  const { data: masterProducts, error: masterProductsError } = masterProductIds.length > 0
    ? await d
        .schema('catalog')
        .from('products')
        .select('id, name, image_urls')
        .in('id', masterProductIds)
    : { data: [], error: null };

  if (masterProductsError) {
    throw masterProductsError;
  }

  const tenantProductMap = new Map(tenantProductRows.map((row) => [row.id, row]));
  const masterProductMap = new Map(
    ((masterProducts ?? []) as Array<{ id: string; name: string; image_urls?: unknown }>).map((row) => [row.id, row]),
  );

  return rawItems.map((row) => {
    const tenantProduct = tenantProductMap.get(row.tenant_product_id);
    const masterProduct = tenantProduct?.master_product_id ? masterProductMap.get(tenantProduct.master_product_id) ?? null : null;
    const masterName = masterProduct?.name ?? null;

    return {
      tenant_product_id: row.tenant_product_id,
      product_name: productDisplayName(tenantProduct?.name_override ?? null, masterName),
      internal_sku: tenantProduct?.internal_sku ?? null,
      unit: tenantProduct?.default_uom ?? null,
      image_url: firstStoredImageUrl(tenantProduct?.image_urls) ?? firstStoredImageUrl(masterProduct?.image_urls),
      qty: Number(row.qty ?? 0),
      unit_price: row.unit_price == null ? null : Number(row.unit_price),
      tax_rate: row.tax_rate != null ? Number(row.tax_rate) : null,
      line_total: row.line_total == null ? null : Number(row.line_total),
      disc_pct: row.disc_pct == null ? null : Number(row.disc_pct),
      buyer_target_unit_price_min: row.buyer_target_unit_price_min == null ? null : Number(row.buyer_target_unit_price_min),
      buyer_target_unit_price_max: row.buyer_target_unit_price_max == null ? null : Number(row.buyer_target_unit_price_max),
    };
  });
}
