import { NextRequest } from 'next/server';

import type { PriceListsLandingMetricsV4 } from '@/hooks/usePriceLists';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function emptyPriceListsLandingMetricsV4(): PriceListsLandingMetricsV4 {
  return {
    page_key: 'price_lists',
    period: {
      period_key: 'now',
      grain: 'now',
      period_start: '',
      period_end_exclusive: '',
      label: 'Now',
    },
    computed_at: null,
    source_watermark: null,
    cards: [],
  };
}

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: PriceListsLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'price_lists_metrics_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  const flagEnabled = await getFlag('df_pricing_engine', claims.tenant_id);
  if (!flagEnabled) return timedJson({ error: 'Feature not enabled' }, { status: 403 });

  try {
    // KPI snapshot is keyed by period_key='now' (not 'this_month') -- price lists are a
    // point-in-time set, not a time-windowed metric. Written by
    // app._metrics_v4_refresh_landing_kpis's 'price_lists' block (page_key='price_lists',
    // grain='now') on the same periodic tick as every other v4 landing page.
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'price_lists',
      p_period_key: 'now',
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/price-lists/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch price lists metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') {
      return timedJson(emptyPriceListsLandingMetricsV4());
    }

    const payload = data as PriceListsLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/price-lists/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
