import { getPostHogClient } from '@/lib/posthog-server';

export type WhatsAppInboxServerEvent = 'whatsapp_reply_submitted' | 'whatsapp_entry_first_opened';

type Scalar = string | number | boolean | null;

/** Whole seconds between an ISO timestamp and now; null when missing, invalid or in the future. */
export function secondsSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at) || at > now) return null;
  return Math.round((now - at) / 1000);
}

/**
 * Fire-and-forget product analytics for the WhatsApp Today inbox. Only ids,
 * enums and counts are accepted (no message text, phones or error bodies) and
 * a PostHog problem never affects the request.
 */
export function captureWhatsAppInboxEvent(
  event: WhatsAppInboxServerEvent,
  tenantId: string,
  actorUserId: string | null,
  properties: Record<string, Scalar | undefined>,
): void {
  try {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    const safe: Record<string, Scalar> = { tenant_id: tenantId, source: 'whatsapp_inbox' };
    for (const [key, value] of Object.entries(properties)) {
      if (value !== undefined) safe[key] = value;
    }
    getPostHogClient().capture({
      distinctId: actorUserId ?? tenantId,
      event,
      properties: safe,
    });
  } catch (error) {
    console.warn('[whatsapp-inbox-analytics] capture failed (non-blocking)', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
