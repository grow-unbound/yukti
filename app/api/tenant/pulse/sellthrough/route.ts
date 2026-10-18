import { NextRequest } from 'next/server';

import { periodMeta, pulseV2Context } from '@/lib/server/pulse-v2';
import type { PulseSellDimension, PulseSellThroughResponse } from '@/types/pulse-v2';

export const dynamic = 'force-dynamic';

const DIMENSIONS: PulseSellDimension[] = ['category', 'brand', 'product'];

export async function GET(request: NextRequest) {
  const guard = await pulseV2Context(request, 'pulse_sellthrough_api');
  if (!guard.ok) return guard.response;
  const { tenantId, period, json, db } = guard.ctx;

  const requested = request.nextUrl.searchParams.get('by') as PulseSellDimension | null;
  const dimension = requested && DIMENSIONS.includes(requested) ? requested : 'category';

  // Line-level reads are capped at 92 days like the activity funnel; longer windows say so instead of shrinking.
  if (period.activityCapped) {
    const body: PulseSellThroughResponse = {
      period: periodMeta(period),
      window: { from: period.window.from, to_excl: period.window.toExcl },
      dimension,
      capped: true,
      rows: [],
      totals: null,
      generated_at: new Date().toISOString(),
    };
    return json(body);
  }

  const { data, error } = await db.schema('app').rpc('get_pulse_sellthrough', {
    p_tenant_id: tenantId,
    p_from: period.window.from,
    p_to_excl: period.window.toExcl,
    p_dimension: dimension,
    p_limit: dimension === 'product' ? 10 : 8,
  });
  if (error) {
    console.error('[GET /api/tenant/pulse/sellthrough] get_pulse_sellthrough failed', error);
    return json({ error: 'Failed to load Pulse sell-through' }, { status: 500 });
  }
  return json({ period: periodMeta(period), capped: false, ...(data as object) });
}
