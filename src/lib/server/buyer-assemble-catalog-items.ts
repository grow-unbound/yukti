import type { SupabaseClient } from '@supabase/supabase-js';
import type { BuyerCatalogItem } from '@/types/buyer';
import { enrichBuyerProducts } from '@/lib/server/buyer-product-data';
import { getVisibleBuyerCatalogs } from '@/lib/server/buyer-access';
import { campaignOverridePrice } from '@/lib/server/buyer-campaign-pricing';
import type { GuestPricingContext, PublicCatalogRecord } from '@/lib/server/public-catalog';

type CampaignMapEntry = {
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_valid_until: string | null;
  campaign_price: number | null;
  is_featured?: boolean;
};

/**
 * Builds `BuyerCatalogItem` rows for arbitrary tenant product IDs (e.g. reorder from past orders).
 * Catalog fields are optional when the SKU is not on a published list.
 */
export async function assembleBuyerCatalogItemsForProductIds(
  db: SupabaseClient,
  params: {
    tenantId?: string | null;
    buyerId: string | null;
    productIds: string[];
    allowedTenantBrandIds?: string[] | null;
    campaignId: string | null;
    campaignName: string | null;
    campaignValidUntil: string | null;
    priceOverrides: Map<string, number | null>;
    inventoryWarehouseId?: string | null;
    guestPricing?: GuestPricingContext | null;
    publicCatalog?: PublicCatalogRecord | null;
  },
): Promise<Map<string, BuyerCatalogItem>> {
  const {
    tenantId = null,
    buyerId,
    productIds,
    allowedTenantBrandIds,
    campaignId,
    campaignName,
    campaignValidUntil,
    priceOverrides,
    inventoryWarehouseId = null,
    guestPricing = null,
    publicCatalog = null,
  } = params;
  if (productIds.length === 0) return new Map<string, BuyerCatalogItem>();

  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    const { data: productTenantRows, error } = await db
      .schema('app')
      .from('tenant_products')
      .select('id, tenant_id')
      .in('id', productIds)
      .limit(1);
    if (error) throw new Error(error.message);
    resolvedTenantId = ((productTenantRows ?? [])[0] as { tenant_id?: string } | undefined)?.tenant_id ?? null;
  }

  if (!resolvedTenantId) {
    return new Map<string, BuyerCatalogItem>();
  }

  let campaignByProductId = new Map<string, CampaignMapEntry>(
    productIds.map((productId) => [productId, {
      campaign_id: campaignId,
      campaign_name: campaignName,
      campaign_valid_until: campaignValidUntil,
      campaign_price: priceOverrides.get(productId) ?? null,
    } satisfies CampaignMapEntry]),
  );

  const hasExplicitCampaignContext =
    campaignId != null
    || campaignName != null
    || campaignValidUntil != null
    || priceOverrides.size > 0;

  if (!hasExplicitCampaignContext && buyerId && !guestPricing) {
    const visibleCampaigns = await getVisibleBuyerCatalogs(resolvedTenantId, buyerId);
    if (visibleCampaigns.length > 0) {
      const visibleCampaignIds = visibleCampaigns.map((campaign) => campaign.id);
      const campaignPriority = new Map(visibleCampaignIds.map((id, index) => [id, index]));
      const { data, error } = await db
        .schema('app')
        .from('campaign_items')
        .select('campaign_id, tenant_product_id, price_override, display_order, is_featured')
        .in('campaign_id', visibleCampaignIds)
        .in('tenant_product_id', productIds)
        .is('deleted_at', null);
      if (error) throw new Error(error.message);

      const campaignById = new Map(visibleCampaigns.map((campaign) => [campaign.id, campaign]));
      const rows = ((data ?? []) as Array<{
        campaign_id: string;
        tenant_product_id: string;
        price_override: number | null;
        display_order: number | null;
        is_featured?: boolean | null;
      }>).sort((a, b) => {
        const aHasOverride = campaignOverridePrice(a.price_override) != null ? 0 : 1;
        const bHasOverride = campaignOverridePrice(b.price_override) != null ? 0 : 1;
        if (aHasOverride !== bHasOverride) return aHasOverride - bHasOverride;

        const campaignRank = (campaignPriority.get(a.campaign_id) ?? Number.MAX_SAFE_INTEGER)
          - (campaignPriority.get(b.campaign_id) ?? Number.MAX_SAFE_INTEGER);
        if (campaignRank !== 0) return campaignRank;
        return (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER);
      });

      campaignByProductId = new Map<string, CampaignMapEntry>();
      for (const row of rows) {
        if (campaignByProductId.has(row.tenant_product_id)) continue;
        const campaign = campaignById.get(row.campaign_id);
        if (!campaign) continue;
        campaignByProductId.set(row.tenant_product_id, {
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          campaign_valid_until: campaign.valid_to,
          campaign_price: campaignOverridePrice(row.price_override),
          is_featured: Boolean(row.is_featured),
        });
      }
    } else {
      campaignByProductId = new Map();
    }
  }

  return enrichBuyerProducts(db, {
    tenantId: resolvedTenantId,
    buyerId: guestPricing ? null : buyerId,
    tenantProductIds: productIds,
    allowedTenantBrandIds: guestPricing ? null : allowedTenantBrandIds,
    inventoryWarehouseId,
    campaignByProductId: guestPricing ? new Map() : campaignByProductId,
    guestPricing,
    publicCatalog,
  });
}
