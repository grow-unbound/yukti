import { NextRequest } from 'next/server';

import type { CohortsLandingMetricsV4 } from '@/hooks/useCohorts';
import { getVerifiedClaims } from '@/lib/auth';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { assertSellerAdmin } from '@/lib/server/seller-auth';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function emptyCohortsLandingMetricsV4(): CohortsLandingMetricsV4 {
  return {
    page_key: 'customer_groups',
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
  const timedJson = (body: CohortsLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'cohorts_metrics_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  const adminCheck = assertSellerAdmin(claims);
  if (!adminCheck.ok) {
    return timedJson({ error: adminCheck.status === 401 ? 'Unauthorized' : 'Forbidden' }, { status: adminCheck.status });
  }
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  try {
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'customer_groups',
      p_period_key: 'this_quarter',
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/cohorts/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch customer group metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') {
      return timedJson(emptyCohortsLandingMetricsV4());
    }

    const payload = data as CohortsLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/cohorts/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
