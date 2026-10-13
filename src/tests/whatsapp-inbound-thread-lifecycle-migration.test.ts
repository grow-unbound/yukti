import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261013140000_whatsapp_inbound_thread_lifecycle.sql'),
  'utf8',
);
const code = sql.replace(/^--.*$/gm, '');

describe('whatsapp inbound thread lifecycle migration', () => {
  it('does not aggregate a uuid with min()/max() (no such function in Postgres; broke every inbound message)', () => {
    expect(code).not.toMatch(/\bmin\(\s*buyer_id\s*\)/i);
    expect(code).not.toMatch(/\bmax\(\s*buyer_id\s*\)/i);
    expect(code).toContain('(array_agg(buyer_id))[1]');
  });

  it('closes the thread only for resolved entries past the 24h quiet threshold', () => {
    expect(code).toContain("v_quiet_status = 'resolved'");
    expect(code).toContain("v_quiet_at < v_received_at - interval '24 hours'");
    expect(code).toContain("SET status = 'closed'");
  });

  it('surfaces any inbound message as new work and clears waiting + stale resolution fields', () => {
    expect(code).toMatch(/SET status = 'new',\s+remind_at = NULL,\s+resolution_reason = NULL,\s+resolved_at = NULL,\s+resolved_by = NULL/);
  });

  it('never moves the service window or last inbound timestamp backwards', () => {
    expect(code).toContain('service_window_expires_at = GREATEST(');
    expect(code).toContain('last_inbound_message_at = GREATEST(');
  });

  it('records from_status on the inbound event and tolerates a disabled entry type', () => {
    expect(code).toMatch(/'whatsapp_inbound_received',\s+v_prev_status,/);
    expect(code).toContain("'skipped', 'entry_type_disabled'");
  });
});
