import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/20261002120119_fix_submit_buyer_intake_internal_reopen.sql'),
  'utf8',
);

const internalReopenBlock = migration.slice(
  migration.indexOf("IF v_old_onboarding_status = 'needs_more_info'"),
  migration.indexOf('RETURN v_buyer;'),
);

describe('submit_buyer_intake internal reopen migration', () => {
  it('does not call the admin-only entry action RPC for buyer resubmission reopen', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION app.submit_buyer_intake');
    expect(migration).not.toContain("app.apply_entry_action(v_buyer.tenant_id, v_entry_id, NULL, 'reopen')");
    expect(internalReopenBlock).toContain('UPDATE app.entries');
    expect(internalReopenBlock).toContain("last_action = 'reopen'");
    expect(internalReopenBlock).toContain("external_sync_status = 'not_required'");
    expect(internalReopenBlock).toContain('INSERT INTO app.entry_events');
    expect(internalReopenBlock).toContain("'reopen', v_entry_status, 'new'");
  });

  it('keeps document ownership validation and service-role-only grants', () => {
    expect(migration).toContain('RAISE EXCEPTION \'invalid_document_id\'');
    expect(migration).toContain('bd.buyer_id = p_buyer_id');
    expect(migration).toContain("WHEN onboarding_status = 'needs_more_info' THEN 'pending_approval'");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.submit_buyer_intake(uuid, text, text, boolean, text, text, jsonb, jsonb, uuid[]) FROM PUBLIC',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.submit_buyer_intake(uuid, text, text, boolean, text, text, jsonb, jsonb, uuid[]) TO service_role',
    );
  });
});
