import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { captureBuyerServerActivity } from '@/lib/server/buyer-posthog-events';

export type BuyerAppActivityEvent =
  | 'session_started'
  | 'home_viewed'
  | 'catalog_viewed'
  | 'activity_viewed';

interface RecordBuyerAppActivityInput {
  tenantId: string;
  buyerId: string;
  eventName: BuyerAppActivityEvent | string;
  path?: string | null;
  locationId?: string | null;
  idempotencyKey?: string | null;
  qualifiesForEngagement?: boolean;
  context?: Record<string, unknown>;
  /** Optional: lets the PostHog mirror reuse the browser distinct id. */
  request?: NextRequest | null;
  /** Optional server-resolved role for the PostHog mirror (falls back to context.role). */
  role?: string | null;
}

export async function recordBuyerAppActivity(
  db: Pick<SupabaseClient, 'schema'>,
  input: RecordBuyerAppActivityInput,
) {
  const { error } = await db.schema('app').rpc('record_buyer_app_activity', {
    p_tenant_id: input.tenantId,
    p_buyer_id: input.buyerId,
    p_event_name: input.eventName,
    p_location_id: input.locationId ?? null,
    p_metadata: {
      ...(input.context ?? {}),
      path: input.path ?? null,
    },
    p_idempotency_key: input.idempotencyKey ?? null,
    p_qualifies_for_engagement: input.qualifiesForEngagement ?? true,
  });

  if (error) {
    throw new Error(error.message ?? 'Failed to record buyer app activity');
  }
}

// Presence ledger: one row per buyer per event per IST day. Presence events fire on every
// navigation (~30 per buyer session), and every reader (DAU/WAU/MAU, funnel, last seen) works at
// buyer-day grain. Estimates/orders are NOT recorded here: they live in `estimates`/`orders`
// (`is_buyer_app_*`) and engagement readers union them in. The RPC keeps the first write of the day
// (ON CONFLICT DO NOTHING), so a duplicate costs no row rewrite or WAL.
const PRESENCE_EVENTS = new Set<string>(['session_started', 'home_viewed', 'catalog_viewed', 'activity_viewed']);
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_THROTTLE_ENTRIES = 5000;
const lastPresenceRecordedDay = new Map<string, string>();

/** IST calendar day (YYYY-MM-DD) for the given epoch ms; matches `occurred_day` in the RPC. */
function istDay(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True when this instance already recorded the same presence event for the buyer today (IST). */
function isThrottledPresenceEvent(input: RecordBuyerAppActivityInput, day: string): boolean {
  if (!PRESENCE_EVENTS.has(input.eventName)) return false;
  const key = `${input.tenantId}:${input.buyerId}:${input.eventName}`;
  if (lastPresenceRecordedDay.get(key) === day) return true;
  if (lastPresenceRecordedDay.size >= MAX_THROTTLE_ENTRIES) lastPresenceRecordedDay.clear();
  lastPresenceRecordedDay.set(key, day);
  return false;
}

// Mirrors the two events the PostHog parity check (S0) needs. Kept separate from the DB write so it
// survives when request-path writes to app.buyer_app_activity are retired.
function mirrorToPostHog(input: RecordBuyerAppActivityInput) {
  if (input.eventName !== 'catalog_viewed' && input.eventName !== 'session_started') return;
  const ctxRole = input.context?.role;
  captureBuyerServerActivity({
    request: input.request,
    event: input.eventName,
    tenantId: input.tenantId,
    buyerId: input.buyerId,
    role: input.role ?? (typeof ctxRole === 'string' ? ctxRole : null),
    path: input.path,
    context: input.eventName === 'catalog_viewed' ? input.context : { principal_type: input.context?.principal_type, source: input.context?.source },
  });
}

export async function recordBuyerAppActivitySafe(
  db: Pick<SupabaseClient, 'schema'>,
  input: RecordBuyerAppActivityInput,
) {
  mirrorToPostHog(input);
  const day = istDay(Date.now());
  if (isThrottledPresenceEvent(input, day)) return;
  // Cross-instance backstop: a stable per-day key makes concurrent lambdas collapse to one row via
  // the (tenant_id, idempotency_key) unique constraint (DO NOTHING on conflict).
  const keyed: RecordBuyerAppActivityInput =
    PRESENCE_EVENTS.has(input.eventName) && !input.idempotencyKey
      ? { ...input, idempotencyKey: `d:${input.eventName}:${input.buyerId}:${day}` }
      : input;
  try {
    await recordBuyerAppActivity(db, keyed);
  } catch (error) {
    console.warn('[buyer-app-activity] record failed', error);
  }
}
