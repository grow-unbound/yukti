import { NextRequest, NextResponse } from 'next/server';

import type { BuyerHomeMetricsV4 } from '@/lib/buyer-home-types';
import { emptyBuyerHomeMetricsV4 } from '@/lib/server/buyer-home-metrics';
import { recordBuyerAppActivitySafe } from '@/lib/server/buyer-app-activity';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { isPendingBuyerCatalogSession } from '@/lib/server/buyer-pending-guard';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  request: NextRequest,
): Promise<NextResponse<BuyerHomeMetricsV4 | { error: string }>> {
  try {
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Pending / access-disabled sessions get the empty (zeroed) payload, never real metrics.
    if (isPendingBuyerCatalogSession(profile) || !profile.buyer?.id) {
      return NextResponse.json(emptyBuyerHomeMetricsV4(), { headers: BUYER_CACHE_PERSONAL });
    }

    const tenantId = profile.context.tenant_id;
    const buyerId = profile.buyer.id;

    void recordBuyerAppActivitySafe(supabaseAdmin, {
      tenantId,
      buyerId,
      eventName: 'home_viewed',
      path: request.nextUrl.pathname,
    });

    const { data, error } = await supabaseAdmin
      .schema('app')
      .rpc('get_buyer_home_metrics_v4', {
        p_tenant_id: tenantId,
        p_buyer_id: buyerId,
        p_as_of: new Date().toISOString(),
      });

    if (error) {
      throw new Error(error.message ?? 'Failed to load buyer home metrics');
    }

    return NextResponse.json(data as BuyerHomeMetricsV4, { headers: BUYER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/buyer/home/metrics]', error);
    return NextResponse.json({ error: 'Failed to load buyer home metrics' }, { status: 500 });
  }
}
