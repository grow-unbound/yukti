import { NextRequest, NextResponse } from 'next/server';

import { assembleBuyerCatalogItemsForProductIds } from '@/lib/server/buyer-assemble-catalog-items';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { resolveBuyerAllowedTenantBrandIds } from '@/lib/server/buyer-brand-visibility';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import { guardPendingBuyerCatalogAccess } from '@/lib/server/buyer-pending-guard';
import { getCachedGuestPricingContext } from '@/lib/server/public-catalog';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerCatalogItem } from '@/types/buyer';

export const dynamic = 'force-dynamic';

const LIMIT = 8;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<BuyerCatalogItem[] | { error: string }>> {
  const profile = await requireBuyerAccessProfile(request, { slim: true });
  if (!profile?.context.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { id: categoryId } = await params;
  const tenantId = profile.context.tenant_id!;
  const gate = await guardPendingBuyerCatalogAccess(supabaseAdmin as any, profile);
  if (gate.blocked) return gate.blocked as NextResponse<{ error: string }>;
  const buyerId = gate.pending ? null : (profile.buyer?.id ?? null);
  const isGuest = profile.context.mode === 'guest';

  try {
    const { data: rpcData, error: rpcErr } = await supabaseAdmin
      .schema('app')
      .rpc('reco_get_bestsellers', {
        p_tenant_id: tenantId,
        p_category_id: categoryId,
        p_limit: LIMIT,
      });

    if (rpcErr) throw new Error(rpcErr.message);

    const rows = (rpcData as { tenant_product_id: string }[] | null) ?? [];
    if (rows.length === 0) return NextResponse.json([], { headers: BUYER_CACHE_PRICED });

    const productIds = rows.map((r) => r.tenant_product_id);

    const [allowedTenantBrandIds, guestPricing] = await Promise.all([
      buyerId ? resolveBuyerAllowedTenantBrandIds(supabaseAdmin as any, tenantId, buyerId) : Promise.resolve(null),
      gate.pending
        ? Promise.resolve(gate.guestPricing)
        : isGuest ? getCachedGuestPricingContext(tenantId) : Promise.resolve(null),
    ]);

    const enriched = await assembleBuyerCatalogItemsForProductIds(supabaseAdmin as any, {
      tenantId,
      buyerId,
      productIds,
      allowedTenantBrandIds,
      campaignId: null,
      campaignName: null,
      campaignValidUntil: null,
      priceOverrides: new Map(),
      guestPricing,
    });

    // Return in RPC's weighted_score order
    const items = productIds.map((id) => enriched.get(id)).filter((x): x is BuyerCatalogItem => x != null);

    return NextResponse.json(items, { headers: BUYER_CACHE_PRICED });
  } catch (error) {
    console.error('[GET /api/buyer/reco/category]', error);
    return NextResponse.json([]);
  }
}
