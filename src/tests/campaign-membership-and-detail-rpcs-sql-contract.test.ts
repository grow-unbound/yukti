import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'supabase/migrations');

function migration(suffix: string): string {
  const file = readdirSync(dir).find((name) => name.endsWith(suffix));
  if (!file) throw new Error(`migration not found: ${suffix}`);
  return readFileSync(join(dir, file), 'utf8');
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SERVICE_ROLE_ONLY = (fn: string) => [
  new RegExp(`REVOKE ALL ON FUNCTION ${escapeRe(fn)} FROM PUBLIC, anon, authenticated`),
  new RegExp(`GRANT EXECUTE ON FUNCTION ${escapeRe(fn)} TO service_role`),
];

describe('flush_buyer_membership migration', () => {
  const sql = migration('_flush_buyer_membership.sql');

  it('is service_role only, tenant-checked, kill-switch aware and never double-claims work', () => {
    for (const re of SERVICE_ROLE_ONLY('app.flush_buyer_membership(uuid, uuid)')) expect(sql).toMatch(re);
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('membership_runtime_control');
    expect(sql).toContain("entity_type = 'buyer_candidate'");
    expect(sql).toContain("w.state = 'pending'");
    expect(sql).toContain('b.tenant_id = p_tenant_id');
  });

  it('uses the same evaluators as the tick and swallows evaluator errors (row stays pending)', () => {
    expect(sql).toContain('app.evaluate_buyer_for_cohorts_v2(p_buyer_id)');
    expect(sql).toContain('app.evaluate_buyer_for_campaign_buyers(p_buyer_id)');
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]*RETURN false/);
  });
});

describe('campaign detail RPC migration', () => {
  const sql = migration('_campaign_detail_line_items_and_audience_rpcs.sql');

  it('exposes both functions to service_role only and re-checks the campaign tenant', () => {
    for (const re of SERVICE_ROLE_ONLY('app.get_campaign_attributed_line_items(uuid, uuid)')) expect(sql).toMatch(re);
    for (const re of SERVICE_ROLE_ONLY('app.get_campaign_audience_buyers(uuid, uuid)')) expect(sql).toMatch(re);
    expect(sql.match(/c\.tenant_id = p_tenant_id/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('returns a single jsonb scalar with explicit caps (no 1000-row PostgREST truncation)', () => {
    expect(sql.match(/RETURNS jsonb/g)?.length).toBe(2);
    expect(sql).not.toMatch(/RETURNS (SETOF|TABLE)/);
    expect(sql).toContain('c_cap constant integer := 20000');
    expect(sql).toContain('c_cap constant integer := 5000');
    expect(sql).toContain("'truncated'");
  });

  it('keeps every table reference schema-qualified', () => {
    const allowed = new Set(['jsonb_array_elements_text', 'PUBLIC']); // PUBLIC: REVOKE ... FROM PUBLIC
    const refs = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1] as string);
    const unqualified = refs.filter((ref) => !ref.startsWith('app.') && !allowed.has(ref));
    expect(unqualified).toEqual([]);
  });
});

describe('product velocity RPC migration', () => {
  const sql = migration('_product_velocity_90d_rpc.sql');

  it('reads the product period summary, not the dropped snapshot, and is service_role only', () => {
    for (const re of SERVICE_ROLE_ONLY('app.get_product_velocity_90d(uuid, uuid[])')) expect(sql).toMatch(re);
    expect(sql).toContain('app.metrics_product_period_summary');
    expect(sql).not.toMatch(/FROM app\.metrics_product_snapshot/);
    expect(sql).toContain("s.grain = 'month'");
    expect(sql).toContain('c_max_ids constant integer := 1000');
  });
});
