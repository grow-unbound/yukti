import { NextRequest } from 'next/server';

import { parseBoundedLimit, parseRowsOffset } from '@/lib/server/bounded-get';
import { pulseV2Context } from '@/lib/server/pulse-v2';
import type { PulseActBuyersPage, PulseActGroupId, PulseActRow } from '@/types/pulse-v2';

export const dynamic = 'force-dynamic';

const GROUPS: PulseActGroupId[] = ['quotes_waiting', 'browse_no_quote', 'went_quiet', 'valuable_without_access'];

export async function GET(request: NextRequest, context: { params: Promise<{ group: string }> }) {
  const guard = await pulseV2Context(request, 'pulse_act_now_buyers_api');
  if (!guard.ok) return guard.response;
  const { tenantId, period, json, db } = guard.ctx;

  const { group } = await context.params;
  if (!GROUPS.includes(group as PulseActGroupId)) return json({ error: 'Not found' }, { status: 404 });

  const limit = parseBoundedLimit(request.nextUrl.searchParams.get('limit'), 25, 50);
  const offset = parseRowsOffset(request.nextUrl.searchParams.get('offset'));

  const { data, error } = await db.schema('app').rpc('get_pulse_opportunity_buyers', {
    p_tenant_id: tenantId,
    p_group: group,
    p_from: period.window.from,
    p_to_excl: period.window.toExcl,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    console.error('[GET /api/tenant/pulse/act-now/[group]] get_pulse_opportunity_buyers failed', error);
    return json({ error: 'Failed to load Pulse customers' }, { status: 500 });
  }

  const payload = data as { id: PulseActGroupId; total: number; value: number; rows: PulseActRow[] };
  const nextOffset = offset + payload.rows.length;
  const page: PulseActBuyersPage = {
    id: payload.id,
    total: payload.total,
    value: payload.value,
    rows: payload.rows,
    nextOffset: payload.rows.length > 0 && nextOffset < payload.total ? nextOffset : null,
  };
  return json(page);
}
