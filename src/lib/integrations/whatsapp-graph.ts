export const WHATSAPP_GRAPH_API_VERSION = 'v21.0';

export type SubscribeWabaResult = { ok: true } | { ok: false; message: string };

/**
 * Subscribes the app to a tenant's WABA so Meta delivers that WABA's webhook
 * events (inbound messages, statuses) to our app-level webhook. Idempotent on
 * Meta's side; safe to call again to repair a connection.
 */
export async function subscribeWabaToApp(
  wabaId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscribeWabaResult> {
  try {
    const response = await fetchImpl(
      `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const json = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      error?: { message?: string };
    };
    if (response.ok && json.success === true) return { ok: true };
    return { ok: false, message: json.error?.message ?? 'Meta rejected the webhook subscription' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Failed to reach Meta' };
  }
}
