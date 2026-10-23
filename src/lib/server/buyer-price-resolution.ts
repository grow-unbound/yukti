import type { SupabaseClient } from '@supabase/supabase-js';
import { campaignOverridePrice } from '@/lib/server/buyer-campaign-pricing';
import { resolveVisibleCampaignMap } from '@/lib/server/buyer-product-data';
import { getCampaignItemsForProducts } from '@/lib/server/campaign-items-cache';

export type BuyerPricedLine = {
  tenant_product_id: string;
  qty: number;
  unit_price: number;
  gst_rate?: number | null;
  product_name?: string;
};

type PriceRow = { tenant_product_id: string; unit_price: number | string };

/**
 * Re-derives authoritative per-line prices via `app.resolve_prices_batch` — the same
 * RPC used for catalog display — and overwrites any client-supplied `unit_price`.
 * Order/estimate placement must never trust a client-sent price directly.
 * Items are grouped by qty since price can be qty-tiered, mirroring the grouping
 * already used in buyer-product-data.ts's catalog price resolution.
 *
 * Campaign prices are applied per product, exactly like browse/PDP/cart do
 * (`resolveVisibleCampaignMap` = the buyer's visible campaigns, best one per product), so a
 * cart that mixes products from different campaigns is charged what each card quoted.
 * `campaignId` is an explicit campaign the client is ordering from (e.g. a share link) and is
 * checked first. `resolve_prices_batch` only implements steps 2-5 (buyer/cohort/all_buyers
 * price lists, then base_selling_price), so without the campaign layer every campaign-priced
 * item would silently re-price at list price at checkout.
 */
export async function resolveAuthoritativePrices(
  db: SupabaseClient,
  params: { tenantId: string; buyerId: string; items: BuyerPricedLine[]; campaignId?: string | null },
): Promise<{ ok: true; items: BuyerPricedLine[] } | { ok: false; status: number; error: string }> {
  const { buyerId, items, campaignId } = params;

  const campaignPriceMap = new Map<string, number>();
  if (campaignId) {
    // The id is client-supplied (share links): only honour a published, in-window campaign of THIS
    // tenant, never an arbitrary UUID (another tenant's, a draft, an expired one).
    const nowIso = new Date().toISOString();
    const { data: campaignRow, error: campaignError } = await db
      .schema('app')
      .from('campaigns')
      .select('id')
      .eq('id', campaignId)
      .eq('tenant_id', params.tenantId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .lte('valid_from', nowIso)
      .gte('valid_to', nowIso)
      .maybeSingle();
    if (campaignError) throw new Error(campaignError.message);

    if (campaignRow) {
      const campaignItemRows = await getCampaignItemsForProducts(
        db,
        params.tenantId,
        [campaignId],
        items.map((item) => item.tenant_product_id),
      );
      for (const row of campaignItemRows) {
        const override = campaignOverridePrice(row.price_override);
        if (override !== null) {
          campaignPriceMap.set(row.tenant_product_id, override);
        }
      }
    }
  }

  const visibleCampaignMap = await resolveVisibleCampaignMap(db, {
    tenantId: params.tenantId,
    buyerId,
    productIds: [...new Set(items.map((item) => item.tenant_product_id))],
  });

  const grouped = new Map<number, string[]>();
  for (const item of items) {
    const qty = Math.max(1, Number(item.qty ?? 1));
    const bucket = grouped.get(qty) ?? [];
    bucket.push(item.tenant_product_id);
    grouped.set(qty, bucket);
  }

  const priceMap = new Map<string, number>();
  const responses = await Promise.all(
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
  for (const rows of responses) {
    for (const row of rows) {
      priceMap.set(row.tenant_product_id, Number(row.unit_price ?? 0));
    }
  }

  const priced: BuyerPricedLine[] = [];
  for (const item of items) {
    const resolved = campaignPriceMap.get(item.tenant_product_id)
      ?? campaignOverridePrice(visibleCampaignMap.get(item.tenant_product_id)?.campaign_price)
      ?? priceMap.get(item.tenant_product_id);
    if (resolved === undefined || !Number.isFinite(resolved) || resolved <= 0) {
      return {
        ok: false,
        status: 409,
        error: `${item.product_name || 'One item'} could not be priced — it may no longer be available.`,
      };
    }
    priced.push({ ...item, unit_price: resolved });
  }

  return { ok: true, items: priced };
}
