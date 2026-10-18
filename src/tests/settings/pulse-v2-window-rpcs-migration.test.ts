import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'supabase/migrations');
const name = readdirSync(dir).find((f) => f.endsWith('_pulse_v2_window_rpcs.sql'))!;
const sql = readFileSync(path.join(dir, name), 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

const PUBLIC_RPCS = ['get_pulse_scorecard', 'get_pulse_act_now', 'get_pulse_opportunity_buyers', 'get_pulse_funnel'];

describe('Pulse v2 window RPCs', () => {
  it('reads raw tables only (no metrics_* tables)', () => {
    expect(code).not.toMatch(/metrics_[a-z_]+/);
  });

  it('uses the canonical metric-day and status helpers', () => {
    for (const helper of [
      'app.metric_day_ist',
      'app.estimate_status_counts_as_demand',
      'app.order_status_in_flow',
      'app.invoice_status_gmv_included',
    ]) {
      expect(code).toContain(helper);
    }
  });

  it('is service_role only and pins search_path', () => {
    for (const fn of PUBLIC_RPCS) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION app\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${fn}\\([^)]*\\) TO service_role`));
      expect(code).not.toMatch(new RegExp(`GRANT[^;]*app\\.${fn}[^;]*(anon|authenticated|PUBLIC)`));
    }
    expect(code).not.toMatch(/SECURITY DEFINER\s+AS/);
    expect(code.match(/SET search_path TO 'pg_catalog'/g)!.length).toBeGreaterThanOrEqual(7);
  });

  it('caps window length (366 days; 92 for the activity funnel) and rejects bad windows', () => {
    expect(code).toContain("'invalid_window'");
    expect(code).toContain("'window_too_long'");
    expect(code).toContain('app._pulse_check_window(p_from, p_to_excl, 92)');
    expect(code).toContain('app._pulse_check_window(p_from, p_to_excl, 366)');
  });

  it('documents every function', () => {
    expect(code.match(/COMMENT ON FUNCTION/g)!.length).toBe(7);
  });
});
