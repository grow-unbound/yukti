import type { CohortRules } from '@/lib/zod';
import { PAGE_SIZE } from '@/lib/pagination';
import { getSellerLandingPeriodMeta } from '@/lib/server/seller-period';

type DbClient = {
  schema: (name: 'app' | 'catalog') => {
    from: (table: string) => any;
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
  };
};

type BuyerDbRow = {
  id: string;
  business_name: string;
  contact_name: string | null;
  geography: { city?: string; state?: string } | null;
  tier: 'A' | 'B' | 'C' | null;
  payment_terms_days: number | null;
  credit_limit: number | null;
  external_ref: string | null;
};

type OrderDbRow = {
  buyer_id: string;
  total_amount: number | null;
  placed_at: string | null;
  status: string | null;
  deleted_at?: string | null;
};

type InvoiceDbRow = {
  buyer_id: string;
  outstanding_balance: number | null;
};

export type CohortComposerBuyerRow = {
  id: string;
  business_name: string;
  contact_name: string | null;
  external_ref: string | null;
  geography_label: string;
  city: string | null;
  state: string | null;
  tier: 'A' | 'B' | 'C' | null;
  last_order_at: string | null;
  mtd_spend: number;
  orders_mtd: number;
  credit_used: number;
  payment_terms_days: number;
  gmv_90d: number;
  initials: string;
  hue: 'teal' | 'ember' | 'cream';
  /** Only populated by getCohortComposerBuyerResultset (the shared buyer-picker path). */
  buyer_app_enabled?: boolean;
  overdue_amount?: number;
  invoice_count?: number;
};

export type CohortComposerFilterOption = {
  value: string;
  label: string;
  count: number;
};

export type CohortComposerPayload = {
  buyers: CohortComposerBuyerRow[];
  total_buyer_count: number;
  brands: Array<{
    id: string;
    label: string;
  }>;
  filters: {
    geographies: CohortComposerFilterOption[];
    last_order_buckets: CohortComposerFilterOption[];
    gmv_90d_buckets: CohortComposerFilterOption[];
  };
};

export type CohortComposerBuyerResultset = {
  buyers: CohortComposerBuyerRow[];
  total: number;
  nextCursor: string | null;
};

const INVOICE_MISSING_CODES = new Set(['PGRST205', '42P01']);
const INDIAN_STATE_LABELS: Record<string, string> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CG: 'Chhattisgarh',
  CH: 'Chandigarh',
  DD: 'Daman and Diu',
  DH: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OD: 'Odisha',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TN: 'Tamil Nadu',
  TR: 'Tripura',
  TS: 'Telangana',
  UK: 'Uttarakhand',
  UP: 'Uttar Pradesh',
  WB: 'West Bengal',
};

export const COHORT_GMV_BUCKETS: Array<{
  id: 'gmv_0' | 'gmv_1_50000' | 'gmv_50001_200000' | 'gmv_200001_500000' | 'gmv_500001_plus';
  label: string;
  test: (value: number) => boolean;
}> = [
  { id: 'gmv_0', label: 'No GMV', test: (value) => value <= 0 },
  { id: 'gmv_1_50000', label: '₹1 - ₹50k', test: (value) => value > 0 && value <= 50_000 },
  { id: 'gmv_50001_200000', label: '₹50k - ₹2L', test: (value) => value > 50_000 && value <= 200_000 },
  { id: 'gmv_200001_500000', label: '₹2L - ₹5L', test: (value) => value > 200_000 && value <= 500_000 },
  { id: 'gmv_500001_plus', label: '₹5L+', test: (value) => value > 500_000 },
];

export const COHORT_LAST_ORDER_BUCKETS: Array<{
  id: 'anytime' | 'within_30_days' | 'within_90_days' | 'dormant_90_plus_days';
  label: string;
}> = [
  { id: 'anytime', label: 'Anytime' },
  { id: 'within_30_days', label: 'Within 30 days' },
  { id: 'within_90_days', label: 'Within 90 days' },
  { id: 'dormant_90_plus_days', label: 'Dormant 90+ days' },
];

function getInitials(value: string) {
  return (
    value
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'CH'
  );
}

function expandStateLabel(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return INDIAN_STATE_LABELS[trimmed.toUpperCase()] ?? trimmed;
}

function isInvoiceTableMissing(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return INVOICE_MISSING_CODES.has(error.code ?? '') || (error.message ?? '').toLowerCase().includes('invoices');
}

function getIstMonthBounds(now = new Date()) {
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istNow.getFullYear();
  const month = istNow.getMonth();

  const currentStart = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const nextStart = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
  return {
    currentStartIso: currentStart.toISOString(),
    nextStartIso: nextStart.toISOString(),
  };
}

function buildOptionCounts(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function logComposerQueryError(label: string, error: { code?: string; message?: string } | null | undefined) {
  if (!error) return;
  console.error(`[cohort-composer] ${label}`, error.code ?? 'unknown', error.message ?? 'unknown error');
}

function parseOffsetCursor(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function deriveLastOrderBucket(lastOrderAt: string | null, now = new Date()) {
  if (!lastOrderAt) return 'dormant_90_plus_days' as const;
  const diffMs = now.getTime() - new Date(lastOrderAt).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 30) return 'within_30_days' as const;
  if (diffDays <= 90) return 'within_90_days' as const;
  return 'dormant_90_plus_days' as const;
}

export function matchesLastOrderBucket(
  lastOrderAt: string | null,
  bucket: 'anytime' | 'within_30_days' | 'within_90_days' | 'dormant_90_plus_days',
  now = new Date(),
) {
  if (bucket === 'anytime') return true;
  const resolved = deriveLastOrderBucket(lastOrderAt, now);
  if (bucket === 'within_30_days') return resolved === 'within_30_days';
  if (bucket === 'within_90_days') {
    return resolved === 'within_30_days' || resolved === 'within_90_days';
  }
  return resolved === 'dormant_90_plus_days';
}

export function deriveGmv90dBucket(value: number) {
  return COHORT_GMV_BUCKETS.find((bucket) => bucket.test(value))?.id ?? 'gmv_0';
}

export function buildCohortRulesFromComposerState(input: {
  geographies: string[];
  lastOrderBucket: 'anytime' | 'within_30_days' | 'within_90_days' | 'dormant_90_plus_days';
  gmvBuckets: Array<'gmv_0' | 'gmv_1_50000' | 'gmv_50001_200000' | 'gmv_200001_500000' | 'gmv_500001_plus'>;
  selectedBuyerIds: string[];
  excludedBuyerIds: string[];
}) {
  const filters: CohortRules['filters'] = [];

  if (input.geographies.length > 0) {
    filters.push({
      field: 'geography.city',
      operator: 'in',
      value: input.geographies,
    });
  }

  if (input.lastOrderBucket !== 'anytime') {
    filters.push({
      field: 'last_order_bucket',
      operator: 'eq',
      value: input.lastOrderBucket,
    });
  }

  if (input.gmvBuckets.length > 0) {
    filters.push({
      field: 'gmv_90d_bucket',
      operator: 'in',
      value: input.gmvBuckets,
    });
  }

  return {
    filters,
    selected_buyer_ids: input.selectedBuyerIds,
    excluded_buyer_ids: input.excludedBuyerIds,
  } satisfies CohortRules;
}

export function resolveBuyerIdsForRules(
  buyers: CohortComposerBuyerRow[],
  rules: CohortRules | null | undefined,
  isStatic: boolean,
) {
  const normalizedRules: CohortRules = {
    filters: rules?.filters ?? [],
    selected_buyer_ids: rules?.selected_buyer_ids ?? [],
    excluded_buyer_ids: rules?.excluded_buyer_ids ?? [],
  };

  if (isStatic) {
    return normalizedRules.selected_buyer_ids;
  }

  const selectedCities = new Set<string>();
  const selectedGmvBuckets = new Set<string>();
  let lastOrderBucket: string | null = null;

  for (const filter of normalizedRules.filters) {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (filter.field === 'geography.city') values.forEach((value) => selectedCities.add(value.toLowerCase()));
    if (filter.field === 'gmv_90d_bucket') values.forEach((value) => selectedGmvBuckets.add(value));
    if (filter.field === 'last_order_bucket') lastOrderBucket = values[0] ?? null;
  }

  const excluded = new Set(normalizedRules.excluded_buyer_ids ?? []);

  return buyers
    .filter((buyer) => {
      if (selectedCities.size > 0 && !selectedCities.has((buyer.city ?? '').toLowerCase())) return false;
      if (selectedGmvBuckets.size > 0 && !selectedGmvBuckets.has(deriveGmv90dBucket(buyer.gmv_90d))) return false;
      if (lastOrderBucket && !matchesLastOrderBucket(buyer.last_order_at, lastOrderBucket as 'anytime' | 'within_30_days' | 'within_90_days' | 'dormant_90_plus_days')) return false;
      if (excluded.has(buyer.id)) return false;
      return true;
    })
    .map((buyer) => buyer.id);
}

export async function getCohortComposerPayload(db: DbClient, tenantId: string): Promise<CohortComposerPayload> {
  const { currentStartIso, nextStartIso } = getIstMonthBounds();
  const currentMonthDate = currentStartIso.slice(0, 10);
  const nextMonthDate = nextStartIso.slice(0, 10);
  const quarterMeta = getSellerLandingPeriodMeta('quarter');
  const currentQuarterStart = quarterMeta.current_start.slice(0, 10);

  // Phase 1: all queries in parallel.
  // buyers: display list (100 rows). V4 buyer now/period summaries: full-dataset facets.
  const [buyersRes, brandsRes, buyerNowRes, buyerPeriodRes, tenantNowRes, geoRes] = await Promise.all([
    db
      .schema('app')
      .from('buyers')
      .select('id, business_name, contact_name, geography, tier, payment_terms_days, credit_limit, external_ref')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('business_name', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE_SIZE.MAX),
    db
      .schema('app')
      .from('tenant_brands')
      .select('id, display_name_override, master_brand_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .eq('is_active', true)
      .order('created_at', { ascending: true }),
    // metrics_buyer_now_summary (v4): one row per buyer for receivables + last invoice date.
    db
      .schema('app')
      .from('metrics_buyer_now_summary')
      .select('buyer_id, receivable_amount, last_invoice_date')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    // metrics_buyer_period_summary (v4, grain=quarter): quarter-to-date invoice value stands
    // in for the old v2 "order_value_90d" figure — not a true rolling 90-day window anymore,
    // matches how every other v4-migrated page defines "demand" (quarter-to-date).
    db
      .schema('app')
      .from('metrics_buyer_period_summary')
      .select('buyer_id, invoice_value')
      .eq('tenant_id', tenantId)
      .eq('grain', 'quarter')
      .eq('period_start', currentQuarterStart)
      .is('deleted_at', null),
    // metrics_tenant_now_summary (v4): accurate active buyer total for facets.
    db
      .schema('app')
      .from('metrics_tenant_now_summary')
      .select('active_buyer_count')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .maybeSingle(),
    // All active buyer geographies for geo facet (live — no summary table covers this)
    db
      .schema('app')
      .from('buyers')
      .select('geography')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .is('deleted_at', null),
  ]);

  if (buyersRes.error) throw buyersRes.error;
  if (brandsRes.error) throw brandsRes.error;

  const buyerRows = (buyersRes.data ?? []) as BuyerDbRow[];
  const firstPageBuyerIds = buyerRows.map((buyer) => buyer.id);
  const mtdOrdersRes = firstPageBuyerIds.length > 0
    ? await db
        .schema('app')
        .from('orders')
        .select('buyer_id, total_amount, order_date, created_at, status')
        .eq('tenant_id', tenantId)
        .in('buyer_id', firstPageBuyerIds)
        .is('deleted_at', null)
        .gte('order_date', currentMonthDate)
        .lt('order_date', nextMonthDate)
    : { data: [], error: null };
  if (mtdOrdersRes.error) throw mtdOrdersRes.error;

  // Build brand options (unchanged)
  const tenantBrands = (brandsRes.data ?? []) as Array<{
    id: string;
    display_name_override: string | null;
    master_brand_id: string | null;
  }>;
  const masterBrandIds = Array.from(
    new Set(tenantBrands.map((brand) => brand.master_brand_id).filter(Boolean) as string[]),
  );
  const masterBrandsRes = masterBrandIds.length > 0
    ? await db.schema('catalog').from('brands').select('id, name').in('id', masterBrandIds)
    : { data: [], error: null };
  if (masterBrandsRes.error) {
    logComposerQueryError('master brands lookup failed', masterBrandsRes.error);
  }
  const masterBrandMap = new Map(
    ((masterBrandsRes.data ?? []) as Array<{ id: string; name: string }>).map((brand) => [brand.id, brand.name]),
  );
  const brandOptions = tenantBrands.map((brand) => ({
    id: brand.id,
    label: brand.display_name_override ?? (brand.master_brand_id ? masterBrandMap.get(brand.master_brand_id) ?? 'Unnamed brand' : 'Unnamed brand'),
  }));

  // Build v4 metric lookup maps.
  if (buyerNowRes.error) throw buyerNowRes.error;
  if (buyerPeriodRes.error) throw buyerPeriodRes.error;
  type BuyerNowRow = { buyer_id: string; receivable_amount: number | null; last_invoice_date: string | null };
  const nowRows = (buyerNowRes.data ?? []) as BuyerNowRow[];
  const metricsByBuyer = new Map(nowRows.map((row) => [row.buyer_id, row]));

  const gmv90dByBuyer = new Map<string, number>();
  const mtdSpendByBuyer = new Map<string, number>();
  const ordersMtdByBuyer = new Map<string, number>();
  for (const row of (buyerPeriodRes.data ?? []) as Array<{ buyer_id: string; invoice_value: number | null }>) {
    gmv90dByBuyer.set(row.buyer_id, Number(row.invoice_value ?? 0));
  }
  for (const row of (mtdOrdersRes.data ?? []) as Array<{ buyer_id: string; total_amount: number | null; status: string | null }>) {
    if (row.status === 'cancelled' || row.status === 'rejected' || row.status === 'archived') continue;
    mtdSpendByBuyer.set(row.buyer_id, (mtdSpendByBuyer.get(row.buyer_id) ?? 0) + Number(row.total_amount ?? 0));
    ordersMtdByBuyer.set(row.buyer_id, (ordersMtdByBuyer.get(row.buyer_id) ?? 0) + 1);
  }

  // Build display buyer rows (capped at PAGE_SIZE.MAX)
  const buyersPayload = buyerRows.map((buyer, index) => {
    const city = buyer.geography?.city?.trim() || null;
    const state = expandStateLabel(buyer.geography?.state?.trim() || null);
    const metrics = metricsByBuyer.get(buyer.id);
    return {
      id: buyer.id,
      business_name: buyer.business_name,
      contact_name: buyer.contact_name,
      external_ref: buyer.external_ref,
      geography_label: [city, state].filter(Boolean).join(', ') || '—',
      city,
      state,
      tier: buyer.tier,
      last_order_at: metrics?.last_invoice_date ?? null,
      mtd_spend: Number((mtdSpendByBuyer.get(buyer.id) ?? 0).toFixed(2)),
      orders_mtd: ordersMtdByBuyer.get(buyer.id) ?? 0,
      credit_used: Number((metrics?.receivable_amount ?? 0).toFixed(2)),
      payment_terms_days: Number(buyer.payment_terms_days ?? 0),
      gmv_90d: Number((gmv90dByBuyer.get(buyer.id) ?? 0).toFixed(2)),
      initials: getInitials(buyer.business_name),
      hue: index % 3 === 0 ? 'teal' : index % 3 === 1 ? 'ember' : 'cream',
    } satisfies CohortComposerBuyerRow;
  });

  // Accurate facet counts from full dataset (v4 now-summary rows, no 100-buyer cap)
  if (tenantNowRes.error) throw tenantNowRes.error;
  const tenantNow = tenantNowRes.data as { active_buyer_count: number | null } | null;
  const totalBuyerCount = Number(tenantNow?.active_buyer_count ?? nowRows.length);

  // last_order_bucket counts: now sourced from metrics_buyer_now_summary.last_invoice_date.
  const lastOrderBuckets = COHORT_LAST_ORDER_BUCKETS.map((bucket) => ({
    value: bucket.id,
    label: bucket.label,
    count:
      bucket.id === 'anytime'
        ? totalBuyerCount
        : nowRows.filter((row) => matchesLastOrderBucket(row.last_invoice_date, bucket.id)).length,
  }));

  // gmv_90d_bucket counts: buyers not in set = gmv_0
  const buyersWithAnyGmv = new Set(gmv90dByBuyer.keys());
  const gmvBuckets = COHORT_GMV_BUCKETS.map((bucket) => {
    if (bucket.id === 'gmv_0') {
      return { value: bucket.id, label: bucket.label, count: totalBuyerCount - buyersWithAnyGmv.size };
    }
    let count = 0;
    for (const gmv of gmv90dByBuyer.values()) {
      if (bucket.test(gmv)) count++;
    }
    return { value: bucket.id, label: bucket.label, count };
  });

  // geography counts: tally from ALL active buyer geographies (live, no snapshot)
  const allGeoRows = (geoRes.data ?? []) as Array<{ geography: { city?: string; state?: string } | null }>;
  const geographies = buildOptionCounts(allGeoRows.map((row) => row.geography?.city?.trim() || null));

  if (buyerRows.length === 0) {
    return {
      buyers: [],
      total_buyer_count: totalBuyerCount,
      brands: brandOptions,
      filters: { geographies, last_order_buckets: lastOrderBuckets, gmv_90d_buckets: gmvBuckets },
    };
  }

  return {
    buyers: buyersPayload,
    total_buyer_count: totalBuyerCount,
    brands: brandOptions,
    filters: { geographies, last_order_buckets: lastOrderBuckets, gmv_90d_buckets: gmvBuckets },
  };
}

export type BuyerPickerQuickFilter =
  | 'has_dues'
  | 'overdue'
  | 'app_enabled'
  | 'dormant_qtr'
  | 'buying_qtr'
  | 'enquire_no_sales'
  | 'top20';

export async function getCohortComposerBuyerResultset(
  db: DbClient,
  tenantId: string,
  options: {
    q?: string;
    geographies?: string[];
    lastOrderBucket?: 'anytime' | 'within_30_days' | 'within_90_days' | 'dormant_90_plus_days';
    gmvBuckets?: Array<'gmv_0' | 'gmv_1_50000' | 'gmv_50001_200000' | 'gmv_200001_500000' | 'gmv_500001_plus'>;
    limit?: number;
    cursor?: string | null;
    /**
     * Bypass query/geography/bucket filtering and return exactly these buyers (still
     * tenant/active-scoped). Used only to preload selected-buyer rows for the picker —
     * always hard-capped at 250 by the caller (route + hook), never an unbounded list.
     */
    ids?: string[];
    /** Picker quick filters (toggle chips) — OR'd together server-side. */
    quickFilters?: BuyerPickerQuickFilter[];
    /** Picker advanced filters (single-select dropdowns, null/undefined = "All"). */
    status?: 'active' | 'dormant' | 'inactive' | null;
    buyerAppFilter?: 'enabled' | 'not_enabled' | null;
    outstandingFilter?: 'has_dues' | 'overdue' | null;
    locationId?: string | null;
  } = {},
): Promise<CohortComposerBuyerResultset> {
  const { currentStartIso, nextStartIso } = getIstMonthBounds();
  const ninetyDaysAgoDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const currentMonthDate = currentStartIso.slice(0, 10);
  const nextMonthDate = nextStartIso.slice(0, 10);
  const quarterMeta = getSellerLandingPeriodMeta('quarter');
  const currentQuarterStart = quarterMeta.current_start.slice(0, 10);
  const previousQuarterStart = quarterMeta.previous_start.slice(0, 10);
  const ids = options.ids?.slice(0, 250);
  const limit = ids?.length
    ? ids.length
    : Math.max(1, Math.min(options.limit ?? PAGE_SIZE.COMPOSER, PAGE_SIZE.MAX));
  const offset = ids?.length ? 0 : parseOffsetCursor(options.cursor);
  const { data, error } = await db.schema('app').rpc('search_cohort_composer_buyers', {
    p_tenant_id: tenantId,
    p_query: options.q?.trim() || null,
    p_geographies: options.geographies?.length ? options.geographies : null,
    p_last_order_bucket: options.lastOrderBucket && options.lastOrderBucket !== 'anytime'
      ? options.lastOrderBucket
      : null,
    p_gmv_buckets: options.gmvBuckets?.length ? options.gmvBuckets : null,
    p_ninety_days_ago: ninetyDaysAgoDate,
    p_month_start: currentMonthDate,
    p_next_month_start: nextMonthDate,
    p_limit: limit,
    p_offset: offset,
    p_ids: ids?.length ? ids : null,
    p_quarter_start: currentQuarterStart,
    p_prev_quarter_start: previousQuarterStart,
    p_quick_filters: options.quickFilters?.length ? options.quickFilters : null,
    p_status: options.status ?? null,
    p_buyer_app_filter: options.buyerAppFilter ?? null,
    p_outstanding_filter: options.outstandingFilter ?? null,
    p_location_id: options.locationId ?? null,
  });

  if (error) throw error;

  const pageRows = (data ?? []) as Array<{
    buyer_id: string;
    business_name: string;
    contact_name: string | null;
    external_ref: string | null;
    geography: { city?: string; state?: string } | null;
    tier: 'A' | 'B' | 'C' | null;
    payment_terms_days: number | null;
    last_order_at: string | null;
    outstanding_dues: number | null;
    gmv_90d: number | null;
    mtd_spend: number | null;
    orders_mtd: number | null;
    total_count: number | null;
    buyer_app_enabled: boolean | null;
    overdue_amount: number | null;
    invoice_count: number | null;
  }>;
  const total = Number(pageRows[0]?.total_count ?? 0);

  return {
    buyers: pageRows.map((buyer, index) => {
      const city = buyer.geography?.city?.trim() || null;
      const state = expandStateLabel(buyer.geography?.state?.trim() || null);
      return {
        id: buyer.buyer_id,
        business_name: buyer.business_name,
        contact_name: buyer.contact_name,
        external_ref: buyer.external_ref,
        geography_label: [city, state].filter(Boolean).join(', ') || '—',
        city,
        state,
        tier: buyer.tier,
        last_order_at: buyer.last_order_at,
        mtd_spend: Number(Number(buyer.mtd_spend ?? 0).toFixed(2)),
        orders_mtd: Number(buyer.orders_mtd ?? 0),
        credit_used: Number(Number(buyer.outstanding_dues ?? 0).toFixed(2)),
        payment_terms_days: Number(buyer.payment_terms_days ?? 0),
        gmv_90d: Number(Number(buyer.gmv_90d ?? 0).toFixed(2)),
        initials: getInitials(buyer.business_name),
        hue: (offset + index) % 3 === 0 ? 'teal' : (offset + index) % 3 === 1 ? 'ember' : 'cream',
        buyer_app_enabled: Boolean(buyer.buyer_app_enabled),
        overdue_amount: Number(buyer.overdue_amount ?? 0),
        invoice_count: Number(buyer.invoice_count ?? 0),
      } satisfies CohortComposerBuyerRow;
    }),
    total,
    nextCursor: ids?.length || offset + pageRows.length >= total
      ? null
      : String(offset + pageRows.length),
  };
}

/**
 * Server-side membership resolver for cohort save/update paths.
 * Queries ALL active buyers (no display cap) to compute correct rule-based membership.
 */
export async function resolveAllBuyerIdsForRules(
  db: DbClient,
  tenantId: string,
  rules: CohortRules | null | undefined,
  isStatic: boolean,
): Promise<string[]> {
  const normalizedRules: CohortRules = {
    filters: rules?.filters ?? [],
    selected_buyer_ids: rules?.selected_buyer_ids ?? [],
    excluded_buyer_ids: rules?.excluded_buyer_ids ?? [],
  };

  if (isStatic) return normalizedRules.selected_buyer_ids;

  const excluded = new Set(normalizedRules.excluded_buyer_ids ?? []);

  // Parse filters to know what data we need
  const selectedCities = new Set<string>();
  const selectedGmvBuckets = new Set<string>();
  let lastOrderBucket: string | null = null;

  for (const filter of normalizedRules.filters) {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (filter.field === 'geography.city') values.forEach((v) => selectedCities.add(String(v).toLowerCase()));
    if (filter.field === 'gmv_90d_bucket') values.forEach((v) => selectedGmvBuckets.add(String(v)));
    if (filter.field === 'last_order_bucket') lastOrderBucket = String(values[0] ?? '');
  }

  const needsGmv = selectedGmvBuckets.size > 0;
  const needsLastOrder = !!lastOrderBucket;
  const needsGeo = selectedCities.size > 0;

  // Fetch all active buyer IDs + geography and v4 buyer metrics in parallel.
  const currentQuarterStart = getSellerLandingPeriodMeta('quarter').current_start.slice(0, 10);
  const [allBuyersRes, buyerNowRes, buyerPeriodRes] = await Promise.all([
    db
      .schema('app')
      .from('buyers')
      .select(needsGeo ? 'id, geography' : 'id')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .is('deleted_at', null),
    needsLastOrder
      ? db
          .schema('app')
          .from('metrics_buyer_now_summary')
          .select('buyer_id, last_invoice_date')
          .eq('tenant_id', tenantId)
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    needsGmv
      ? db
          .schema('app')
          .from('metrics_buyer_period_summary')
          .select('buyer_id, invoice_value')
          .eq('tenant_id', tenantId)
          .eq('grain', 'quarter')
          .eq('period_start', currentQuarterStart)
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (allBuyersRes.error) throw allBuyersRes.error;
  if (buyerNowRes.error) throw buyerNowRes.error;
  if (buyerPeriodRes.error) throw buyerPeriodRes.error;

  const allBuyers = (allBuyersRes.data ?? []) as Array<{ id: string; geography?: { city?: string } | null }>;

  const lastOrderByBuyer = new Map<string, string | null>();
  for (const row of (buyerNowRes.data ?? []) as Array<{ buyer_id: string; last_invoice_date: string | null }>) {
    lastOrderByBuyer.set(row.buyer_id, row.last_invoice_date);
  }

  const gmv90dByBuyer = new Map<string, number>();
  for (const row of (buyerPeriodRes.data ?? []) as Array<{ buyer_id: string; invoice_value: number | null }>) {
    gmv90dByBuyer.set(row.buyer_id, Number(row.invoice_value ?? 0));
  }

  return allBuyers
    .filter((buyer) => {
      if (excluded.has(buyer.id)) return false;
      if (needsGeo) {
        const city = (buyer.geography?.city?.trim() ?? '').toLowerCase();
        if (!selectedCities.has(city)) return false;
      }
      if (needsLastOrder) {
        const lastOrderAt = lastOrderByBuyer.get(buyer.id) ?? null;
        if (!matchesLastOrderBucket(lastOrderAt, lastOrderBucket as 'anytime' | 'within_30_days' | 'within_90_days' | 'dormant_90_plus_days')) return false;
      }
      if (needsGmv) {
        const gmv = gmv90dByBuyer.get(buyer.id) ?? 0;
        if (!selectedGmvBuckets.has(deriveGmv90dBucket(gmv))) return false;
      }
      return true;
    })
    .map((buyer) => buyer.id);
}

/** Buyer metrics for cohort members only (detail page Buyers tab). */
export async function buildCohortMemberBuyerRows(db: DbClient, tenantId: string, memberBuyerIds: string[]): Promise<CohortComposerBuyerRow[]> {
  const uniqueIds = Array.from(new Set(memberBuyerIds.filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const { data: buyers, error: buyersError } = await db
    .schema('app')
    .from('buyers')
    .select('id, business_name, contact_name, geography, tier, payment_terms_days, credit_limit, external_ref')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .in('id', uniqueIds)
    .order('business_name', { ascending: true });

  if (buyersError) throw buyersError;

  const buyerRows = (buyers ?? []) as BuyerDbRow[];
  if (buyerRows.length === 0) return [];

  const buyerIds = buyerRows.map((b) => b.id);
  const { currentStartIso, nextStartIso } = getIstMonthBounds();
  const ninetyDaysAgoIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const [allOrdersRes, mtdOrdersRes, invoicesRes] = await Promise.all([
    db
      .schema('app')
      .from('orders')
      .select('buyer_id, total_amount, placed_at, status')
      .eq('tenant_id', tenantId)
      .in('buyer_id', buyerIds)
      .is('deleted_at', null)
      .neq('status', 'cancelled')
      .gte('placed_at', ninetyDaysAgoIso) // limit to 90-day window (only gmv_90d is shown)
      .order('placed_at', { ascending: false }),
    db
      .schema('app')
      .from('orders')
      .select('buyer_id, total_amount, placed_at, status')
      .eq('tenant_id', tenantId)
      .in('buyer_id', buyerIds)
      .is('deleted_at', null)
      .neq('status', 'cancelled')
      .gte('placed_at', currentStartIso)
      .lt('placed_at', nextStartIso),
    db
      .schema('app')
      .from('invoices')
      .select('buyer_id, outstanding_balance')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .in('buyer_id', buyerIds)
      .in('status', ['sent', 'overdue']),
  ]);

  if (allOrdersRes.error) throw allOrdersRes.error;
  if (mtdOrdersRes.error) throw mtdOrdersRes.error;
  if (invoicesRes.error && !isInvoiceTableMissing(invoicesRes.error)) throw invoicesRes.error;

  const allOrders = (allOrdersRes.data ?? []) as OrderDbRow[];
  const mtdOrders = (mtdOrdersRes.data ?? []) as OrderDbRow[];
  const invoices = isInvoiceTableMissing(invoicesRes.error) ? [] : ((invoicesRes.data ?? []) as InvoiceDbRow[]);

  const lastOrderByBuyer = new Map<string, string>();
  const mtdSpendByBuyer = new Map<string, number>();
  const ordersMtdByBuyer = new Map<string, number>();
  const gmv90dByBuyer = new Map<string, number>();
  const creditUsedByBuyer = new Map<string, number>();

  for (const order of allOrders) {
    if (order.placed_at && !lastOrderByBuyer.has(order.buyer_id)) {
      lastOrderByBuyer.set(order.buyer_id, order.placed_at);
    }
    if (order.placed_at && order.placed_at >= ninetyDaysAgoIso) {
      gmv90dByBuyer.set(order.buyer_id, (gmv90dByBuyer.get(order.buyer_id) ?? 0) + Number(order.total_amount ?? 0));
    }
  }

  for (const order of mtdOrders) {
    mtdSpendByBuyer.set(order.buyer_id, (mtdSpendByBuyer.get(order.buyer_id) ?? 0) + Number(order.total_amount ?? 0));
    ordersMtdByBuyer.set(order.buyer_id, (ordersMtdByBuyer.get(order.buyer_id) ?? 0) + 1);
  }

  for (const invoice of invoices) {
    creditUsedByBuyer.set(invoice.buyer_id, (creditUsedByBuyer.get(invoice.buyer_id) ?? 0) + Number(invoice.outstanding_balance ?? 0));
  }

  return buyerRows.map((buyer, index) => {
    const city = buyer.geography?.city?.trim() || null;
    const state = expandStateLabel(buyer.geography?.state?.trim() || null);
    const geographyLabel = [city, state].filter(Boolean).join(', ') || '—';
    return {
      id: buyer.id,
      business_name: buyer.business_name,
      contact_name: buyer.contact_name,
      external_ref: buyer.external_ref,
      geography_label: geographyLabel,
      city,
      state,
      tier: buyer.tier,
      last_order_at: lastOrderByBuyer.get(buyer.id) ?? null,
      mtd_spend: Number((mtdSpendByBuyer.get(buyer.id) ?? 0).toFixed(2)),
      orders_mtd: ordersMtdByBuyer.get(buyer.id) ?? 0,
      credit_used: Number((creditUsedByBuyer.get(buyer.id) ?? 0).toFixed(2)),
      payment_terms_days: Number(buyer.payment_terms_days ?? 0),
      gmv_90d: Number((gmv90dByBuyer.get(buyer.id) ?? 0).toFixed(2)),
      initials: getInitials(buyer.business_name),
      hue: index % 3 === 0 ? 'teal' : index % 3 === 1 ? 'ember' : 'cream',
    } satisfies CohortComposerBuyerRow;
  });
}
