// Shared WhatsApp dispatch core, extracted from whatsapp-dispatch-worker so
// whatsapp-queue-sweep-worker can drain the rest of app.whatsapp_send_queue
// with the exact same guardrails/Meta-call/completion logic — no second
// send pipeline.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { resolveWhatsAppClientForTenant, WhatsAppConfigError } from './whatsapp-client.ts';
import { captureInboxEvent, classifyReplyFailure } from './whatsapp-inbox-analytics.ts';

export function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Missing required env var: SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_KEY');
  if (!key) throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

interface SendPayload {
  type?: 'template' | 'text';
  meta_template_name?: string;
  locale?: string;
  text_body?: string;
  preview_url?: boolean;
  body_params?: Array<{ text: string; parameter_name?: string }>;
  header_params?: { type: 'image'; media_id?: string; link?: string };
  button_params?: Array<{ type: 'url'; index: string; text: string }>;
}

interface PreparedMessage {
  ready?: boolean;
  failed?: boolean;
  skipped?: string;
  message_id?: string;
  queue_id?: string;
  tenant_id?: string | null;
  recipient_phone: string;
  send_payload: SendPayload;
  failure_reason?: string;
}

function providerErrorBody(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
  skipped: number;
}

export async function dispatchMessageIds(
  admin: ReturnType<typeof createAdminClient>,
  messageIds: string[],
): Promise<DispatchResult> {
  let dispatched = 0;
  let failed = 0;
  let skipped = 0;

  for (const messageId of messageIds) {
    const { data: prepared, error: prepareError } = await admin
      .schema('app')
      .rpc('prepare_whatsapp_message_for_send', { p_message_id: messageId });

    if (prepareError) {
      await completeSend(admin, messageId, false, null, `prepare failed: ${prepareError.message}`);
      failed += 1;
      continue;
    }

    const msg = (prepared ?? null) as PreparedMessage | null;
    if (!msg?.ready) {
      console.info('[whatsapp-dispatch] skipped prepared message', {
        messageId,
        failed: msg?.failed ?? false,
        skipped: msg?.skipped ?? null,
        failureReason: msg?.failure_reason ?? null,
      });
      if (msg?.failed) failed += 1;
      else skipped += 1;
      continue;
    }

    const payload = msg.send_payload;
    const payloadType = payload?.type === 'text' ? 'text' : 'template';
    if (payloadType === 'template' && !payload?.meta_template_name) {
      await completeSend(admin, messageId, false, null, 'missing send_payload');
      failed += 1;
      continue;
    }
    if (payloadType === 'text' && !payload?.text_body?.trim()) {
      await completeSend(admin, messageId, false, null, 'missing text_body');
      await captureInboxEvent('whatsapp_reply_failed', msg.tenant_id, {
        failure_class: classifyReplyFailure('missing text_body'),
      });
      failed += 1;
      continue;
    }

    const { client: resolvedClient, source: credentialSource } = await resolveWhatsAppClientForTenant(admin, msg.tenant_id);
    if (!resolvedClient.isConfigured()) {
      await completeSend(admin, messageId, false, null, 'WhatsApp credentials not configured');
      if (payloadType === 'text') {
        await captureInboxEvent('whatsapp_reply_failed', msg.tenant_id, {
          failure_class: classifyReplyFailure('WhatsApp credentials not configured'),
          credential_source: credentialSource,
        });
      }
      failed += 1;
      continue;
    }

    try {
      console.info('[whatsapp-dispatch] sending provider message', {
        messageId,
        queueId: msg.queue_id ?? null,
        tenantId: msg.tenant_id ?? null,
        credentialSource,
        recipientPhone: msg.recipient_phone,
        sendType: payloadType,
        metaTemplateName: payload.meta_template_name ?? null,
      });
      const result = payloadType === 'text'
        ? await resolvedClient.sendText({
            to: msg.recipient_phone,
            body: payload.text_body!.trim(),
            previewUrl: payload.preview_url === true,
          })
        : await resolvedClient.sendTemplate({
            to: msg.recipient_phone,
            templateName: payload.meta_template_name,
            locale: payload.locale ?? 'en',
            bodyParams: (payload.body_params ?? []).map((p) => ({
              text: p.text,
              parameterName: p.parameter_name,
            })),
            headerParams: payload.header_params?.type === 'image'
              ? {
                  type: 'image',
                  mediaId: payload.header_params.media_id,
                  link: payload.header_params.link,
                }
              : undefined,
            buttonParams: payload.button_params?.map((b) => ({
              type: 'url' as const,
              index: b.index,
              text: b.text,
            })),
          });

      console.info('[whatsapp-dispatch] provider send succeeded', {
        messageId,
        queueId: msg.queue_id ?? null,
        tenantId: msg.tenant_id ?? null,
        credentialSource,
        recipientPhone: msg.recipient_phone,
        sendType: payloadType,
        metaTemplateName: payload.meta_template_name ?? null,
        providerMessageId: result.providerMessageId,
      });
      await completeSend(admin, messageId, true, result.providerMessageId, null);
      if (payloadType === 'text') {
        await captureInboxEvent('whatsapp_reply_sent', msg.tenant_id, { credential_source: credentialSource });
      }
      dispatched += 1;
    } catch (err) {
      const reason = err instanceof WhatsAppConfigError
        ? 'WhatsApp credentials not configured'
        : providerErrorBody(err);
      console.error('[whatsapp-dispatch] provider send failed', {
        messageId,
        queueId: msg.queue_id ?? null,
        tenantId: msg.tenant_id ?? null,
        credentialSource,
        recipientPhone: msg.recipient_phone,
        sendType: payloadType,
        metaTemplateName: payload.meta_template_name ?? null,
        providerError: reason,
      });
      await completeSend(admin, messageId, false, null, reason);
      if (payloadType === 'text') {
        await captureInboxEvent('whatsapp_reply_failed', msg.tenant_id, {
          failure_class: classifyReplyFailure(reason),
          credential_source: credentialSource,
        });
      }
      failed += 1;
    }
  }

  return { dispatched, failed, skipped };
}

async function completeSend(
  admin: ReturnType<typeof createAdminClient>,
  messageId: string,
  success: boolean,
  providerMessageId: string | null,
  failureReason: string | null,
): Promise<void> {
  const { error } = await admin
    .schema('app')
    .rpc('complete_whatsapp_message_send', {
      p_message_id: messageId,
      p_success: success,
      p_provider_message_id: providerMessageId,
      p_failure_reason: failureReason,
    });

  if (error) {
    console.error('[whatsapp-dispatch] complete send failed:', error.message);
  }
}
