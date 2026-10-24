import { NextRequest } from 'next/server';

import type { BuyerAppLandingMetricsV4 } from '@/hooks/useBuyerApp';
import { getVerifiedClaims } from '@/lib/auth';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function emptyBuyerAppLandingMetricsV4(): BuyerAppLandingMetricsV4 {
  return {
    page_key: 'buyer_app',
    period: {
      period_key: 'this_quarter',
      grain: 'quarter',
      period_start: '',
      period_end_exclusive: '',
      label: 'This Quarter',
    },
    computed_at: null,
    source_watermark: null,
    cards: [],
  };
}

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: BuyerAppLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'buyer_app_metrics_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  try {
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'buyer_app',
      p_period_key: 'this_quarter',
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/buyer-app/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch buyer app metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') {
      return timedJson(emptyBuyerAppLandingMetricsV4());
    }

    const payload = data as BuyerAppLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/buyer-app/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
