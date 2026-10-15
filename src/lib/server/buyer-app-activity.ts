import type { SupabaseClient } from '@supabase/supabase-js';

export type BuyerAppActivityEvent =
  | 'session_started'
  | 'home_viewed'
  | 'catalog_viewed'
  | 'activity_viewed'
  | 'estimate_created'
  | 'order_created';

interface RecordBuyerAppActivityInput {
  tenantId: string;
  buyerId: string;
  eventName: BuyerAppActivityEvent | string;
  path?: string | null;
  locationId?: string | null;
  idempotencyKey?: string | null;
  qualifiesForEngagement?: boolean;
  context?: Record<string, unknown>;
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

// View-type events fire on every navigation (~30 per buyer session). Engagement reads them as
// distinct buyer-days, so one row per buyer per event per window carries the same signal. Each
// row costs ~160 ms on the 0.5 GB prod instance (insert + metrics capture triggers + WAL).
const THROTTLED_VIEW_EVENTS = new Set<string>(['catalog_viewed', 'home_viewed', 'activity_viewed']);
const VIEW_EVENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_THROTTLE_ENTRIES = 5000;
const lastViewRecordedAt = new Map<string, number>();

function viewEventBucket(nowMs: number): number {
  return Math.floor(nowMs / VIEW_EVENT_WINDOW_MS);
}

/** True when this instance already recorded the same view event for the buyer in the window. */
function isThrottledViewEvent(input: RecordBuyerAppActivityInput, nowMs: number): boolean {
  if (!THROTTLED_VIEW_EVENTS.has(input.eventName)) return false;
  const key = `${input.tenantId}:${input.buyerId}:${input.eventName}`;
  const last = lastViewRecordedAt.get(key);
  if (last != null && nowMs - last < VIEW_EVENT_WINDOW_MS) return true;
  if (lastViewRecordedAt.size >= MAX_THROTTLE_ENTRIES) lastViewRecordedAt.clear();
  lastViewRecordedAt.set(key, nowMs);
  return false;
}

export async function recordBuyerAppActivitySafe(
  db: Pick<SupabaseClient, 'schema'>,
  input: RecordBuyerAppActivityInput,
) {
  const nowMs = Date.now();
  if (isThrottledViewEvent(input, nowMs)) return;
  // Cross-instance backstop: a stable per-window key makes concurrent lambdas collapse to one row
  // via the (tenant_id, idempotency_key) unique constraint.
  const keyed: RecordBuyerAppActivityInput =
    THROTTLED_VIEW_EVENTS.has(input.eventName) && !input.idempotencyKey
      ? { ...input, idempotencyKey: `view:${input.eventName}:${input.buyerId}:${viewEventBucket(nowMs)}` }
      : input;
  try {
    await recordBuyerAppActivity(db, keyed);
  } catch (error) {
    console.warn('[buyer-app-activity] record failed', error);
  }
}
