// supabase/functions/email-inbound-webhook/index.ts
//
// Inbound email ingest. Called only by the Cloudflare email-ingest Worker
// (workers/email-ingest), which has already archived the raw .eml to R2 and
// parsed the MIME. Spec: specs/Yukti_Email-Inbox_Spec_v1.md.
//
// Status codes are the retry contract with the Worker:
//   200  handled (processed, duplicate, filtered, or a permanent skip)
//   401  bad/missing/stale signature (fail closed)
//   400  unparseable body (permanent)
//   404  unknown alias token (Worker rejects the SMTP transaction)
//   500  transient failure (Worker keeps the raw mail and retries)
// No message content or addresses are logged: ids and enums only.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalizeInboundEmail, type EmailWorkerPayload } from '../_shared/email-inbound-normalize.ts';
import { hashAliasToken, verifyEmailSignature } from '../_shared/email-inbound-signature.ts';

const EMAIL_INBOX_FLAG = 'df_email_inbox';

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Missing required env var: SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_KEY');
  if (!key) throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** null = could not be determined (PostHog down or unconfigured): the caller must retry, not drop. */
async function isEmailInboxFlagEnabled(tenantId: string): Promise<boolean | null> {
  const key = Deno.env.get('NEXT_PUBLIC_POSTHOG_KEY')?.trim();
  if (!key) return null;
  const host = (Deno.env.get('NEXT_PUBLIC_POSTHOG_HOST')?.trim() || 'https://us.i.posthog.com').replace(/\/$/, '');
  try {
    const response = await fetch(`${host}/decide/?v=3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, distinct_id: tenantId }),
    });
    if (!response.ok) {
      console.error('[email-inbound-webhook] PostHog flag check failed', { tenantId, status: response.status });
      return null;
    }
    const body = (await response.json().catch(() => null)) as { featureFlags?: Record<string, unknown> } | null;
    return body?.featureFlags?.[EMAIL_INBOX_FLAG] === true;
  } catch (error) {
    console.error('[email-inbound-webhook] PostHog flag check errored', {
      tenantId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/** Fire-and-forget product analytics. Only ids and enums: never addresses, subjects or bodies. */
async function captureEmailEvent(tenantId: string, result: Record<string, unknown>): Promise<void> {
  if (result.duplicate === true || result.processed !== true) return;
  const key = Deno.env.get('NEXT_PUBLIC_POSTHOG_KEY')?.trim();
  if (!key) return;
  const host = (Deno.env.get('NEXT_PUBLIC_POSTHOG_HOST')?.trim() || 'https://us.i.posthog.com').replace(/\/$/, '');
  try {
    await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event: 'email_inbound_captured',
        distinct_id: tenantId,
        properties: {
          tenant_id: tenantId,
          source: 'email_inbox',
          filtered: result.filtered === true,
          filter_reason: (result.filter_reason as string | null | undefined) ?? null,
          message_kind: (result.message_kind as string | null | undefined) ?? 'message',
          resolution_status: (result.resolution_status as string | null | undefined) ?? null,
          match_method: (result.match_method as string | null | undefined) ?? null,
        },
      }),
    });
  } catch {
    // Analytics must never affect ingest.
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const check = await verifyEmailSignature({
    secrets: [Deno.env.get('EMAIL_INGEST_SECRET'), Deno.env.get('EMAIL_INGEST_SECRET_PREVIOUS')],
    timestampHeader: req.headers.get('x-yukti-timestamp'),
    signatureHeader: req.headers.get('x-yukti-signature'),
    rawBody,
  });
  if (check !== 'ok') {
    console.warn('[email-inbound-webhook] rejected request', { reason: check });
    return json(401, { error: 'unauthorized' });
  }

  let payload: EmailWorkerPayload;
  try {
    payload = JSON.parse(rawBody) as EmailWorkerPayload;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const aliasToken = payload.alias_token?.trim();
  const normalized = normalizeInboundEmail(payload);
  if (!aliasToken || !normalized) return json(400, { error: 'invalid_payload' });

  try {
    const admin = createAdminClient();
    const aliasHash = await hashAliasToken(aliasToken);

    const { data: integration, error: lookupError } = await admin
      .schema('app')
      .from('tenant_integrations')
      .select('tenant_id')
      .eq('integration_type_id', 'email_forwarding')
      .eq('status', 'connected')
      .eq('config->>alias_token_hash', aliasHash)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (lookupError) {
      console.error('[email-inbound-webhook] alias lookup failed', { code: lookupError.code });
      return json(500, { error: 'lookup_failed' });
    }
    if (!integration?.tenant_id) return json(404, { error: 'unknown_alias' });

    const tenantId = integration.tenant_id as string;
    const featureEnabled = await isEmailInboxFlagEnabled(tenantId);
    // Flag off: the Worker already archived the raw mail, so nothing is lost
    // and replay after enabling is possible.
    if (featureEnabled === null) return json(500, { error: 'flag_unavailable' });
    if (!featureEnabled) return json(200, { processed: false, skipped: 'feature_disabled' });

    const { data, error } = await admin.schema('app').rpc('process_email_inbound_message', {
      p_alias_token_hash: aliasHash,
      p_payload: normalized,
      p_feature_enabled: true,
    });
    if (error) {
      // Log the SQLSTATE only: messages can echo constraint details containing addresses.
      console.error('[email-inbound-webhook] rpc failed', { tenantId, code: error.code });
      // 22xxx = data exception (bad cast): retrying a permanently bad payload is pointless.
      if (typeof error.code === 'string' && error.code.startsWith('22')) return json(400, { error: 'invalid_payload' });
      return json(500, { error: 'rpc_failed' });
    }

    const result = (data ?? {}) as Record<string, unknown>;
    console.info('[email-inbound-webhook] handled', {
      tenantId,
      processed: result.processed ?? null,
      duplicate: result.duplicate ?? null,
      filtered: result.filtered ?? null,
      filter_reason: result.filter_reason ?? null,
      skipped: result.skipped ?? null,
      resolution_status: result.resolution_status ?? null,
    });
    await captureEmailEvent(tenantId, result);
    return json(200, result);
  } catch (err) {
    console.error('[email-inbound-webhook] unexpected error', { error: err instanceof Error ? err.message : String(err) });
    return json(500, { error: 'unexpected' });
  }
});
