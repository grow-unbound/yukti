import type { SupabaseClient } from '@supabase/supabase-js';
import { unstable_cache } from 'next/cache';

import { buyerContextTenantTag } from '@/lib/server/buyer-context-cache';

/**
 * Live items of ONE campaign, cached per (tenant, campaign). Buyer catalog pages used to ask
 * PostgREST for `campaign_items WHERE campaign_id IN (...) AND tenant_product_id IN (<page ids>)` on
 * every page, i.e. one query shape per page; a whole campaign is a few hundred small rows, so one
 * cached read per campaign serves every page and every buyer of the tenant.
 *
 * Tagged with the tenant's buyer-context tag, which seller campaign/catalog/cohort writers already
 * revalidate (revalidateBuyerContext). Writers outside Next (sync, pg_cron) fall back to the TTL.
 */
export interface CachedCampaignItem {
  campaign_id: string;
  tenant_product_id: string;
  price_override: number | string | null;
  display_order: number | null;
  is_featured: boolean | null;
}

const CAMPAIGN_ITEMS_REVALIDATE_SECONDS = 60;
// Safety cap (data-fetching rule); the largest live campaign is ~340 items. PostgREST max-rows is 1000.
const CAMPAIGN_ITEMS_LIMIT = 1000;

// Cached results are shared across callers, so `db` MUST be the service-role admin client (never a
// request-bound/user client whose RLS view would leak into the shared cache entry).

export function getCampaignItemsCached(
  db: SupabaseClient,
  tenantId: string,
  campaignId: string,
): Promise<CachedCampaignItem[]> {
  return unstable_cache(
    async () => {
      const { data, error } = await db
        .schema('app')
        .from('campaign_items')
        .select('campaign_id, tenant_product_id, price_override, display_order, is_featured')
        .eq('campaign_id', campaignId)
        .is('deleted_at', null)
        .limit(CAMPAIGN_ITEMS_LIMIT);
      if (error) throw new Error(error.message);
      if ((data?.length ?? 0) >= CAMPAIGN_ITEMS_LIMIT) {
        console.error('[campaign-items-cache] campaign hit the row cap; items beyond it lose their overrides', campaignId);
      }
      return (data ?? []) as CachedCampaignItem[];
    },
    ['campaign-items', tenantId, campaignId],
    { revalidate: CAMPAIGN_ITEMS_REVALIDATE_SECONDS, tags: [buyerContextTenantTag(tenantId)] },
  )();
}

/**
 * Items of several campaigns narrowed to the given products. Cached by default (display paths);
 * `fresh: true` reads the DB directly for authoritative pricing (order/estimate totals must never
 * bill a price override that a seller changed within the cache TTL).
 */
export async function getCampaignItemsForProducts(
  db: SupabaseClient,
  tenantId: string,
  campaignIds: readonly string[],
  productIds: readonly string[],
  opts: { fresh?: boolean } = {},
): Promise<CachedCampaignItem[]> {
  if (opts.fresh) {
    const { data, error } = await db
      .schema('app')
      .from('campaign_items')
      .select('campaign_id, tenant_product_id, price_override, display_order, is_featured')
      .in('campaign_id', [...campaignIds])
      .in('tenant_product_id', [...productIds])
      .is('deleted_at', null)
      .limit(CAMPAIGN_ITEMS_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []) as CachedCampaignItem[];
  }
  const wanted = new Set(productIds);
  const perCampaign = await Promise.all(
    campaignIds.map((campaignId) => getCampaignItemsCached(db, tenantId, campaignId)),
  );
  return perCampaign.flat().filter((item) => wanted.has(item.tenant_product_id));
}
