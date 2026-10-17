import { NextRequest, NextResponse } from 'next/server';

import type { BuyerHomePromotionsResponse } from '@/lib/buyer-home-types';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { loadBuyerHomePromotions } from '@/lib/server/buyer-home-promotions';
import { BUYER_CACHE_CATALOG } from '@/lib/server/buyer-cache-headers';
import { isPendingBuyerCatalogSession } from '@/lib/server/buyer-pending-guard';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  request: NextRequest,
): Promise<NextResponse<BuyerHomePromotionsResponse | { error: string }>> {
  try {
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Buyer-scoped promotions are never exposed to a pending / access-disabled session.
    if (isPendingBuyerCatalogSession(profile)) {
      const pendingPayload: BuyerHomePromotionsResponse = { latest_promotions_preview: [] };
      return NextResponse.json(pendingPayload, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    if (!profile.buyer?.id) {
      const previewPayload: BuyerHomePromotionsResponse = {
        latest_promotions_preview: [],
        preview_message: 'Preview mode — buyer-specific numbers show as 0.',
      };
      return NextResponse.json(previewPayload, { headers: BUYER_CACHE_CATALOG });
    }

    const payload = await loadBuyerHomePromotions(
      supabaseAdmin,
      profile.context.tenant_id,
      profile.buyer.id,
    );

    return NextResponse.json(payload, { headers: BUYER_CACHE_CATALOG });
  } catch (error) {
    console.error('[GET /api/buyer/home/promotions]', error);
    return NextResponse.json({ error: 'Failed to load buyer home promotions' }, { status: 500 });
  }
}
