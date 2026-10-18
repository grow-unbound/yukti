import { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { canAccessPulse, pulseForbiddenResponse } from '@/lib/server/pulse-access';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming, parseBoundedLimit, parseRowsOffset } from '@/lib/server/bounded-get';
import { loadPulseOpportunityBuyerPage } from '@/lib/server/pulse-core';
import { createTimer } from '@/lib/server-timing';
import type { PulseOpportunityBuyerPage, PulseOpportunityGroup } from '@/types/pulse';

export const dynamic = 'force-dynamic';

const OPPORTUNITY_IDS = new Set<PulseOpportunityGroup['id']>([
  'valuable_assisted_customers_without_access',
  'dormant_customers_90d',
]);

function parseOpportunityId(value: string): PulseOpportunityGroup['id'] | null {
  return OPPORTUNITY_IDS.has(value as PulseOpportunityGroup['id']) ? value as PulseOpportunityGroup['id'] : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const timer = createTimer();
  const timedJson = (body: PulseOpportunityBuyerPage | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'pulse_opportunity_buyers_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulse(claims.role)) return pulseForbiddenResponse();

  const { id: rawId } = await params;
  const id = parseOpportunityId(rawId);
  if (!id) return timedJson({ error: 'Unknown opportunity group' }, { status: 404 });

  const searchParams = request.nextUrl.searchParams;
  const limit = parseBoundedLimit(searchParams.get('limit'), 20, 50);
  const offset = parseRowsOffset(searchParams.get('cursor'), 5_000);

  const { page, status, error } = await loadPulseOpportunityBuyerPage(claims, id, offset, limit);
  if (status === 403) return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (status === 500) {
    console.error('[GET /api/tenant/pulse/opportunities/[id]/buyers] failed', error);
    return timedJson({ error: 'Failed to load Pulse opportunity buyers' }, { status: 500 });
  }
  if (!page) return timedJson({ error: 'Failed to load Pulse opportunity buyers' }, { status: 500 });

  return timedJson(page);
}
