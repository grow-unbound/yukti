import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { unstable_cache } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerAccessProfile, BuyerVisibleCatalog } from '@/lib/server/buyer-access';
import { getVisibleBuyerCatalogs } from '@/lib/server/buyer-access';
import { resolveBuyerAllowedTenantBrandIds } from '@/lib/server/buyer-brand-visibility';
import { getBuyerCatalogContext } from '@/lib/server/buyer-catalog-context';
import { getSelectedBuyerDeliveryFromRequest } from '@/lib/server/buyer-location-selection';
import type { BuyerDeliveryLocation } from '@/lib/buyer-delivery-location';
import { resolveNearestBuyerLocation } from '@/lib/server/buyer-routing';
import {
  BUYER_SCOPED_PRODUCT_COLUMNS,
  searchScopedProducts,
  type ScopedProductSearchRow,
} from '@/lib/server/scoped-product-search';
import { r2Url } from '@/lib/r2-url';
import type {
  BuyerBrand,
  BuyerCatalogItem,
  BuyerCatalogResponse,
  BuyerCatalogSummary,
  BuyerCategory,
} from '@/types/buyer';
import { isPendingBuyerCatalogSession } from '@/lib/server/buyer-pending-guard';
import { campaignOverridePrice } from '@/lib/server/buyer-campaign-pricing';
import { getCampaignItemsForProducts } from '@/lib/server/campaign-items-cache';
import {
  getCachedGuestPricingContext,
  resolveGuestPricingContext,
  guestUnitPrice,
  loadLivePublicCatalog,
  loadAssignedPriceListPrices,
  TENANT_PRODUCT_PUBLIC_SELECT,
  type GuestPricingContext,
  type PublicCatalogRecord,
} from '@/lib/server/public-catalog';

export { TENANT_PRODUCT_PUBLIC_SELECT };

type CampaignItemRow = {
  tenant_product_id: string;
  price_override: number | null;
  display_order: number | null;
  is_featured?: boolean | null;
};

type PriceRow = {
  tenant_product_id: string;
  unit_price: number | null;
};

type BuyerFacetRpcRow = {
  facet_type: 'brand' | 'category';
  facet_id: string;
  facet_label: string;
  facet_slug: string | null;
  image_url: string | null;
  image_thumb_key: string | null;
  image_medium_key: string | null;
  product_count: number;
};

type CampaignCountRow = {
  id: string;
  campaign_items: Array<{ count: number }> | null;
};

const BUYER_CATALOG_SUMMARY_LIMIT = 100;

export type BuyerProductEnrichmentParams = {
  tenantId: string;
  buyerId: string | null;
  tenantProductIds: string[];
  allowedTenantBrandIds?: string[] | null;
  inventoryWarehouseId?: string | null;
  campaignByProductId?: Map<string, {
    campaign_id: string | null;
    campaign_name: string | null;
    campaign_valid_until: string | null;
    campaign_price: number | null;
    is_featured?: boolean;
  }>;
  qtyByProductId?: Map<string, number>;
  /**
   * Price/stock already resolved by `search_products_scoped` (e.g. via `resolveCatalogScope`).
   * When provided, skips the `resolve_prices_batch` RPC and the standalone inventory query
   * entirely — callers without a prior scope resolution (product-detail resolve, share-token
   * catalog, cart/order assembly) omit this and get the original self-contained resolution.
   */
  priceStockByProductId?: Map<string, { unit_price: number; on_hand: number }>;
  /**
   * Set when `scopedRows` came from a `load/search_products_scoped` call made WITH this buyer's id
   * (unit_price is then the buyer's qty-1 price: buyer > cohort > all_buyers list, base fallback).
   * Qty-1 lines take that price instead of a second `resolve_prices_batch` round trip. Never set it
   * for rows fetched without the buyer (guest/price-list pricing) — they carry the base price.
   */
  scopedRowsPricedForBuyer?: boolean;
  /**
   * Full enrichment rows already fetched by the caller's own search_products_scoped /
   * load_products_scoped call (e.g. resolveCatalogScope) — skips enrichBuyerProducts's
   * own RPC round-trip entirely. Callers working from an arbitrary id list with no
   * prior RPC call (home reco, recommendations, cart resolve) omit this.
   */
  scopedRows?: ScopedProductSearchRow[] | null;
  /** Public-store guest pricing. When set, never call `resolve_prices_batch`. */
  guestPricing?: GuestPricingContext | null;
  /** Tenant public catalog behavior. Hidden-price mode suppresses all buyer-visible prices. */
  publicCatalog?: PublicCatalogRecord | null;
};

type CatalogPageParams = {
  db: SupabaseClient;
  tenantId: string;
  buyerId: string | null;
  allowedTenantBrandIds?: string[] | null;
  inventoryWarehouseId?: string | null;
  visibleCampaigns: BuyerVisibleCatalog[];
  search?: string;
  categoryId?: string;
  brandId?: string;
  tenantProductId?: string;
  requestedCampaignId?: string;
  limit: number;
  offset: number;
  guestPricing?: GuestPricingContext | null;
  publicCatalog?: PublicCatalogRecord | null;
};

type CatalogScopeResult = {
  orderedProductIds: string[];
  total: number;
  selectedCampaign: BuyerVisibleCatalog | null;
  campaignByProductId: Map<string, {
    campaign_id: string | null;
    campaign_name: string | null;
    campaign_valid_until: string | null;
    campaign_price: number | null;
    is_featured?: boolean;
  }>;
  textByProductId: Map<string, ScopedProductSearchRow>;
};

function isBuyerStockVisibilityEnabled(db: SupabaseClient, tenantId: string): Promise<boolean> {
  return unstable_cache(
    async () => {
      const { data } = await (db as any)
        .schema('app')
        .from('tenant_settings')
        .select('settings')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const rawSettings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
      const rawBuyerApp = (rawSettings.buyer_app ?? {}) as Record<string, unknown>;
      return rawBuyerApp.stock_visibility_enabled === true;
    },
    ['buyer-stock-visibility', tenantId],
    { revalidate: 300, tags: [`tenant-settings:${tenantId}`] },
  )();
}

function rowsToTextMap(rows: ScopedProductSearchRow[]): Map<string, ScopedProductSearchRow> {
  return new Map(rows.map((row) => [row.tenant_product_id, row]));
}

export async function resolveVisibleCampaignMap(
  db: SupabaseClient,
  params: {
    tenantId: string;
    buyerId: string | null;
    productIds: string[];
    visibleCampaigns?: BuyerVisibleCatalog[];
  },
): Promise<Map<string, {
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_valid_until: string | null;
  campaign_price: number | null;
  is_featured?: boolean;
}>> {
  const { tenantId, buyerId, productIds } = params;
  if (!buyerId || productIds.length === 0) return new Map();

  const visibleCampaigns = params.visibleCampaigns ?? await getVisibleBuyerCatalogs(tenantId, buyerId);
  if (visibleCampaigns.length === 0) return new Map();

  const visibleCampaignIds = visibleCampaigns.map((campaign) => campaign.id);
  const campaignPriority = new Map(visibleCampaignIds.map((id, index) => [id, index]));

  const data = await getCampaignItemsForProducts(db, tenantId, visibleCampaignIds, productIds);

  const campaignsById = new Map(visibleCampaigns.map((campaign) => [campaign.id, campaign]));
  const rows = data as Array<CampaignItemRow & { campaign_id: string }>;
  rows.sort((a, b) => {
    const aHasOverride = campaignOverridePrice(a.price_override) != null ? 0 : 1;
    const bHasOverride = campaignOverridePrice(b.price_override) != null ? 0 : 1;
    if (aHasOverride !== bHasOverride) return aHasOverride - bHasOverride;

    const campaignRank = (campaignPriority.get(a.campaign_id) ?? Number.MAX_SAFE_INTEGER)
      - (campaignPriority.get(b.campaign_id) ?? Number.MAX_SAFE_INTEGER);
    if (campaignRank !== 0) return campaignRank;
    return (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER);
  });

  const campaignByProductId = new Map<string, {
    campaign_id: string | null;
    campaign_name: string | null;
    campaign_valid_until: string | null;
    campaign_price: number | null;
    is_featured?: boolean;
  }>();

  for (const row of rows) {
    if (campaignByProductId.has(row.tenant_product_id)) continue;
    const campaign = campaignsById.get(row.campaign_id);
    if (!campaign) continue;
    campaignByProductId.set(row.tenant_product_id, {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      campaign_valid_until: campaign.valid_to,
      campaign_price: campaignOverridePrice(row.price_override),
      is_featured: Boolean(row.is_featured),
    });
  }

  return campaignByProductId;
}

function tenantCategoryImageUrl(
  thumbKey: string | null | undefined,
  mediumKey?: string | null,
): string | null {
  return r2Url(thumbKey ?? mediumKey);
}

async function resolveTenantBrandIdsForMasterBrand(
  db: SupabaseClient,
  tenantId: string,
  masterBrandId: string,
): Promise<string[]> {
  const { data, error } = await db
    .schema('app')
    .from('tenant_brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('master_brand_id', masterBrandId)
    .is('deleted_at', null);

  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function resolveTenantBrandIdsForBuyerBrand(
  db: SupabaseClient,
  tenantId: string,
  brandId: string,
): Promise<string[]> {
  const { data: tenantBrandById, error: tenantBrandByIdError } = await db
    .schema('app')
    .from('tenant_brands')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('id', brandId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tenantBrandByIdError) throw new Error(tenantBrandByIdError.message);
  if (tenantBrandById) return [(tenantBrandById as { id: string }).id];

  return resolveTenantBrandIdsForMasterBrand(db, tenantId, brandId);
}

export async function resolveBuyerInventoryWarehouseId(
  db: SupabaseClient,
  request: NextRequest,
  profile: BuyerAccessProfile,
): Promise<string | null> {
  const tenantId = profile.context.tenant_id;
  if (!tenantId) return null;

  const selectedDelivery = getSelectedBuyerDeliveryFromRequest(request);
  if (selectedDelivery?.nearest_warehouse_id) {
    return selectedDelivery.nearest_warehouse_id;
  }

  const resolvedRouting = await resolveNearestBuyerLocation(db as any, tenantId, selectedDelivery);
  if (resolvedRouting?.warehouseId) return resolvedRouting.warehouseId;

  if (profile.buyer?.geography) {
    const { data: defaultWarehouse, error } = await db
      .schema('app')
      .from('warehouses')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('is_default', true)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (defaultWarehouse as { id: string } | null)?.id ?? null;
  }

  return null;
}

/**
 * Cookie-based sibling of resolveBuyerInventoryWarehouseId, for Server
 * Components (page.tsx doesn't have a NextRequest, only next/headers
 * cookies()). Takes an already-resolved `selectedDelivery` (callers already
 * fetch this for getBuyerServerProductScope, no need to re-read cookies).
 *
 * Deliberately omits the last-resort profile.buyer.geography-gated default-
 * warehouse fallback the request-scoped version has — that needs a full
 * buyer row fetch this path doesn't otherwise need. Returns null in that
 * residual case; callers skip SSR-seeding the product grid and fall back to
 * the existing client fetch, same graceful-degradation pattern
 * getBuyerServerProductScope already uses when there's no delivery cookie.
 */
export async function resolveBuyerInventoryWarehouseIdFromCookies(
  db: SupabaseClient,
  tenantId: string,
  selectedDelivery: BuyerDeliveryLocation | null,
): Promise<string | null> {
  if (selectedDelivery?.nearest_warehouse_id) {
    return selectedDelivery.nearest_warehouse_id;
  }

  const resolvedRouting = await resolveNearestBuyerLocation(db as any, tenantId, selectedDelivery);
  return resolvedRouting?.warehouseId ?? null;
}

export async function resolveBuyerCatalogSummaries(
  db: SupabaseClient,
  tenantId: string,
  buyerId: string | null,
): Promise<{ visibleCampaigns: BuyerVisibleCatalog[]; catalogs: BuyerCatalogSummary[] }> {
  let visibleCampaigns: BuyerVisibleCatalog[] = [];
  if (buyerId) {
    visibleCampaigns = (await getVisibleBuyerCatalogs(tenantId, buyerId)).slice(0, BUYER_CATALOG_SUMMARY_LIMIT);
  } else {
    const { data, error } = await db
      .schema('app')
      .from('campaigns')
      .select('id, tenant_id, name, share_token, valid_to, created_at, scope_type, scope_value, hero_image_url')
      .eq('tenant_id', tenantId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .or(`valid_to.is.null,valid_to.gt.${new Date().toISOString()}`)
      .order('created_at', { ascending: false })
      .limit(BUYER_CATALOG_SUMMARY_LIMIT);
    if (error) throw new Error(error.message);
    visibleCampaigns = (data ?? []) as BuyerVisibleCatalog[];
  }

  const counts = new Map<string, number>();
  if (buyerId) {
    // Item counts ride along in the cached per-buyer catalog context: no extra campaigns query.
    const ctx = await getBuyerCatalogContext(tenantId, buyerId);
    for (const campaign of visibleCampaigns) {
      counts.set(campaign.id, ctx.itemCountByCampaignId[campaign.id] ?? 0);
    }
  } else {
    const campaignIds = visibleCampaigns.map((campaign) => campaign.id);
    if (campaignIds.length > 0) {
      const { data, error } = await db
        .schema('app')
        .from('campaigns')
        .select('id, campaign_items(count)')
        .eq('tenant_id', tenantId)
        .in('id', campaignIds)
        .is('deleted_at', null)
        .is('campaign_items.deleted_at', null)
        .limit(BUYER_CATALOG_SUMMARY_LIMIT);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as unknown as CampaignCountRow[]) {
        counts.set(row.id, Number(row.campaign_items?.[0]?.count ?? 0));
      }
    }
  }

  const catalogs = visibleCampaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    product_count: counts.get(campaign.id) ?? 0,
    share_token: campaign.share_token,
    valid_until: campaign.valid_to,
    hero_image_url: campaign.hero_image_url ?? null,
  }));

  return { visibleCampaigns, catalogs };
}

export async function enrichBuyerProducts(
  db: SupabaseClient,
  params: BuyerProductEnrichmentParams,
): Promise<Map<string, BuyerCatalogItem>> {
  const {
    tenantId,
    buyerId,
    tenantProductIds,
    allowedTenantBrandIds = null,
    inventoryWarehouseId = null,
    campaignByProductId = new Map(),
    qtyByProductId = new Map(),
    priceStockByProductId = null,
    guestPricing = null,
    scopedRows = null,
    scopedRowsPricedForBuyer = false,
    publicCatalog = null,
  } = params;
  const hiddenPriceEnquiry = publicCatalog?.pricingMode === 'hide_price_collect_enquiry';

  const orderedIds = tenantProductIds.filter(Boolean);
  if (orderedIds.length === 0) return new Map();

  // Name/brand/category/tax/stock/images now come from one RPC round-trip
  // (search_products_scoped / load_products_scoped — see scoped-product-
  // search.ts) instead of the old 4-stage tenant_products -> tenant_brands/
  // tenant_categories/catalog.products -> catalog.brands/catalog.categories
  // -> inventory join chain. A caller that already ran that RPC for its own
  // purposes (fetchBuyerCatalogPage's resolveCatalogScope) passes the rows
  // straight through via `scopedRows` — zero extra round-trips. A caller
  // working from an arbitrary id list with no prior RPC call (home reco,
  // recommendations, cart resolve) triggers exactly one here.
  //
  // Deliberately not passing allowedTenantBrandIds into that fetch: this
  // function only ever enriches ids the caller already decided are legitimate
  // to look up (a past order's line items, the recommendation engine's own
  // output, a cart the buyer built by adding items they could already see) —
  // never an open browse. The cohort brand allowlist is the browse-time
  // authorization boundary (enforced by resolveCatalogScope's own RPC call,
  // whose rows arrive here via `scopedRows`); re-applying it to an explicit
  // id list previously caused a real bug (a campaign product outside the
  // buyer's allowlist silently failed to resolve during checkout).
  // Rows we fetch ourselves are fetched WITH the buyer so they arrive priced (qty 1) and the
  // separate resolve_prices_batch call below is only needed for quantity-tiered lines.
  const fetchPricedForBuyer = !scopedRows && !priceStockByProductId && Boolean(buyerId) && !guestPricing && !hiddenPriceEnquiry;
  const rowsPricedForBuyer = Boolean(buyerId) && !guestPricing && !hiddenPriceEnquiry
    && (fetchPricedForBuyer || scopedRowsPricedForBuyer);
  const rows: ScopedProductSearchRow[] = scopedRows ?? (
    orderedIds.length > 0
      ? (await searchScopedProducts({
          columns: BUYER_SCOPED_PRODUCT_COLUMNS,
          db,
          tenantId,
          buyerId: fetchPricedForBuyer ? buyerId : null,
          ids: orderedIds,
          warehouseIds: inventoryWarehouseId ? [inventoryWarehouseId] : null,
          limit: Math.max(orderedIds.length, 1),
        })).rows
      : []
  );

  const stockVisibilityEnabled = await isBuyerStockVisibilityEnabled(db, tenantId);

  if (rows.length === 0) return new Map();
  const rowById = new Map(rows.map((row) => [row.tenant_product_id, row]));
  const productIds = orderedIds.filter((id) => rowById.has(id));
  if (productIds.length === 0) return new Map();

  const inventoryMap = new Map<string, number>();
  if (priceStockByProductId) {
    // Match the standalone-query path's semantics exactly: stock is only ever
    // surfaced (even internally) when the tenant has visibility turned on.
    if (stockVisibilityEnabled) {
      for (const [productId, entry] of priceStockByProductId) {
        inventoryMap.set(productId, Math.max(0, entry.on_hand));
      }
    }
  } else if (stockVisibilityEnabled) {
    for (const productId of productIds) {
      inventoryMap.set(productId, Number(rowById.get(productId)?.on_hand ?? 0));
    }
  }

  const priceMap = new Map<string, number>();
  if (hiddenPriceEnquiry || guestPricing?.mode === 'hidden_until_login') {
    // Guests never see a unit price in this mode — leave priceMap empty.
  } else if (guestPricing?.mode === 'assigned_price_list' && guestPricing.priceListId) {
    const assigned = await loadAssignedPriceListPrices(db, {
      tenantId,
      priceListId: guestPricing.priceListId,
      productIds,
    });
    for (const [productId, unitPrice] of assigned) {
      priceMap.set(productId, unitPrice);
    }
  } else if (guestPricing?.mode === 'base_selling_rate') {
    for (const productId of productIds) {
      const basePrice = rowById.get(productId)?.base_selling_price;
      if (basePrice != null) priceMap.set(productId, Number(basePrice));
    }
  } else if (priceStockByProductId) {
    for (const [productId, entry] of priceStockByProductId) {
      priceMap.set(productId, entry.unit_price);
    }
  } else if (buyerId && productIds.length > 0) {
    // Qty-tiered price-list pricing depends on the actual quantity, which
    // search_products_scoped's own price resolution doesn't know about (it
    // always resolves at qty=1) — kept as a dedicated, qty-grouped RPC call,
    // same as before this change.
    const grouped = new Map<number, string[]>();
    for (const productId of productIds) {
      const qty = Math.max(1, Number(qtyByProductId.get(productId) ?? 1));
      if (qty === 1 && rowsPricedForBuyer) {
        // Already priced by the scoped RPC (same precedence as resolve_prices_batch at qty 1).
        priceMap.set(productId, Number(rowById.get(productId)?.unit_price ?? 0));
        continue;
      }
      const bucket = grouped.get(qty) ?? [];
      bucket.push(productId);
      grouped.set(qty, bucket);
    }

    const priceResponses = await Promise.all(
      Array.from(grouped.entries()).map(async ([qty, ids]) => {
        const { data, error } = await db.schema('app').rpc('resolve_prices_batch', {
          p_tenant_product_ids: ids,
          p_buyer_id: buyerId,
          p_qty: qty,
        });
        if (error) throw new Error(error.message);
        return (data ?? []) as PriceRow[];
      }),
    );

    for (const priceRows of priceResponses) {
      for (const row of priceRows) {
        priceMap.set(row.tenant_product_id, Number(row.unit_price ?? 0));
      }
    }
  }

  const out = new Map<string, BuyerCatalogItem>();
  for (const productId of orderedIds) {
    const row = rowById.get(productId);
    if (!row) continue;

    const campaign = guestPricing || hiddenPriceEnquiry ? null : (campaignByProductId.get(productId) ?? null);
    const resolvedPrice = guestPricing
      ? guestUnitPrice({
          mode: guestPricing.mode,
          assignedPrice: priceMap.get(productId),
          baseSellingPrice: row.base_selling_price,
        })
      : hiddenPriceEnquiry
        ? null
        : (priceMap.get(productId) ?? Number(row.base_selling_price ?? row.mrp ?? 0));
    const campaignPrice = campaignOverridePrice(campaign?.campaign_price);
    const unitPrice = hiddenPriceEnquiry ? null : (guestPricing ? resolvedPrice : (campaignPrice ?? resolvedPrice));
    const onHand = Math.max(0, inventoryMap.get(productId) ?? 0);
    const fallbackImageUrl = row.image_urls?.length ? row.image_urls[0] : null;
    const smallVariantUrl = r2Url(row.r2_small_key) ?? r2Url(row.r2_medium_key) ?? r2Url(row.r2_large_key);
    const mediumVariantUrl = r2Url(row.r2_medium_key) ?? r2Url(row.r2_large_key) ?? r2Url(row.r2_small_key);
    const largeVariantUrl = r2Url(row.r2_large_key) ?? r2Url(row.r2_medium_key) ?? r2Url(row.r2_small_key);
    // Falls back to the SKU's parent product family's shared photo when this
    // specific variant has no own image — common for families where only one
    // representative photo is uploaded, not one per variant.
    const familyImageUrl = r2Url(row.family_r2_small_key)
      ?? r2Url(row.family_r2_medium_key)
      ?? r2Url(row.family_r2_large_key)
      ?? (row.family_image_urls?.length ? row.family_image_urls[0] : null);

    out.set(productId, {
      id: productId,
      tenant_product_id: productId,
      campaign_id: campaign?.campaign_id ?? null,
      campaign_name: campaign?.campaign_name ?? null,
      campaign_valid_until: campaign?.campaign_valid_until ?? null,
      internal_sku: row.sku ?? productId,
      display_name: row.product_name,
      brand_id: row.brand_id,
      brand_name: row.brand_name,
      category_id: row.category_id,
      category_name: row.category_name,
      mrp: Number(row.mrp ?? 0),
      price: unitPrice,
      resolved_price: resolvedPrice,
      campaign_price: campaignPrice,
      has_campaign_price: campaignPrice != null,
      catalog_id: publicCatalog?.id ?? null,
      catalog_pricing_mode: publicCatalog?.pricingMode ?? guestPricing?.mode ?? null,
      collect_target_unit_price_range: publicCatalog?.collectTargetUnitPriceRange ?? false,
      gst_rate: row.tax_pct,
      default_uom: row.default_uom,
      pack_size: row.pack_size,
      image_urls: (row.image_urls?.length ? row.image_urls : []) as string[],
      image_url_small: smallVariantUrl ?? fallbackImageUrl,
      image_url_medium: mediumVariantUrl ?? fallbackImageUrl,
      image_url_large: largeVariantUrl ?? fallbackImageUrl,
      brand_logo_url: row.brand_logo_url,
      category_image_url: r2Url(row.category_image_thumb_key ?? row.category_image_medium_key),
      family_image_url: familyImageUrl,
      stock_status: !stockVisibilityEnabled ? 'available' : onHand === 0 ? 'out_of_stock' : onHand < 10 ? 'limited' : 'available',
      on_hand: onHand,
      is_featured: campaign?.is_featured ?? false,
    });
  }

  return out;
}

async function resolveCatalogScope(params: CatalogPageParams): Promise<CatalogScopeResult> {
  const {
    db,
    tenantId,
    allowedTenantBrandIds = null,
    visibleCampaigns,
    search = '',
    categoryId = '',
    brandId = '',
    tenantProductId = '',
    requestedCampaignId = '',
    limit,
    offset,
  } = params;

  const trimmedSearch = search.trim();
  if (requestedCampaignId && !params.guestPricing) {
    const selectedCampaign = visibleCampaigns.find((campaign) => campaign.id === requestedCampaignId) ?? null;
    if (!selectedCampaign) {
      return {
        orderedProductIds: [],
        total: 0,
        selectedCampaign: null,
        campaignByProductId: new Map(),
        textByProductId: new Map(),
      };
    }

    // A buyer's `allowedTenantBrandIds` gates the *default* catalog browse —
    // it must not also gate a campaign the buyer was explicitly targeted for
    // (`selectedCampaign` above already proves that authorization via
    // `visibleCampaigns`/`getVisibleBuyerCatalogs`). A cohort's brand allowlist
    // and a campaign's own product membership are independent scopes; applying
    // both meant a buyer whose cohort excludes a brand saw the campaign banner
    // but got zero items on every campaign product that happened to be in that
    // brand — the campaign's own membership is the authoritative scope here.
    // The explicit `brandId` filter chip (a user choice within the campaign
    // view, not a visibility gate) still applies on its own.
    let effectiveTenantBrandIds: string[] | null = null;
    if (brandId) {
      effectiveTenantBrandIds = await resolveTenantBrandIdsForBuyerBrand(db, tenantId, brandId);
      if (effectiveTenantBrandIds.length === 0) {
        return { orderedProductIds: [], total: 0, selectedCampaign, campaignByProductId: new Map(), textByProductId: new Map() };
      }
    }

    const { rows, total } = await searchScopedProducts({
      columns: BUYER_SCOPED_PRODUCT_COLUMNS,
      db,
      tenantId,
      buyerId: params.buyerId,
      campaignId: selectedCampaign.id,
      query: trimmedSearch,
      limit,
      offset,
      ids: tenantProductId ? [tenantProductId] : null,
      brandIds: effectiveTenantBrandIds,
      categoryScopeId: categoryId || null,
      allowedBrandIds: effectiveTenantBrandIds,
      warehouseIds: params.inventoryWarehouseId ? [params.inventoryWarehouseId] : null,
      availability: 'show_all',
      sort: trimmedSearch ? 'relevance' : 'created_desc',
    });
    const orderedProductIds = rows.map((row) => row.tenant_product_id);
    const textByProductId = rowsToTextMap(rows);
    if (orderedProductIds.length === 0) {
      return { orderedProductIds: [], total, selectedCampaign, campaignByProductId: new Map(), textByProductId };
    }

    const pageCampaignItems = await getCampaignItemsForProducts(db, tenantId, [selectedCampaign.id], orderedProductIds);

    const itemByProductId = new Map(
      (pageCampaignItems as CampaignItemRow[]).map((row) => [row.tenant_product_id, row]),
    );
    const campaignByProductId = new Map(
      orderedProductIds.flatMap((productId) => {
        const row = itemByProductId.get(productId);
        return row ? [[productId, {
          campaign_id: selectedCampaign.id,
          campaign_name: selectedCampaign.name,
          campaign_valid_until: selectedCampaign.valid_to,
          campaign_price: campaignOverridePrice(row.price_override),
          is_featured: Boolean(row.is_featured),
        }] as const] : [];
      }),
    );

    return {
      orderedProductIds,
      total,
      selectedCampaign,
      campaignByProductId,
      textByProductId,
    };
  }

  let effectiveTenantBrandIds = Array.isArray(allowedTenantBrandIds) ? [...allowedTenantBrandIds] : null;
  if (brandId) {
    const matchingTenantBrandIds = await resolveTenantBrandIdsForBuyerBrand(db, tenantId, brandId);
    effectiveTenantBrandIds = effectiveTenantBrandIds
      ? effectiveTenantBrandIds.filter((id) => matchingTenantBrandIds.includes(id))
      : matchingTenantBrandIds;
  }
  if (effectiveTenantBrandIds) {
    if (effectiveTenantBrandIds.length === 0) {
      return { orderedProductIds: [], total: 0, selectedCampaign: null, campaignByProductId: new Map(), textByProductId: new Map() };
    }
  }

  const { rows, total } = await searchScopedProducts({
    columns: BUYER_SCOPED_PRODUCT_COLUMNS,
    db,
    tenantId,
    buyerId: params.guestPricing ? null : params.buyerId,
    priceListId: params.guestPricing?.mode === 'assigned_price_list' ? params.guestPricing.priceListId : null,
    query: trimmedSearch,
    limit,
    offset,
    ids: tenantProductId ? [tenantProductId] : null,
    brandIds: effectiveTenantBrandIds,
    categoryScopeId: categoryId || null,
    allowedBrandIds: effectiveTenantBrandIds,
    warehouseIds: params.inventoryWarehouseId ? [params.inventoryWarehouseId] : null,
    availability: 'show_all',
    sort: trimmedSearch ? 'relevance' : 'created_desc',
  });

  const excluded = new Set(params.guestPricing?.excludedProductIds ?? []);
  const orderedProductIds = rows
    .map((row) => row.tenant_product_id)
    .filter((id) => !excluded.has(id));
  const textByProductId = rowsToTextMap(rows.filter((row) => !excluded.has(row.tenant_product_id)));
  const campaignByProductId = params.guestPricing
    ? new Map()
    : await resolveVisibleCampaignMap(db, {
        tenantId,
        buyerId: params.buyerId,
        productIds: orderedProductIds,
        visibleCampaigns,
      });

  return {
    orderedProductIds,
    total,
    selectedCampaign: null,
    campaignByProductId,
    textByProductId,
  };
}

export async function fetchBuyerCatalogPage(
  params: CatalogPageParams,
): Promise<BuyerCatalogResponse> {
  const scope = await resolveCatalogScope(params);
  // Same reasoning as resolveCatalogScope's campaign branch: a buyer's cohort
  // brand allowlist gates the default browse, not a campaign they were
  // explicitly targeted for (scope.selectedCampaign is only set once that
  // targeting is already verified). Applying it here too silently dropped
  // every enriched item for a campaign product outside the buyer's allowlist,
  // even after the scope query itself was scoped correctly.
  const itemsMap = await enrichBuyerProducts(params.db, {
    tenantId: params.tenantId,
    buyerId: params.buyerId,
    tenantProductIds: scope.orderedProductIds,
    allowedTenantBrandIds: scope.selectedCampaign ? null : params.allowedTenantBrandIds,
    inventoryWarehouseId: params.inventoryWarehouseId,
    campaignByProductId: scope.campaignByProductId,
    scopedRows: Array.from(scope.textByProductId.values()),
    scopedRowsPricedForBuyer: !params.guestPricing && Boolean(params.buyerId),
    guestPricing: params.guestPricing ?? null,
    publicCatalog: params.publicCatalog ?? null,
  });

  return {
    items: scope.orderedProductIds
      .map((id) => itemsMap.get(id))
      .filter((item): item is BuyerCatalogItem => Boolean(item)),
    total: scope.total,
    has_more: params.offset + params.limit < scope.total,
    catalog_id: params.publicCatalog?.id ?? null,
    pricing_mode: params.publicCatalog?.pricingMode ?? params.guestPricing?.mode ?? null,
    collect_target_unit_price_range: params.publicCatalog?.collectTargetUnitPriceRange ?? false,
    selected_campaign_id: scope.selectedCampaign?.id ?? null,
    selected_campaign_name: scope.selectedCampaign?.name ?? null,
    selected_campaign_valid_until: scope.selectedCampaign?.valid_to ?? null,
    selected_campaign_message: scope.selectedCampaign?.message ?? null,
    selected_campaign_image_url: scope.selectedCampaign?.hero_image_url ?? null,
  };
}

type FacetScopeParams = {
  db: SupabaseClient;
  tenantId: string;
  allowedTenantBrandIds?: string[] | null;
  categoryId?: string;
  brandId?: string;
  requestedCampaignId?: string;
  shareToken?: string;
};

async function resolveFacetScopeRows(params: FacetScopeParams): Promise<BuyerFacetRpcRow[]> {
  const {
    db,
    tenantId,
    allowedTenantBrandIds = null,
    categoryId = '',
    brandId = '',
    requestedCampaignId = '',
    shareToken = '',
  } = params;

  if (Array.isArray(allowedTenantBrandIds) && allowedTenantBrandIds.length === 0) return [];

  let campaignId = requestedCampaignId || null;
  if (!campaignId && shareToken) {
    const { data: campaign, error } = await db
      .schema('app')
      .from('campaigns')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('share_token', shareToken)
      .eq('status', 'published')
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    campaignId = (campaign as { id?: string } | null)?.id ?? null;
    if (!campaignId) return [];
  }

  const rpcDb = db as any;
  const { data, error } = await rpcDb.schema('app').rpc('get_buyer_product_facets_scoped', {
    p_tenant_id: tenantId,
    p_campaign_id: campaignId,
    p_allowed_brand_ids: allowedTenantBrandIds,
    p_brand_scope_id: brandId || null,
    p_category_scope_id: categoryId || null,
    p_limit: 100,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as BuyerFacetRpcRow[];
}

export async function fetchBuyerCategories(
  params: FacetScopeParams,
): Promise<BuyerCategory[]> {
  const rows = await resolveFacetScopeRows(params);
  return rows
    .filter((row) => row.facet_type === 'category')
    .map((row) => ({
      id: row.facet_id,
      name: row.facet_label,
      slug: row.facet_slug ?? row.facet_id,
      image_url: tenantCategoryImageUrl(row.image_medium_key, row.image_thumb_key) ?? row.image_url,
      product_count: Number(row.product_count),
    }));
}

export async function fetchBuyerBrands(
  params: FacetScopeParams,
): Promise<BuyerBrand[]> {
  const rows = await resolveFacetScopeRows(params);
  return rows
    .filter((row) => row.facet_type === 'brand')
    .map((row) => ({
      id: row.facet_id,
      name: row.facet_label,
      product_count: Number(row.product_count),
      logo_url: row.image_url,
    }));
}

/**
 * Cached guest-only category/brand facets — no cohort scoping (allowedTenantBrandIds
 * is always null for a guest), no campaign/share-token scoping, tenant-scoped only.
 * Callers must only use these for a confirmed guest request with no campaign/share_token
 * query params — see app/api/buyer/categories and app/api/buyer/brands routes.
 * Invalidated via revalidatePublicCatalogCache() on catalog writes.
 */
export function fetchCachedGuestCategories(tenantId: string): Promise<BuyerCategory[]> {
  return unstable_cache(
    () => fetchBuyerCategories({ db: supabaseAdmin as unknown as SupabaseClient, tenantId, allowedTenantBrandIds: null }),
    ['guest-categories', tenantId],
    { revalidate: 300, tags: [`public-catalog:${tenantId}`] },
  )();
}

export function fetchCachedGuestBrands(tenantId: string): Promise<BuyerBrand[]> {
  return unstable_cache(
    () => fetchBuyerBrands({ db: supabaseAdmin as unknown as SupabaseClient, tenantId, allowedTenantBrandIds: null }),
    ['guest-brands', tenantId],
    { revalidate: 300, tags: [`public-catalog:${tenantId}`] },
  )();
}

/**
 * Cache key for an authenticated buyer's cohort brand allowlist. Buyers in the
 * same cohort(s) resolve to the identical `allowedTenantBrandIds` set (or
 * `null` if unrestricted), so this dedupes the facet query across buyers
 * sharing a cohort rather than caching per-buyer. `allowedTenantBrandIds` is
 * always recomputed live from the buyer's current claims in
 * resolveBuyerProductScopeContext — never itself cached — so a cohort switch
 * or membership edit naturally produces a different key on the next request,
 * with no explicit invalidation needed here.
 */
function cohortCacheKey(allowedTenantBrandIds: string[] | null): string {
  if (allowedTenantBrandIds === null) return 'unrestricted';
  if (allowedTenantBrandIds.length === 0) return 'empty';
  const sorted = [...allowedTenantBrandIds].sort();
  return createHash('sha1').update(sorted.join(',')).digest('hex');
}

/**
 * Cached authenticated-buyer category/brand facets, keyed by tenant + cohort
 * brand allowlist signature. Only used for the default browse (no campaign/
 * share_token override, which are session-specific and never cached) — see
 * app/api/buyer/categories and app/api/buyer/brands routes.
 */
export function fetchCachedBuyerCategories(
  tenantId: string,
  allowedTenantBrandIds: string[] | null,
): Promise<BuyerCategory[]> {
  return unstable_cache(
    () => fetchBuyerCategories({ db: supabaseAdmin as unknown as SupabaseClient, tenantId, allowedTenantBrandIds }),
    ['buyer-categories', tenantId, cohortCacheKey(allowedTenantBrandIds)],
    { revalidate: 300, tags: [`public-catalog:${tenantId}`] },
  )();
}

export function fetchCachedBuyerBrands(
  tenantId: string,
  allowedTenantBrandIds: string[] | null,
): Promise<BuyerBrand[]> {
  return unstable_cache(
    () => fetchBuyerBrands({ db: supabaseAdmin as unknown as SupabaseClient, tenantId, allowedTenantBrandIds }),
    ['buyer-brands', tenantId, cohortCacheKey(allowedTenantBrandIds)],
    { revalidate: 300, tags: [`public-catalog:${tenantId}`] },
  )();
}

export { isPendingBuyerCatalogSession };

export function isCatalogApprovalRequiredForProfile(
  profile: BuyerAccessProfile,
  publicCatalog: PublicCatalogRecord | null,
): boolean {
  return isPendingBuyerCatalogSession(profile) && !publicCatalog;
}

/** Buyer sessions read the live public catalog from the cached per-buyer context; guests/pending read it directly. */
async function loadPublicCatalogForRequest(
  db: SupabaseClient,
  tenantId: string,
  buyerId: string | null,
): Promise<PublicCatalogRecord | null> {
  if (!buyerId) return loadLivePublicCatalog(db, tenantId);
  return (await getBuyerCatalogContext(tenantId, buyerId)).publicCatalog;
}

export async function resolveBuyerCatalogContext(
  db: SupabaseClient,
  request: NextRequest,
  profile: BuyerAccessProfile,
): Promise<{
  tenantId: string;
  buyerId: string | null;
  inventoryWarehouseId: string | null;
  allowedTenantBrandIds: string[] | null;
  visibleCampaigns: BuyerVisibleCatalog[];
  catalogs: BuyerCatalogSummary[];
  guestPricing: GuestPricingContext | null;
  publicCatalog: PublicCatalogRecord | null;
}> {
  const tenantId = profile.context.tenant_id!;
  const pendingBuyerCatalogSession = isPendingBuyerCatalogSession(profile);
  const buyerId = pendingBuyerCatalogSession ? null : (profile.buyer?.id ?? null);
  const isGuestLikePublicBrowse = profile.context.mode === 'guest' || pendingBuyerCatalogSession;
  const publicCatalog = await loadPublicCatalogForRequest(db, tenantId, buyerId);
  const publicBrowseAllowed = !pendingBuyerCatalogSession || publicCatalog?.accessMode === 'public_link';
  const effectivePublicCatalog = publicBrowseAllowed ? publicCatalog : null;
  const [scopeContext, catalogSummary] = await Promise.all([
    resolveBuyerProductScopeContext(db, request, profile, effectivePublicCatalog),
    isGuestLikePublicBrowse
      ? Promise.resolve({ visibleCampaigns: [] as BuyerVisibleCatalog[], catalogs: [] as BuyerCatalogSummary[] })
      : resolveBuyerCatalogSummaries(db, tenantId, buyerId),
  ]);

  return {
    tenantId: scopeContext.tenantId,
    buyerId: scopeContext.buyerId,
    inventoryWarehouseId: scopeContext.inventoryWarehouseId,
    allowedTenantBrandIds: scopeContext.allowedTenantBrandIds,
    visibleCampaigns: catalogSummary.visibleCampaigns,
    catalogs: catalogSummary.catalogs,
    // Already resolved inside resolveBuyerProductScopeContext — don't fetch twice.
    guestPricing: scopeContext.guestPricing,
    publicCatalog: effectivePublicCatalog,
  };
}

export async function resolveBuyerProductScopeContext(
  db: SupabaseClient,
  request: NextRequest,
  profile: BuyerAccessProfile,
  preloadedPublicCatalog?: PublicCatalogRecord | null,
): Promise<{
  tenantId: string;
  buyerId: string | null;
  inventoryWarehouseId: string | null;
  allowedTenantBrandIds: string[] | null;
  guestPricing: GuestPricingContext | null;
  publicCatalog: PublicCatalogRecord | null;
}> {
  const tenantId = profile.context.tenant_id!;
  const pendingBuyerCatalogSession = isPendingBuyerCatalogSession(profile);
  const buyerId = pendingBuyerCatalogSession ? null : (profile.buyer?.id ?? null);
  const isGuestLikePublicBrowse = profile.context.mode === 'guest' || pendingBuyerCatalogSession;
  const publicCatalog = preloadedPublicCatalog === undefined
    ? await loadPublicCatalogForRequest(db, tenantId, buyerId)
    : preloadedPublicCatalog;
  const publicBrowseAllowed = !pendingBuyerCatalogSession || publicCatalog?.accessMode === 'public_link';
  const effectivePublicCatalog = publicBrowseAllowed ? publicCatalog : null;
  const [inventoryWarehouseId, allowedTenantBrandIds, guestPricing] = await Promise.all([
    resolveBuyerInventoryWarehouseId(db, request, profile),
    buyerId ? resolveBuyerAllowedTenantBrandIds(db as any, tenantId, buyerId) : Promise.resolve(null),
    isGuestLikePublicBrowse && effectivePublicCatalog
      ? (
          profile.context.mode === 'guest'
            ? getCachedGuestPricingContext(tenantId)
            : resolveGuestPricingContext(db, tenantId)
        )
      : Promise.resolve(null),
  ]);

  return {
    tenantId,
    buyerId,
    inventoryWarehouseId,
    allowedTenantBrandIds,
    guestPricing,
    publicCatalog: effectivePublicCatalog,
  };
}
