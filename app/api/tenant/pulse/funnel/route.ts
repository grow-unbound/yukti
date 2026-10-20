import { NextRequest } from 'next/server';

import { periodMeta, pulseV2Context } from '@/lib/server/pulse-v2';
import type { PulseFunnelResponse } from '@/types/pulse-v2';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const guard = await pulseV2Context(request, 'pulse_funnel_api');
  if (!guard.ok) return guard.response;
  const { tenantId, period, json, db } = guard.ctx;

  // The activity strip is capped at 92 days; longer windows say so instead of silently shrinking.
  if (period.activityCapped) {
    const body: PulseFunnelResponse = {
      period: periodMeta(period),
      window: { from: period.window.from, to_excl: period.window.toExcl },
      capped: true,
      funnel: null,
      days: [],
      generated_at: new Date().toISOString(),
    };
    return json(body);
  }

  const { data, error } = await db.schema('app').rpc('get_pulse_funnel', {
    p_tenant_id: tenantId,
    p_from: period.window.from,
    p_to_excl: period.window.toExcl,
  });
  if (error) {
    console.error('[GET /api/tenant/pulse/funnel] get_pulse_funnel failed', error);
    return json({ error: 'Failed to load Pulse funnel' }, { status: 500 });
  }
  return json({ period: periodMeta(period), capped: false, ...(data as object) });
}
