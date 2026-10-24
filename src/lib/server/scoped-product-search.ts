import type { SupabaseClient } from '@supabase/supabase-js';

export type ScopedProductAvailability =
  | 'show_all'
  | 'show_everything'
  | 'in_stock'
  | 'in_stock_only'
  | 'low_stock'
  | 'low_stock_only'
  | 'out_of_stock'
  | 'new_in_stock_today'
  | 'old_stock';

export interface ScopedProductSearchParams {
  db: SupabaseClient;
  tenantId: string;
  query?: string | null;
  buyerId?: string | null;
  priceListId?: string | null;
  campaignId?: string | null;
  limit: number;
  offset?: number;
  ids?: string[] | null;
  brandIds?: string[] | null;
  categoryIds?: string[] | null;
  categoryScopeId?: string | null;
  allowedBrandIds?: string[] | null;
  warehouseIds?: string[] | null;
  availability?: ScopedProductAvailability;
  sort?: 'relevance' | 'name_asc' | 'created_desc';
  /**
   * PostgREST column filter for the RPC result. Omit for every column (seller callers). Each dropped
   * column saves its JSON key and value on every row of every page, so buyer callers pass
   * BUYER_SCOPED_PRODUCT_COLUMNS. Must include `total_count`.
   */
  columns?: readonly string[];
}

/**
 * Columns the buyer catalog mapping (enrichBuyerProducts) reads. Not returned to buyers:
 * cost_price, hsn_code, reorder_point, created_at, search_rank.
 */
export const BUYER_SCOPED_PRODUCT_COLUMNS = [
  'tenant_product_id',
  'product_name',
  'sku',
  'brand_id',
  'brand_name',
  'category_id',
  'category_name',
  'tax_pct',
  'on_hand',
  'unit_price',
  'mrp',
  'base_selling_price',
  'default_uom',
  'pack_size',
  'total_count',
  'image_urls',
  'r2_small_key',
  'r2_medium_key',
  'r2_large_key',
  'brand_logo_url',
  'category_image_thumb_key',
  'category_image_medium_key',
  'family_image_urls',
  'family_r2_small_key',
  'family_r2_medium_key',
  'family_r2_large_key',
] as const;

export interface ScopedProductSearchRow {
  tenant_product_id: string;
  product_name: string;
  sku: string | null;
  brand_id: string | null;
  brand_name: string;
  category_id: string | null;
  category_name: string;
  hsn_code: string | null;
  tax_pct: number | null;
  on_hand: number | null;
  reorder_point: number | null;
  unit_price: number | null;
  mrp: number | null;
  base_selling_price: number | null;
  cost_price: number | null;
  default_uom: string | null;
  pack_size: number | null;
  created_at: string;
  search_rank: number;
  total_count: number;
  image_urls: string[] | null;
  r2_small_key: string | null;
  r2_medium_key: string | null;
  r2_large_key: string | null;
  brand_logo_url: string | null;
  category_image_thumb_key: string | null;
  category_image_medium_key: string | null;
  family_image_urls: string[] | null;
  family_r2_small_key: string | null;
  family_r2_medium_key: string | null;
  family_r2_large_key: string | null;
}

function normalizeUuidArray(values?: string[] | null): string[] | null {
  if (!values) return null;
  const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return normalized.length > 0 ? normalized : null;
}

export async function searchScopedProducts(
  params: ScopedProductSearchParams,
): Promise<{ rows: ScopedProductSearchRow[]; total: number }> {
  // An explicitly resolved empty visibility scope means the caller is allowed
  // to see no brands. It must not collapse to NULL, which means no SQL filter.
  if (params.allowedBrandIds && params.allowedBrandIds.length === 0) {
    return { rows: [], total: 0 };
  }

  const trimmedQuery = params.query?.trim() ?? '';
  const db = params.db as any;
  // A plain browse/filter/id-list load (no search text) never needs the
  // tsquery/prefix-query/trigram-rank machinery search_products_scoped pays
  // for on every call — route it to load_products_scoped instead, which
  // shares the same enrichment/pricing shape minus that overhead.
  const isSearch = trimmedQuery.length > 0;
  const rpcName = isSearch ? 'search_products_scoped' : 'load_products_scoped';

  const sharedArgs = {
    p_tenant_id: params.tenantId,
    p_buyer_id: params.buyerId ?? null,
    p_price_list_id: params.priceListId ?? null,
    p_campaign_id: params.campaignId ?? null,
    p_category_scope_id: params.categoryScopeId?.trim() || null,
    p_limit: Math.max(1, params.limit),
    p_offset: Math.max(0, params.offset ?? 0),
    p_ids: normalizeUuidArray(params.ids),
    p_brand_ids: normalizeUuidArray(params.brandIds),
    p_category_ids: normalizeUuidArray(params.categoryIds),
    p_allowed_brand_ids: normalizeUuidArray(params.allowedBrandIds),
    p_warehouse_ids: normalizeUuidArray(params.warehouseIds),
    p_availability: params.availability ?? 'show_all',
  };
  const rpcArgs = isSearch
    ? { ...sharedArgs, p_query: trimmedQuery, p_sort: params.sort ?? 'relevance' }
    : { ...sharedArgs, p_sort: params.sort === 'name_asc' ? 'name_asc' : 'created_desc' };

  const call = db.schema('app').rpc(rpcName, rpcArgs);
  const { data, error } = await (params.columns ? call.select(params.columns.join(',')) : call);

  if (error) {
    throw new Error(error.message);
  }

  const rows = ((data ?? []) as Array<ScopedProductSearchRow & { search_rank?: number }>).map((row) => ({
    ...row,
    search_rank: row.search_rank ?? 0,
  }));
  let total = rows[0]?.total_count ?? 0;
  if (rows.length === 0 && (params.offset ?? 0) > 0) {
    // Window counts disappear on an out-of-range page. Recover the stable total
    // with one bounded probe instead of misreporting an existing scope as empty.
    const { data: probeData, error: probeError } = await db.schema('app').rpc(rpcName, {
      ...rpcArgs,
      p_limit: 1,
      p_offset: 0,
    });
    if (probeError) throw new Error(probeError.message);
    total = Number((probeData as ScopedProductSearchRow[] | null)?.[0]?.total_count ?? 0);
  }
  return {
    rows,
    total,
  };
}
