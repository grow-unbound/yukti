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
    const callbackUrl = process.env.WHATSAPP_WEBHOOK_CALLBACK_URL?.trim();
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();
    if (Boolean(callbackUrl) !== Boolean(verifyToken)) {
      return {
        ok: false,
        message: 'WHATSAPP_WEBHOOK_CALLBACK_URL and WHATSAPP_WEBHOOK_VERIFY_TOKEN must be configured together',
      };
    }
    if (callbackUrl) {
      const parsedCallbackUrl = new URL(callbackUrl);
      if (parsedCallbackUrl.protocol !== 'https:') {
        return { ok: false, message: 'WHATSAPP_WEBHOOK_CALLBACK_URL must use HTTPS' };
      }
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    const request: RequestInit = { method: 'POST', headers };
    if (callbackUrl && verifyToken) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify({
        override_callback_uri: callbackUrl,
        verify_token: verifyToken,
      });
    }

    const response = await fetchImpl(
      `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      request,
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
