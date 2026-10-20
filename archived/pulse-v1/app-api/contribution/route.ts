import { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { canAccessPulse, pulseForbiddenResponse } from '@/lib/server/pulse-access';
import { createTimer } from '@/lib/server-timing';
import { landingMetricsToPulseContribution } from '@/lib/server/pulse-core';
import { supabaseAdmin } from '@/lib/supabase';
import type { PulseContributionResponse } from '@/types/pulse';
import type { SellerDashboardMetricsV4 } from '@/types/seller-dashboard';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: PulseContributionResponse | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'pulse_contribution_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulse(claims.role)) return pulseForbiddenResponse();
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  try {
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_metrics_v4', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'buyer_app',
      p_period_key: 'this_quarter',
      p_scope_kind: 'tenant',
      p_scope_id: null,
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/pulse/contribution] get_landing_metrics_v4 failed', error);
      return timedJson({ error: 'Failed to load Pulse contribution' }, { status: 500 });
    }

    return timedJson(landingMetricsToPulseContribution(data as SellerDashboardMetricsV4 | null));
  } catch (error) {
    console.error('[GET /api/tenant/pulse/contribution] unexpected metrics error', error);
    return timedJson({ error: 'Failed to load Pulse contribution' }, { status: 500 });
  }
}
