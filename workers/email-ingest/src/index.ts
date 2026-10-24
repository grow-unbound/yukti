// Cloudflare Email Routing -> Yukti inbox.
//
// Durable-first: the raw .eml is written to R2 BEFORE anything else, so a
// webhook outage, a flag-off tenant or a parser bug never loses mail. Webhook
// results (see supabase/functions/email-inbound-webhook):
//   200      done
//   404      unknown alias  -> reject the SMTP transaction
//   400      permanent      -> keep raw, drop (needs a human)
//   401/5xx  transient      -> park a replay marker in R2; cron retries it
import PostalMime from 'postal-mime';
import { signEmailPayload } from '../../../supabase/functions/_shared/email-inbound-signature';
import { buildWorkerPayload, type ParsedEmail, type StoredAttachment } from './build-payload';

interface Env {
  EMAIL_BUCKET: R2Bucket;
  EMAIL_INGEST_SECRET: string;
  EMAIL_INGEST_URL: string;
  /** Mail domain this Worker serves; recipients on any other domain are rejected. */
  EMAIL_INBOUND_DOMAIN?: string;
}

const MAX_RAW_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const PENDING_PREFIX = 'email-pending/';
const REPLAY_BATCH = 20;
const REPLAY_MAX_AGE_MS = 72 * 60 * 60 * 1000;

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type PostResult = 'ok' | 'unknown_alias' | 'permanent' | 'transient';

async function postToWebhook(env: Env, body: string): Promise<PostResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const response = await fetch(env.EMAIL_INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-yukti-timestamp': String(timestamp),
        'x-yukti-signature': await signEmailPayload(env.EMAIL_INGEST_SECRET, timestamp, body),
      },
      body,
    });
    if (response.ok) return 'ok';
    if (response.status === 404) return 'unknown_alias';
    if (response.status === 400) return 'permanent';
    return 'transient';
  } catch {
    return 'transient';
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject('Message too large');
      return;
    }
    const [localPart, recipientDomain] = message.to.toLowerCase().split('@');
    const pinnedDomain = env.EMAIL_INBOUND_DOMAIN?.trim().toLowerCase();
    if (!localPart || (pinnedDomain && recipientDomain !== pinnedDomain)) {
      message.setReject('Unknown recipient');
      return;
    }
    const aliasToken = localPart;

    const raw = await new Response(message.raw).arrayBuffer();
    const rawHash = await sha256Hex(raw);
    const rawKey = `email-raw/${rawHash}.eml`;
    await env.EMAIL_BUCKET.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' } });

    // Raw mail is already safe in R2: a parse failure must not bounce or retry the SMTP transaction.
    let parsed: ParsedEmail & {
      attachments?: Array<{ filename?: string | null; mimeType?: string; content: ArrayBuffer | Uint8Array | string }>;
    };
    try {
      parsed = (await PostalMime.parse(raw)) as typeof parsed;
    } catch (error) {
      console.error('[email-ingest] MIME parse failed, raw kept', { rawKey, error: error instanceof Error ? error.message : 'unknown' });
      return;
    }

    const attachments: StoredAttachment[] = [];
    const storedAttachmentKeys: string[] = [];
    for (const att of (parsed.attachments ?? []).slice(0, 50)) {
      if (typeof att.content === 'string') continue;
      const bytes = att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content);
      const sha = await sha256Hex(bytes);
      let r2Key: string | null = null;
      if (bytes.byteLength <= MAX_ATTACHMENT_BYTES) {
        r2Key = `email-att/${sha}`;
        await env.EMAIL_BUCKET.put(r2Key, bytes);
        storedAttachmentKeys.push(r2Key);
      }
      attachments.push({ filename: att.filename, mime_type: att.mimeType, size_bytes: bytes.byteLength, sha256: sha, r2_key: r2Key });
    }

    const body = JSON.stringify(
      buildWorkerPayload({
        aliasToken,
        receivedAt: new Date().toISOString(),
        rawR2Key: rawKey,
        parsed,
        attachments,
      }),
    );

    const result = await postToWebhook(env, body);
    if (result === 'unknown_alias') {
      // Open MX: do not keep spam for aliases that do not exist.
      await env.EMAIL_BUCKET.delete([rawKey, ...storedAttachmentKeys]);
      message.setReject('Unknown recipient');
    } else if (result === 'transient') {
      try {
        await env.EMAIL_BUCKET.put(`${PENDING_PREFIX}${rawHash}.json`, body, { customMetadata: { parked_at: String(Date.now()) } });
        console.error('[email-ingest] webhook transient failure, parked for replay', { rawKey });
      } catch (error) {
        console.error('[email-ingest] could not park replay marker, raw kept', { rawKey, error: error instanceof Error ? error.message : 'unknown' });
      }
    } else if (result === 'permanent') {
      console.error('[email-ingest] webhook rejected payload, raw kept', { rawKey });
    }
  },

  // Replays parked mail. The signature is regenerated, so the 5 minute replay
  // window in the webhook is never an obstacle. The webhook is idempotent.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const listing = await env.EMAIL_BUCKET.list({ prefix: PENDING_PREFIX, limit: REPLAY_BATCH });
    for (const object of listing.objects) {
      const item = await env.EMAIL_BUCKET.get(object.key);
      if (!item) continue;
      const parkedAt = Number(item.customMetadata?.parked_at ?? 0);
      const result = await postToWebhook(env, await item.text());
      if (result === 'transient' && Date.now() - parkedAt < REPLAY_MAX_AGE_MS) continue;
      if (result === 'transient') console.error('[email-ingest] replay expired, raw kept in email-raw/', { key: object.key });
      await env.EMAIL_BUCKET.delete(object.key);
    }
  },
};
