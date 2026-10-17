import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { secondsSince } from '@/lib/server/whatsapp-inbox-analytics';
import {
  buildInboxEventPayload,
  classifyReplyFailure,
} from '../../supabase/functions/_shared/whatsapp-inbox-analytics';

describe('secondsSince', () => {
  const now = Date.parse('2026-10-13T10:00:00.000Z');
  it('returns whole seconds for a past timestamp', () => {
    expect(secondsSince('2026-10-13T09:58:30.000Z', now)).toBe(90);
  });
  it('returns null for missing, invalid or future timestamps', () => {
    expect(secondsSince(null, now)).toBeNull();
    expect(secondsSince('nope', now)).toBeNull();
    expect(secondsSince('2026-10-13T10:05:00.000Z', now)).toBeNull();
  });
});

describe('buildInboxEventPayload', () => {
  it('always carries tenant and source and uses the tenant as distinct id', () => {
    const payload = buildInboxEventPayload('key', 'whatsapp_inbound_captured', 'tenant-1', { resolution_status: 'matched' });
    expect(payload).toMatchObject({
      api_key: 'key',
      event: 'whatsapp_inbound_captured',
      distinct_id: 'tenant-1',
      properties: { tenant_id: 'tenant-1', source: 'whatsapp_inbox', resolution_status: 'matched' },
    });
  });

  it('drops objects, arrays and undefined so content blobs cannot leak', () => {
    const payload = buildInboxEventPayload('k', 'whatsapp_reply_failed', 't', {
      failure_class: 'provider_error',
      count: 2,
      ok: false,
      none: null,
      nested: { text: 'hello buyer' },
      list: ['a'],
      missing: undefined,
    });
    expect(payload.properties).toEqual({
      tenant_id: 't',
      source: 'whatsapp_inbox',
      failure_class: 'provider_error',
      count: 2,
      ok: false,
      none: null,
    });
  });
});

describe('classifyReplyFailure', () => {
  it.each([
    ['WhatsApp credentials not configured', 'credentials'],
    ['prepare failed: boom', 'prepare_error'],
    ['missing text_body', 'invalid_payload'],
    ['missing send_payload', 'invalid_payload'],
    ['(#131047) Re-engagement message to +91 98xxxxxx', 'provider_error'],
  ])('%s -> %s (raw provider text is never forwarded)', (reason, expected) => {
    expect(classifyReplyFailure(reason)).toBe(expected);
  });
});

describe('analytics wiring and G7 migration shape', () => {
  const dispatch = readFileSync('supabase/functions/_shared/whatsapp-dispatch.ts', 'utf8');
  const webhook = readFileSync('supabase/functions/whatsapp-inbound-webhook/index.ts', 'utf8');
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261013170000_whatsapp_reply_drafts.sql'), 'utf8');
  const code = sql.replace(/^--.*$/gm, '');

  it('dispatch emits sent/failed only for service text replies, never templates', () => {
    expect(dispatch).toContain("captureInboxEvent('whatsapp_reply_sent'");
    expect(dispatch.match(/if \(payloadType === 'text'\) \{\n\s+await captureInboxEvent/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('webhook emits inbound_captured only for newly processed messages', () => {
    expect(webhook).toContain("captureInboxEvent('whatsapp_inbound_captured'");
    expect(webhook).toContain('result.duplicate !== true && !result.skipped');
  });

  it('reply audit table is tenant-scoped, RLS-protected and keeps delivery state on the ledger', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS app.whatsapp_reply_drafts');
    expect(code).toContain('ALTER TABLE app.whatsapp_reply_drafts ENABLE ROW LEVEL SECURITY');
    expect(code).toContain("tenant_id = (select app.jwt_tenant_id())");
    expect(code).toContain('whatsapp_reply_drafts_whatsapp_message_uk');
    expect(code).not.toMatch(/\bdelivery_status\b/);
  });

  it('records the audit row inside the existing send-record function without changing its signature', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION app.record_whatsapp_thread_outbound_reply(');
    expect(code).toContain('INSERT INTO app.whatsapp_reply_drafts');
    expect(code).toContain("'manual'");
  });
});
