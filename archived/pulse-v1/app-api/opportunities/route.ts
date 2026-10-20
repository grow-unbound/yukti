import { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { canAccessPulse, pulseForbiddenResponse } from '@/lib/server/pulse-access';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { loadPulseOpportunities } from '@/lib/server/pulse-core';
import { createTimer } from '@/lib/server-timing';
import type { PulseOpportunitiesResponse } from '@/types/pulse';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: PulseOpportunitiesResponse | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'pulse_opportunities_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulse(claims.role)) return pulseForbiddenResponse();

  const { response, status, error } = await loadPulseOpportunities(claims);
  if (status === 403) return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (status === 500) {
    console.error('[GET /api/tenant/pulse/opportunities] failed', error);
    return timedJson({ error: 'Failed to load Pulse opportunities' }, { status: 500 });
  }
  if (!response) return timedJson({ error: 'Failed to load Pulse opportunities' }, { status: 500 });

  return timedJson(response);
}
