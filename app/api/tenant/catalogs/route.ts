import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { getVerifiedClaims } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { createTimer } from '@/lib/server-timing';
import { getSellerLandingPeriodMeta } from '@/lib/server/seller-period';
import { PAGE_SIZE } from '@/lib/pagination';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming, parseRowsLimit } from '@/lib/server/bounded-get';
import { resolveCampaignWorkflowStatus, type CampaignWorkflowStatus, type CampaignWorkflowStatusLabel, type CampaignWorkflowStatusTone, type RawCampaignStatus } from '@/lib/campaign-workflow-status';
import { CampaignFormPayloadSchema, CatalogComposerPayloadSchema, type CatalogComposerFilterState, type CatalogComposerTag } from '@/lib/zod';
import { revalidateSellerDashboardCache } from '@/lib/server/dashboard-cache';
import { revalidatePublicCatalogCache } from '@/lib/server/public-catalog-cache';
import { queueCampaignPublishNotify } from '@/lib/server/campaign-publish-notify';
import { runCampaignPublishPreflight } from '@/lib/server/campaign-publish-preflight';
import { getFlag } from '@/lib/flags';
import { FEATURE_FLAGS } from '@/constants';
import { readArrayParam } from '@/lib/landing-filter-params';
import { getPostHogClient } from '@/lib/posthog-server';
import { searchSellerLandingEntityIds } from '@/lib/server/seller-landing-entity-search';

type CatalogStatus = RawCampaignStatus;
type DisplayStatus = CampaignWorkflowStatusLabel;
type StatusTone = CampaignWorkflowStatusTone;
type AvatarHue = 'teal' | 'ember' | 'cream';

interface CatalogRow {
  id: string;
  name: string;
  scope_type: 'cohort' | 'buyer' | 'geography' | 'all';
  scope_value: Record<string, unknown> | null;
  valid_from: string;
  valid_to: string | null;
  status: CatalogStatus;
  created_at: string;
  hero_image_url: string | null;
}

interface CatalogItemRow {
  campaign_id: string;
  tenant_product_id: string;
}

interface TenantProductRow {
  id: string;
  internal_sku: string;
  name_override: string | null;
  tenant_brand_id: string | null;
  category_name: string | null;
  mrp: number | null;
  base_selling_price: number | null;
  created_at: string;
}

function getHue(index: number): AvatarHue {
  if (index % 3 === 0) return 'teal';
  if (index % 3 === 1) return 'ember';
  return 'cream';
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function buildCatalogScopeValue(input: {
  scopeType: 'cohort' | 'buyer' | 'geography' | 'all';
  cohortId?: string | null;
  buyerId?: string | null;
  buyerIds?: string[];
  geography?: { state?: string; city?: string; zone?: string } | null;
  filters: CatalogComposerFilterState;
  tagOverrides?: Record<string, CatalogComposerTag | null>;
  priceSource?: 'price_list' | 'manual';
  priceListId?: string | null;
}) {
  const scope: Record<string, unknown> = {
    composer: {
      filters: input.filters,
      tag_overrides: input.tagOverrides ?? {},
      price_source: input.priceSource ?? 'manual',
      price_list_id: input.priceListId ?? null,
    },
  };

  if (input.scopeType === 'cohort' && input.cohortId) {
    scope.cohort_id = input.cohortId;
  } else if (input.scopeType === 'buyer' && input.buyerId) {
    scope.buyer_id = input.buyerId;
  } else if (input.scopeType === 'buyer' && input.buyerIds && input.buyerIds.length > 0) {
    scope.buyer_ids = input.buyerIds;
  } else if (input.scopeType === 'geography' && input.geography) {
    scope.geography = input.geography;
  }

  return scope;
}

function buildSimpleFormMeta(description?: string | null) {
  return {
    description: description?.trim() ? description.trim() : null,
  };
}

function generateShareToken() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

type CampaignCursor = {
  t: string;
  i: string;
};

type CampaignMetricRow = {
  campaign_id: string;
  viewed_buyer_count: number | string | null;
  view_count: number | string | null;
  estimate_count: number | string | null;
  estimate_value: number | string | null;
  order_count: number | string | null;
  order_value: number | string | null;
  invoice_count: number | string | null;
  invoice_value: number | string | null;
  demand_buyer_count: number | string | null;
  revenue_buyer_count: number | string | null;
};

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function encodeCampaignCursor(payload: CampaignCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCampaignCursor(cursor: string | null): CampaignCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Partial<CampaignCursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') return null;
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
}

function parseCampaignFilterPreset(raw: string | null): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function campaignMatchesConversion(metric: CampaignMetricRow, conversions: string[]): boolean {
  if (conversions.length === 0) return true;
  return conversions.some((value) => {
    if (value === 'has_viewed') return toNumber(metric.viewed_buyer_count) > 0 || toNumber(metric.view_count) > 0;
    if (value === 'has_demand') return toNumber(metric.demand_buyer_count) > 0 || toNumber(metric.estimate_count) > 0 || toNumber(metric.order_count) > 0;
    if (value === 'has_revenue') return toNumber(metric.revenue_buyer_count) > 0 || toNumber(metric.invoice_count) > 0 || toNumber(metric.invoice_value) > 0;
    return false;
  });
}

function conversionFiltersFromPreset(preset: Record<string, unknown> | null): string[] {
  if (!preset) return [];
  const values = new Set<string>();
  if (preset.has_viewed === true || preset.conversion === 'has_viewed') values.add('has_viewed');
  if (preset.has_demand === true || preset.conversion === 'has_demand') values.add('has_demand');
  if (preset.has_revenue === true || preset.conversion === 'has_revenue') values.add('has_revenue');
  return Array.from(values);
}

function normalizeStatusLabels(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value && value !== 'All');
}

async function getOptimizedCatalogsLanding(req: NextRequest, timedJson: (body: unknown, init?: ResponseInit) => NextResponse) {
  const claims = await getVerifiedClaims(req);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  const tenantId = claims.tenant_id;
  const db = supabaseAdmin;
  const now = new Date();
  const nowTs = now.getTime();
  const period = getSellerLandingPeriodMeta('quarter', now);
  const limit = parseRowsLimit(req.nextUrl.searchParams.get('limit'), PAGE_SIZE.SELLER);
  const cursor = decodeCampaignCursor(req.nextUrl.searchParams.get('cursor'));
  const search = req.nextUrl.searchParams.get('search')?.trim() ?? '';
  const statusLabels = normalizeStatusLabels(readArrayParam(req.nextUrl.searchParams, 'status'));
  const preset = parseCampaignFilterPreset(req.nextUrl.searchParams.get('filter_preset'));
  const conversions = Array.from(new Set([
    ...readArrayParam(req.nextUrl.searchParams, 'conversion'),
    ...conversionFiltersFromPreset(preset),
  ]));
  const periodStart = period.current_start.slice(0, 10);
  const scanLimit = Math.max(limit * 6, 300);

  const metricsRes = await db
    .schema('app')
    .from('metrics_campaign_period_summary')
    .select('campaign_id, viewed_buyer_count, view_count, estimate_count, estimate_value, order_count, order_value, invoice_count, invoice_value, demand_buyer_count, revenue_buyer_count')
    .eq('tenant_id', tenantId)
    .eq('grain', 'quarter')
    .eq('period_start', periodStart)
    .is('deleted_at', null)
    .limit(scanLimit);
  if (metricsRes.error) {
    console.error('[GET /api/tenant/catalogs] V4 metrics query error:', metricsRes.error);
    return timedJson({ error: 'Failed to fetch catalogs landing' }, { status: 500 });
  }

  const metricById = new Map<string, CampaignMetricRow>(
    ((metricsRes.data ?? []) as CampaignMetricRow[]).map((metric) => [metric.campaign_id, metric]),
  );

  let campaignQuery = db
    .schema('app')
    .from('campaigns')
    .select('id, name, scope_type, scope_value, valid_from, valid_to, status, created_at, hero_image_url')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(scanLimit);
  if (cursor) {
    campaignQuery = campaignQuery.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.i})`);
  }
  if (search) {
    // Indexed (idx_campaigns_search_vector) candidate-id lookup instead of an
    // unindexed ILIKE seq scan.
    const { ids: searchIds } = await searchSellerLandingEntityIds({
      tenantId,
      entity: 'campaigns',
      query: search,
      limit: scanLimit,
    });
    campaignQuery = campaignQuery.in('id', searchIds.length > 0 ? searchIds : ['00000000-0000-0000-0000-000000000000']);
  }

  const campaignsRes = await campaignQuery;
  if (campaignsRes.error) {
    console.error('[GET /api/tenant/catalogs] campaigns query error:', campaignsRes.error);
    return timedJson({ error: 'Failed to fetch catalogs landing' }, { status: 500 });
  }

  const zeroMetric = (campaignId: string): CampaignMetricRow => ({
    campaign_id: campaignId,
    viewed_buyer_count: 0,
    view_count: 0,
    estimate_count: 0,
    estimate_value: 0,
    order_count: 0,
    order_value: 0,
    invoice_count: 0,
    invoice_value: 0,
    demand_buyer_count: 0,
    revenue_buyer_count: 0,
  });
  const candidateCampaigns = ((campaignsRes.data ?? []) as CatalogRow[])
    .map((campaign) => ({ campaign, metric: metricById.get(campaign.id) ?? zeroMetric(campaign.id) }))
    .filter(({ campaign, metric }) => {
      const workflowStatus = resolveCampaignWorkflowStatus({
        rawStatus: campaign.status,
        validFrom: campaign.valid_from,
        validTo: campaign.valid_to,
        now,
      });
      const statusMatch = statusLabels.length === 0 || statusLabels.includes(workflowStatus.label);
      return statusMatch && campaignMatchesConversion(metric, conversions);
    });
  const pagePairs = candidateCampaigns.slice(0, limit);
  const extraPair = candidateCampaigns[limit];
  const pageCampaignIds = pagePairs.map(({ campaign }) => campaign.id);

  const [itemsRes, membersRes] = pageCampaignIds.length > 0
    ? await Promise.all([
        db
          .schema('app')
          .from('campaign_items')
          .select('campaign_id, tenant_product_id')
          .in('campaign_id', pageCampaignIds)
          .is('deleted_at', null),
        db
          .schema('app')
          .from('campaign_buyer_members')
          .select('campaign_id, buyer_id')
          .in('campaign_id', pageCampaignIds)
          .is('valid_until', null),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (itemsRes.error || membersRes.error) {
    console.error('[GET /api/tenant/catalogs] enrichment query error:', itemsRes.error || membersRes.error);
    return timedJson({ error: 'Failed to fetch catalogs landing' }, { status: 500 });
  }

  const items = (itemsRes.data ?? []) as CatalogItemRow[];
  const productIds = Array.from(new Set(items.map((item) => item.tenant_product_id)));
  const productsRes = productIds.length > 0
    ? await db
        .schema('app')
        .from('tenant_products')
        .select('id, tenant_brand_id')
        .in('id', productIds)
        .is('deleted_at', null)
    : { data: [], error: null };
  if (productsRes.error) {
    console.error('[GET /api/tenant/catalogs] product enrichment error:', productsRes.error);
    return timedJson({ error: 'Failed to fetch catalogs landing' }, { status: 500 });
  }

  const itemsByCampaign = new Map<string, CatalogItemRow[]>();
  for (const item of items) {
    if (!itemsByCampaign.has(item.campaign_id)) itemsByCampaign.set(item.campaign_id, []);
    itemsByCampaign.get(item.campaign_id)?.push(item);
  }
  const brandByProductId = new Map(
    ((productsRes.data ?? []) as Array<{ id: string; tenant_brand_id: string | null }>).map((product) => [product.id, product.tenant_brand_id]),
  );
  const memberCountByCampaign = new Map<string, Set<string>>();
  for (const member of (membersRes.data ?? []) as Array<{ campaign_id: string; buyer_id: string }>) {
    if (!memberCountByCampaign.has(member.campaign_id)) memberCountByCampaign.set(member.campaign_id, new Set());
    memberCountByCampaign.get(member.campaign_id)?.add(member.buyer_id);
  }

  const rows = pagePairs.map(({ campaign: catalog, metric }, index) => {
    const workflowStatus = resolveCampaignWorkflowStatus({
      rawStatus: catalog.status,
      validFrom: catalog.valid_from,
      validTo: catalog.valid_to,
      now,
    });
    const catalogItems = itemsByCampaign.get(catalog.id) ?? [];
    const brandSet = new Set<string>();
    for (const item of catalogItems) {
      const brandId = brandByProductId.get(item.tenant_product_id);
      if (brandId) brandSet.add(brandId);
    }
    const daysLeft = catalog.valid_to && (workflowStatus.value === 'published' || workflowStatus.value === 'published_dirty')
      ? Math.max(0, Math.ceil((new Date(catalog.valid_to).getTime() - nowTs) / 86_400_000))
      : null;
    const viewedBuyers = toNumber(metric.viewed_buyer_count);
    const audienceCount = memberCountByCampaign.get(catalog.id)?.size ?? null;
    const demandBuyers = toNumber(metric.demand_buyer_count);
    const estimateCount = toNumber(metric.estimate_count);
    const orderCount = toNumber(metric.order_count);
    const estimateValue = toNumber(metric.estimate_value);
    const orderValue = toNumber(metric.order_value);
    const invoiceValue = toNumber(metric.invoice_value);
    const invoiceCount = toNumber(metric.invoice_count);
    return {
      id: catalog.id, name: catalog.name, initials: getInitials(catalog.name), hue: getHue(index),
      hero_image_url: catalog.hero_image_url ?? null,
      status: { value: workflowStatus.value, raw_value: catalog.status, label: workflowStatus.label, tone: workflowStatus.tone },
      cohort_name: audienceCount != null ? 'Campaign audience' : 'Audience rules',
      audience_count: audienceCount,
      products_count: catalogItems.length,
      brands_count: brandSet.size,
      gmv: orderValue > 0 ? orderValue : estimateValue,
      orders: orderCount,
      order_count: orderCount,
      estimate_count: estimateCount,
      conversions: orderCount + estimateCount,
      demand_customers: demandBuyers,
      invoice_value: invoiceValue,
      invoice_count: invoiceCount,
      revenue_buyer_count: toNumber(metric.revenue_buyer_count),
      views: viewedBuyers,
      view_pct: audienceCount && audienceCount > 0 ? Number(((viewedBuyers / audienceCount) * 100).toFixed(1)) : 0,
      conversion_pct: viewedBuyers > 0 ? Number(((demandBuyers / viewedBuyers) * 100).toFixed(1)) : 0,
      valid_from: catalog.valid_from, valid_to: catalog.valid_to,
      valid_until_label: catalog.valid_to ? new Date(catalog.valid_to).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : 'No end date',
      days_left: daysLeft, created_at: catalog.created_at, growth_pct: 0,
    };
  });

  const liveCount = rows.filter((row) => row.status.label === 'Live' || row.status.label === 'Live · Unpublished Changes').length;
  const draftCount = rows.filter((row) => row.status.label === 'Draft').length;
  const endedCount = rows.filter((row) => row.status.label === 'Expired' || row.status.label === 'Archived').length;
  const last = pagePairs[pagePairs.length - 1]?.campaign;
  return timedJson({
    period,
    channels: { orders_enabled: true, estimates_enabled: true },
    primary_demand_kind: 'orders',
    kpis: {
      live_catalogs: liveCount,
      draft_catalogs: draftCount,
      ended_catalogs: endedCount,
      expiring7d: rows.filter((row) => row.days_left != null && row.days_left <= 7 && row.days_left > 0).length,
      opened_customers_mtd: 0,
      gmv_mtd: 0,
      gmv_prev_mtd: 0,
      gmv_growth_pct: 0,
      avg_conversion_pct: 0,
      orders_attributed_mtd: 0,
      conversions_mtd: 0,
    },
    todays_read: { needs_attention: [], top_performers: [], top_risers: [] },
    catalogs: rows,
    total: candidateCampaigns.length,
    limit,
    nextCursor: extraPair && last ? encodeCampaignCursor({ t: last.created_at, i: last.id }) : null,
  });
}

async function ensureTenantProducts(
  db: any,
  tenantId: string,
  tenantProductIds: string[],
) {
  if (tenantProductIds.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await db
    .schema('app')
    .from('tenant_products')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', tenantProductIds)
    .is('deleted_at', null);

  if (error) {
    throw new Error('Failed to validate selected products');
  }

  return new Set<string>(((data ?? []) as Array<{ id: string }>).map((row) => row.id));
}

async function ensureTenantBuyers(db: any, tenantId: string, buyerIds: string[]) {
  if (buyerIds.length === 0) return new Set<string>();

  const { data, error } = await db
    .schema('app')
    .from('buyers')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('id', buyerIds)
    .is('deleted_at', null);

  if (error) throw new Error('Failed to validate selected buyers');
  return new Set<string>(((data ?? []) as Array<{ id: string }>).map((row) => row.id));
}

async function ensureTenantPriceList(db: any, tenantId: string, priceListId: string | null | undefined) {
  if (!priceListId) return true;

  const { data, error } = await db
    .schema('app')
    .from('price_lists')
    .select('id')
    .eq('id', priceListId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new Error('Failed to validate price list');
  return Boolean(data);
}

export async function GET(req: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: unknown, init?: ResponseInit) => {
    return jsonWithServerTiming(body, timer, 'catalogs_api', init, APP_GET_CACHE_CONTROL);
  };

  return getOptimizedCatalogsLanding(req, timedJson);
}

async function POSTImpl(request: NextRequest) {
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const db = supabaseAdmin as any;
  const rawBody = await request.json().catch(() => null);
  const simpleParsed = CampaignFormPayloadSchema.safeParse(rawBody);
  const composerParsed = simpleParsed.success ? null : CatalogComposerPayloadSchema.safeParse(rawBody);
  if (!simpleParsed.success && !composerParsed?.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const isSimpleForm = simpleParsed.success;
  const payload: any = isSimpleForm ? simpleParsed.data : composerParsed!.data;
  const composerPayload = isSimpleForm ? null : composerParsed!.data;

  if (isSimpleForm) {
    const buyerTargetMode = payload.buyer_target_mode ?? (payload.target_mode === 'customer_group' ? 'customer_group' : 'manual');
    const productMembershipMode = payload.product_membership_mode ?? 'manual';
    if (payload.target_mode === 'customer_group') {
      const { data: cohort, error: cohortError } = await db
        .schema('app')
        .from('cohorts')
        .select('id')
        .eq('id', payload.target_cohort_id)
        .eq('tenant_id', claims.tenant_id)
        .is('deleted_at', null)
        .maybeSingle();

      if (cohortError) return NextResponse.json({ error: 'Failed to validate cohort' }, { status: 500 });
      if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 400 });
    }
    if (payload.pricing_mode === 'pricelist') {
      const priceListOk = await ensureTenantPriceList(db, claims.tenant_id, payload.price_list_id);
      if (!priceListOk) {
        return NextResponse.json({ error: 'Pricelist not found' }, { status: 400 });
      }
    }
    if (buyerTargetMode === 'manual') {
      const validBuyerIds = await ensureTenantBuyers(db, claims.tenant_id, payload.buyer_ids);
      if (validBuyerIds.size !== payload.buyer_ids.length) {
        return NextResponse.json({ error: 'One or more selected buyers are invalid' }, { status: 400 });
      }
    }
    if (productMembershipMode === 'manual') {
      const validProductIds = await ensureTenantProducts(db, claims.tenant_id, payload.selected_product_ids);
      if (validProductIds.size !== payload.selected_product_ids.length) {
        return NextResponse.json({ error: 'One or more selected products are invalid' }, { status: 400 });
      }
    }
  } else {
    if (payload.scope_type === 'cohort') {
      const { data: cohort, error: cohortError } = await db
        .schema('app')
        .from('cohorts')
        .select('id')
        .eq('id', payload.cohort_id)
        .eq('tenant_id', claims.tenant_id)
        .is('deleted_at', null)
        .maybeSingle();

      if (cohortError) return NextResponse.json({ error: 'Failed to validate cohort' }, { status: 500 });
      if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 400 });
    }

    if (payload.scope_type === 'buyer') {
      const validBuyerIds = await ensureTenantBuyers(db, claims.tenant_id, payload.buyer_ids);
      if (validBuyerIds.size !== payload.buyer_ids.length) {
        return NextResponse.json({ error: 'One or more selected buyers are invalid' }, { status: 400 });
      }
    }

    if (payload.price_source === 'price_list') {
      const priceListOk = await ensureTenantPriceList(db, claims.tenant_id, payload.price_list_id);
      if (!priceListOk) {
        return NextResponse.json({ error: 'Pricelist not found' }, { status: 400 });
      }
    }

    if (!payload.is_dynamic) {
      const tenantProductIds = payload.items.map((item: any) => item.tenant_product_id);
      const validProductIds = await ensureTenantProducts(db, claims.tenant_id, tenantProductIds);
      if (validProductIds.size !== tenantProductIds.length) {
        return NextResponse.json({ error: 'One or more selected products are invalid' }, { status: 400 });
      }
    }
  }

  const status: CatalogStatus = isSimpleForm ? 'draft' : payload.save_mode === 'publish' ? 'published' : 'draft';
  const shareToken = !isSimpleForm && payload.save_mode === 'publish' ? generateShareToken() : null;
  const scopeValue = isSimpleForm
    ? {
        ...buildCatalogScopeValue({
          scopeType: payload.target_mode === 'customer_group' ? 'cohort' : 'buyer',
          cohortId: payload.target_mode === 'customer_group' ? payload.target_cohort_id ?? null : null,
          buyerIds: (payload.buyer_target_mode ?? (payload.target_mode === 'customer_group' ? 'customer_group' : 'manual')) === 'manual'
            ? payload.buyer_ids
            : [],
          filters: { brand_names: [], category_names: [], availability: 'show_everything' },
          tagOverrides: {},
          priceSource: payload.pricing_mode === 'pricelist' ? 'price_list' : 'manual',
          priceListId: payload.pricing_mode === 'pricelist' ? payload.price_list_id ?? null : null,
        }),
        simple_form: buildSimpleFormMeta(payload.description),
      }
    : buildCatalogScopeValue({
        scopeType: payload.scope_type,
        cohortId: payload.cohort_id,
        buyerIds: payload.buyer_ids,
        filters: payload.filters,
        tagOverrides: payload.tag_overrides,
        priceSource: payload.price_source,
        priceListId: payload.price_list_id,
      });
  const buyerNote = (isSimpleForm ? payload.buyer_note : (payload.buyer_note ?? payload.message))?.trim() || null;
  const isPublishing = !isSimpleForm && payload.save_mode === 'publish';

  if (isPublishing && composerPayload?.notify_whatsapp) {
    const flagEnabled = await getFlag(FEATURE_FLAGS.WHATSAPP_BROADCAST, claims.tenant_id);
    if (!flagEnabled) {
      return NextResponse.json({ error: 'WhatsApp broadcast feature is not enabled' }, { status: 403 });
    }

    const preflight = await runCampaignPublishPreflight(db, {
      tenantId: claims.tenant_id,
      scopeType: composerPayload.scope_type,
      scopeValue,
      notifyWhatsapp: true,
      buyerNote: payload.buyer_note ?? payload.message ?? '',
    });

    if (!preflight.can_notify) {
      return NextResponse.json(
        { error: preflight.blockers[0] ?? 'WhatsApp notify preflight failed', blockers: preflight.blockers },
        { status: 400 },
      );
    }

    if (composerPayload.notify_scheduled_for && new Date(composerPayload.notify_scheduled_for).getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Scheduled time must be in the future' }, { status: 400 });
    }
  }

  // Two independent membership axes (requirement 2). isSimpleForm: infer buyer_target_mode
  // from the legacy target_mode when the new field is omitted (current UI doesn't send it
  // yet); composer path infers from scope_type/is_dynamic the same way the Phase 1 backfill
  // did, since CatalogComposerPayloadSchema doesn't carry these fields either.
  const buyerTargetMode = isSimpleForm
    ? (payload.buyer_target_mode ?? (payload.target_mode === 'customer_group' ? 'customer_group' : 'manual'))
    : (payload.scope_type === 'cohort' ? 'customer_group' : 'manual');
  const buyerFilterRules = isSimpleForm ? (payload.buyer_rules ?? null) : null;
  const productMembershipMode = isSimpleForm ? (payload.product_membership_mode ?? 'manual') : (payload.is_dynamic ? 'automatic' : 'manual');
  const productRules = isSimpleForm ? (payload.product_rules ?? null) : (payload.is_dynamic ? payload.filters : null);
  const pricingSource = isSimpleForm
    ? (payload.pricing_mode === 'pricelist' ? 'pricelist' : 'individual_prices')
    : (payload.price_source === 'price_list' ? 'pricelist' : 'individual_prices');
  const campaignPriceListId = isSimpleForm
    ? (payload.pricing_mode === 'pricelist' ? payload.price_list_id ?? null : null)
    : (payload.price_source === 'price_list' ? payload.price_list_id ?? null : null);
  // Flat/percent bulk pricing only applies to campaign-specific pricing -- a pricelist
  // already dictates pricing, so force edit_each/null there regardless of form input.
  const campaignPricingStrategy = isSimpleForm && pricingSource === 'individual_prices'
    ? (payload.pricing_strategy ?? 'edit_each')
    : 'edit_each';
  const campaignStrategyValue = campaignPricingStrategy === 'edit_each' ? null : (payload.strategy_value ?? null);

  const { data: insertedCatalog, error: insertError } = await db
    .schema('app')
    .from('campaigns')
    .insert({
      tenant_id: claims.tenant_id,
      name: payload.name,
      scope_type: isSimpleForm
        ? (payload.target_mode === 'customer_group' ? 'cohort' : 'buyer')
        : payload.scope_type,
      scope_value: scopeValue,
      valid_from: payload.valid_from.toISOString(),
      valid_to: payload.valid_to ? payload.valid_to.toISOString() : null,
      message: isSimpleForm ? buyerNote : (isPublishing ? buyerNote : (payload.message?.trim() || null)),
      hero_image_url: (isSimpleForm ? payload.hero_image_url : payload.hero_image_url) || null,
      status,
      share_token: shareToken,
      buyer_target_mode: buyerTargetMode,
      buyer_filter_rules: buyerFilterRules,
      product_membership_mode: productMembershipMode,
      dynamic_rules: productRules,
      is_dynamic: productMembershipMode === 'automatic',
      pricing_source: pricingSource,
      price_list_id: campaignPriceListId,
      pricing_strategy: campaignPricingStrategy,
      strategy_value: campaignStrategyValue,
      created_by: claims.sub,
      updated_by: claims.sub,
    })
    .select('id, status')
    .single();

  if (insertError || !insertedCatalog) {
    console.error('[POST /api/tenant/catalogs] insert error:', insertError);
    return NextResponse.json({ error: 'Failed to create catalog' }, { status: 500 });
  }

  if (buyerTargetMode === 'automatic' || productMembershipMode === 'automatic') {
    // Recompute now (requirement 4), not left frozen until the next scheduled refresh.
    const refreshCalls: Array<{ entityType: 'campaign_buyers' | 'campaign_products'; promise: PromiseLike<{ error: { message: string } | null }> }> = [];
    if (buyerTargetMode === 'automatic') {
      refreshCalls.push({ entityType: 'campaign_buyers', promise: db.schema('app').rpc('refresh_campaign_buyers_by_id', { p_campaign_id: insertedCatalog.id }) });
    }
    if (productMembershipMode === 'automatic') {
      refreshCalls.push({ entityType: 'campaign_products', promise: db.schema('app').rpc('refresh_campaign_products_by_id', { p_campaign_id: insertedCatalog.id }) });
    }
    const refreshResults = await Promise.all(refreshCalls.map((call) => call.promise));
    await Promise.all(
      refreshResults.map(async ({ error }, index) => {
        if (!error) return;
        const entityType = refreshCalls[index].entityType;
        console.error(`[POST /api/tenant/catalogs] ${entityType} refresh error:`, error.message);
        // Sync refresh failed (timeout, transient error) -- guarantee the async
        // backstop picks this up rather than relying solely on the trigger's
        // independent insert, so membership never ends up silently unresolved.
        await db.schema('app').rpc('membership_mark_dirty', {
          p_tenant_id: claims.tenant_id,
          p_entity_type: entityType,
          p_entity_id: insertedCatalog.id,
          p_reason: `sync_refresh_failed:${error.message.slice(0, 200)}`,
        });
      }),
    );
  }

  if (!isSimpleForm && !payload.is_dynamic && payload.items.length > 0) {
    const { error: itemsError } = await db
      .schema('app')
      .from('campaign_items')
      .insert(
        payload.items.map((item: any) => ({
          campaign_id: insertedCatalog.id,
          tenant_product_id: item.tenant_product_id,
          display_order: item.display_order,
          price_override: item.price_override ?? null,
          created_by: claims.sub,
          updated_by: claims.sub,
        })),
      );

    if (itemsError) {
      console.error('[POST /api/tenant/catalogs] items error:', itemsError);
      return NextResponse.json({ error: 'Failed to create catalog items' }, { status: 500 });
    }
  } else if (isSimpleForm && productMembershipMode === 'manual' && payload.selected_product_ids.length > 0) {
    const { error: itemsError } = await db
      .schema('app')
      .from('campaign_items')
      .insert(
        payload.selected_product_ids.map((tenantProductId: string, index: number) => ({
          campaign_id: insertedCatalog.id,
          tenant_product_id: tenantProductId,
          display_order: index,
          price_override: null,
          created_by: claims.sub,
          updated_by: claims.sub,
        })),
      );

    if (itemsError) {
      console.error('[POST /api/tenant/catalogs] simple items error:', itemsError);
      return NextResponse.json({ error: 'Failed to create catalog items' }, { status: 500 });
    }
  }

  if (campaignPricingStrategy !== 'edit_each') {
    const { error: applyError } = await db.schema('app').rpc('apply_campaign_pricing_strategy', { p_campaign_id: insertedCatalog.id });
    if (applyError) {
      console.error('[POST /api/tenant/catalogs] apply pricing strategy error:', applyError.message);
    }
  }

  revalidateSellerDashboardCache(claims.tenant_id);

  let whatsappNotify: { broadcast_id: string; recipient_count: number; scheduled: boolean } | null = null;

  if (isPublishing && composerPayload?.notify_whatsapp) {
    try {
      whatsappNotify = await queueCampaignPublishNotify(db, {
        tenantId: claims.tenant_id,
        actorId: claims.sub ?? claims.tenant_id,
        campaignId: insertedCatalog.id,
        campaignName: payload.name,
        scopeType: composerPayload.scope_type,
        scopeValue,
        buyerNote,
        scheduledFor: composerPayload.notify_scheduled_for ?? null,
        heroImageUrl: null,
      });
    } catch (notifyError) {
      console.error('[POST /api/tenant/catalogs] WhatsApp notify failed after publish:', notifyError);
      return NextResponse.json(
        {
          error: notifyError instanceof Error ? notifyError.message : 'Campaign published but WhatsApp notify failed',
          catalog: insertedCatalog,
        },
        { status: 500 },
      );
    }
  }

  try {
    const ph = getPostHogClient();
    ph.capture({
      distinctId: claims.sub ?? claims.tenant_id,
      event: isPublishing ? 'catalog_published' : 'catalog_draft_saved',
      properties: {
        tenant_id: claims.tenant_id,
        seller_id: claims.sub,
        campaign_id: insertedCatalog.id,
        status: insertedCatalog.status,
        scope_type: isSimpleForm
          ? (payload.target_mode === 'customer_group' ? 'cohort' : 'buyer')
          : payload.scope_type,
        buyer_target_mode: buyerTargetMode,
        product_membership_mode: productMembershipMode,
        pricing_source: pricingSource,
        has_price_list: Boolean(campaignPriceListId),
        product_count: isSimpleForm
          ? payload.selected_product_ids.length
          : productMembershipMode === 'automatic'
            ? null
            : payload.items.length,
        notify_whatsapp: Boolean(isPublishing && composerPayload?.notify_whatsapp),
        whatsapp_recipient_count: whatsappNotify?.recipient_count ?? null,
        whatsapp_scheduled: whatsappNotify?.scheduled ?? false,
      },
    });
    await ph.flush();
  } catch {
    // Analytics is non-blocking for catalog creation.
  }

  revalidatePublicCatalogCache(claims.tenant_id);
  return NextResponse.json({ catalog: insertedCatalog, whatsapp_notify: whatsappNotify });
}

export const POST = withBuyerContextRevalidation(POSTImpl);
