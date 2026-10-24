import { NextRequest } from 'next/server';

import type { CatalogsLandingMetricsV4 } from '@/hooks/useCatalogs';
import { getVerifiedClaims } from '@/lib/auth';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { assertSellerAdmin } from '@/lib/server/seller-auth';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function emptyCatalogsLandingMetricsV4(): CatalogsLandingMetricsV4 {
  return {
    page_key: 'campaigns',
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
  const timedJson = (body: CatalogsLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'catalogs_metrics_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  const adminCheck = assertSellerAdmin(claims);
  if (!adminCheck.ok) {
    return timedJson({ error: adminCheck.status === 401 ? 'Unauthorized' : 'Forbidden' }, { status: adminCheck.status });
  }
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  try {
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'campaigns',
      p_period_key: 'this_quarter',
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/catalogs/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch campaign metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') {
      return timedJson(emptyCatalogsLandingMetricsV4());
    }

    const payload = data as CatalogsLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/catalogs/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
