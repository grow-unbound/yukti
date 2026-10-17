import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { createTimer } from '@/lib/server-timing';
import { CohortCreateSchema, CustomerGroupFormPayloadSchema } from '@/lib/zod';
import { resolveAllBuyerIdsForRules } from '@/lib/server/cohort-composer';
import { applyManualCohortMembersPlan, planManualCohortMembers } from '@/lib/server/cohort-manual-members';
import { getSellerLandingPeriodMeta } from '@/lib/server/seller-period';
import { readArrayParam } from '@/lib/landing-filter-params';
import { PAGE_SIZE } from '@/lib/pagination';
import { getPostHogClient } from '@/lib/posthog-server';
import { parseRowsLimit, SELLER_GET_CACHE_CONTROL } from '@/lib/server/bounded-get';
import { searchSellerLandingEntityIds } from '@/lib/server/seller-landing-entity-search';

type CohortType = 'Geo-based' | 'Activity-based' | 'Brand affinity';
type CohortStatusFilter = 'Active' | 'Dormant' | 'Inactive';
type CohortLandingSort = 'invoice_value_desc' | 'invoice_value_asc' | 'active_member_count_desc' | 'demand_value_desc';

type CohortCursor = {
  v: number;
  i: string;
};

type CohortMetricRow = {
  cohort_id: string;
  member_count: number | string | null;
  active_member_count: number | string | null;
  demand_count: number | string | null;
  demand_value: number | string | null;
  invoice_count: number | string | null;
  invoice_value: number | string | null;
};

type CohortIdentityRow = {
  id: string;
  name: string;
  description: string | null;
  rules: unknown;
  is_static: boolean | null;
  cached_member_count: number | null;
  created_at: string;
  allowed_tenant_brand_ids: string[] | null;
};

function buildPeriodFallbackFilter(
  primaryColumn: string,
  fallbackColumn: string,
  startIso: string,
  endExclusiveIso: string,
) {
  return `and(${primaryColumn}.gte.${startIso},${primaryColumn}.lt.${endExclusiveIso}),and(${primaryColumn}.is.null,${fallbackColumn}.gte.${startIso},${fallbackColumn}.lt.${endExclusiveIso})`;
}

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function encodeCohortCursor(payload: CohortCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCohortCursor(cursor: string | null | undefined): CohortCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Partial<CohortCursor>;
    if (typeof parsed.v !== 'number' || typeof parsed.i !== 'string') return null;
    return { v: parsed.v, i: parsed.i };
  } catch {
    return null;
  }
}

function parseCohortSort(value: string | null | undefined): CohortLandingSort {
  if (value === 'invoice_value_asc' || value === 'active_member_count_desc' || value === 'demand_value_desc') return value;
  return 'invoice_value_desc';
}

function normalizeCohortStatuses(values: string[]): CohortStatusFilter[] {
  const allowed = new Set<CohortStatusFilter>(['Active', 'Dormant', 'Inactive']);
  return values.filter((value): value is CohortStatusFilter => allowed.has(value as CohortStatusFilter));
}

function parseCohortFilterPreset(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function statusesFromCohortPreset(preset: Record<string, unknown> | null): CohortStatusFilter[] {
  if (!preset) return [];
  if (preset.status === 'Active' || preset.active_period === true || typeof preset.sold_period === 'string') return ['Active'];
  if (preset.status === 'Dormant' || preset.dormant_period === true || typeof preset.not_sold_period === 'string') return ['Dormant'];
  if (preset.status === 'Inactive') return ['Inactive'];
  return [];
}

function isCohortActive(metric: CohortMetricRow): boolean {
  return toNumber(metric.active_member_count) > 0 || toNumber(metric.demand_count) > 0 || toNumber(metric.invoice_count) > 0 || toNumber(metric.invoice_value) > 0;
}

function cohortStatus(metric: CohortMetricRow): { label: CohortStatusFilter; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  return isCohortActive(metric)
    ? { label: 'Active', tone: 'success' }
    : { label: 'Dormant', tone: 'warning' };
}

function cohortMatchesStatus(metric: CohortMetricRow, statuses: CohortStatusFilter[]): boolean {
  if (statuses.length === 0) return true;
  const status = cohortStatus(metric).label;
  return statuses.includes(status);
}

function cohortSortValue(row: { metric: CohortMetricRow }, sort: CohortLandingSort): number {
  if (sort === 'active_member_count_desc') return toNumber(row.metric.active_member_count);
  if (sort === 'demand_value_desc') return toNumber(row.metric.demand_value);
  return toNumber(row.metric.invoice_value);
}

function compareCohortRows(
  left: { id: string; metric: CohortMetricRow },
  right: { id: string; metric: CohortMetricRow },
  sort: CohortLandingSort,
): number {
  const leftValue = cohortSortValue(left, sort);
  const rightValue = cohortSortValue(right, sort);
  if (leftValue !== rightValue) {
    return sort === 'invoice_value_asc' ? leftValue - rightValue : rightValue - leftValue;
  }
  return left.id.localeCompare(right.id);
}

function cohortAfterCursor(row: { id: string; metric: CohortMetricRow }, sort: CohortLandingSort, cursor: CohortCursor | null): boolean {
  if (!cursor) return true;
  const value = cohortSortValue(row, sort);
  if (sort === 'invoice_value_asc') {
    if (value > cursor.v) return true;
    if (value < cursor.v) return false;
    return row.id.localeCompare(cursor.i) > 0;
  }
  if (value < cursor.v) return true;
  if (value > cursor.v) return false;
  return row.id.localeCompare(cursor.i) > 0;
}

function deriveCohortType(rules: unknown): CohortType {
  const json = rules && typeof rules === 'object' ? (rules as Record<string, unknown>) : null;
  const filters = Array.isArray(json?.filters) ? (json?.filters as Array<Record<string, unknown>>) : [];
  const fields = filters.map((f) => String(f.field ?? '').toLowerCase());
  if (fields.some((f) => f.includes('geography') || f.includes('city'))) return 'Geo-based';
  if (fields.some((f) => f.includes('last_order') || f.includes('gmv'))) return 'Activity-based';
  return 'Brand affinity';
}

function deriveFocusChips(rules: unknown, type: CohortType): string[] {
  const json = rules && typeof rules === 'object' ? (rules as Record<string, unknown>) : null;
  const filters = Array.isArray(json?.filters) ? (json?.filters as Array<Record<string, unknown>>) : [];

  const chips = filters
    .map((filter) => {
      const raw = filter.value;
      if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean);
      if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
      return [];
    })
    .flat()
    .slice(0, 3);

  if (chips.length > 0) return chips;
  if (type === 'Geo-based') return ['City cluster'];
  if (type === 'Activity-based') return ['Order history'];
  return ['Brand mix'];
}

export async function getCohortsLandingPayload(
  tenantId: string,
  periodInput?: string | null,
  filters: {
    search?: string;
    brands?: string[];
    status?: string[];
    limit?: number;
    cursor?: string | null;
    sort?: string | null;
    filterPreset?: Record<string, unknown> | null;
    includeSummary?: boolean;
  } = {},
) {
  const db = supabaseAdmin as any;
  const period = getSellerLandingPeriodMeta('quarter');
  const limit = filters.limit ?? PAGE_SIZE.SELLER;
  const search = filters.search?.trim() ?? '';
  const brandFilter = filters.brands ?? [];
  const sort = parseCohortSort(filters.sort);
  const cursor = decodeCohortCursor(filters.cursor);
  const presetStatuses = statusesFromCohortPreset(filters.filterPreset ?? null);
  const statuses = normalizeCohortStatuses(filters.status ?? []).concat(presetStatuses);
  const statusFilters = Array.from(new Set(statuses));
  const periodStart = period.current_start.slice(0, 10);
  const scanLimit = Math.max(limit * 6, 300);

  const metricsRes = await db
    .schema('app')
    .from('metrics_cohort_period_summary')
    .select('cohort_id, member_count, active_member_count, demand_count, demand_value, invoice_count, invoice_value')
    .eq('tenant_id', tenantId)
    .eq('grain', 'quarter')
    .eq('period_start', periodStart)
    .is('deleted_at', null)
    .limit(scanLimit);
  if (metricsRes.error) throw metricsRes.error;

  const metricById = new Map<string, CohortMetricRow>(
    ((metricsRes.data ?? []) as CohortMetricRow[]).map((row) => [row.cohort_id, row]),
  );

  let identityQuery = db
    .schema('app')
    .from('cohorts')
    .select('id, name, description, rules, is_static, cached_member_count, created_at, allowed_tenant_brand_ids')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(scanLimit);
  if (search) {
    // Indexed (idx_cohorts_search_vector) candidate-id lookup instead of an
    // unindexed ILIKE seq scan.
    const { ids: searchIds } = await searchSellerLandingEntityIds({
      tenantId,
      entity: 'cohorts',
      query: search,
      limit: scanLimit,
    });
    identityQuery = identityQuery.in('id', searchIds.length > 0 ? searchIds : ['00000000-0000-0000-0000-000000000000']);
  }
  const identitiesRes = await identityQuery;
  if (identitiesRes.error) throw identitiesRes.error;
  const identities = (identitiesRes.data ?? []) as CohortIdentityRow[];

  const rowsForSort = identities
    .filter((cohort) => {
      if (brandFilter.length === 0) return true;
      return (cohort.allowed_tenant_brand_ids ?? []).some((brandId) => brandFilter.includes(brandId));
    })
    .map((cohort) => {
      const metric = metricById.get(cohort.id) ?? {
        cohort_id: cohort.id,
        member_count: cohort.cached_member_count ?? 0,
        active_member_count: 0,
        demand_count: 0,
        demand_value: 0,
        invoice_count: 0,
        invoice_value: 0,
      };
      return { id: cohort.id, identity: cohort, metric };
    })
    .filter((row) => cohortMatchesStatus(row.metric, statusFilters))
    .sort((left, right) => compareCohortRows(left, right, sort))
    .filter((row) => cohortAfterCursor(row, sort, cursor));

  const pageRows = rowsForSort.slice(0, limit);
  const extraRow = rowsForSort[limit];

  const toLandingRow = (cohort: CohortIdentityRow, metric: CohortMetricRow) => {
    const type = deriveCohortType(cohort.rules);
    const invoiceValue = toNumber(metric.invoice_value);
    const invoiceCount = toNumber(metric.invoice_count);
    const demandValue = toNumber(metric.demand_value);
    const demandCount = toNumber(metric.demand_count);
    const memberCount = toNumber(metric.member_count ?? cohort.cached_member_count);
    const purchasingMembers = toNumber(metric.active_member_count);
    const status = cohortStatus(metric);
    return {
      id: cohort.id,
      name: cohort.name,
      description: cohort.description ?? null,
      is_static: Boolean(cohort.is_static),
      type,
      focus_chips: deriveFocusChips(cohort.rules, type),
      allowed_brands_count: Array.isArray(cohort.allowed_tenant_brand_ids) ? cohort.allowed_tenant_brand_ids.length : null,
      allowed_brands_label: Array.isArray(cohort.allowed_tenant_brand_ids) ? `${cohort.allowed_tenant_brand_ids.length} brands` : 'All Brands',
      allowed_tenant_brand_ids: Array.isArray(cohort.allowed_tenant_brand_ids) ? cohort.allowed_tenant_brand_ids : null,
      gmv_mtd: invoiceValue,
      invoice_value: invoiceValue,
      invoice_count: invoiceCount,
      demand_value: demandValue,
      demand_count: demandCount,
      growth_pct: 0,
      active_members: purchasingMembers,
      total_members: memberCount,
      conversion_pct: memberCount > 0 ? Number(((purchasingMembers / memberCount) * 100).toFixed(1)) : 0,
      live_catalogs_count: 0,
      status_label: status.label,
      status_tone: status.tone,
      aov: invoiceCount > 0 ? invoiceValue / invoiceCount : 0,
      orders_mtd: demandCount,
    };
  };

  const brandsRes = await db
    .schema('app')
    .from('tenant_brands')
    .select('id, display_name_override, master_brand_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (brandsRes.error) throw brandsRes.error;
  const brands = brandsRes.data ?? [];
  const brandMasterIds = [...new Set(brands.map((brand: { master_brand_id: string | null }) => brand.master_brand_id).filter(Boolean) as string[])];
  const masterBrandNameById = new Map<string, string>();
  if (brandMasterIds.length > 0) {
    const { data: masterBrands } = await db
      .schema('catalog')
      .from('brands')
      .select('id, name, deleted_at')
      .in('id', brandMasterIds)
      .is('deleted_at', null)
      .limit(100);
    for (const row of masterBrands ?? []) {
      masterBrandNameById.set(row.id, row.name);
    }
  }

  const last = pageRows[pageRows.length - 1];
  return {
    brands: brands.map((brand: { id: string; display_name_override: string | null; master_brand_id: string | null }) => ({
      id: brand.id,
      name: brand.display_name_override ?? (brand.master_brand_id ? masterBrandNameById.get(brand.master_brand_id) ?? 'Unknown brand' : 'Unknown brand'),
    })),
    kpis: {
      total_cohorts: identities.length,
      covered_members: pageRows.reduce((sum, row) => sum + toNumber(row.metric.member_count), 0),
      total_buyers: pageRows.reduce((sum, row) => sum + toNumber(row.metric.member_count), 0),
      combined_gmv_mtd: pageRows.reduce((sum, row) => sum + toNumber(row.metric.invoice_value), 0),
      avg_conversion_pct: 0,
      uncategorised_buyers: 0,
    },
    todays_read: {
      low_conversion: [],
      top_performers: [],
      top_risers: [],
    },
    cohorts: pageRows.map((row) => toLandingRow(row.identity, row.metric)),
    total: rowsForSort.length,
    limit,
    nextCursor: extraRow && last ? encodeCohortCursor({ v: cohortSortValue(last, sort), i: last.id }) : null,
    period,
  };
}

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: unknown, init?: ResponseInit) => {
    const response = NextResponse.json(body, init);
    response.headers.set('Server-Timing', timer.header('cohorts_api'));
    if (!init?.status || (init.status >= 200 && init.status < 300)) {
      response.headers.set('Cache-Control', SELLER_GET_CACHE_CONTROL);
    }
    return response;
  };
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) {
    return timedJson({ error: 'Unauthorized' }, { status: 401 });
  }

  if (claims.role !== 'seller_admin') {
    return timedJson({ error: 'Forbidden' }, { status: 403 });
  }

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) {
    return timedJson({ error: 'Feature not enabled' }, { status: 403 });
  }

  if (!supabaseAdmin) {
    return timedJson({ error: 'Server configuration error' }, { status: 500 });
  }

  try {
    const payload = await getCohortsLandingPayload(claims.tenant_id, request.nextUrl.searchParams.get('period'), {
      search: request.nextUrl.searchParams.get('search')?.trim() ?? '',
      brands: readArrayParam(request.nextUrl.searchParams, 'brands'),
      status: readArrayParam(request.nextUrl.searchParams, 'status'),
      limit: parseRowsLimit(request.nextUrl.searchParams.get('limit'), PAGE_SIZE.SELLER),
      cursor: request.nextUrl.searchParams.get('cursor'),
      sort: request.nextUrl.searchParams.get('sort'),
      filterPreset: parseCohortFilterPreset(request.nextUrl.searchParams.get('filter_preset')),
    });
    return timedJson(payload);
  } catch (error: any) {
    console.error('[GET /api/cohorts] DB error:', error?.code, error?.message);
    return timedJson({ error: 'Failed to fetch cohorts' }, { status: 500 });
  }
}

async function POSTImpl(request: NextRequest) {
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (claims.role !== 'seller_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) {
    return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const simpleParsed = CustomerGroupFormPayloadSchema.safeParse(body);
  const composerParsed = simpleParsed.success ? null : CohortCreateSchema.safeParse(body);
  if (!simpleParsed.success && !composerParsed?.success) {
    return NextResponse.json({ error: composerParsed?.error.errors[0]?.message ?? simpleParsed.error.errors[0]?.message ?? 'Validation failed' }, { status: 422 });
  }

  const isSimpleForm = simpleParsed.success;
  const membershipMode = isSimpleForm ? simpleParsed.data.membership_mode : 'manual';
  const data: any = isSimpleForm
    ? {
        name: simpleParsed.data.name,
        description: simpleParsed.data.description,
        is_static: membershipMode === 'manual',
        rules: membershipMode === 'automatic' ? simpleParsed.data.rules : null,
        allowed_tenant_brand_ids: simpleParsed.data.allowed_tenant_brand_ids,
      }
    : composerParsed!.data;
  const allowedTenantBrandIds =
    data.allowed_tenant_brand_ids && data.allowed_tenant_brand_ids.length > 0
      ? data.allowed_tenant_brand_ids
      : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  const { data: nameMatch } = await db
    .schema('app')
    .from('cohorts')
    .select('id')
    .eq('tenant_id', claims.tenant_id)
    .eq('name', data.name)
    .is('deleted_at', null)
    .maybeSingle();

  if (nameMatch) {
    return NextResponse.json({ error: 'A cohort with this name already exists.' }, { status: 409 });
  }

  // Validate the selected buyers belong to this tenant before creating anything, so a bad
  // selection can't leave an empty cohort behind.
  let manualMembersPlan: Awaited<ReturnType<typeof planManualCohortMembers>> | null = null;
  if (isSimpleForm && membershipMode === 'manual') {
    try {
      manualMembersPlan = await planManualCohortMembers(db, claims.tenant_id, null, simpleParsed.data.selected_buyer_ids);
    } catch (error) {
      console.error('[POST /api/cohorts] member plan error:', error instanceof Error ? error.message : error);
      return NextResponse.json({ error: 'Failed to validate selected buyers' }, { status: 500 });
    }
    if (manualMembersPlan.invalidBuyerIds.length > 0) {
      return NextResponse.json({ error: 'One or more selected buyers are invalid.' }, { status: 422 });
    }
  }

  const { data: cohort, error: insertError } = await db
    .schema('app')
    .from('cohorts')
    .insert({
      tenant_id: claims.tenant_id,
      name: data.name,
      description: data.description ?? null,
      is_static: data.is_static,
      membership_mode: membershipMode,
      rules: data.rules ?? null,
      allowed_tenant_brand_ids: allowedTenantBrandIds,
      created_by: claims.sub,
      updated_by: claims.sub,
    })
    .select()
    .single();

  if (insertError) {
    console.error('[POST /api/cohorts] DB error:', insertError.code, insertError.message);
    return NextResponse.json({ error: 'Failed to create cohort' }, { status: 500 });
  }

  let cachedMemberCount = 0;

  if (!isSimpleForm) {
    try {
      const memberIds = await resolveAllBuyerIdsForRules(db, claims.tenant_id, data.rules, data.is_static);
      cachedMemberCount = memberIds.length;

      if (memberIds.length > 0) {
        // SCD2: cohort_members only enforces uniqueness on the active row via a partial
        // index, which upsert-on-conflict can't target -- insert only for pairs with no
        // existing active row (a brand-new cohort has none, so this is effectively all rows,
        // but stays correct if this path is ever reused for an existing cohort).
        const rows = memberIds.map((buyerId) => ({ cohort_id: cohort.id, buyer_id: buyerId }));
        const { error: membersError } = await db.schema('app').from('cohort_members').insert(rows);

        if (membersError) {
          console.error('[POST /api/cohorts] member sync error:', membersError.message);
          return NextResponse.json({ error: 'Cohort created but failed to save members' }, { status: 500 });
        }
      }

      await db
        .schema('app')
        .from('cohorts')
        .update({ cached_member_count: cachedMemberCount })
        .eq('id', cohort.id)
        .eq('tenant_id', claims.tenant_id);
    } catch (error: any) {
      console.error('[POST /api/cohorts] composer sync error:', error?.message);
      return NextResponse.json({ error: 'Cohort created but failed to build membership' }, { status: 500 });
    }
  } else if (membershipMode === 'automatic') {
    // Recompute now (requirement 4: automatic membership evaluated on save), not left frozen
    // until the next scheduled refresh.
    const { error: refreshError } = await db.schema('app').rpc('refresh_cohort_by_id', { p_cohort_id: cohort.id });
    if (refreshError) {
      console.error('[POST /api/cohorts] refresh error:', refreshError.message);
    } else {
      const { count } = await db
        .schema('app')
        .from('cohort_members_active')
        .select('*', { count: 'exact', head: true })
        .eq('cohort_id', cohort.id);
      cachedMemberCount = count ?? 0;
    }
  } else if (manualMembersPlan) {
    try {
      cachedMemberCount = await applyManualCohortMembersPlan(db, claims.tenant_id, cohort.id, manualMembersPlan);
    } catch (error) {
      console.error('[POST /api/cohorts] member insert error:', error instanceof Error ? error.message : error);
      return NextResponse.json({ error: 'Cohort created but failed to save selected buyers' }, { status: 500 });
    }
  }

  getPostHogClient()?.capture({
    distinctId: claims.sub ?? claims.tenant_id,
    event: 'customer_group_created',
    properties: {
      tenant_id: claims.tenant_id,
      seller_id: claims.sub,
      cohort_id: cohort.id,
      membership_mode: membershipMode,
      is_static: Boolean(cohort.is_static),
      is_simple_form: isSimpleForm,
      member_count: cachedMemberCount,
      allowed_brands_count: allowedTenantBrandIds?.length ?? 0,
      has_rules: Boolean(data.rules),
      role: claims.role,
    },
  });

  return NextResponse.json({ cohort: { ...cohort, cached_member_count: cachedMemberCount } }, { status: 201 });
}

export const POST = withBuyerContextRevalidation(POSTImpl);
