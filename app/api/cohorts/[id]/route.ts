import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';
import { getSellerLandingPeriodMeta } from '@/lib/server/seller-period';
import { CohortUpdateSchema, CustomerGroupFormPayloadSchema } from '@/lib/zod';
import { buildCohortRulesSummary } from '@/lib/cohort-rules-summary';
import { getPostHogClient } from '@/lib/posthog-server';
import { getAuthUserEmailMap } from '@/lib/server/auth-user-directory';
import { resolveAllBuyerIdsForRules } from '@/lib/server/cohort-composer';
import { applyManualCohortMembersPlan, planManualCohortMembers } from '@/lib/server/cohort-manual-members';
import {
  aggregateCampaignViewsByCampaign,
  computeCampaignViewMetrics,
  type CampaignViewRow,
} from '@/lib/server/campaign-performance';

type DbClient = NonNullable<typeof supabaseAdmin>;

type BuyerRow = {
  id: string;
  business_name: string;
  tier: 'A' | 'B' | 'C' | null;
  geography: { city?: string; state?: string } | null;
};

type OrderRow = {
  id: string;
  buyer_id: string;
  total_amount: number | null;
  status: string;
  placed_at: string | null;
  order_date: string | null;
  campaign_id: string | null;
};

type CatalogRow = {
  id: string;
  scope_type: string;
  scope_value: { cohort_id?: string } | null;
  status: string;
  name: string;
  valid_from: string;
  created_at: string;
  updated_at: string;
};

type CatalogItemRow = {
  campaign_id: string;
  tenant_product_id: string;
};

type TenantProductRow = {
  id: string;
  tenant_brand_id: string | null;
};

type TenantBrandRow = {
  id: string;
  display_name_override: string | null;
  master_brand_id: string | null;
};

function getIstMonthWindow(now = new Date()) {
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istNow.getFullYear();
  const month = istNow.getMonth();

  const currentStart = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString().slice(0, 10);
  const nextStart = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0)).toISOString().slice(0, 10);

  return {
    currentStartDate: currentStart,
    nextStartDate: nextStart,
  };
}

function initialsFromName(name: string) {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function truncate56(text: string | null | undefined) {
  if (!text) return 'No description';
  return text.length > 56 ? `${text.slice(0, 56)}…` : text;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const includePerformance = request.nextUrl.searchParams.get('include_performance') !== 'false';
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const db = supabaseAdmin as DbClient as any;

  const { data: globalCohort, error: globalCohortError } = await db
    .schema('app')
    .from('cohorts')
    .select('id, tenant_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (globalCohortError) return NextResponse.json({ error: 'Failed to fetch cohort' }, { status: 500 });
  if (!globalCohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });
  if (globalCohort.tenant_id !== claims.tenant_id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: cohort, error: cohortError } = await db
    .schema('app')
    .from('cohorts')
    .select('id, tenant_id, name, description, rules, is_static, cached_member_count, last_refreshed_at, created_at, created_by, updated_at, allowed_tenant_brand_ids')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .single();

  if (cohortError || !cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });

  const cohortQuarterMeta = getSellerLandingPeriodMeta('quarter');
  const cohortQuarterStart = cohortQuarterMeta.current_start.slice(0, 10);

  const [{ data: buyers }, { data: members }, cohortPeriodRes] = await Promise.all([
    db
      .schema('app')
      .from('buyers')
      .select('id, business_name, tier, geography')
      .eq('tenant_id', claims.tenant_id)
      .eq('is_active', true)
      .is('deleted_at', null),
    db
      .schema('app')
      .from('cohort_members_active')
      .select('cohort_id, buyer_id')
      .eq('cohort_id', id),
    db
      .schema('app')
      .from('metrics_cohort_period_summary')
      .select('member_count, active_member_count, demand_count, demand_value, invoice_count, invoice_value')
      .eq('cohort_id', id)
      .eq('tenant_id', claims.tenant_id)
      .eq('grain', 'quarter')
      .eq('period_start', cohortQuarterStart)
      .is('deleted_at', null)
      .maybeSingle(),
  ]);

  if (cohortPeriodRes.error) {
    console.error('[GET /api/cohorts/[id]] metrics_cohort_period_summary fetch failed', cohortPeriodRes.error);
    return NextResponse.json({ error: 'Failed to fetch cohort detail' }, { status: 500 });
  }
  const cohortQuarter = (cohortPeriodRes.data ?? null) as {
    member_count: number;
    active_member_count: number;
    demand_count: number;
    demand_value: number;
    invoice_count: number;
    invoice_value: number;
  } | null;

  const buyerRows = (buyers ?? []) as BuyerRow[];
  const memberRows = members ?? [];
  const allowedTenantBrandIds = (cohort.allowed_tenant_brand_ids as string[] | null | undefined) ?? null;

  const memberBuyerIds = new Set<string>(memberRows.map((row: { buyer_id: string }) => row.buyer_id));
  const totalMembers = cohort.cached_member_count ?? memberBuyerIds.size;

  const currentMembers = buyerRows.filter((b) => memberBuyerIds.has(b.id));
  const memberPreview = currentMembers
    .slice(0, 10)
    .map((b) => ({ id: b.id, name: b.business_name, city: b.geography?.city ?? b.geography?.state ?? '—', tier: b.tier ?? '—' }));

  const memberBuyerIdsList = Array.from(memberBuyerIds);

  // Brand-name lookup for details_rules/rules_summary (always needed) — scoped to just the
  // cohort's allowed brands. When include_performance is on, this list is widened below to
  // also cover brands actually carried by scoped-catalog products (brands_carried figure).
  let tenantBrandIdsToLoad = Array.from(new Set(allowedTenantBrandIds ?? []));

  let performance: {
    summary: { gmv_mtd: number; aov: number };
    engagement: {
      active_members: number;
      total_members: number;
      dormant_members: number;
      conversion_pct: number;
      brands_sold: number;
      brands_carried: number;
    };
    top_members: Array<{
      buyer_id: string;
      buyer_name: string;
      city: string;
      initials: string;
      spend_mtd: number;
      order_count_mtd: number;
    }>;
    catalogs: Array<{
      campaign_id: string;
      catalog_name: string;
      sent_at: string;
      opens: number;
      orders: number;
      gmv: number;
    }>;
  } | null = null;

  if (includePerformance) {
    const { data: scopedCatalogRowsData, error: scopedCatalogRowsError } = await db
      .schema('app')
      .from('campaigns')
      .select('id, scope_type, scope_value, status, name, valid_from, created_at, updated_at')
      .eq('tenant_id', claims.tenant_id)
      .eq('scope_type', 'cohort')
      .contains('scope_value', { cohort_id: id })
      .is('deleted_at', null);

    if (scopedCatalogRowsError) {
      return NextResponse.json({ error: 'Failed to fetch cohort catalogs' }, { status: 500 });
    }

    const scopedCatalogs = (scopedCatalogRowsData ?? []) as CatalogRow[];
    const scopedCatalogIds = scopedCatalogs.map((catalog) => catalog.id);
    const { currentStartDate, nextStartDate } = getIstMonthWindow();

    const [memberOrdersRes, scopedCatalogOrdersRes, campaignViewsRes, catalogItemsRes] = await Promise.all([
      memberBuyerIdsList.length > 0
        ? db
            .schema('app')
            .from('orders')
            .select('id, buyer_id, total_amount, status, placed_at, order_date, campaign_id')
            .eq('tenant_id', claims.tenant_id)
            .in('buyer_id', memberBuyerIdsList)
            .neq('status', 'cancelled')
            .is('deleted_at', null)
        : Promise.resolve({ data: [], error: null }),
      scopedCatalogIds.length > 0
        ? db
            .schema('app')
            .from('orders')
            .select('id, buyer_id, total_amount, status, placed_at, order_date, campaign_id')
            .eq('tenant_id', claims.tenant_id)
            .in('campaign_id', scopedCatalogIds)
            .neq('status', 'cancelled')
            .is('deleted_at', null)
        : Promise.resolve({ data: [], error: null }),
      scopedCatalogIds.length > 0
        ? db
            .schema('app')
            .from('campaign_views')
            .select('buyer_id, campaign_id, viewed_at, view_date')
            .eq('tenant_id', claims.tenant_id)
            .in('campaign_id', scopedCatalogIds)
            .gte('view_date', currentStartDate)
            .lt('view_date', nextStartDate)
            .is('deleted_at', null)
        : Promise.resolve({ data: [], error: null }),
      scopedCatalogIds.length > 0
        ? db
            .schema('app')
            .from('campaign_items')
            .select('campaign_id, tenant_product_id')
            .in('campaign_id', scopedCatalogIds)
            .is('deleted_at', null)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (memberOrdersRes.error || scopedCatalogOrdersRes.error || campaignViewsRes.error || catalogItemsRes.error) {
      return NextResponse.json({ error: 'Failed to fetch cohort detail metrics' }, { status: 500 });
    }

    const orderRows = (memberOrdersRes.data ?? []) as OrderRow[];
    const scopedCatalogOrders = (scopedCatalogOrdersRes.data ?? []) as OrderRow[];
    const campaignViewRows = (campaignViewsRes.data ?? []) as CampaignViewRow[];
    const catalogItemRows = (catalogItemsRes.data ?? []) as CatalogItemRow[];
    const catalogProductIds = Array.from(new Set(catalogItemRows.map((row) => row.tenant_product_id)));

    const { data: tenantProductsData, error: tenantProductsError } = catalogProductIds.length > 0
      ? await db
          .schema('app')
          .from('tenant_products')
          .select('id, tenant_brand_id')
          .eq('tenant_id', claims.tenant_id)
          .in('id', catalogProductIds)
          .is('deleted_at', null)
      : { data: [], error: null };

    if (tenantProductsError) {
      return NextResponse.json({ error: 'Failed to fetch catalog products' }, { status: 500 });
    }

    const tenantProductRows = (tenantProductsData ?? []) as TenantProductRow[];
    const carriedBrandIds = Array.from(
      new Set(
        tenantProductRows
          .map((row) => row.tenant_brand_id)
          .filter((brandId): brandId is string => Boolean(brandId)),
      ),
    );
    tenantBrandIdsToLoad = Array.from(new Set([...tenantBrandIdsToLoad, ...carriedBrandIds]));

    let gmvMtd = 0;
    let ordersMtd = 0;
    const activeMembersSet = new Set<string>();

    for (const order of orderRows) {
      if (!memberBuyerIds.has(order.buyer_id)) continue;
      const amount = Number(order.total_amount ?? 0);
      const metricDay = order.order_date ?? (order.placed_at ? new Date(order.placed_at).toISOString().slice(0, 10) : null);
      if (!metricDay) continue;

      if (metricDay >= currentStartDate && metricDay < nextStartDate) {
        gmvMtd += amount;
        ordersMtd += 1;
        activeMembersSet.add(order.buyer_id);
      }
    }

    const aov = ordersMtd > 0 ? gmvMtd / ordersMtd : 0;

    const scopedCatalogIdSet = new Set(scopedCatalogIds);

    const catalogOrdersMtd = scopedCatalogOrders.filter((order) => {
      if (!order.campaign_id || !scopedCatalogIdSet.has(order.campaign_id)) return false;
      const metricDay = order.order_date ?? (order.placed_at ? new Date(order.placed_at).toISOString().slice(0, 10) : null);
      return Boolean(metricDay && metricDay >= currentStartDate && metricDay < nextStartDate);
    }).length;

    const uniqueCatalogViews = computeCampaignViewMetrics(campaignViewRows).uniqueViewers;
    const conversionPct = uniqueCatalogViews > 0 ? Number(((catalogOrdersMtd / uniqueCatalogViews) * 100).toFixed(1)) : 0;

    const mtdSpendByBuyer = new Map<string, number>();
    for (const order of orderRows) {
      const metricDay = order.order_date ?? (order.placed_at ? new Date(order.placed_at).toISOString().slice(0, 10) : null);
      if (!memberBuyerIds.has(order.buyer_id) || !metricDay) continue;
      if (metricDay < currentStartDate || metricDay >= nextStartDate) continue;
      mtdSpendByBuyer.set(order.buyer_id, (mtdSpendByBuyer.get(order.buyer_id) ?? 0) + Number(order.total_amount ?? 0));
    }

    const ordersByBuyerMtd = new Map<string, number>();
    for (const order of orderRows) {
      const metricDay = order.order_date ?? (order.placed_at ? new Date(order.placed_at).toISOString().slice(0, 10) : null);
      if (!memberBuyerIds.has(order.buyer_id) || !metricDay) continue;
      if (metricDay < currentStartDate || metricDay >= nextStartDate) continue;
      ordersByBuyerMtd.set(order.buyer_id, (ordersByBuyerMtd.get(order.buyer_id) ?? 0) + 1);
    }

    const topMembers = currentMembers
      .map((member) => ({
        buyer_id: member.id,
        buyer_name: member.business_name,
        city: member.geography?.city ?? member.geography?.state ?? '—',
        initials: initialsFromName(member.business_name),
        spend_mtd: Number((mtdSpendByBuyer.get(member.id) ?? 0).toFixed(2)),
        order_count_mtd: ordersByBuyerMtd.get(member.id) ?? 0,
      }))
      .sort((a, b) => b.spend_mtd - a.spend_mtd);

    const dormantMembers = Math.max(0, totalMembers - activeMembersSet.size);

    const scopedCatalogOrdersMtd = scopedCatalogOrders.filter((order) => {
      if (!order.campaign_id || !scopedCatalogIdSet.has(order.campaign_id)) return false;
      const metricDay = order.order_date ?? (order.placed_at ? new Date(order.placed_at).toISOString().slice(0, 10) : null);
      return Boolean(metricDay && metricDay >= currentStartDate && metricDay < nextStartDate);
    });

    const tenantProductToBrand = new Map<string, string | null>(tenantProductRows.map((row) => [row.id, row.tenant_brand_id]));
    const brandIdsCarried = new Set<string>();
    const catalogProductIdsByCatalog = new Map<string, string[]>();
    for (const row of catalogItemRows) {
      if (!scopedCatalogIdSet.has(row.campaign_id)) continue;
      if (!catalogProductIdsByCatalog.has(row.campaign_id)) catalogProductIdsByCatalog.set(row.campaign_id, []);
      catalogProductIdsByCatalog.get(row.campaign_id)?.push(row.tenant_product_id);
      const brandId = tenantProductToBrand.get(row.tenant_product_id);
      if (brandId) brandIdsCarried.add(brandId);
    }

    const brandIdsSold = new Set<string>();
    for (const order of scopedCatalogOrdersMtd) {
      if (!order.campaign_id) continue;
      const productIds = catalogProductIdsByCatalog.get(order.campaign_id) ?? [];
      for (const productId of productIds) {
        const brandId = tenantProductToBrand.get(productId);
        if (brandId) brandIdsSold.add(brandId);
      }
    }

    const opensByCatalog = aggregateCampaignViewsByCampaign(campaignViewRows);
    const ordersByCatalogMtd = new Map<string, { orders: number; gmv: number }>();
    for (const order of scopedCatalogOrdersMtd) {
      if (!order.campaign_id) continue;
      const current = ordersByCatalogMtd.get(order.campaign_id) ?? { orders: 0, gmv: 0 };
      current.orders += 1;
      current.gmv += Number(order.total_amount ?? 0);
      ordersByCatalogMtd.set(order.campaign_id, current);
    }

    const catalogs = scopedCatalogs
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .map((catalog) => {
        const stats = ordersByCatalogMtd.get(catalog.id) ?? { orders: 0, gmv: 0 };
        return {
          campaign_id: catalog.id,
          catalog_name: catalog.name,
          sent_at: catalog.valid_from ?? catalog.updated_at ?? catalog.created_at,
          opens: opensByCatalog.get(catalog.id)?.uniqueViewers ?? 0,
          orders: stats.orders,
          gmv: Number(stats.gmv.toFixed(2)),
        };
      });

    performance = {
      summary: { gmv_mtd: gmvMtd, aov },
      engagement: {
        active_members: activeMembersSet.size,
        total_members: totalMembers,
        dormant_members: dormantMembers,
        conversion_pct: conversionPct,
        brands_sold: brandIdsSold.size,
        brands_carried: brandIdsCarried.size,
      },
      top_members: topMembers,
      catalogs,
    };
  }

  const { data: tenantBrandsData, error: tenantBrandsError } = tenantBrandIdsToLoad.length > 0
    ? await db
        .schema('app')
        .from('tenant_brands')
        .select('id, display_name_override, master_brand_id')
        .eq('tenant_id', claims.tenant_id)
        .in('id', tenantBrandIdsToLoad)
        .is('deleted_at', null)
    : { data: [], error: null };

  if (tenantBrandsError) {
    return NextResponse.json({ error: 'Failed to fetch catalog brands' }, { status: 500 });
  }

  const tenantBrandRows = (tenantBrandsData ?? []) as TenantBrandRow[];
  const masterBrandIds = Array.from(new Set(tenantBrandRows.map((row) => row.master_brand_id).filter(Boolean) as string[]));
  const { data: masterBrandsData } = masterBrandIds.length > 0
    ? await db.schema('catalog').from('brands').select('id, name').in('id', masterBrandIds)
    : { data: [] };
  const masterBrandMap = new Map(((masterBrandsData ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
  const tenantBrandNameMap = new Map(
    tenantBrandRows.map((row) => [
      row.id,
      row.display_name_override ?? (row.master_brand_id ? masterBrandMap.get(row.master_brand_id) ?? 'Unnamed brand' : 'Unnamed brand'),
    ]),
  );
  const allowedBrandNames = allowedTenantBrandIds?.map((brandId) => tenantBrandNameMap.get(brandId) ?? 'Unnamed brand') ?? [];

  const createdByUserMap = await getAuthUserEmailMap(cohort.created_by ? [cohort.created_by] : []);
  const createdByLabel = cohort.created_by ? createdByUserMap.get(cohort.created_by) ?? 'Team member' : 'System';
  const createdBy = `Created by ${createdByLabel}`;

  const rulesPayload = cohort.rules ?? { filters: [] };
  const rules_summary = buildCohortRulesSummary({
    is_static: cohort.is_static,
    filters: rulesPayload.filters ?? [],
    member_count: totalMembers,
    total_tenant_buyers: buyerRows.length,
    allowed_brand_names: allowedBrandNames,
  });

  return NextResponse.json({
    header: {
      id: cohort.id,
      cohort_name: cohort.name,
      status_label: 'Active',
      status_tone: 'success',
      initials: initialsFromName(cohort.name),
      hue: cohort.is_static ? 'cream' : 'ember',
      subtitle: {
        members_text: `${totalMembers} of ${buyerRows.length} buyers`,
        description_text: truncate56(cohort.description),
        created_by_text: createdBy,
      },
    },
    meta_strip_4: {
      active_member_count: cohortQuarter?.active_member_count ?? memberBuyerIds.size,
      member_count: cohortQuarter?.member_count ?? totalMembers,
      sales_qtd_value: cohortQuarter?.invoice_value ?? 0,
      sales_qtd_count: cohortQuarter?.invoice_count ?? 0,
      demand_qtd_value: cohortQuarter?.demand_value ?? 0,
      demand_qtd_count: cohortQuarter?.demand_count ?? 0,
      brands_count: allowedTenantBrandIds && allowedTenantBrandIds.length > 0 ? allowedTenantBrandIds.length : null,
    },
    details_rules: {
      id: cohort.id,
      name: cohort.name,
      description: cohort.description ?? '',
      type: cohort.is_static ? 'Static list' : 'Rule-based',
      is_static: cohort.is_static,
      allowed_tenant_brand_ids: allowedTenantBrandIds,
      allowed_brand_names: allowedBrandNames,
      rules: cohort.rules ?? { filters: [] },
      members_preview: memberPreview,
      updated_at: cohort.updated_at,
      last_refreshed_at: (cohort as any).last_refreshed_at ?? null,
    },
    performance,
    rules_summary,
  }, { headers: SELLER_CACHE_PERSONAL });
}

async function PATCHImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const simpleParsed = CustomerGroupFormPayloadSchema.safeParse(body);
  const composerParsed = simpleParsed.success ? null : CohortUpdateSchema.safeParse(body);
  if (!simpleParsed.success && !composerParsed?.success) {
    return NextResponse.json({ error: composerParsed?.error.errors[0]?.message ?? simpleParsed.error.errors[0]?.message ?? 'Validation failed' }, { status: 422 });
  }

  const db = supabaseAdmin as DbClient as any;

  const { data: existing } = await db
    .schema('app')
    .from('cohorts')
    .select('id, is_static, rules')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });

  const isSimpleForm = simpleParsed.success;
  const payload: any = isSimpleForm
    ? {
        name: simpleParsed.data.name,
        description: simpleParsed.data.description,
        allowed_tenant_brand_ids: simpleParsed.data.allowed_tenant_brand_ids,
        membership_mode: simpleParsed.data.membership_mode,
        selected_buyer_ids: simpleParsed.data.selected_buyer_ids,
        rules: simpleParsed.data.rules,
      }
    : composerParsed!.data;
  const simpleMembershipMode = isSimpleForm ? payload.membership_mode : undefined;

  // Plan the manual-membership change (and validate newly added buyers) before touching the
  // cohort row, so a bad selection is rejected without a half-applied edit.
  let manualMembersPlan: Awaited<ReturnType<typeof planManualCohortMembers>> | null = null;
  if (isSimpleForm && simpleMembershipMode === 'manual') {
    try {
      manualMembersPlan = await planManualCohortMembers(
        db,
        claims.tenant_id,
        id,
        payload.selected_buyer_ids ?? [],
      );
    } catch (error) {
      console.error('[PATCH /api/cohorts/[id]] member plan error:', error instanceof Error ? error.message : error);
      return NextResponse.json({ error: 'Failed to update selected buyers' }, { status: 500 });
    }
    if (manualMembersPlan.invalidBuyerIds.length > 0) {
      return NextResponse.json({ error: 'One or more selected buyers are invalid.' }, { status: 422 });
    }
  }

  if (payload.name) {
    const { data: nameMatch } = await db
      .schema('app')
      .from('cohorts')
      .select('id')
      .eq('tenant_id', claims.tenant_id)
      .eq('name', payload.name)
      .is('deleted_at', null)
      .neq('id', id)
      .maybeSingle();
    if (nameMatch) return NextResponse.json({ error: 'A cohort with this name already exists.' }, { status: 409 });
  }

  const nextRules =
    !isSimpleForm && payload.rules !== undefined ? payload.rules : existing.rules;
  const nextIsStatic =
    !isSimpleForm && payload.is_static !== undefined ? payload.is_static : existing.is_static;

  const normalizedAllowedBrandIds =
    payload.allowed_tenant_brand_ids === undefined
      ? undefined
      : payload.allowed_tenant_brand_ids && payload.allowed_tenant_brand_ids.length > 0
        ? payload.allowed_tenant_brand_ids
        : null;

  const { data: cohort, error: updateError } = await db
    .schema('app')
    .from('cohorts')
    .update({
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined ? { description: payload.description || null } : {}),
      ...(!isSimpleForm && payload.is_static !== undefined ? { is_static: payload.is_static } : {}),
      ...(!isSimpleForm && payload.rules !== undefined ? { rules: payload.rules } : {}),
      ...(isSimpleForm && simpleMembershipMode !== undefined ? {
        membership_mode: simpleMembershipMode,
        is_static: simpleMembershipMode === 'manual',
        rules: simpleMembershipMode === 'automatic' ? payload.rules : null,
      } : {}),
      ...(normalizedAllowedBrandIds !== undefined ? { allowed_tenant_brand_ids: normalizedAllowedBrandIds } : {}),
      updated_at: new Date().toISOString(),
      updated_by: claims.sub,
    })
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .select()
    .single();

  if (updateError) {
    console.error('[PATCH /api/cohorts/[id]]', updateError.message);
    return NextResponse.json({ error: 'Failed to update cohort' }, { status: 500 });
  }

  if (isSimpleForm && simpleMembershipMode === 'automatic') {
    // Mode switch or rule edit -- recompute now (requirement 4).
    const { error: refreshError } = await db.schema('app').rpc('refresh_cohort_by_id', { p_cohort_id: id });
    if (refreshError) {
      console.error('[PATCH /api/cohorts/[id]] refresh error:', refreshError.message);
    }
  } else if (isSimpleForm && simpleMembershipMode === 'manual' && manualMembersPlan) {
    try {
      cohort.cached_member_count = await applyManualCohortMembersPlan(db, claims.tenant_id, id, manualMembersPlan);
    } catch (error) {
      console.error('[PATCH /api/cohorts/[id]] member sync error:', error instanceof Error ? error.message : error);
      return NextResponse.json({ error: 'Failed to save selected buyers' }, { status: 500 });
    }
  }

  if (!isSimpleForm) {
    try {
      const memberIds = await resolveAllBuyerIdsForRules(db, claims.tenant_id, nextRules, nextIsStatic);

      // SCD2: diff against the currently-active set instead of clear-and-rebuild -- close
      // rows for buyers no longer matched, insert rows only for newly-matched buyers. Never
      // hard-delete, and never touch rows for buyers whose membership hasn't changed (so
      // their original valid_from is preserved for point-in-time attribution).
      const { data: activeRows } = await db
        .schema('app')
        .from('cohort_members_active')
        .select('buyer_id')
        .eq('cohort_id', id);
      const currentlyActive = new Set<string>((activeRows ?? []).map((row: { buyer_id: string }) => row.buyer_id));
      const nextSet = new Set<string>(memberIds);

      const toClose = [...currentlyActive].filter((buyerId) => !nextSet.has(buyerId));
      const toAdd = memberIds.filter((buyerId) => !currentlyActive.has(buyerId));

      if (toClose.length > 0) {
        const { error: closeError } = await db
          .schema('app')
          .from('cohort_members')
          .update({ valid_until: new Date().toISOString() })
          .eq('cohort_id', id)
          .in('buyer_id', toClose)
          .is('valid_until', null);
        if (closeError) {
          console.error('[PATCH /api/cohorts/[id]] member close error:', closeError.message);
          return NextResponse.json({ error: 'Failed to refresh cohort members' }, { status: 500 });
        }
      }

      if (toAdd.length > 0) {
        const rows = toAdd.map((buyerId) => ({ cohort_id: id, buyer_id: buyerId }));
        const { error: membersError } = await db.schema('app').from('cohort_members').insert(rows);

        if (membersError) {
          console.error('[PATCH /api/cohorts/[id]] member sync error:', membersError.message);
          return NextResponse.json({ error: 'Failed to refresh cohort members' }, { status: 500 });
        }
      }

      await db
        .schema('app')
        .from('cohorts')
        .update({ cached_member_count: memberIds.length, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('tenant_id', claims.tenant_id);

      cohort.cached_member_count = memberIds.length;
    } catch (error: any) {
      console.error('[PATCH /api/cohorts/[id]] composer sync error:', error?.message);
      return NextResponse.json({ error: 'Failed to rebuild cohort membership' }, { status: 500 });
    }
  }

  getPostHogClient()?.capture({
    distinctId: claims.sub ?? claims.tenant_id,
    event: 'customer_group_updated',
    properties: {
      tenant_id: claims.tenant_id,
      seller_id: claims.sub,
      cohort_id: id,
      membership_mode: isSimpleForm ? simpleMembershipMode : (cohort as any).membership_mode ?? null,
      is_static: Boolean((cohort as any).is_static),
      is_simple_form: isSimpleForm,
      member_count: (cohort as any).cached_member_count ?? null,
      allowed_brands_count: Array.isArray((cohort as any).allowed_tenant_brand_ids)
        ? (cohort as any).allowed_tenant_brand_ids.length
        : 0,
      changed_name: payload.name !== undefined,
      changed_rules: payload.rules !== undefined,
      changed_allowed_brands: payload.allowed_tenant_brand_ids !== undefined,
      role: claims.role,
    },
  });

  return NextResponse.json({ cohort });
}

async function DELETEImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const db = supabaseAdmin as DbClient as any;

  const { data: cohort } = await db
    .schema('app')
    .from('cohorts')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });

  const { data: activeCatalogs } = await db
    .schema('app')
    .from('campaigns')
    .select('id')
    .eq('tenant_id', claims.tenant_id)
    .eq('status', 'published')
    .eq('scope_type', 'cohort')
    .contains('scope_value', { cohort_id: id })
    .is('deleted_at', null);

  if (activeCatalogs && activeCatalogs.length > 0) {
    return NextResponse.json(
      { error: 'This cohort is used in an active catalog. Archive the catalog before deleting the cohort.', code: 'COHORT_IN_USE' },
      { status: 409 },
    );
  }

  const { error: deleteError } = await db
    .schema('app')
    .from('cohorts')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null);

  if (deleteError) {
    console.error('[DELETE /api/cohorts/[id]]', deleteError.message);
    return NextResponse.json({ error: 'Failed to delete cohort' }, { status: 500 });
  }

  getPostHogClient()?.capture({
    distinctId: claims.sub ?? claims.tenant_id,
    event: 'customer_group_deleted',
    properties: {
      tenant_id: claims.tenant_id,
      seller_id: claims.sub,
      cohort_id: id,
      active_catalog_count: activeCatalogs?.length ?? 0,
      role: claims.role,
    },
  });

  return NextResponse.json({ ok: true });
}

export const PATCH = withBuyerContextRevalidation(PATCHImpl);

export const DELETE = withBuyerContextRevalidation(DELETEImpl);
