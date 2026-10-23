import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260928125155_whatsapp_inbox_p0.sql', 'utf8');
const webhook = readFileSync('supabase/functions/whatsapp-inbound-webhook/index.ts', 'utf8');

describe('WhatsApp inbox P0 migration and webhook contract', () => {
  it('creates durable thread tables with RLS and provider id idempotency', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS app.whatsapp_threads');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS app.whatsapp_thread_messages');
    expect(migration).toContain('ALTER TABLE app.whatsapp_threads ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE app.whatsapp_thread_messages ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('whatsapp_thread_messages_provider_uk');
  });

  it('adds the Today entry taxonomy and service-role ingestion RPC', () => {
    expect(migration).toContain("'whatsapp_buyer_message'");
    expect(migration).toContain("'whatsapp_thread'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION app.process_whatsapp_inbound_message');
    expect(migration).toContain('p_feature_enabled boolean DEFAULT false');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION app.process_whatsapp_inbound_message');
  });

  it('keeps inbound processing behind the tenant-scoped PostHog flag and platform fallback', () => {
    expect(webhook).toContain("const WHATSAPP_INBOX_FLAG = 'df_whatsapp_inbox'");
    expect(webhook).toContain("const POSTHOG_TENANT_GROUP_TYPE = 'tenant'");
    expect(webhook).toContain("Deno.env.get('POSTHOG_PROJECT_API_KEY')");
    expect(webhook).toContain('groups: { [POSTHOG_TENANT_GROUP_TYPE]: tenantId }');
    expect(webhook).toContain("Deno.env.get('WHATSAPP_PLATFORM_TENANT_ID')");
    expect(webhook).toContain("Deno.env.get('WHATSAPP_PLATFORM_PHONE_NUMBER_ID')");
    expect(webhook).toContain("rpc('process_whatsapp_inbound_message'");
  });
});
