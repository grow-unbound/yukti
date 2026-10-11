import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getPostHogClient } from '@/lib/posthog-server';
import { revalidateSellerDashboardCache } from '@/lib/server/dashboard-cache';
import { revalidatePublicCatalogCache } from '@/lib/server/public-catalog-cache';
import {
  resolveCampaignWorkflowStatus,
  type CampaignWorkflowStatusLabel,
  type CampaignWorkflowStatusTone,
  type RawCampaignStatus,
} from '@/lib/campaign-workflow-status';
import { getCatalogComposerPayload } from '@/lib/server/catalog-composer';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';
import { getSellerLandingPeriodMeta } from '@/lib/server/seller-period';
import {
  computeCampaignAttributedMetrics,
  computeCampaignViewMetrics,
  filterLineItemsByMembershipWindow,
  getCampaignBuyerOpenedStatus,
  groupLineItemsByParent,
  isEligibleCampaignEstimate,
  type CampaignEstimateRow,
  type CampaignItemMembershipWindow,
  type CampaignOrderRow,
  type CampaignViewRow,
} from '@/lib/server/campaign-performance';
import { getInAppCreateFlags } from '@/lib/server/seller-features';
import {
  queueCampaignFollowupNotify,
  queueCampaignPublishNotify,
} from '@/lib/server/campaign-publish-notify';
import { runCampaignPublishPreflight } from '@/lib/server/campaign-publish-preflight';
import { getFlag } from '@/lib/flags';
import { FEATURE_FLAGS } from '@/constants';
import {
  CatalogNotifyBuyersActionSchema,
  CatalogPublishUpdatesActionSchema,
  CampaignFormPayloadSchema,
  CatalogComposerPayloadSchema,
  CatalogPublishActionSchema,
  type CatalogNotifyRecipientFilter,
  type CatalogComposerFilterState,
  type CatalogComposerPricingStrategy,
  type CatalogComposerTag,
} from '@/lib/zod';

type DbClient = NonNullable<typeof supabaseAdmin>;

type CatalogStatus = RawCampaignStatus;

type ScopeType = 'cohort' | 'buyer' | 'geography' | 'all';
type ComposerScopeType = 'cohort' | 'buyer' | 'all';

type CatalogDraftSnapshot = {
  name: string;
  valid_from: string;
  valid_to: string | null;
  scope_type: ComposerScopeType;
  cohort_id: string | null;
  buyer_ids: string[];
  message: string | null;
  price_source: 'price_list' | 'manual';
  price_list_id: string | null;
  pricing_strategy?: CatalogComposerPricingStrategy;
  filters: CatalogComposerFilterState;
  tag_overrides: Record<string, CatalogComposerTag | null>;
  items: Array<{
    tenant_product_id: string;
    display_order: number;
    price_override?: number | null;
  }>;
};

function logCatalogPatchDbError(
  branch: string,
  context: Record<string, unknown>,
  error: { code?: string; message?: string; details?: string; hint?: string } | null | undefined,
) {
  console.error(`[PATCH /api/tenant/catalogs/:id] ${branch} failed`, {
    ...context,
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
  });
}

const PatchSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('extend_validity'),
    valid_until: z.string().datetime(),
  }),
  CatalogPublishActionSchema,
  CatalogPublishUpdatesActionSchema,
  CatalogNotifyBuyersActionSchema,
  z.object({
    action: z.literal('ensure_share_link'),
  }),
  z.object({
    action: z.literal('add_product'),
    tenant_product_id: z.string().uuid(),
    price_override: z.number().nonnegative().nullable().optional(),
  }),
  z.object({
    action: z.literal('remove_product'),
    tenant_product_id: z.string().uuid(),
  }),
]);

function defaultCatalogFilters(): CatalogComposerFilterState {
  return {
    brand_names: [],
    category_names: [],
    availability: 'show_everything' as const,
  };
}

function buildCatalogScopeValue(input: {
  scopeType: ComposerScopeType;
  cohortId?: string | null;
  buyerIds?: string[];
  filters: CatalogComposerFilterState;
  tagOverrides?: Record<string, CatalogComposerTag | null>;
  priceSource?: 'price_list' | 'manual';
  priceListId?: string | null;
  pricingStrategy?: CatalogComposerPricingStrategy;
  draft?: CatalogDraftSnapshot | null;
}) {
  return {
    ...(input.scopeType === 'cohort' && input.cohortId ? { cohort_id: input.cohortId } : {}),
    ...(input.scopeType === 'buyer' && input.buyerIds && input.buyerIds.length > 0 ? { buyer_ids: input.buyerIds } : {}),
    composer: {
      filters: input.filters,
      tag_overrides: input.tagOverrides ?? {},
      price_source: input.priceSource ?? 'manual',
      price_list_id: input.priceListId ?? null,
      pricing_strategy: input.pricingStrategy,
    },
    ...(input.draft ? { composer_draft: input.draft } : {}),
  };
}

function readSimpleFormDescription(scopeValue: Record<string, unknown> | null): string {
  const value = (scopeValue ?? {}) as { simple_form?: { description?: string | null } | null };
  return value.simple_form?.description ?? '';
}

function generateShareToken() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function buildBuyerCatalogUrl(origin: string, shareToken: string) {
  return `${origin}/buy/home?share_token=${shareToken}`;
}

function buildCatalogDraftSnapshot(payload: z.infer<typeof CatalogComposerPayloadSchema>): CatalogDraftSnapshot {
  return {
    name: payload.name,
    valid_from: payload.valid_from.toISOString(),
    valid_to: payload.valid_to ? payload.valid_to.toISOString() : null,
    scope_type: payload.scope_type,
    cohort_id: payload.scope_type === 'cohort' ? (payload.cohort_id ?? null) : null,
    buyer_ids: payload.scope_type === 'buyer' ? payload.buyer_ids : [],
    message: payload.message?.trim() || null,
    price_source: payload.price_source,
    price_list_id: payload.price_source === 'price_list' ? (payload.price_list_id ?? null) : null,
    pricing_strategy: payload.pricing_strategy,
    filters: payload.filters,
    tag_overrides: payload.tag_overrides,
    items: payload.items,
  };
}

function readComposerDraft(scopeValue: Record<string, unknown> | null): CatalogDraftSnapshot | null {
  const value = (scopeValue ?? {}) as { composer_draft?: CatalogDraftSnapshot | null };
  return value.composer_draft ?? null;
}

function resolveDetailWorkflowStatus(input: {
  rawStatus: CatalogStatus;
  validFrom: string | null;
  validTo: string | null;
  scopeValue: Record<string, unknown> | null;
}) {
  return resolveCampaignWorkflowStatus({
    rawStatus: input.rawStatus,
    validFrom: input.validFrom,
    validTo: input.validTo,
    hasUnpublishedChanges: Boolean(readComposerDraft(input.scopeValue)),
  });
}

function buildScopeValueFromDraft(
  draft: CatalogDraftSnapshot,
) {
  return buildCatalogScopeValue({
    scopeType: draft.scope_type,
    cohortId: draft.cohort_id,
    buyerIds: draft.buyer_ids,
    filters: draft.filters,
    tagOverrides: draft.tag_overrides,
    priceSource: draft.price_source,
    priceListId: draft.price_list_id,
    pricingStrategy: draft.pricing_strategy,
    draft: null,
  });
}

async function ensureTenantProducts(
  db: DbClient,
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

async function ensureTenantBuyers(db: DbClient, tenantId: string, buyerIds: string[]) {
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

async function ensureTenantPriceList(db: DbClient, tenantId: string, priceListId: string | null | undefined) {
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

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatDate(date: string | null): string {
  if (!date) return 'No end date';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function extractBuyerCity(geography: unknown): string {
  if (!geography || typeof geography !== 'object') return 'Unknown';
  const city = (geography as { city?: unknown }).city;
  return typeof city === 'string' && city.trim().length > 0 ? city : 'Unknown';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const db = supabaseAdmin as DbClient;

  const { data: globalCatalog, error: globalCatalogError } = await db
    .schema('app')
    .from('campaigns')
    .select('id, tenant_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (globalCatalogError) return NextResponse.json({ error: 'Failed to fetch catalog' }, { status: 500 });
  if (!globalCatalog) return NextResponse.json({ error: 'Catalog not found' }, { status: 404 });
  if (globalCatalog.tenant_id !== claims.tenant_id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const campaignQuarterMeta = getSellerLandingPeriodMeta('quarter');
  const campaignQuarterStart = campaignQuarterMeta.current_start.slice(0, 10);

  const [catalogRes, itemsRes, ordersRes, estimatesRes, viewsRes, composerPayload, campaignPeriodRes, audienceRes, lineItemsRes, createFlags] = await Promise.all([
    db
      .schema('app')
      .from('campaigns')
      .select('id, tenant_id, name, scope_type, scope_value, valid_from, valid_to, status, share_token, message, hero_image_url, created_by, created_at, buyer_target_mode, buyer_filter_rules, product_membership_mode, dynamic_rules, pricing_source, price_list_id, pricing_strategy, strategy_value')
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .single(),
    // No deleted_at filter: point-in-time SKU attribution below needs every historical
    // membership window, not just currently-active items.
    db
      .schema('app')
      .from('campaign_items')
      .select('id, tenant_product_id, price_override, display_order, created_at, valid_from, deleted_at')
      .eq('campaign_id', id)
      .order('display_order', { ascending: true }),
    db
      .schema('app')
      .from('orders')
      .select('id, buyer_id, total_amount, placed_at, order_date, status, created_at')
      .eq('tenant_id', claims.tenant_id)
      .eq('campaign_id', id)
      .is('deleted_at', null),
    db
      .schema('app')
      .from('estimates')
      .select('id, buyer_id, total_amount, status, converted_to_order_id, estimate_date, created_at')
      .eq('tenant_id', claims.tenant_id)
      .eq('campaign_id', id)
      .is('deleted_at', null),
    // Point-in-time audience filter (requirement 7): a view only counts toward opens if the
    // buyer was actually in the campaign's audience at the moment they viewed it, not just
    // currently. See app.filter_campaign_views_by_audience_at_view_time.
    db.schema('app').rpc('filter_campaign_views_by_audience_at_view_time', { p_campaign_id: id }),
    getCatalogComposerPayload(db, claims.tenant_id, claims.role),
    db
      .schema('app')
      .from('metrics_campaign_period_summary')
      .select('viewed_buyer_count, view_count, estimate_value, estimate_count, order_value, order_count, invoice_value, invoice_count, demand_buyer_count, revenue_buyer_count')
      .eq('campaign_id', id)
      .eq('tenant_id', claims.tenant_id)
      .eq('grain', 'quarter')
      .eq('period_start', campaignQuarterStart)
      .is('deleted_at', null)
      .maybeSingle(),
    // Audience and line items are resolved server-side. Sending id lists as GET filters exceeded
    // the request URL limit (HTTP 400) on large campaigns and hit PostgREST's 1000-row cap.
    db.schema('app').rpc('get_campaign_audience_buyers', { p_tenant_id: claims.tenant_id, p_campaign_id: id }),
    db.schema('app').rpc('get_campaign_attributed_line_items', { p_tenant_id: claims.tenant_id, p_campaign_id: id }),
    getInAppCreateFlags(claims.tenant_id),
  ]);

  if (catalogRes.error) return NextResponse.json({ error: 'Catalog not found' }, { status: 404 });
  if (itemsRes.error || ordersRes.error || estimatesRes.error || viewsRes.error || campaignPeriodRes.error) {
    return NextResponse.json({ error: 'Failed to load catalog detail' }, { status: 500 });
  }
  if (audienceRes.error) return NextResponse.json({ error: 'Failed to load buyers' }, { status: 500 });
  if (lineItemsRes.error) return NextResponse.json({ error: 'Failed to load line items' }, { status: 500 });
  const campaignQuarter = (campaignPeriodRes.data ?? null) as {
    viewed_buyer_count: number;
    view_count: number;
    estimate_value: number;
    estimate_count: number;
    order_value: number;
    order_count: number;
    invoice_value: number;
    invoice_count: number;
    demand_buyer_count: number;
    revenue_buyer_count: number;
  } | null;

  const catalog = catalogRes.data as {
    id: string;
    tenant_id: string;
    name: string;
    scope_type: ScopeType;
    scope_value: Record<string, unknown> | null;
    valid_from: string;
    valid_to: string | null;
    status: CatalogStatus;
    share_token: string | null;
    message: string | null;
    hero_image_url: string | null;
    created_by: string | null;
    created_at: string;
    buyer_target_mode: string | null;
    buyer_filter_rules: Record<string, unknown> | null;
    product_membership_mode: string | null;
    dynamic_rules: Record<string, unknown> | null;
    pricing_source: 'pricelist' | 'individual_prices' | null;
    price_list_id: string | null;
    pricing_strategy: 'edit_each' | 'flat_off_base' | 'percentage' | null;
    strategy_value: number | null;
  };

  const allCampaignItemRows = (itemsRes.data ?? []) as Array<{
    id: string;
    tenant_product_id: string;
    price_override: number | null;
    display_order: number | null;
    created_at: string;
    valid_from: string;
    deleted_at: string | null;
  }>;
  // Display list stays current-membership-only, matching prior behavior.
  const catalogItems = allCampaignItemRows.filter((item) => item.deleted_at === null);
  const campaignItemWindowsByProduct = new Map<string, CampaignItemMembershipWindow[]>();
  for (const item of allCampaignItemRows) {
    const windows = campaignItemWindowsByProduct.get(item.tenant_product_id) ?? [];
    windows.push({ valid_from: item.valid_from, deleted_at: item.deleted_at });
    campaignItemWindowsByProduct.set(item.tenant_product_id, windows);
  }

  const orders = (ordersRes.data ?? []) as CampaignOrderRow[];

  const estimates = (estimatesRes.data ?? []) as CampaignEstimateRow[];

  const campaignViewRows = (viewsRes.data ?? []) as CampaignViewRow[];

  const scopeValue = (catalog.scope_value ?? {}) as { cohort_id?: string; buyer_id?: string; buyer_ids?: string[] };
  const composerScopeValue = (catalog.scope_value ?? {}) as {
    cohort_id?: string;
    buyer_ids?: string[];
    composer?: {
      filters?: ReturnType<typeof defaultCatalogFilters>;
      tag_overrides?: Record<string, CatalogComposerTag | null>;
      price_source?: 'price_list' | 'manual';
      price_list_id?: string | null;
      pricing_strategy?: CatalogComposerPricingStrategy;
    };
    composer_draft?: CatalogDraftSnapshot;
  };
  const filters = composerScopeValue.composer?.filters ?? defaultCatalogFilters();
  const tagOverrides = composerScopeValue.composer?.tag_overrides ?? {};
  const composerDraft = composerScopeValue.composer_draft ?? null;

  type BuyerRow = { id: string; business_name: string; geography: unknown; tier: string | null };

  const audience = (audienceRes.data ?? {}) as {
    member_count?: number;
    selected_cohort_id?: string | null;
    selected_cohort_name?: string | null;
    buyers?: BuyerRow[];
    truncated?: boolean;
  };
  if (audience.truncated) {
    // Rows past the cap would silently drop from the ranked buyer list.
    console.warn('[GET /api/tenant/catalogs/:id] audience exceeds RPC cap; buyer ranking is approximate', { campaignId: id });
  }
  const selectedCohortId: string | null = audience.selected_cohort_id ?? null;
  const selectedCohortName = audience.selected_cohort_name ?? 'All buyers';
  const targetBuyerCount: number = Number(audience.member_count ?? 0);
  const audienceBuyers: BuyerRow[] = audience.buyers ?? [];
  const cohortMemberIds = audienceBuyers.map((buyer) => buyer.id);
  const buyersById = new Map(audienceBuyers.map((buyer) => [buyer.id, buyer]));

  // get_campaign_attributed_line_items already restricts to products that were campaign members
  // at some point (all membership windows), so historical lines can be point-in-time attributed below.
  const eligibleEstimates = estimates.filter(isEligibleCampaignEstimate);
  const validEstimateIds = new Set(eligibleEstimates.map((estimate) => estimate.id));
  const productMetaById = new Map(composerPayload.products.map((product) => [product.id, product]));

  type CampaignLineRow = {
    parent_id: string;
    tenant_product_id: string;
    qty: number | null;
    line_total: number | null;
    unit_price: number | null;
  };
  const lineItems = (lineItemsRes.data ?? {}) as {
    orders?: CampaignLineRow[];
    estimates?: CampaignLineRow[];
    truncated?: boolean;
  };
  if (lineItems.truncated) {
    // Never aggregate a partial set: conversion/spend would be silently under-counted.
    return NextResponse.json({ error: 'Campaign has too many line items to summarise' }, { status: 500 });
  }

  // Point-in-time attribution: a line item only counts toward this campaign if its product
  // was actually a campaign member on the date the order/estimate was placed -- not just
  // currently. Matches recordConversion's own date fallback (placed_at ?? created_at for
  // orders; created_at for estimates) so the gating date lines up with the GMV timestamp.
  const orderDateByParentId = new Map(orders.map((order) => [order.id, order.placed_at ?? order.created_at]));
  const estimateDateByParentId = new Map(estimates.map((estimate) => [estimate.id, estimate.created_at]));

  // Orders: every campaign order's lines (as before). Estimates: eligible estimates only.
  const rawOrderItems = lineItems.orders ?? [];
  const rawEstimateItems = (lineItems.estimates ?? []).filter((item) => validEstimateIds.has(item.parent_id));

  const attributedOrderItems = filterLineItemsByMembershipWindow(rawOrderItems, orderDateByParentId, campaignItemWindowsByProduct);
  const attributedEstimateItems = filterLineItemsByMembershipWindow(rawEstimateItems, estimateDateByParentId, campaignItemWindowsByProduct);

  const orderItemsByParent = groupLineItemsByParent(attributedOrderItems);
  const estimateItemsByParent = groupLineItemsByParent(attributedEstimateItems);

  const channelOptions = {
    includeOrders: createFlags.create_sales_orders,
    includeEstimates: createFlags.create_enquiries,
  };
  const conversionMetrics = computeCampaignAttributedMetrics(
    orders,
    estimates,
    orderItemsByParent,
    estimateItemsByParent,
    channelOptions,
  );
  const { lastOpenedAtByBuyer } = computeCampaignViewMetrics(campaignViewRows);
  const { conversionsByBuyer, spendByBuyer, lastConversionAtByBuyer } = conversionMetrics;

  const today = Date.now();
  const daysLeft = catalog.valid_to ? Math.max(0, Math.ceil((new Date(catalog.valid_to).getTime() - today) / (1000 * 60 * 60 * 24))) : 0;

  // Only the counts/metadata below feed header/products_summary — the composition/catalog_gmv
  // breakdown used to live here too, but CatalogCompositionTab sources its rows from the
  // already-paginated search_catalog_products_detail RPC instead, so it was dead weight.
  const products = catalogItems.map((item, index) => {
    const composerProduct = productMetaById.get(item.tenant_product_id);
    return {
      tenant_product_id: item.tenant_product_id,
      product_name: composerProduct?.display_name ?? 'Unknown product',
      internal_sku: composerProduct?.internal_sku ?? item.tenant_product_id,
      brand_name: composerProduct?.brand_name ?? 'Unknown brand',
      stock_label: composerProduct?.stock_label ?? 'Out',
      stock_tone: composerProduct?.stock_tone ?? 'neutral',
      mrp: composerProduct?.mrp ?? null,
      base_selling_price: composerProduct?.base_selling_price ?? null,
      units_mtd: composerProduct?.units_mtd ?? 0,
      days_cover: composerProduct?.days_cover ?? null,
      tag: tagOverrides[item.tenant_product_id] ?? composerProduct?.tag ?? null,
      override_price: item.price_override != null ? Number(item.price_override) : null,
      catalog_order: item.display_order ?? index,
    };
  });

  const brandsCovered = new Set(products.map((item) => item.brand_name)).size;

  const buyers = cohortMemberIds
    .map((buyerId) => {
      const buyer = buyersById.get(buyerId);
      const buyerConversionCount = conversionsByBuyer.get(buyerId) ?? 0;
      const spend = spendByBuyer.get(buyerId) ?? 0;
      const lastOpenedAt = lastOpenedAtByBuyer.get(buyerId) ?? null;
      const lastConversionAt = lastConversionAtByBuyer.get(buyerId) ?? null;

      return {
        buyer_id: buyerId,
        buyer_name: buyer?.business_name ?? 'Unknown buyer',
        city: extractBuyerCity(buyer?.geography),
        cohort_label: selectedCohortName,
        opened_status: getCampaignBuyerOpenedStatus(buyerConversionCount, lastOpenedAt),
        spend,
        orders: buyerConversionCount,
        last_opened_at: lastOpenedAt,
        last_order_at: lastConversionAt,
      };
    })
    .sort((a, b) => {
      if (b.spend !== a.spend) return b.spend - a.spend;
      if (b.orders !== a.orders) return b.orders - a.orders;
      return a.buyer_name.localeCompare(b.buyer_name);
    });

  const publishedBy = catalog.created_by ? `User ${catalog.created_by.slice(0, 8)}` : 'System';
  const workflowStatus = resolveCampaignWorkflowStatus({
    rawStatus: catalog.status,
    validFrom: catalog.valid_from,
    validTo: catalog.valid_to,
    hasUnpublishedChanges: Boolean(composerDraft),
  });
  return NextResponse.json({
    header: {
      id: catalog.id,
      name: catalog.name,
      status_label: workflowStatus.label,
      status_tone: workflowStatus.tone,
      initials: getInitials(catalog.name),
      products_count: products.length,
      brands_covered: brandsCovered,
      cohort_name: selectedCohortName,
      valid_from_label: formatDate(catalog.valid_from),
      valid_until_label: formatDate(catalog.valid_to),
      valid_until_iso: catalog.valid_to,
      hero_image_url: catalog.hero_image_url,
      published_by: publishedBy,
      share_token: catalog.share_token,
      share_url: catalog.share_token ? buildBuyerCatalogUrl(request.nextUrl.origin, catalog.share_token) : null,
      scope_type: catalog.scope_type,
      status_value: workflowStatus.value,
      status_raw_value: catalog.status,
      selected_cohort: {
        id: selectedCohortId,
        name: selectedCohortName,
        member_count: targetBuyerCount,
        scope_type: catalog.scope_type,
        display_label: selectedCohortName,
      },
    },
    meta_strip_4: {
      target_buyer_count: targetBuyerCount,
      viewed_buyer_count: campaignQuarter?.viewed_buyer_count ?? 0,
      view_count: campaignQuarter?.view_count ?? 0,
      view_rate_pct: targetBuyerCount > 0
        ? Math.round(((campaignQuarter?.viewed_buyer_count ?? 0) / targetBuyerCount) * 1000) / 10
        : 0,
      demand_buyer_count: campaignQuarter?.demand_buyer_count ?? 0,
      demand_value: (campaignQuarter?.estimate_value ?? 0) + (campaignQuarter?.order_value ?? 0),
      demand_count: (campaignQuarter?.estimate_count ?? 0) + (campaignQuarter?.order_count ?? 0),
      enquiry_rate_pct: (campaignQuarter?.viewed_buyer_count ?? 0) > 0
        ? Math.round(((campaignQuarter?.demand_buyer_count ?? 0) / (campaignQuarter?.viewed_buyer_count ?? 1)) * 1000) / 10
        : 0,
      revenue_buyer_count: campaignQuarter?.revenue_buyer_count ?? 0,
      invoice_value: campaignQuarter?.invoice_value ?? 0,
      invoice_count: campaignQuarter?.invoice_count ?? 0,
      billing_rate_pct: (campaignQuarter?.demand_buyer_count ?? 0) > 0
        ? Math.round(((campaignQuarter?.revenue_buyer_count ?? 0) / (campaignQuarter?.demand_buyer_count ?? 1)) * 1000) / 10
        : 0,
      days_left: daysLeft,
      valid_until_label: formatDate(catalog.valid_to),
    },
    products_summary: {
      filters,
      included_count: products.length,
      brands_covered: brandsCovered,
      in_stock_count: products.filter((product) => product.stock_tone === 'success').length,
      tag_overrides_count: Object.values(tagOverrides).filter(Boolean).length,
    },
    buyers: buyers.slice(0, 50),
    permissions: {
      can_extend_validity: claims.role === 'seller_admin',
      can_edit_composition: claims.role === 'seller_admin',
    },
    composer: {
      name: composerDraft?.name ?? catalog.name,
      description: readSimpleFormDescription((catalog.scope_value ?? {}) as Record<string, unknown>),
      status: workflowStatus.value,
      live_status: resolveCampaignWorkflowStatus({
        rawStatus: catalog.status,
        validFrom: catalog.valid_from,
        validTo: catalog.valid_to,
        hasUnpublishedChanges: false,
      }).value,
      has_unpublished_changes: Boolean(composerDraft),
      valid_from: composerDraft?.valid_from ?? catalog.valid_from,
      valid_to: composerDraft?.valid_to ?? catalog.valid_to,
      message: composerDraft?.message ?? catalog.message ?? '',
      price_source: composerDraft?.price_source ?? composerScopeValue.composer?.price_source ?? 'manual',
      price_list_id: composerDraft?.price_list_id ?? composerScopeValue.composer?.price_list_id ?? null,
      pricing_strategy: composerDraft?.pricing_strategy ?? composerScopeValue.composer?.pricing_strategy,
      pricing_source: catalog.pricing_source ?? (catalog.price_list_id ? 'pricelist' : 'individual_prices'),
      bulk_pricing_strategy: catalog.pricing_strategy ?? 'edit_each',
      bulk_pricing_strategy_value: catalog.strategy_value ?? null,
      scope_type: composerDraft?.scope_type ?? (catalog.scope_type === 'all' ? 'all' : catalog.scope_type === 'buyer' ? 'buyer' : 'cohort'),
      cohort_id: composerDraft?.cohort_id ?? composerScopeValue.cohort_id ?? null,
      buyer_ids: composerDraft?.buyer_ids ?? composerScopeValue.buyer_ids ?? (scopeValue.buyer_id ? [scopeValue.buyer_id] : []),
      filters: composerDraft?.filters ?? filters,
      buyer_target_mode: catalog.buyer_target_mode ?? (catalog.scope_type === 'cohort' ? 'customer_group' : 'manual'),
      buyer_rules: catalog.buyer_filter_rules ?? {},
      product_membership_mode: catalog.product_membership_mode ?? 'manual',
      product_rules: catalog.dynamic_rules ?? { brand_names: [], category_names: [] },
      tag_overrides: composerDraft?.tag_overrides ?? tagOverrides,
      items: (composerDraft?.items ?? catalogItems.map((item) => ({
        tenant_product_id: item.tenant_product_id,
        display_order: item.display_order ?? 0,
        price_override: item.price_override ?? null,
      }))),
    },
  }, { headers: SELLER_CACHE_PERSONAL });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const rawBody = await request.json().catch(() => null);
  const actionParsed = PatchSchema.safeParse(rawBody);
  const simpleParsed = actionParsed.success ? null : CampaignFormPayloadSchema.safeParse(rawBody);
  const composerParsed = actionParsed.success || simpleParsed?.success ? null : CatalogComposerPayloadSchema.safeParse(rawBody);
  if (!actionParsed.success && !simpleParsed?.success && !composerParsed?.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const db = supabaseAdmin as DbClient;

  const { data: globalCatalog, error: globalCatalogError } = await db
    .schema('app')
    .from('campaigns')
    .select('id, tenant_id, name, status, share_token, scope_type, scope_value, valid_from, valid_to, message, hero_image_url, product_membership_mode')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (globalCatalogError) return NextResponse.json({ error: 'Failed to fetch catalog' }, { status: 500 });
  if (!globalCatalog) return NextResponse.json({ error: 'Catalog not found' }, { status: 404 });
  if (globalCatalog.tenant_id !== claims.tenant_id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const globalWorkflowStatus = resolveDetailWorkflowStatus({
    rawStatus: globalCatalog.status as CatalogStatus,
    validFrom: globalCatalog.valid_from as string | null,
    validTo: globalCatalog.valid_to as string | null,
    scopeValue: (globalCatalog.scope_value ?? {}) as Record<string, unknown> | null,
  });
  const globalComposerDraft = readComposerDraft((globalCatalog.scope_value ?? {}) as Record<string, unknown>);

  if (actionParsed.success && actionParsed.data.action === 'extend_validity') {
    if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { error } = await db
      .schema('app')
      .from('campaigns')
      .update({ valid_to: actionParsed.data.valid_until, updated_by: claims.sub })
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null);

    if (error) return NextResponse.json({ error: 'Failed to extend validity' }, { status: 500 });
    revalidateSellerDashboardCache(claims.tenant_id);
    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({ ok: true });
  }

  if (actionParsed.success && actionParsed.data.action === 'publish_catalog') {
    if (claims.role !== 'seller_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (globalCatalog.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft catalogs can be published' }, { status: 400 });
    }

    const publishInput = actionParsed.data;
    const scopeValue = (globalCatalog.scope_value ?? {}) as Record<string, unknown>;

    if (publishInput.notify_whatsapp) {
      const flagEnabled = await getFlag(FEATURE_FLAGS.WHATSAPP_BROADCAST, claims.tenant_id);
      if (!flagEnabled) {
        return NextResponse.json({ error: 'WhatsApp broadcast feature is not enabled' }, { status: 403 });
      }

      const preflight = await runCampaignPublishPreflight(db, {
        tenantId: claims.tenant_id,
        scopeType: globalCatalog.scope_type as ScopeType,
        scopeValue,
        notifyWhatsapp: true,
        buyerNote: publishInput.buyer_note ?? '',
      });

      if (!preflight.can_notify) {
        return NextResponse.json(
          { error: preflight.blockers[0] ?? 'WhatsApp notify preflight failed', blockers: preflight.blockers },
          { status: 400 },
        );
      }

      if (publishInput.notify_scheduled_for && new Date(publishInput.notify_scheduled_for).getTime() <= Date.now()) {
        return NextResponse.json({ error: 'Scheduled time must be in the future' }, { status: 400 });
      }
    }

    const shareToken = globalCatalog.share_token ?? generateShareToken();
    const buyerNote = publishInput.buyer_note?.trim();

    const { error } = await db
      .schema('app')
      .from('campaigns')
      .update({
        status: 'published',
        share_token: shareToken,
        ...(buyerNote !== undefined ? { message: buyerNote || null } : {}),
        ...(publishInput.hero_image_url ? { hero_image_url: publishInput.hero_image_url } : {}),
        updated_by: claims.sub,
      })
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null);

    if (error) return NextResponse.json({ error: 'Failed to publish catalog' }, { status: 500 });

    const { error: publishAuditError } = await db.schema('app').from('audit_log').insert({
      tenant_id: claims.tenant_id,
      actor_user_id: claims.sub,
      entity_type: 'campaign',
      entity_id: id,
      action: 'status_change',
      diff: { status: 'published', share_token: shareToken, notify_whatsapp: publishInput.notify_whatsapp },
      ts: new Date().toISOString(),
    });
    if (publishAuditError) console.error('[publish_catalog] audit', publishAuditError);

    let whatsappNotify: { broadcast_id: string; recipient_count: number; scheduled: boolean } | null = null;

    if (publishInput.notify_whatsapp) {
      const { data: publishedCampaign } = await db
        .schema('app')
        .from('campaigns')
        .select('id, name, scope_type, scope_value, hero_image_url, message')
        .eq('id', id)
        .eq('tenant_id', claims.tenant_id)
        .maybeSingle();

      if (publishedCampaign) {
        try {
          whatsappNotify = await queueCampaignPublishNotify(db, {
            tenantId: claims.tenant_id,
            actorId: claims.sub ?? claims.tenant_id,
            campaignId: id,
            campaignName: publishedCampaign.name as string,
            scopeType: publishedCampaign.scope_type as ScopeType,
            scopeValue: (publishedCampaign.scope_value ?? {}) as Record<string, unknown>,
            buyerNote: publishedCampaign.message as string | null,
            scheduledFor: publishInput.notify_scheduled_for ?? null,
            heroImageUrl: publishedCampaign.hero_image_url as string | null,
          });
        } catch (notifyError) {
          console.error('[publish_catalog] WhatsApp notify failed after publish:', notifyError);
          return NextResponse.json(
            {
              error: notifyError instanceof Error ? notifyError.message : 'Campaign published but WhatsApp notify failed',
              ok: true,
              share_link: {
                share_token: shareToken,
                share_url: buildBuyerCatalogUrl(request.nextUrl.origin, shareToken),
              },
            },
            { status: 500 },
          );
        }
      }
    }

    try {
      const ph = getPostHogClient();
      ph.capture({
        distinctId: claims.sub ?? claims.tenant_id,
        event: 'catalog_published',
        properties: {
          campaign_id: id,
          tenant_id: claims.tenant_id,
          seller_id: claims.sub,
          scope_type: globalCatalog.scope_type,
          share_token: shareToken,
          notify_whatsapp: publishInput.notify_whatsapp,
        },
      });
      await ph.flush();
    } catch {
      // non-blocking
    }

    revalidateSellerDashboardCache(claims.tenant_id);
    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({
      ok: true,
      share_link: {
        share_token: shareToken,
        share_url: buildBuyerCatalogUrl(request.nextUrl.origin, shareToken),
      },
      whatsapp_notify: whatsappNotify,
    });
  }

  if (actionParsed.success && actionParsed.data.action === 'publish_catalog_updates') {
    if (claims.role !== 'seller_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (globalWorkflowStatus.value !== 'published_dirty' || !globalComposerDraft) {
      return NextResponse.json({ error: 'Only live campaigns with unpublished changes can publish updates' }, { status: 400 });
    }

    const buyerNote = actionParsed.data.buyer_note?.trim() ?? globalComposerDraft.message ?? globalCatalog.message ?? null;
    const nextScopeValue = buildScopeValueFromDraft(globalComposerDraft);

    const { data: updatedCatalog, error: updateCatalogError } = await db
      .schema('app')
      .from('campaigns')
      .update({
        name: globalComposerDraft.name,
        scope_type: globalComposerDraft.scope_type,
        scope_value: nextScopeValue,
        valid_from: globalComposerDraft.valid_from,
        valid_to: globalComposerDraft.valid_to,
        message: buyerNote || null,
        ...(actionParsed.data.hero_image_url ? { hero_image_url: actionParsed.data.hero_image_url } : {}),
        updated_by: claims.sub,
      })
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .select('id, status')
      .single();

    if (updateCatalogError || !updatedCatalog) {
      return NextResponse.json({ error: 'Failed to publish campaign updates' }, { status: 500 });
    }

    const deletedAt = new Date().toISOString();
    const { error: deleteItemsError } = await db
      .schema('app')
      .from('campaign_items')
      .update({ deleted_at: deletedAt, updated_by: claims.sub })
      .eq('campaign_id', id)
      .is('deleted_at', null);

    if (deleteItemsError) {
      return NextResponse.json({ error: 'Failed to refresh campaign items' }, { status: 500 });
    }

    if (globalComposerDraft.items.length > 0) {
      const { error: insertItemsError } = await db
        .schema('app')
        .from('campaign_items')
        .insert(
          globalComposerDraft.items.map((item) => ({
            campaign_id: id,
            tenant_product_id: item.tenant_product_id,
            display_order: item.display_order,
            price_override: item.price_override ?? null,
            created_by: claims.sub,
            updated_by: claims.sub,
          })),
        );

      if (insertItemsError) {
        return NextResponse.json({ error: 'Failed to save campaign items' }, { status: 500 });
      }
    }

    revalidateSellerDashboardCache(claims.tenant_id);
    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({ ok: true, catalog: updatedCatalog });
  }

  if (actionParsed.success && actionParsed.data.action === 'notify_catalog_buyers') {
    if (claims.role !== 'seller_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (globalWorkflowStatus.value !== 'published') {
      return NextResponse.json({ error: 'Only live published campaigns can notify buyers' }, { status: 400 });
    }

    const flagEnabled = await getFlag(FEATURE_FLAGS.WHATSAPP_BROADCAST, claims.tenant_id);
    if (!flagEnabled) {
      return NextResponse.json({ error: 'WhatsApp broadcast feature is not enabled' }, { status: 403 });
    }
    if (actionParsed.data.notify_scheduled_for && new Date(actionParsed.data.notify_scheduled_for).getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Scheduled time must be in the future' }, { status: 400 });
    }

    try {
      const whatsappNotify = await queueCampaignFollowupNotify(db, {
        tenantId: claims.tenant_id,
        actorId: claims.sub ?? claims.tenant_id,
        campaignId: id,
        campaignName: (globalCatalog.name as string) ?? 'Campaign',
        scopeType: globalCatalog.scope_type as ScopeType,
        scopeValue: (globalCatalog.scope_value ?? {}) as Record<string, unknown>,
        buyerNote: actionParsed.data.buyer_note?.trim() ?? (globalCatalog.message as string | null) ?? null,
        scheduledFor: actionParsed.data.notify_scheduled_for ?? null,
        heroImageUrl: (globalCatalog.hero_image_url as string | null) ?? null,
        recipientFilter: actionParsed.data.recipient_filter as CatalogNotifyRecipientFilter,
      });

      revalidateSellerDashboardCache(claims.tenant_id);
      return NextResponse.json({ ok: true, whatsapp_notify: whatsappNotify });
    } catch (notifyError) {
      return NextResponse.json(
        { error: notifyError instanceof Error ? notifyError.message : 'Failed to notify buyers' },
        { status: 500 },
      );
    }
  }

  if (actionParsed.success && actionParsed.data.action === 'ensure_share_link') {
    if (globalCatalog.status !== 'published') {
      return NextResponse.json({ error: 'Share links are only available for published catalogs' }, { status: 400 });
    }

    const shareToken = globalCatalog.share_token ?? generateShareToken();
    if (!globalCatalog.share_token) {
      const { error } = await db
        .schema('app')
        .from('campaigns')
        .update({
          share_token: shareToken,
          updated_by: claims.sub,
        })
        .eq('id', id)
        .eq('tenant_id', claims.tenant_id)
        .is('deleted_at', null);

      if (error) return NextResponse.json({ error: 'Failed to generate share link' }, { status: 500 });
      revalidateSellerDashboardCache(claims.tenant_id);
      revalidatePublicCatalogCache(claims.tenant_id);
    }

    return NextResponse.json({
      share_link: {
        share_token: shareToken,
        share_url: buildBuyerCatalogUrl(request.nextUrl.origin, shareToken),
      },
    });
  }

  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (actionParsed.success && actionParsed.data.action === 'add_product') {
    if (globalCatalog.product_membership_mode === 'automatic') {
      return NextResponse.json({ error: 'Update filters to manage automatic product membership' }, { status: 400 });
    }
    const { error } = await db
      .schema('app')
      .from('campaign_items')
      .insert({
        campaign_id: id,
        tenant_product_id: actionParsed.data.tenant_product_id,
        price_override: actionParsed.data.price_override ?? null,
        created_by: claims.sub,
        updated_by: claims.sub,
      });

    if (error) return NextResponse.json({ error: 'Failed to add product to catalog' }, { status: 500 });
    revalidateSellerDashboardCache(claims.tenant_id);
    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({ ok: true });
  }

  if (actionParsed.success && actionParsed.data.action === 'remove_product') {
    if (globalCatalog.product_membership_mode === 'automatic') {
      return NextResponse.json({ error: 'Update filters to manage automatic product membership' }, { status: 400 });
    }
    const { error } = await db
      .schema('app')
      .from('campaign_items')
      .update({ deleted_at: new Date().toISOString(), updated_by: claims.sub })
      .eq('campaign_id', id)
      .eq('tenant_product_id', actionParsed.data.tenant_product_id)
      .is('deleted_at', null);

    if (error) return NextResponse.json({ error: 'Failed to remove product from catalog' }, { status: 500 });
    revalidateSellerDashboardCache(claims.tenant_id);
    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({ ok: true });
  }

  if (simpleParsed?.success) {
    const payload = simpleParsed.data;
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

    const liveScopeValue = (globalCatalog.scope_value ?? {}) as {
      composer?: {
        filters?: CatalogComposerFilterState;
        tag_overrides?: Record<string, CatalogComposerTag | null>;
        price_source?: 'price_list' | 'manual';
        price_list_id?: string | null;
        pricing_strategy?: CatalogComposerPricingStrategy;
      };
      composer_draft?: CatalogDraftSnapshot | null;
    };
    const nextScopeValue = {
      ...buildCatalogScopeValue({
        scopeType: payload.target_mode === 'customer_group' ? 'cohort' : 'buyer',
        cohortId: payload.target_mode === 'customer_group' ? payload.target_cohort_id ?? null : null,
        buyerIds: buyerTargetMode === 'manual' ? payload.buyer_ids : [],
        filters: liveScopeValue.composer?.filters ?? defaultCatalogFilters(),
        tagOverrides: liveScopeValue.composer?.tag_overrides ?? {},
        priceSource: payload.pricing_mode === 'pricelist' ? 'price_list' : 'manual',
        priceListId: payload.pricing_mode === 'pricelist' ? payload.price_list_id ?? null : null,
        pricingStrategy: liveScopeValue.composer?.pricing_strategy,
        draft: liveScopeValue.composer_draft ?? null,
      }),
      simple_form: {
        description: payload.description?.trim() ? payload.description.trim() : null,
      },
    };
    const pricingSource = payload.pricing_mode === 'pricelist' ? 'pricelist' : 'individual_prices';
    const campaignPriceListId = payload.pricing_mode === 'pricelist' ? payload.price_list_id ?? null : null;
    // A pricelist already dictates pricing -- force edit_each/null there regardless of form input.
    const campaignPricingStrategy = pricingSource === 'individual_prices' ? (payload.pricing_strategy ?? 'edit_each') : 'edit_each';
    const campaignStrategyValue = campaignPricingStrategy === 'edit_each' ? null : (payload.strategy_value ?? null);

    const { data: updatedCatalog, error: updateCatalogError } = await db
      .schema('app')
      .from('campaigns')
      .update({
        name: payload.name,
        scope_type: payload.target_mode === 'customer_group' ? 'cohort' : 'buyer',
        scope_value: nextScopeValue,
        valid_from: payload.valid_from.toISOString(),
        valid_to: payload.valid_to ? payload.valid_to.toISOString() : null,
        message: payload.buyer_note?.trim() || null,
        hero_image_url: payload.hero_image_url?.trim() || null,
        buyer_target_mode: buyerTargetMode,
        buyer_filter_rules: buyerTargetMode === 'automatic' ? (payload.buyer_rules ?? null) : null,
        product_membership_mode: productMembershipMode,
        dynamic_rules: productMembershipMode === 'automatic' ? (payload.product_rules ?? null) : null,
        is_dynamic: productMembershipMode === 'automatic',
        pricing_source: pricingSource,
        price_list_id: campaignPriceListId,
        pricing_strategy: campaignPricingStrategy,
        strategy_value: campaignStrategyValue,
        updated_by: claims.sub,
      })
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .select('id, status')
      .single();

    if (updateCatalogError || !updatedCatalog) {
      logCatalogPatchDbError('simple campaign update', {
        campaignId: id,
        tenantId: claims.tenant_id,
        buyerTargetMode,
        productMembershipMode,
      }, updateCatalogError);
      return NextResponse.json({ error: 'Failed to update catalog' }, { status: 500 });
    }

    if (buyerTargetMode === 'automatic' || productMembershipMode === 'automatic') {
      // Mode switch or rule edit -- recompute now (requirement 4).
      const refreshCalls: Array<{ entityType: 'campaign_buyers' | 'campaign_products'; promise: PromiseLike<{ error: { message: string } | null }> }> = [];
      if (buyerTargetMode === 'automatic') {
        refreshCalls.push({ entityType: 'campaign_buyers', promise: db.schema('app').rpc('refresh_campaign_buyers_by_id', { p_campaign_id: id }) });
      }
      if (productMembershipMode === 'automatic') {
        refreshCalls.push({ entityType: 'campaign_products', promise: db.schema('app').rpc('refresh_campaign_products_by_id', { p_campaign_id: id }) });
      }
      const refreshResults = await Promise.all(refreshCalls.map((call) => call.promise));
      await Promise.all(
        refreshResults.map(async ({ error }, index) => {
          if (!error) return;
          const entityType = refreshCalls[index].entityType;
          console.error(`[PATCH /api/tenant/catalogs/[id]] ${entityType} refresh error:`, error.message);
          await db.schema('app').rpc('membership_mark_dirty', {
            p_tenant_id: claims.tenant_id,
            p_entity_type: entityType,
            p_entity_id: id,
            p_reason: `sync_refresh_failed:${error.message.slice(0, 200)}`,
          });
        }),
      );
    } else if (productMembershipMode === 'manual') {
      const { data: existingItems, error: existingItemsError } = await db
        .schema('app')
        .from('campaign_items')
        .select('id, tenant_product_id, deleted_at')
        .eq('campaign_id', id);

      if (existingItemsError) {
        logCatalogPatchDbError('load existing simple campaign items', {
          campaignId: id,
          tenantId: claims.tenant_id,
          selectedProductCount: payload.selected_product_ids.length,
        }, existingItemsError);
        return NextResponse.json({ error: 'Failed to sync selected products' }, { status: 500 });
      }

      const existingByProductId = new Map<string, { id: string; tenant_product_id: string; deleted_at: string | null }>(
        (existingItems ?? []).map((item: { id: string; tenant_product_id: string; deleted_at: string | null }) => [item.tenant_product_id, item]),
      );
      const nextSet = new Set(payload.selected_product_ids);
      const idsToSoftDelete = (existingItems ?? [])
        .filter((item: { tenant_product_id: string; deleted_at: string | null }) => !item.deleted_at && !nextSet.has(item.tenant_product_id))
        .map((item: { id: string }) => item.id);

      if (idsToSoftDelete.length > 0) {
        const { error: deleteItemsError } = await db
          .schema('app')
          .from('campaign_items')
          .update({ deleted_at: new Date().toISOString(), updated_by: claims.sub })
          .in('id', idsToSoftDelete);
        if (deleteItemsError) {
          logCatalogPatchDbError('soft-delete unselected simple campaign items', {
            campaignId: id,
            tenantId: claims.tenant_id,
            deleteCount: idsToSoftDelete.length,
          }, deleteItemsError);
          return NextResponse.json({ error: 'Failed to remove unselected products' }, { status: 500 });
        }
      }

      const nowIso = new Date().toISOString();
      const itemsToReactivate: Array<{
        id: string;
        campaign_id: string;
        tenant_product_id: string;
        display_order: number;
        deleted_at: null;
        updated_at: string;
        updated_by: string | null;
      }> = [];
      const itemsToInsert: Array<{
        campaign_id: string;
        tenant_product_id: string;
        display_order: number;
        price_override: null;
        created_by: string | null;
        updated_by: string | null;
        deleted_at: null;
      }> = [];

      payload.selected_product_ids.forEach((tenantProductId, index) => {
        const existingItem = existingByProductId.get(tenantProductId);
        if (existingItem) {
          itemsToReactivate.push({
            id: existingItem.id,
            campaign_id: id,
            tenant_product_id: tenantProductId,
            display_order: index,
            deleted_at: null,
            updated_at: nowIso,
            updated_by: claims.sub,
          });
        } else {
          itemsToInsert.push({
            campaign_id: id,
            tenant_product_id: tenantProductId,
            display_order: index,
            price_override: null,
            created_by: claims.sub,
            updated_by: claims.sub,
            deleted_at: null,
          });
        }
      });

      if (itemsToReactivate.length > 0) {
        const { error: updateItemsError } = await db
          .schema('app')
          .from('campaign_items')
          .upsert(itemsToReactivate, { onConflict: 'id' });
        if (updateItemsError) {
          logCatalogPatchDbError('reactivate simple campaign items', {
            campaignId: id,
            tenantId: claims.tenant_id,
            reactivateCount: itemsToReactivate.length,
          }, updateItemsError);
          return NextResponse.json({ error: 'Failed to update selected products' }, { status: 500 });
        }
      }

      if (itemsToInsert.length > 0) {
        const { error: insertItemsError } = await db
          .schema('app')
          .from('campaign_items')
          .insert(itemsToInsert);
        if (insertItemsError) {
          logCatalogPatchDbError('insert simple campaign items', {
            campaignId: id,
            tenantId: claims.tenant_id,
            insertCount: itemsToInsert.length,
          }, insertItemsError);
          return NextResponse.json({ error: 'Failed to add selected products' }, { status: 500 });
        }
      }
    }

    if (campaignPricingStrategy !== 'edit_each') {
      const { error: applyError } = await db.schema('app').rpc('apply_campaign_pricing_strategy', { p_campaign_id: id });
      if (applyError) {
        console.error('[PATCH /api/tenant/catalogs/[id]] apply pricing strategy error:', applyError.message);
      }
    }

    revalidateSellerDashboardCache(claims.tenant_id);
    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({ catalog: updatedCatalog });
  }

  if (!composerParsed?.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const payload = composerParsed.data;
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
    const tenantProductIds = payload.items.map((item) => item.tenant_product_id);
    const validProductIds = await ensureTenantProducts(db, claims.tenant_id, tenantProductIds);
    if (validProductIds.size !== tenantProductIds.length) {
      return NextResponse.json({ error: 'One or more selected products are invalid' }, { status: 400 });
    }
  }

  if (globalCatalog.status === 'published' && payload.save_mode === 'draft') {
    const liveScopeValue = (globalCatalog.scope_value ?? {}) as {
      cohort_id?: string;
      buyer_id?: string;
      buyer_ids?: string[];
      composer?: {
        filters?: CatalogComposerFilterState;
        tag_overrides?: Record<string, CatalogComposerTag | null>;
        price_source?: 'price_list' | 'manual';
        price_list_id?: string | null;
        pricing_strategy?: CatalogComposerPricingStrategy;
      };
    };

    const liveScopeType = (globalCatalog.scope_type as ComposerScopeType) === 'all'
      ? 'all'
      : (globalCatalog.scope_type as ComposerScopeType) === 'buyer'
        ? 'buyer'
        : 'cohort';

    const { data: savedDraft, error: saveDraftError } = await db
      .schema('app')
      .from('campaigns')
      .update({
        scope_value: buildCatalogScopeValue({
          scopeType: liveScopeType,
          cohortId: liveScopeValue.cohort_id ?? null,
          buyerIds: liveScopeValue.buyer_ids ?? (liveScopeValue.buyer_id ? [liveScopeValue.buyer_id] : []),
          filters: liveScopeValue.composer?.filters ?? defaultCatalogFilters(),
          tagOverrides: liveScopeValue.composer?.tag_overrides ?? {},
          priceSource: liveScopeValue.composer?.price_source ?? 'manual',
          priceListId: liveScopeValue.composer?.price_list_id ?? null,
          pricingStrategy: liveScopeValue.composer?.pricing_strategy,
          draft: buildCatalogDraftSnapshot(payload),
        }),
        updated_by: claims.sub,
      })
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .select('id, status')
      .single();

    if (saveDraftError || !savedDraft) {
      return NextResponse.json({ error: 'Failed to save unpublished changes' }, { status: 500 });
    }

    revalidatePublicCatalogCache(claims.tenant_id);
    return NextResponse.json({ catalog: savedDraft });
  }

  if (globalCatalog.status !== 'draft' && !(globalCatalog.status === 'published' && payload.save_mode === 'publish')) {
    return NextResponse.json({ error: 'Composition can only be edited for draft catalogs' }, { status: 400 });
  }

  const isFirstComposerPublish = globalCatalog.status === 'draft' && payload.save_mode === 'publish';
  const buyerNote = (payload.buyer_note ?? payload.message)?.trim() || null;
  const nextScopeValue = buildCatalogScopeValue({
    scopeType: payload.scope_type,
    cohortId: payload.cohort_id,
    buyerIds: payload.buyer_ids,
    filters: payload.filters,
    tagOverrides: payload.tag_overrides,
    priceSource: payload.price_source,
    priceListId: payload.price_list_id,
    pricingStrategy: payload.pricing_strategy,
    draft: null,
  });

  if (isFirstComposerPublish && payload.notify_whatsapp) {
    const flagEnabled = await getFlag(FEATURE_FLAGS.WHATSAPP_BROADCAST, claims.tenant_id);
    if (!flagEnabled) {
      return NextResponse.json({ error: 'WhatsApp broadcast feature is not enabled' }, { status: 403 });
    }

    const preflight = await runCampaignPublishPreflight(db, {
      tenantId: claims.tenant_id,
      scopeType: payload.scope_type,
      scopeValue: nextScopeValue,
      notifyWhatsapp: true,
      buyerNote: payload.buyer_note ?? payload.message ?? '',
    });

    if (!preflight.can_notify) {
      return NextResponse.json(
        { error: preflight.blockers[0] ?? 'WhatsApp notify preflight failed', blockers: preflight.blockers },
        { status: 400 },
      );
    }

    if (payload.notify_scheduled_for && new Date(payload.notify_scheduled_for).getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Scheduled time must be in the future' }, { status: 400 });
    }
  }

  const nextStatus: CatalogStatus = payload.save_mode === 'publish' ? 'published' : 'draft';
  const { data: updatedCatalog, error: updateCatalogError } = await db
    .schema('app')
    .from('campaigns')
    .update({
      name: payload.name,
      scope_type: payload.scope_type,
      scope_value: nextScopeValue,
      valid_from: payload.valid_from.toISOString(),
      valid_to: payload.valid_to ? payload.valid_to.toISOString() : null,
      ...(payload.save_mode === 'publish' ? { message: buyerNote } : {}),
      ...(payload.hero_image_url ? { hero_image_url: payload.hero_image_url } : {}),
      status: nextStatus,
      share_token: nextStatus === 'published' ? globalCatalog.share_token ?? generateShareToken() : globalCatalog.share_token,
      updated_by: claims.sub,
    })
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .select('id, status')
    .single();

  if (updateCatalogError || !updatedCatalog) {
    logCatalogPatchDbError('composer campaign update', {
      campaignId: id,
      tenantId: claims.tenant_id,
      saveMode: payload.save_mode,
      isDynamic: payload.is_dynamic,
      itemCount: payload.items.length,
    }, updateCatalogError);
    return NextResponse.json({ error: 'Failed to update catalog' }, { status: 500 });
  }

  const deletedAt = new Date().toISOString();
  const { error: deleteItemsError } = await db
    .schema('app')
    .from('campaign_items')
    .update({ deleted_at: deletedAt, updated_by: claims.sub })
    .eq('campaign_id', id)
    .is('deleted_at', null);

  if (deleteItemsError) {
    logCatalogPatchDbError('soft-delete composer campaign items', {
      campaignId: id,
      tenantId: claims.tenant_id,
    }, deleteItemsError);
    return NextResponse.json({ error: 'Failed to refresh catalog items' }, { status: 500 });
  }

  if (!payload.is_dynamic && payload.items.length > 0) {
    const { error: insertItemsError } = await db
      .schema('app')
      .from('campaign_items')
      .insert(
        payload.items.map((item) => ({
          campaign_id: id,
          tenant_product_id: item.tenant_product_id,
          display_order: item.display_order,
          price_override: item.price_override ?? null,
          created_by: claims.sub,
          updated_by: claims.sub,
        })),
      );

    if (insertItemsError) {
      logCatalogPatchDbError('insert composer campaign items', {
        campaignId: id,
        tenantId: claims.tenant_id,
        itemCount: payload.items.length,
      }, insertItemsError);
      return NextResponse.json({ error: 'Failed to save catalog items' }, { status: 500 });
    }
  }

  revalidateSellerDashboardCache(claims.tenant_id);
  revalidatePublicCatalogCache(claims.tenant_id);

  let whatsappNotify: { broadcast_id: string; recipient_count: number; scheduled: boolean } | null = null;

  if (isFirstComposerPublish && payload.notify_whatsapp) {
    const { data: publishedCampaign } = await db
      .schema('app')
      .from('campaigns')
      .select('id, name, scope_type, scope_value, hero_image_url, message')
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .maybeSingle();

    if (publishedCampaign) {
      try {
        whatsappNotify = await queueCampaignPublishNotify(db, {
          tenantId: claims.tenant_id,
          actorId: claims.sub ?? claims.tenant_id,
          campaignId: id,
          campaignName: publishedCampaign.name as string,
          scopeType: publishedCampaign.scope_type as ScopeType,
          scopeValue: (publishedCampaign.scope_value ?? {}) as Record<string, unknown>,
          buyerNote: (publishedCampaign.message as string | null) ?? buyerNote,
          scheduledFor: payload.notify_scheduled_for ?? null,
          heroImageUrl: publishedCampaign.hero_image_url as string | null,
        });
      } catch (notifyError) {
        console.error('[PATCH /api/tenant/catalogs/:id] WhatsApp notify failed after publish:', notifyError);
        return NextResponse.json(
          {
            error: notifyError instanceof Error ? notifyError.message : 'Campaign published but WhatsApp notify failed',
            catalog: updatedCatalog,
          },
          { status: 500 },
        );
      }
    }
  }

  return NextResponse.json({ catalog: updatedCatalog, whatsapp_notify: whatsappNotify });
}
