// supabase/functions/whatsapp-inbound-webhook/index.ts
//
// WhatsApp inbound handler:
//   - Phase C: STOP/UNSUBSCRIBE opt-out (§4.8, §7.2)
//   - Delivery tracking: message status webhooks (sent/delivered/read/failed)
// Spec: DealFlow_WhatsApp-Broadcast-Spec_v4.md §5

import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalizeInboundMessage, type MetaInboundMessage } from '../_shared/whatsapp-inbound-normalize.ts';
import { captureInboxEvent } from '../_shared/whatsapp-inbox-analytics.ts';

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Missing required env var: SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_KEY');
  if (!key) throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const OPT_OUT_KEYWORDS = new Set(['stop', 'unsubscribe', 'unsub', 'opt out', 'optout', 'stop all']);

function isOptOutMessage(body: string | null | undefined): boolean {
  if (!body) return false;
  const normalized = body.trim().toLowerCase();
  return OPT_OUT_KEYWORDS.has(normalized);
}

function normalizeIndianPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length > 10) return digits.slice(-10);
  if (digits.startsWith('0') && digits.length > 10) return digits.slice(-10);
  return digits;
}


interface MetaStatusUpdate {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{ title?: string; message?: string }>;
}

interface MetaWebhookEntry {
  changes?: Array<{
    field?: string;
    value?: {
      metadata?: {
        display_phone_number?: string;
        phone_number_id?: string;
      };
      messages?: MetaInboundMessage[];
      statuses?: MetaStatusUpdate[];
    };
  }>;
}

interface MetaWebhookBody {
  entry?: MetaWebhookEntry[];
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

// Meta signs every webhook POST body with the app's App Secret (Meta App
// dashboard > Settings > Basic > App Secret — NOT WHATSAPP_TOKEN, which is
// the Cloud API access token, and NOT WHATSAPP_WEBHOOK_VERIFY_TOKEN, which
// is only the arbitrary string used in the GET subscribe handshake). The
// signature arrives as `X-Hub-Signature-256: sha256=<hex hmac>` over the
// raw (pre-parsed) request body.
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function isVerifiedMetaSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  const appSecret = Deno.env.get('WHATSAPP_APP_SECRET');
  if (!appSecret) {
    console.error('[whatsapp-inbound-webhook] WHATSAPP_APP_SECRET not configured — rejecting webhook (fail closed)');
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const providedHex = signatureHeader.slice('sha256='.length);
  const providedBytes = hexToBytes(providedHex);
  if (!providedBytes) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expectedBytes = new Uint8Array(signature);

  return timingSafeEqual(providedBytes, expectedBytes);
}

function mapMetaStatusToLedgerStatus(
  metaStatus: string,
): 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch (metaStatus) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

const STATUS_ORDER: Record<'sent' | 'delivered' | 'read' | 'failed', number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

const WHATSAPP_INBOX_FLAG = 'df_whatsapp_inbox';

async function resolveTenantIdForPhoneNumberId(
  admin: ReturnType<typeof createAdminClient>,
  phoneNumberId: string | null | undefined,
): Promise<string | null> {
  const normalizedPhoneNumberId = phoneNumberId?.trim();
  if (!normalizedPhoneNumberId) return null;

  const { data: integration, error } = await admin
    .schema('app')
    .from('tenant_integrations')
    .select('tenant_id')
    .eq('integration_type_id', 'whatsapp_business')
    .eq('status', 'connected')
    .eq('config->>phone_number_id', normalizedPhoneNumberId)
    .is('deleted_at', null)
    .order('connected_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[whatsapp-inbound-webhook] tenant-owned WABA lookup failed', {
      phoneNumberId: normalizedPhoneNumberId,
      error: error.message,
    });
  }
  if (integration?.tenant_id) return integration.tenant_id as string;

  const platformPhoneNumberId =
    Deno.env.get('WHATSAPP_PLATFORM_PHONE_NUMBER_ID')
    ?? Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
    ?? Deno.env.get('NEXT_PUBLIC_WHATSAPP_PHONE_NUMBER_ID');
  const platformTenantId = Deno.env.get('WHATSAPP_PLATFORM_TENANT_ID');
  if (platformPhoneNumberId?.trim() === normalizedPhoneNumberId && platformTenantId?.trim()) {
    return platformTenantId.trim();
  }

  return null;
}

async function isWhatsAppInboxFlagEnabled(tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;

  const key = Deno.env.get('NEXT_PUBLIC_POSTHOG_KEY')?.trim();
  if (!key) return false;

  const host = (Deno.env.get('NEXT_PUBLIC_POSTHOG_HOST')?.trim() || 'https://us.i.posthog.com').replace(/\/$/, '');
  try {
    const response = await fetch(`${host}/decide/?v=3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        distinct_id: tenantId,
      }),
    });
    if (!response.ok) {
      console.error('[whatsapp-inbound-webhook] PostHog flag check failed', {
        tenantId,
        status: response.status,
      });
      return false;
    }
    const body = (await response.json().catch(() => null)) as {
      featureFlags?: Record<string, unknown>;
    } | null;
    return body?.featureFlags?.[WHATSAPP_INBOX_FLAG] === true;
  } catch (error) {
    console.error('[whatsapp-inbound-webhook] PostHog flag check errored', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function handleInboundMessages(
  admin: ReturnType<typeof createAdminClient>,
  changes: NonNullable<MetaWebhookEntry['changes']>,
): Promise<void> {
  const platformPhoneNumberId =
    Deno.env.get('WHATSAPP_PLATFORM_PHONE_NUMBER_ID')
    ?? Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
    ?? Deno.env.get('NEXT_PUBLIC_WHATSAPP_PHONE_NUMBER_ID')
    ?? null;
  const platformTenantId = Deno.env.get('WHATSAPP_PLATFORM_TENANT_ID') ?? null;

  for (const change of changes) {
    if (change.field !== 'messages') continue;
    const metadata = change.value?.metadata;
    const phoneNumberId = metadata?.phone_number_id?.trim() ?? null;
    const displayPhoneNumber = metadata?.display_phone_number?.trim() ?? null;
    const tenantId = await resolveTenantIdForPhoneNumberId(admin, phoneNumberId);
    const featureEnabled = await isWhatsAppInboxFlagEnabled(tenantId);

    for (const message of change.value?.messages ?? []) {
      if (!message.from) continue;

      const inbound = normalizeInboundMessage(message);
      const textBody = inbound?.text ?? null;
      // STOP can arrive as typed text or as a template quick-reply button.
      if ((message.type === 'text' || message.type === 'button') && isOptOutMessage(textBody)) {
        const phone = normalizeIndianPhone(message.from);
        if (!phone) continue;
        console.info('[whatsapp-inbound-webhook] inbound opt-out received', {
          phone,
          tenantId: tenantId ?? null,
        });

        let query = admin
          .schema('app')
          .from('buyers')
          .update({ whatsapp_opt_out_at: new Date().toISOString() })
          .eq('phone', phone)
          .is('whatsapp_opt_out_at', null)
          .is('deleted_at', null);
        if (tenantId) {
          query = query.eq('tenant_id', tenantId);
        }
        const { error } = await query;

        if (error) {
          console.error('[whatsapp-inbound-webhook] failed to stamp opt-out', {
            phone,
            tenantId: tenantId ?? null,
            error: error.message,
          });
        }
        continue;
      }

      if (!inbound || !message.id) continue;
      if ((inbound.type === 'text' || inbound.type === 'button') && !textBody) continue;
      if (!phoneNumberId) {
        console.warn('[whatsapp-inbound-webhook] inbound message missing phone_number_id', {
          providerMessageId: message.id,
        });
        continue;
      }

      const receivedAt = message.timestamp
        ? new Date(Number(message.timestamp) * 1000).toISOString()
        : new Date().toISOString();
      const { data, error } = await admin
        .schema('app')
        .rpc('process_whatsapp_inbound_message', {
          p_provider_message_id: message.id,
          p_sender_phone: message.from,
          p_recipient_phone_number_id: phoneNumberId,
          p_recipient_display_phone: displayPhoneNumber,
          p_message_type: inbound.type,
          p_text_body: textBody ?? '',
          p_received_at: receivedAt,
          p_raw_payload: {
            id: message.id,
            from: message.from,
            type: inbound.type,
            timestamp: message.timestamp ?? null,
            metadata: metadata ?? null,
            ...inbound.extra,
          },
          p_platform_phone_number_id: platformPhoneNumberId,
          p_platform_tenant_id: platformTenantId,
          p_feature_enabled: featureEnabled,
        });

      if (error) {
        console.error('[whatsapp-inbound-webhook] inbound processing failed', {
          providerMessageId: message.id,
          phoneNumberId,
          tenantId: tenantId ?? null,
          error: error.message,
        });
      } else {
        const result = (data ?? {}) as {
          processed?: boolean;
          skipped?: string;
          duplicate?: boolean;
          tenant_id?: string;
          resolution_status?: string;
        };
        if (result.processed === true && result.duplicate !== true && !result.skipped) {
          await captureInboxEvent('whatsapp_inbound_captured', result.tenant_id ?? tenantId, {
            resolution_status: result.resolution_status ?? null,
            message_type: message.type ?? null,
          });
        }
        console.info('[whatsapp-inbound-webhook] inbound processing complete', {
          providerMessageId: message.id,
          phoneNumberId,
          tenantId: tenantId ?? null,
          processed: result.processed === true,
          skipped: result.skipped ?? null,
          duplicate: result.duplicate === true,
        });
      }
    }
  }
}

async function handleStatusUpdates(
  admin: ReturnType<typeof createAdminClient>,
  statuses: MetaStatusUpdate[],
): Promise<void> {
  const touchedBroadcastIds = new Set<string>();

  for (const status of statuses) {
    const providerMessageId = status.id?.trim();
    const ledgerStatus = status.status ? mapMetaStatusToLedgerStatus(status.status) : null;
    if (!providerMessageId || !ledgerStatus) {
      console.warn('[whatsapp-inbound-webhook] ignored malformed status payload', {
        providerMessageId: providerMessageId ?? null,
        rawStatus: status.status ?? null,
      });
      continue;
    }

    const timestamp = status.timestamp
      ? new Date(Number(status.timestamp) * 1000).toISOString()
      : new Date().toISOString();

    const { data: existingRows, error: existingError } = await admin
      .schema('app')
      .from('whatsapp_messages')
      .select('id, status, whatsapp_broadcast_id')
      .eq('provider_message_id', providerMessageId);

    if (existingError) {
      console.error('[whatsapp-inbound-webhook] existing status lookup failed', {
        providerMessageId,
        error: existingError.message,
      });
      continue;
    }

    const existing = (existingRows ?? []) as Array<{
      id: string;
      status: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | null;
      whatsapp_broadcast_id: string | null;
    }>;

    if (existing.length === 0) {
      console.warn('[whatsapp-inbound-webhook] unmatched provider message id', {
        providerMessageId,
        ledgerStatus,
        timestamp,
      });
      continue;
    }

    const staleOrDuplicate = existing.every((row) => {
      if (!row.status || !(row.status in STATUS_ORDER)) return false;
      return STATUS_ORDER[row.status as keyof typeof STATUS_ORDER] >= STATUS_ORDER[ledgerStatus];
    });
    if (staleOrDuplicate) {
      console.info('[whatsapp-inbound-webhook] duplicate or out-of-order status update', {
        providerMessageId,
        incomingStatus: ledgerStatus,
        existingStatuses: existing.map((row) => row.status),
      });
      continue;
    }

    const update: Record<string, unknown> = {
      provider_message_id: providerMessageId,
      status: ledgerStatus,
    };
    if (ledgerStatus === 'sent') update.sent_at = timestamp;
    if (ledgerStatus === 'delivered') update.delivered_at = timestamp;
    if (ledgerStatus === 'read') update.read_at = timestamp;
    if (ledgerStatus === 'failed') {
      const errMsg = status.errors?.[0]?.message ?? status.errors?.[0]?.title ?? 'Meta delivery failed';
      update.failure_reason = errMsg;
    }

    const { data: updatedRows, error } = await admin
      .schema('app')
      .from('whatsapp_messages')
      .update(update)
      .select('id, whatsapp_broadcast_id')
      .eq('provider_message_id', providerMessageId);

    if (error) {
      console.error('[whatsapp-inbound-webhook] status update failed', {
        providerMessageId,
        error: error.message,
      });
      continue;
    }

    const updated = (updatedRows ?? []) as Array<{ id: string; whatsapp_broadcast_id: string | null }>;
    for (const row of updated) {
      if (ledgerStatus === 'failed') {
        const errMsg = status.errors?.[0]?.message ?? status.errors?.[0]?.title ?? 'Meta delivery failed';
        const { error: queueError } = await admin
          .schema('app')
          .from('whatsapp_send_queue')
          .update({
            status: 'failed',
            failure_reason: errMsg,
          })
          .eq('whatsapp_message_id', row.id)
          .neq('status', 'cancelled');

        if (queueError) {
          console.error('[whatsapp-inbound-webhook] queue failure update failed', {
            providerMessageId,
            error: queueError.message,
          });
        }

        // Credits were debited synchronously at dispatch time, before Meta
        // ever confirmed delivery. A failed delivery status means Meta
        // never charges for this message, so the debited credits must be
        // refunded. Idempotent on the DB side (refund_whatsapp_credits
        // no-ops if already refunded) — safe to call even on a duplicate
        // or out-of-order webhook delivery.
        const { error: refundError } = await admin
          .schema('app')
          .rpc('refund_whatsapp_credits', { p_whatsapp_message_id: row.id });

        if (refundError) {
          console.error('[whatsapp-inbound-webhook] credit refund failed', {
            providerMessageId,
            messageId: row.id,
            error: refundError.message,
          });
        }
      }

      if (row.whatsapp_broadcast_id) {
        touchedBroadcastIds.add(row.whatsapp_broadcast_id);
      }
    }
  }

  for (const broadcastId of touchedBroadcastIds) {
    const { error } = await admin
      .schema('app')
      .rpc('refresh_whatsapp_broadcast_rollup', { p_broadcast_id: broadcastId });

    if (error) {
      console.error('[whatsapp-inbound-webhook] broadcast rollup refresh failed', {
        broadcastId,
        error: error.message,
      });
    }
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expectedToken = Deno.env.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN');

    if (mode === 'subscribe' && expectedToken && token === expectedToken && challenge) {
      return ok(challenge);
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();
  const signatureHeader = req.headers.get('x-hub-signature-256');

  if (!(await isVerifiedMetaSignature(rawBody, signatureHeader))) {
    console.warn('[whatsapp-inbound-webhook] rejected webhook with invalid or missing X-Hub-Signature-256');
    return new Response('Forbidden', { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody) as MetaWebhookBody;
    const admin = createAdminClient();

    const changes = (body.entry ?? []).flatMap((entry) => entry.changes ?? []);

    const statuses: MetaStatusUpdate[] = changes
      .flatMap((change) => change.value?.statuses ?? []);

    if (statuses.length > 0) {
      await handleStatusUpdates(admin, statuses);
    }

    await handleInboundMessages(admin, changes);

    return ok('processed');
  } catch (err) {
    console.error('[whatsapp-inbound-webhook] unexpected error', err);
    return ok('error-logged');
  }
});
