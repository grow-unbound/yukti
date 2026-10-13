import type { SupabaseClient } from '@supabase/supabase-js';

import { getVisibleBuyerCatalogs } from '@/lib/server/buyer-access';

function countCartOverlap(campaignProductIds: Set<string>, cartProductIds: string[]): number {
  return cartProductIds.filter((id) => campaignProductIds.has(id)).length;
}

function pickCampaignByMaxOverlap(
  campaignIds: string[],
  productsByCampaign: Map<string, Set<string>>,
  cartProductIds: string[],
): string | null {
  if (campaignIds.length === 0) return null;
  if (campaignIds.length === 1) return campaignIds[0]!;

  let bestId: string | null = null;
  let bestOverlap = 0;
  let tie = false;

  for (const campaignId of campaignIds) {
    const overlap = countCartOverlap(productsByCampaign.get(campaignId) ?? new Set(), cartProductIds);
    if (overlap === 0) continue;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestId = campaignId;
      tie = false;
    } else if (overlap === bestOverlap && bestId !== null) {
      tie = true;
    }
  }

  if (bestOverlap === 0 || tie) return null;
  return bestId;
}

export async function inferCampaignIdForBuyerCart(
  db: SupabaseClient,
  params: {
    tenantId: string;
    buyerId: string;
    clientCampaignId?: string | null;
    tenantProductIds: string[];
  },
): Promise<string | null> {
  if (params.clientCampaignId) {
    // Client-supplied (share links): only trust a published campaign of this tenant, otherwise
    // fall through to inference so a forged id cannot be attributed to the document.
    const { data: owned } = await db
      .schema('app')
      .from('campaigns')
      .select('id')
      .eq('id', params.clientCampaignId)
      .eq('tenant_id', params.tenantId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .maybeSingle();
    if (owned) return params.clientCampaignId;
  }

  const productIds = [...new Set(params.tenantProductIds.filter(Boolean))];
  if (productIds.length === 0) return null;

  const { data: itemRows, error } = await db
    .schema('app')
    .from('campaign_items')
    .select('campaign_id, tenant_product_id')
    .in('tenant_product_id', productIds)
    .is('deleted_at', null);

  if (error || !itemRows?.length) return null;

  const productsByCampaign = new Map<string, Set<string>>();
  for (const row of itemRows as Array<{ campaign_id: string; tenant_product_id: string }>) {
    if (!productsByCampaign.has(row.campaign_id)) {
      productsByCampaign.set(row.campaign_id, new Set());
    }
    productsByCampaign.get(row.campaign_id)?.add(row.tenant_product_id);
  }

  const overlappingCampaignIds = [...productsByCampaign.entries()]
    .filter(([, productSet]) => countCartOverlap(productSet, productIds) >= 1)
    .map(([campaignId]) => campaignId);

  if (overlappingCampaignIds.length === 0) return null;

  const visibleCampaigns = await getVisibleBuyerCatalogs(params.tenantId, params.buyerId);
  const visibleIds = new Set(visibleCampaigns.map((campaign) => campaign.id));
  const eligible = overlappingCampaignIds.filter((id) => visibleIds.has(id));

  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0]!;

  return pickCampaignByMaxOverlap(eligible, productsByCampaign, productIds);
}
