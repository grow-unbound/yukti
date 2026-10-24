import { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import type { CustomersLandingMetricsV4 } from '@/lib/customers-landing-v4-types';
import { getFlag } from '@/lib/flags';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { emptyCustomersLandingMetricsV4 } from '@/lib/server/customers-landing-metrics';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: CustomersLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'customers_metrics_api', init, APP_GET_CACHE_CONTROL);

  try {
    const claims = await getVerifiedClaims(req);
    if (!claims.tenant_id) {
      return timedJson({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!claims.role?.startsWith('seller_')) {
      return timedJson({ error: 'Forbidden' }, { status: 403 });
    }

    const flagEnabled = await getFlag('df_customer_master', claims.tenant_id);
    if (!flagEnabled) {
      return timedJson({ error: 'Feature not enabled' }, { status: 403 });
    }

    if (!supabaseAdmin) {
      return timedJson({ error: 'Server configuration error' }, { status: 500 });
    }

    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'customers',
      p_period_key: 'this_quarter',
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/customers/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch customers metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') {
      return timedJson(emptyCustomersLandingMetricsV4());
    }

    const payload = data as CustomersLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/customers/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
