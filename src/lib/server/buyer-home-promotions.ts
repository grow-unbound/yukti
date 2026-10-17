import type { BuyerHomePromotionsResponse } from '@/lib/buyer-home-types';
import { getVisibleBuyerCatalogs } from '@/lib/server/buyer-access';
import { getBuyerCatalogContext } from '@/lib/server/buyer-catalog-context';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROMOTIONS_PREVIEW_LIMIT = 5;

export async function loadBuyerHomePromotions(
  _db: SupabaseClient,
  tenantId: string,
  buyerId: string,
): Promise<BuyerHomePromotionsResponse> {
  const visibleCatalogs = await getVisibleBuyerCatalogs(tenantId, buyerId);
  // Item counts ride along in the cached per-buyer catalog context (no extra campaign_items query).
  const { itemCountByCampaignId } = await getBuyerCatalogContext(tenantId, buyerId);

  return {
    latest_promotions_preview: visibleCatalogs
      .slice(0, PROMOTIONS_PREVIEW_LIMIT)
      .map((catalog) => ({
        id: catalog.id,
        name: catalog.name,
        product_count: itemCountByCampaignId[catalog.id] ?? 0,
        share_token: catalog.share_token,
        valid_until: catalog.valid_to,
        hero_image_url: catalog.hero_image_url ?? null,
      })),
  };
}
