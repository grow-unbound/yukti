import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'supabase/migrations');
const name = readdirSync(dir).find((f) => f.endsWith('_pulse_v2_sellthrough_customers_patterns.sql'))!;
const code = readFileSync(path.join(dir, name), 'utf8').replace(/^\s*--.*$/gm, '');

const FNS = ['get_pulse_sellthrough', 'get_pulse_customers', 'get_pulse_patterns'];

describe('Pulse v2 P3 RPCs', () => {
  it('reads raw tables only (no metrics_* tables) with the canonical helpers', () => {
    expect(code).not.toMatch(/metrics_[a-z_]+/);
    for (const helper of ['app.metric_day_ist', 'app.estimate_status_counts_as_demand', 'app.order_status_in_flow', 'app.invoice_status_gmv_included']) {
      expect(code).toContain(helper);
    }
  });

  it('is service_role only, security definer with a pinned search_path and statement timeout', () => {
    for (const fn of FNS) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION app\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${fn}\\([^)]*\\) TO service_role`));
      expect(code).not.toMatch(new RegExp(`GRANT[^;]*app\\.${fn}[^;]*(anon|authenticated|PUBLIC)`));
    }
    expect(code.match(/SECURITY DEFINER/g)!.length).toBe(3);
    expect(code.match(/SET search_path TO 'pg_catalog', 'app'/g)!.length).toBe(3);
    expect(code.match(/SET statement_timeout TO '10s'/g)!.length).toBe(3);
  });

  it('whitelists the dimension and caps the line-level window at 92 days', () => {
    expect(code).toContain("p_dimension NOT IN ('category', 'brand', 'product')");
    expect(code).toContain('app._pulse_check_window(p_from, p_to_excl, 92)');
  });

  it('scopes every document read by tenant before joining line items', () => {
    expect(code).toMatch(/FROM app\.estimates e\s+WHERE e\.tenant_id = p_tenant_id/);
    expect(code).toMatch(/FROM app\.invoices i\s+WHERE i\.tenant_id = p_tenant_id/);
    expect(code).toContain('app.tenant_products tp ON tp.id = l.tenant_product_id AND tp.tenant_id = p_tenant_id');
  });

  it('documents every function', () => {
    expect(code.match(/COMMENT ON FUNCTION/g)!.length).toBe(3);
  });
});
