import { NextRequest, NextResponse } from 'next/server';

import { assembleBuyerCatalogItemsForProductIds } from '@/lib/server/buyer-assemble-catalog-items';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { resolveBuyerAllowedTenantBrandIds } from '@/lib/server/buyer-brand-visibility';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import { getCachedGuestPricingContext, loadLivePublicCatalog } from '@/lib/server/public-catalog';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerProductPageRecos } from '@/lib/buyer-home-types';

const EMPTY: BuyerProductPageRecos = { co_order: [], co_buyer: [], same_category: [] };

export async function GET(request: NextRequest): Promise<NextResponse<BuyerProductPageRecos | { error: string }>> {
  const profile = await requireBuyerAccessProfile(request, { slim: true });
  if (!profile?.context.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const productId = request.nextUrl.searchParams.get('product_id');
  if (!productId) {
    return NextResponse.json({ error: 'product_id required' }, { status: 400 });
  }

  const tenantId = profile.context.tenant_id!;
  const pendingBuyerCatalogSession =
    profile.context.mode !== 'preview'
    && (profile.context.role === 'buyer_pending' || profile.buyer?.buyer_app_enabled === false);
  const buyerId = pendingBuyerCatalogSession ? null : (profile.buyer?.id ?? null);
  const isGuestLikePublicBrowse = profile.context.mode === 'guest' || pendingBuyerCatalogSession;

  try {
    if (pendingBuyerCatalogSession) {
      const publicCatalog = await loadLivePublicCatalog(supabaseAdmin, tenantId);
      if (publicCatalog?.accessMode !== 'public_link') {
        return NextResponse.json({ error: 'Approval required' }, {
          status: 403,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
    }

    const [allowedTenantBrandIds, guestPricing] = await Promise.all([
      // null (not []) for guest/no-cohort — an empty array means "allow zero
      // brands" to enrichBuyerProducts and would zero out every result.
      buyerId ? resolveBuyerAllowedTenantBrandIds(supabaseAdmin as any, tenantId, buyerId) : Promise.resolve(null),
      isGuestLikePublicBrowse ? getCachedGuestPricingContext(tenantId) : Promise.resolve(null),
    ]);

    // Only same_category is ever rendered on the PDP (co_order/"Frequently Bought
    // Together" was dropped, co_buyer was fetched but never rendered anywhere) —
    // asking the RPC for widgets nobody sees just wastes the query and the
    // enrichment pass below.
    const recoRes = await supabaseAdmin
      .schema('app')
      .rpc('reco_get_product_page', {
        p_tenant_id: tenantId,
        p_tenant_product_id: productId,
        p_buyer_id: buyerId,
        p_widget_types: ['same_category'],
        p_limit: 8,
      });

    if (recoRes.error) throw new Error(recoRes.error.message);

    const recoData = recoRes.data as {
      same_category?: string[];
    } | null;

    if (!recoData) return NextResponse.json(EMPTY, { headers: BUYER_CACHE_PRICED });

    const allIds = Array.from(new Set(recoData.same_category ?? []));

    const enriched =
      allIds.length > 0
        ? await assembleBuyerCatalogItemsForProductIds(supabaseAdmin as any, {
            tenantId,
            buyerId,
            productIds: allIds,
            allowedTenantBrandIds,
            campaignId: null,
            campaignName: null,
            campaignValidUntil: null,
            priceOverrides: new Map(),
            guestPricing,
          })
        : new Map<string, import('@/types/buyer').BuyerCatalogItem>();

    const hydrate = (ids: string[] = []) =>
      ids.map((id) => enriched.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));

    return NextResponse.json({
      co_order: [],
      co_buyer: [],
      same_category: hydrate(recoData.same_category),
    }, { headers: BUYER_CACHE_PRICED });
  } catch (error) {
    console.error('[GET /api/buyer/recommendations]', error);
    // Recommendations are non-critical — return empty rather than 500
    return NextResponse.json(EMPTY, { headers: BUYER_CACHE_PRICED });
  }
}
