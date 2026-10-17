import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { assertSellerAdmin } from '@/lib/server/seller-auth';
import { getSellerLandingPeriodMeta } from '@/lib/server/seller-period';
import { createTenantBrand } from '@/lib/server/tenant-brand-create';
import { revalidatePublicCatalogCache } from '@/lib/server/public-catalog-cache';
import { getPostHogClient } from '@/lib/posthog-server';
import { PAGE_SIZE } from '@/lib/pagination';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming, parseRowsLimit, SELLER_GET_CACHE_CONTROL } from '@/lib/server/bounded-get';
import { createTimer } from '@/lib/server-timing';
import { readArrayParam } from '@/lib/landing-filter-params';

type TenantBrandLandingRow = {
  id: string;
  tenant_id: string;
  master_brand_id: string | null;
  display_name_override: string | null;
  slug: string | null;
  description: string | null;
  logo_url: string | null;
  margin_pct: number | null;
  exclusivity: boolean | null;
  is_active: boolean;
  external_ref: string | null;
  principal_name: string | null;
  principal_email: string | null;
  principal_phone: string | null;
  principal_location: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  default_cohort_id: string | null;
  created_at: string;
  updated_at: string;
  master_brand: { id: string; name: string; slug: string; logo_url: string | null; description: string | null } | null;
  gmv_mtd: number;
  gmv_prev_mtd: number;
  growth_pct: number;
  portfolio_share_pct: number;
  sku_count: number;
  active_buyers_mtd: number;
  total_buyers: number;
  catalog_days_ago: number | null;
  categories: string[];
  catalog_name: string | null;
  alerts: string[];
};

type BrandLandingSummary = {
  kpis: Record<string, number | null>;
  todays_read: {
    needs_attention: Array<Record<string, unknown>>;
    top_performers: Array<Record<string, unknown>>;
    top_risers: Array<Record<string, unknown>>;
  };
  categories: string[];
  cohorts: Array<{ id: string; name: string }>;
};

type DbClient = {
  schema: (schemaName: string) => {
    from: (tableName: string) => any;
  };
};

type BrandLandingSort = 'invoice_value_desc' | 'invoice_value_asc' | 'invoice_count_desc' | 'invoice_product_count_desc' | 'invoice_buyer_count_desc';

type BrandFilterPreset = {
  sold_period?: string;
  not_sold_period?: string;
  sold_previous_period?: boolean;
  sold_current_period?: boolean;
  sort?: string;
  cutoff?: string;
};

type BrandCursor = {
  v: number;
  i: string;
  n?: number;
};

type BrandMetricRow = {
  tenant_brand_id: string;
  invoice_count: number | string | null;
  invoice_value: number | string | null;
  invoice_product_count: number | string | null;
  invoice_buyer_count: number | string | null;
};

type BrandStatusFilter = 'active' | 'dormant' | 'inactive';

type BrandIdentityRow = {
  id: string;
  tenant_id: string;
  master_brand_id: string | null;
  display_name_override: string | null;
  slug: string | null;
  description: string | null;
  logo_url: string | null;
  margin_pct: number | null;
  exclusivity: boolean | null;
  is_active: boolean;
  external_ref: string | null;
  principal_name: string | null;
  principal_email: string | null;
  principal_phone: string | null;
  principal_location: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  default_cohort_id: string | null;
  created_at: string;
  updated_at: string;
  master_brand?: { id: string; name: string; slug: string; logo_url: string | null; description: string | null } | null;
};

const BRAND_SCAN_LIMIT = 1000;
const BRAND_FILTERS = {
  groups: [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'dormant', label: 'Dormant' },
        { value: 'inactive', label: 'Inactive' },
      ],
    },
  ],
};

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function encodeBrandCursor(payload: BrandCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeBrandCursor(cursor: string | null): BrandCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Partial<BrandCursor>;
    if (typeof parsed.v !== 'number' || typeof parsed.i !== 'string') return null;
    return { v: parsed.v, i: parsed.i, n: typeof parsed.n === 'number' ? parsed.n : undefined };
  } catch {
    return null;
  }
}

function parseBrandSort(value: string | null): BrandLandingSort {
  if (
    value === 'invoice_value_asc' ||
    value === 'invoice_count_desc' ||
    value === 'invoice_product_count_desc' ||
    value === 'invoice_buyer_count_desc'
  ) {
    return value;
  }
  return 'invoice_value_desc';
}

function parseBrandFilterPreset(raw: string | null): BrandFilterPreset | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as BrandFilterPreset;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeBrandStatuses(values: string[]): BrandStatusFilter[] {
  const allowed = new Set<BrandStatusFilter>(['active', 'dormant', 'inactive']);
  return values.filter((value): value is BrandStatusFilter => allowed.has(value as BrandStatusFilter));
}

function statusesFromBrandPreset(preset: BrandFilterPreset | null): BrandStatusFilter[] {
  if (!preset) return [];
  if (typeof preset.sold_period === 'string') return ['active'];
  if (typeof preset.not_sold_period === 'string') return ['dormant'];
  if (preset.sold_previous_period === true && preset.sold_current_period === false) return ['dormant'];
  return [];
}

function brandSortColumn(sort: BrandLandingSort): keyof BrandMetricRow {
  if (sort === 'invoice_count_desc') return 'invoice_count';
  if (sort === 'invoice_product_count_desc') return 'invoice_product_count';
  if (sort === 'invoice_buyer_count_desc') return 'invoice_buyer_count';
  return 'invoice_value';
}

function brandSortValue(row: BrandMetricRow, sort: BrandLandingSort): number {
  return toNumber(row[brandSortColumn(sort)]);
}

function compareBrandRows(
  left: { id: string; identity: BrandIdentityRow; metric: BrandMetricRow },
  right: { id: string; identity: BrandIdentityRow; metric: BrandMetricRow },
  sort: BrandLandingSort,
): number {
  const leftValue = brandSortValue(left.metric, sort);
  const rightValue = brandSortValue(right.metric, sort);
  if (leftValue !== rightValue) {
    return sort === 'invoice_value_asc' ? leftValue - rightValue : rightValue - leftValue;
  }
  return left.id.localeCompare(right.id);
}

function isBrandSold(metric: BrandMetricRow): boolean {
  return toNumber(metric.invoice_count) > 0 || toNumber(metric.invoice_value) > 0 || toNumber(metric.invoice_product_count) > 0;
}

function brandMatchesStatus(identity: BrandIdentityRow, metric: BrandMetricRow, statuses: BrandStatusFilter[]): boolean {
  if (statuses.length === 0) return true;
  const sold = isBrandSold(metric);
  return statuses.some((status) => {
    if (status === 'active') return identity.is_active && sold;
    if (status === 'dormant') return identity.is_active && !sold;
    return !identity.is_active;
  });
}

function applyInMemoryBrandCursor<T extends { id: string; metric: BrandMetricRow }>(
  rows: T[],
  sort: BrandLandingSort,
  cursor: BrandCursor | null,
): T[] {
  if (!cursor) return rows;
  return rows.filter((row) => {
    const value = brandSortValue(row.metric, sort);
    if (sort === 'invoice_value_asc') {
      return value > cursor.v || (value === cursor.v && row.id > cursor.i);
    }
    return value < cursor.v || (value === cursor.v && row.id > cursor.i);
  });
}

function applyBrandKeyset(query: any, sort: BrandLandingSort, cursor: BrandCursor | null) {
  if (!cursor) return query;
  const column = brandSortColumn(sort);
  if (sort === 'invoice_value_asc') {
    return query.or(`${column}.gt.${cursor.v},and(${column}.eq.${cursor.v},tenant_brand_id.gt.${cursor.i})`);
  }
  return query.or(`${column}.lt.${cursor.v},and(${column}.eq.${cursor.v},tenant_brand_id.gt.${cursor.i})`);
}

function getBrandName(row: BrandIdentityRow): string {
  return row.display_name_override?.trim() || row.master_brand?.name?.trim() || 'Unknown brand';
}

async function resolveBrandSearchIds(db: DbClient, tenantId: string, search: string | null): Promise<string[] | null> {
  if (!search) return null;
  const normalized = search.replace(/[*(),]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // Indexed (idx_tenant_brands_search_vector) — the vector already includes
  // the master-catalog brand name, so this covers master-linked brands too.
  const { data, error } = await (db as any).schema('app').rpc('search_seller_brand_landing_ids', {
    p_tenant_id: tenantId,
    p_query: normalized,
    p_limit: 500,
    p_offset: 0,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function fetchActiveBrandIds(db: DbClient, tenantId: string, searchIds: string[] | null): Promise<string[]> {
  let query = db
    .schema('app')
    .from('tenant_brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .limit(1000);
  if (searchIds) query = query.in('id', searchIds);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function fetchBrandUniverseIds(db: DbClient, tenantId: string, searchIds: string[] | null): Promise<string[]> {
  let query = db
    .schema('app')
    .from('tenant_brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .limit(BRAND_SCAN_LIMIT);
  if (searchIds) query = query.in('id', searchIds);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function fetchBrandIdentities(
  db: DbClient,
  tenantId: string,
  brandIds: string[],
): Promise<Map<string, BrandIdentityRow>> {
  const map = new Map<string, BrandIdentityRow>();
  if (brandIds.length === 0) return map;
  const { data, error } = await db
    .schema('app')
    .from('tenant_brands')
    .select('id, tenant_id, master_brand_id, display_name_override, slug, description, logo_url, margin_pct, exclusivity, is_active, external_ref, principal_name, principal_email, principal_phone, principal_location, contact_name, contact_email, contact_phone, default_cohort_id, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .in('id', brandIds)
    .is('deleted_at', null);
  if (error) throw error;

  const rows = (data ?? []) as BrandIdentityRow[];
  const masterIds = [...new Set(rows.map((row) => row.master_brand_id).filter((id): id is string => Boolean(id)))];
  const masterById = new Map<string, { id: string; name: string; slug: string; logo_url: string | null; description: string | null }>();
  if (masterIds.length > 0) {
    const masterRes = await db
      .schema('catalog')
      .from('brands')
      .select('id, name, slug, logo_url, description')
      .in('id', masterIds)
      .is('deleted_at', null)
      .limit(masterIds.length);
    if (masterRes.error) throw masterRes.error;
    for (const master of (masterRes.data ?? []) as Array<{ id: string; name: string; slug: string; logo_url: string | null; description: string | null }>) {
      masterById.set(master.id, master);
    }
  }

  for (const row of rows) {
    map.set(row.id, { ...row, master_brand: row.master_brand_id ? masterById.get(row.master_brand_id) ?? null : null });
  }
  return map;
}

async function fetchProductCountsByBrand(
  db: DbClient,
  tenantId: string,
  brandIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (brandIds.length === 0) return counts;
  const { data, error } = await db
    .schema('app')
    .from('tenant_products')
    .select('tenant_brand_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('tenant_brand_id', brandIds)
    .is('deleted_at', null)
    .limit(5000);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ tenant_brand_id: string | null }>) {
    if (!row.tenant_brand_id) continue;
    counts.set(row.tenant_brand_id, (counts.get(row.tenant_brand_id) ?? 0) + 1);
  }
  return counts;
}

async function fetchCurrentMetricRowsByIds(
  db: DbClient,
  tenantId: string,
  periodStart: string,
  brandIds: string[],
): Promise<Map<string, BrandMetricRow>> {
  const map = new Map<string, BrandMetricRow>();
  if (brandIds.length === 0) return map;
  const { data, error } = await db
    .schema('app')
    .from('metrics_brand_period_summary')
    .select('tenant_brand_id, invoice_count, invoice_value, invoice_product_count, invoice_buyer_count')
    .eq('tenant_id', tenantId)
    .eq('grain', 'month')
    .eq('period_start', periodStart)
    .in('tenant_brand_id', brandIds)
    .is('deleted_at', null);
  if (error) throw error;
  for (const row of (data ?? []) as BrandMetricRow[]) map.set(row.tenant_brand_id, row);
  return map;
}

async function fetchCurrentSoldBrandIds(db: DbClient, tenantId: string, periodStart: string): Promise<Set<string>> {
  const { data, error } = await db
    .schema('app')
    .from('metrics_brand_period_summary')
    .select('tenant_brand_id')
    .eq('tenant_id', tenantId)
    .eq('grain', 'month')
    .eq('period_start', periodStart)
    .is('deleted_at', null)
    .limit(1000);
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ tenant_brand_id: string }>).map((row) => row.tenant_brand_id));
}

async function fetchPortfolioSales(db: DbClient, tenantId: string, periodStart: string): Promise<number> {
  const { data, error } = await db
    .schema('app')
    .from('metrics_brand_period_summary')
    .select('invoice_value')
    .eq('tenant_id', tenantId)
    .eq('grain', 'month')
    .eq('period_start', periodStart)
    .is('deleted_at', null)
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as Array<{ invoice_value: number | string | null }>).reduce(
    (sum, row) => sum + toNumber(row.invoice_value),
    0,
  );
}

function emptyBrandMetric(id: string): BrandMetricRow {
  return {
    tenant_brand_id: id,
    invoice_count: 0,
    invoice_value: 0,
    invoice_product_count: 0,
    invoice_buyer_count: 0,
  };
}

export async function GET(req: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: unknown, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'brands_api', init, APP_GET_CACHE_CONTROL);

  try {
    const claims = await getVerifiedClaims(req);

    if (!claims.tenant_id) {
      return timedJson({ error: 'Unauthorized' }, { status: 401 });
    }
    if (claims.role !== 'seller_admin') {
      return timedJson({ error: 'Forbidden' }, { status: 403 });
    }

    const flagEnabled = await getFlag('df_brand_product_master', claims.tenant_id);
    if (!flagEnabled) {
      return timedJson({ error: 'Feature not enabled' }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return timedJson({ error: 'Server configuration error' }, { status: 500 });
    }

    const db = supabaseAdmin as unknown as DbClient;
    const tenantId = claims.tenant_id;
    const period = getSellerLandingPeriodMeta('month');
    const periodStart = period.current_start.slice(0, 10);
    const previousStart = period.previous_start.slice(0, 10);
    const limit = parseRowsLimit(req.nextUrl.searchParams.get('limit'), PAGE_SIZE.SELLER);
    const cursor = decodeBrandCursor(req.nextUrl.searchParams.get('cursor'));
    const search = req.nextUrl.searchParams.get('search')?.trim() || null;
    const sort = parseBrandSort(req.nextUrl.searchParams.get('sort'));
    const filterPreset = parseBrandFilterPreset(req.nextUrl.searchParams.get('filter_preset'));
    const explicitStatuses = normalizeBrandStatuses(readArrayParam(req.nextUrl.searchParams, 'status'));
    const statusFilters = explicitStatuses.length > 0 ? explicitStatuses : statusesFromBrandPreset(filterPreset);
    const top80 = filterPreset?.cutoff === 'top80';
    const notSold = Boolean(filterPreset?.not_sold_period);
    const dormant = filterPreset?.sold_previous_period === true && filterPreset?.sold_current_period === false;
    const searchIds = await resolveBrandSearchIds(db, tenantId, search);

    if (searchIds && searchIds.length === 0) {
      return timedJson({
        brands: [],
        total: null,
        limit,
        nextCursor: null,
        period,
        period_key: 'this_month',
        grain: 'month',
        portfolio_sales_value: 0,
        filters: BRAND_FILTERS,
      });
    }

    let metricRows: BrandMetricRow[] = [];
    let pageMetricRows: BrandMetricRow[] = [];
    let extraMetricRow: BrandMetricRow | null = null;
    let pageBrandIds: string[] = [];
    let top80AlreadyEmitted = top80 ? Math.max(0, cursor?.n ?? 0) : 0;
    let top80Count: number | null = null;

    if (top80) {
      const top80Res = await db
        .schema('app')
        .from('metrics_tenant_top80_cache')
        .select('top80_count')
        .eq('tenant_id', tenantId)
        .eq('entity_kind', 'brands')
        .eq('grain', 'month')
        .eq('period_start', periodStart)
        .limit(1);
      if (top80Res.error) throw top80Res.error;
      top80Count = toNumber(((top80Res.data ?? []) as Array<{ top80_count: number | string | null }>)[0]?.top80_count);
    }

    const effectiveLimit = top80 && top80Count != null
      ? Math.max(0, Math.min(limit, top80Count - top80AlreadyEmitted))
      : limit;

    if (!top80) {
      const universeIds = await fetchBrandUniverseIds(db, tenantId, searchIds);
      const [identitiesAll, metricsAll] = await Promise.all([
        fetchBrandIdentities(db, tenantId, universeIds),
        fetchCurrentMetricRowsByIds(db, tenantId, periodStart, universeIds),
      ]);
      const candidates = universeIds
        .map((id) => {
          const identity = identitiesAll.get(id);
          if (!identity) return null;
          const metric = metricsAll.get(id) ?? emptyBrandMetric(id);
          return brandMatchesStatus(identity, metric, statusFilters) ? { id, identity, metric } : null;
        })
        .filter((row): row is { id: string; identity: BrandIdentityRow; metric: BrandMetricRow } => Boolean(row))
        .sort((left, right) => compareBrandRows(left, right, sort));
      const cursorFiltered = applyInMemoryBrandCursor(candidates, sort, cursor);
      const pageRowsWithExtra = cursorFiltered.slice(0, limit + 1);
      const pageRows = pageRowsWithExtra.slice(0, limit);
      extraMetricRow = pageRowsWithExtra[limit]?.metric ?? null;
      pageMetricRows = pageRows.map((row) => row.metric);
      pageBrandIds = pageRows.map((row) => row.id);
      metricRows = pageRowsWithExtra.map((row) => row.metric);
    } else if (notSold || dormant) {
      const activeIds = await fetchActiveBrandIds(db, tenantId, searchIds);
      const currentSoldIds = await fetchCurrentSoldBrandIds(db, tenantId, periodStart);
      let candidateIds = activeIds.filter((id) => !currentSoldIds.has(id));

      if (dormant) {
        const previousRes = await db
          .schema('app')
          .from('metrics_brand_period_summary')
          .select('tenant_brand_id')
          .eq('tenant_id', tenantId)
          .eq('grain', 'month')
          .eq('period_start', previousStart)
          .is('deleted_at', null)
          .limit(1000);
        if (previousRes.error) throw previousRes.error;
        const previousSoldIds = new Set(((previousRes.data ?? []) as Array<{ tenant_brand_id: string }>).map((row) => row.tenant_brand_id));
        candidateIds = candidateIds.filter((id) => previousSoldIds.has(id));
      }

      const afterCursor = cursor?.i ? candidateIds.findIndex((id) => id > cursor.i) : 0;
      const startIndex = Math.max(0, afterCursor);
      const pageIdsWithExtra = candidateIds.slice(startIndex, startIndex + limit + 1);
      pageBrandIds = pageIdsWithExtra.slice(0, limit);
      extraMetricRow = pageIdsWithExtra.length > limit ? emptyBrandMetric(pageIdsWithExtra[limit]) : null;
      metricRows = pageIdsWithExtra.map(emptyBrandMetric);
      pageMetricRows = pageBrandIds.map(emptyBrandMetric);
    } else if (effectiveLimit > 0) {
      let query = db
        .schema('app')
        .from('metrics_brand_period_summary')
        .select('tenant_brand_id, invoice_count, invoice_value, invoice_product_count, invoice_buyer_count')
        .eq('tenant_id', tenantId)
        .eq('grain', 'month')
        .eq('period_start', periodStart)
        .is('deleted_at', null);

      if (searchIds) query = query.in('tenant_brand_id', searchIds);
      if (top80) query = query.gt('invoice_value', 0);
      query = applyBrandKeyset(query, sort, cursor)
        .order(brandSortColumn(sort), { ascending: sort === 'invoice_value_asc' })
        .order('tenant_brand_id', { ascending: true })
        .limit(effectiveLimit + 1);

      const { data, error } = await query;
      if (error) throw error;
      metricRows = (data ?? []) as BrandMetricRow[];
      pageMetricRows = metricRows.slice(0, effectiveLimit);
      extraMetricRow = metricRows[effectiveLimit] ?? null;
      pageBrandIds = pageMetricRows.map((row) => row.tenant_brand_id);
    }

    const [identities, productCounts, portfolioSales] = await Promise.all([
      fetchBrandIdentities(db, tenantId, pageBrandIds),
      fetchProductCountsByBrand(db, tenantId, pageBrandIds),
      fetchPortfolioSales(db, tenantId, periodStart),
    ]);
    const metricsById = new Map(pageMetricRows.map((row) => [row.tenant_brand_id, row]));
    const brands = pageBrandIds
      .map((id) => {
        const identity = identities.get(id);
        if (!identity) return null;
        const metric = metricsById.get(id) ?? emptyBrandMetric(id);
        const invoiceValue = toNumber(metric.invoice_value);
        return {
          ...identity,
          gmv_mtd: invoiceValue,
          gmv_prev_mtd: 0,
          growth_pct: 0,
          portfolio_share_pct: portfolioSales > 0 ? Math.round((invoiceValue / portfolioSales) * 100) : 0,
          sku_count: productCounts.get(id) ?? 0,
          active_buyers_mtd: toNumber(metric.invoice_buyer_count),
          total_buyers: toNumber(metric.invoice_buyer_count),
          catalog_days_ago: null,
          categories: [],
          catalog_name: null,
          alerts: [],
          invoice_count: toNumber(metric.invoice_count),
          invoice_product_count: toNumber(metric.invoice_product_count),
          invoice_buyer_count: toNumber(metric.invoice_buyer_count),
        };
      })
      .filter(Boolean) as Array<TenantBrandLandingRow & {
        invoice_count: number;
        invoice_product_count: number;
        invoice_buyer_count: number;
      }>;

    const last = pageMetricRows[pageMetricRows.length - 1] ?? null;
    const nextCursor = extraMetricRow && last
      ? encodeBrandCursor({
          v: notSold || dormant ? 0 : brandSortValue(last, sort),
          i: last.tenant_brand_id,
          n: top80 ? top80AlreadyEmitted + pageMetricRows.length : undefined,
        })
      : null;

    return timedJson({
      brands,
      total: null,
      limit,
      nextCursor,
      period,
      period_key: 'this_month',
      grain: 'month',
      portfolio_sales_value: portfolioSales,
      sort,
      filters: BRAND_FILTERS,
    }, { headers: { 'Cache-Control': SELLER_GET_CACHE_CONTROL } });
  } catch (error: any) {
    console.error('[GET /api/tenant/brands] V4 error:', error?.code, error?.message);
    return timedJson({ error: 'Failed to fetch brands' }, { status: 500 });
  }
}

async function POSTImpl(req: NextRequest) {
  try {
    const claims = await getVerifiedClaims(req);

    const adminCheck = assertSellerAdmin(claims);
    if (!adminCheck.ok) {
      return NextResponse.json(
        { error: adminCheck.status === 401 ? 'Unauthorized' : 'Forbidden' },
        { status: adminCheck.status },
      );
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const db = supabaseAdmin as any;
    const body = await req.json();
    const created = await createTenantBrand(db, claims, body);

    try {
      const ph = getPostHogClient();
      ph.capture({
        distinctId: claims.sub ?? claims.tenant_id ?? undefined,
        event: 'brand_created',
        properties: {
          tenant_id: claims.tenant_id,
          seller_id: claims.sub,
          brand_id: (created as { id?: string })?.id,
        },
      });
      await ph.flush();
    } catch {
      // Analytics is non-blocking for brand creation.
    }

    if (claims.tenant_id) {
      revalidatePublicCatalogCache(claims.tenant_id);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && 'error' in err) {
      const typedErr = err as { status: number; error: string; details?: unknown };
      return NextResponse.json(
        typedErr.details ? { error: typedErr.error, details: typedErr.details } : { error: typedErr.error },
        { status: typedErr.status },
      );
    }
    console.error('[POST /api/tenant/brands] Unexpected error:', err);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export const POST = withBuyerContextRevalidation(POSTImpl);
