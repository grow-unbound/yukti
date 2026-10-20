import type { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { resolvePulsePeriod, pulsePeriodInputFromSearch, type PulsePeriod } from '@/lib/pulse/period';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { canAccessPulse, pulseForbiddenResponse } from '@/lib/server/pulse-access';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';

type Timer = ReturnType<typeof createTimer>;

export interface PulseV2Context {
  tenantId: string;
  period: PulsePeriod;
  timer: Timer;
  json: (body: unknown, init?: ResponseInit) => Response;
  db: NonNullable<typeof supabaseAdmin>;
}

/**
 * Shared front door for the Pulse v2 band routes: verified seller_admin claim, period parsed from
 * the query string (IST windows, see src/lib/pulse/period.ts). Tenant always comes from the claim, never the client.
 */
export async function pulseV2Context(
  request: NextRequest,
  timingName: string,
): Promise<{ ok: true; ctx: PulseV2Context } | { ok: false; response: Response }> {
  const timer = createTimer();
  const json = (body: unknown, init?: ResponseInit) => jsonWithServerTiming(body as never, timer, timingName, init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return { ok: false, response: json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canAccessPulse(claims.role)) return { ok: false, response: pulseForbiddenResponse() };
  if (!supabaseAdmin) return { ok: false, response: json({ error: 'Server configuration error' }, { status: 500 }) };

  const resolved = resolvePulsePeriod(pulsePeriodInputFromSearch(request.nextUrl.searchParams));
  if (!resolved.ok) return { ok: false, response: json({ error: resolved.error }, { status: 400 }) };

  return { ok: true, ctx: { tenantId: claims.tenant_id, period: resolved.period, timer, json, db: supabaseAdmin } };
}

export function periodMeta(period: PulsePeriod) {
  return { key: period.key, label: period.label, thin: period.thin };
}
