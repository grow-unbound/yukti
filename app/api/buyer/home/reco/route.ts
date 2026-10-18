import { NextRequest, NextResponse } from 'next/server';

import type { BuyerHomeRecoResponse } from '@/lib/buyer-home-types';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { loadBuyerHomeReco, loadGuestHomeReco } from '@/lib/server/buyer-home-reco';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import { loadLivePublicCatalog } from '@/lib/server/public-catalog';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  request: NextRequest,
): Promise<NextResponse<BuyerHomeRecoResponse | { error: string }>> {
  try {
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const pendingBuyerCatalogSession =
      profile.context.mode !== 'preview'
      && (profile.context.role === 'buyer_pending' || profile.buyer?.buyer_app_enabled === false);
    if (pendingBuyerCatalogSession) {
      const publicCatalog = await loadLivePublicCatalog(supabaseAdmin, profile.context.tenant_id);
      if (publicCatalog?.accessMode !== 'public_link') {
        return NextResponse.json({ error: 'Approval required' }, {
          status: 403,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
      const payload = await loadGuestHomeReco(supabaseAdmin, profile.context.tenant_id);
      return NextResponse.json(payload, { headers: BUYER_CACHE_PRICED });
    }

    if (!profile.buyer?.id) {
      if (profile.context.mode === 'guest') {
        const payload = await loadGuestHomeReco(supabaseAdmin, profile.context.tenant_id);
        return NextResponse.json(payload, { headers: BUYER_CACHE_PRICED });
      }
      const previewPayload: BuyerHomeRecoResponse = {
        order_again_preview: [],
        bestsellers: [],
        preview_message: 'Preview mode — buyer-specific numbers show as 0.',
      };
      return NextResponse.json(previewPayload, { headers: BUYER_CACHE_PRICED });
    }

    const payload = await loadBuyerHomeReco(
      supabaseAdmin,
      profile.context.tenant_id,
      profile.buyer.id,
    );

    return NextResponse.json(payload, { headers: BUYER_CACHE_PRICED });
  } catch (error) {
    console.error('[GET /api/buyer/home/reco]', error);
    return NextResponse.json({ error: 'Failed to load buyer home reco' }, { status: 500 });
  }
}
