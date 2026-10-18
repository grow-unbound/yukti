import { NextRequest } from 'next/server';

import { periodMeta, pulseV2Context } from '@/lib/server/pulse-v2';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const guard = await pulseV2Context(request, 'pulse_patterns_api');
  if (!guard.ok) return guard.response;
  const { tenantId, period, json, db } = guard.ctx;

  const { data, error } = await db.schema('app').rpc('get_pulse_patterns', {
    p_tenant_id: tenantId,
    p_from: period.window.from,
    p_to_excl: period.window.toExcl,
  });
  if (error) {
    console.error('[GET /api/tenant/pulse/patterns] get_pulse_patterns failed', error);
    return json({ error: 'Failed to load Pulse patterns' }, { status: 500 });
  }
  return json({ period: periodMeta(period), ...(data as object) });
}
