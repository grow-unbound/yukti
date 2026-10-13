import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261013150000_whatsapp_inbound_media_messages.sql'),
  'utf8',
);
const webhook = readFileSync('supabase/functions/whatsapp-inbound-webhook/index.ts', 'utf8');
const code = sql.replace(/^--.*$/gm, '');

describe('whatsapp inbound media migration + webhook wiring', () => {
  it('widens the thread message type check to media, location and contacts', () => {
    expect(code).toContain('whatsapp_thread_messages_type_check');
    for (const type of ['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts']) {
      expect(code).toContain(`'${type}'`);
    }
  });

  it('only requires a body for text and button messages and builds a placeholder otherwise', () => {
    expect(code).toContain("IF COALESCE(p_message_type, 'text') IN ('text', 'button') THEN");
    expect(code).toContain("'Sent an image'");
    expect(code).toContain('v_body := v_body');
    expect(code).not.toMatch(/\bmin\(\s*buyer_id\s*\)/i);
  });

  it('keeps media content out of the stored payload and exposes message_type to the UI', () => {
    expect(code).toContain("- 'text' - 'button' - 'caption'");
    expect(code).toContain("'message_type', sub.message_type");
    expect(code).toContain("'last_inbound_type'");
  });

  it('webhook normalizes through the shared module and still honours STOP from text and button', () => {
    expect(webhook).toContain("from '../_shared/whatsapp-inbound-normalize.ts'");
    expect(webhook).toContain("(message.type === 'text' || message.type === 'button') && isOptOutMessage(textBody)");
  });
});
