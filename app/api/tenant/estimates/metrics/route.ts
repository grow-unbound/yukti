import { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';
import { parseSellerLandingPeriod, type SellerLandingPeriod } from '@/lib/seller-period';
import type { EstimatesLandingMetricsV4 } from '@/types/tenant-estimates';

export const dynamic = 'force-dynamic';

const PERIOD_KEY_BY_SELLER_PERIOD: Record<SellerLandingPeriod, string> = {
  today: 'today',
  week: 'this_week',
  month: 'this_month',
  quarter: 'this_quarter',
  year: 'this_quarter',
  last90: 'this_month',
};

function emptyEstimatesLandingMetricsV4(periodKey = 'this_month'): EstimatesLandingMetricsV4 {
  return {
    page_key: 'estimates',
    period: {
      period_key: periodKey,
      grain: periodKey === 'today' ? 'day' : periodKey === 'this_week' ? 'week' : periodKey === 'this_quarter' ? 'quarter' : 'month',
      period_start: '',
      period_end_exclusive: '',
      label: periodKey === 'this_quarter' ? 'This Quarter' : periodKey === 'this_week' ? 'This Week' : periodKey === 'today' ? 'Today' : 'This Month',
    },
    computed_at: null,
    source_watermark: null,
    cards: [],
  };
}

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: EstimatesLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'estimates_metrics_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  const sellerPeriod = parseSellerLandingPeriod(request.nextUrl.searchParams.get('period'));
  const periodKey = PERIOD_KEY_BY_SELLER_PERIOD[sellerPeriod] ?? 'this_month';

  try {
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'estimates',
      p_period_key: periodKey,
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/estimates/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch estimates metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') {
      return timedJson(emptyEstimatesLandingMetricsV4(periodKey));
    }

    const payload = data as EstimatesLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/estimates/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
