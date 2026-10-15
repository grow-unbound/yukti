// Product analytics for the WhatsApp Today inbox, emitted from edge functions.
// Pure helpers + a fire-and-forget PostHog capture. No message content, phone
// numbers or provider error bodies ever go into an event: only ids, enums and
// counts. Capture failures never affect message processing.

export type WhatsAppInboxEdgeEvent =
  | 'whatsapp_inbound_captured'
  | 'whatsapp_reply_sent'
  | 'whatsapp_reply_failed';

export type ReplyFailureClass = 'credentials' | 'provider_error' | 'invalid_payload' | 'prepare_error';

type Scalar = string | number | boolean | null;

export interface InboxEventPayload {
  api_key: string;
  event: WhatsAppInboxEdgeEvent;
  distinct_id: string;
  properties: Record<string, Scalar>;
}

/** Keeps only scalar properties so a caller can never leak an object or text blob by accident. */
export function buildInboxEventPayload(
  apiKey: string,
  event: WhatsAppInboxEdgeEvent,
  tenantId: string,
  properties: Record<string, unknown>,
): InboxEventPayload {
  const safe: Record<string, Scalar> = { tenant_id: tenantId, source: 'whatsapp_inbox' };
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safe[key] = value as Scalar;
    }
  }
  return { api_key: apiKey, event, distinct_id: tenantId, properties: safe };
}

/** Maps a raw dispatch failure reason to a coarse class (raw reasons can contain buyer data). */
export function classifyReplyFailure(reason: string): ReplyFailureClass {
  const text = reason.toLowerCase();
  if (text.includes('credentials not configured')) return 'credentials';
  if (text.startsWith('prepare failed')) return 'prepare_error';
  if (text.includes('missing text_body') || text.includes('missing send_payload')) return 'invalid_payload';
  return 'provider_error';
}

function getEnv(name: string): string | null {
  const denoEnv = (globalThis as unknown as { Deno?: { env?: { get?: (key: string) => string | undefined } } }).Deno?.env;
  const value = denoEnv?.get?.(name);
  if (value) return value;
  const processEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return processEnv?.[name] ?? null;
}

export async function captureInboxEvent(
  event: WhatsAppInboxEdgeEvent,
  tenantId: string | null | undefined,
  properties: Record<string, unknown>,
): Promise<void> {
  try {
    if (!tenantId) return;
    const key = getEnv('POSTHOG_PROJECT_API_KEY') ?? getEnv('NEXT_PUBLIC_POSTHOG_KEY');
    if (!key) return;
    const host = (getEnv('NEXT_PUBLIC_POSTHOG_HOST') ?? getEnv('POSTHOG_HOST') ?? 'https://us.i.posthog.com').replace(/\/+$/, '');
    const response = await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildInboxEventPayload(key, event, tenantId, properties)),
    });
    if (!response.ok) {
      console.warn('[whatsapp-inbox-analytics] capture rejected', { event, status: response.status });
    }
  } catch (error) {
    console.warn('[whatsapp-inbox-analytics] capture failed (non-blocking)', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
