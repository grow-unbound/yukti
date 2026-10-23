import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261023053003_pulse_v2_primary_demand_conversion.sql'),
  'utf8',
);

describe('Pulse v2 primary demand and conversion migration', () => {
  it('selects exactly one primary demand document kind', () => {
    expect(sql).toContain('app.metrics_v4_primary_demand_kind(p_tenant_id)');
    expect(sql).toContain("'primary_demand_kind', settings.primary_kind");
    expect(sql).toMatch(/'demand_value', CASE settings\.primary_kind/);
    expect(sql).toMatch(/WHEN 'estimates' THEN COALESCE\(\(SELECT sum\(total_amount\) FROM est\)/);
    expect(sql).toMatch(/WHEN 'orders' THEN COALESCE\(\(SELECT sum\(total_amount\) FROM ord\)/);
    expect(sql).not.toContain("COALESCE((SELECT sum(total_amount) FROM est), 0) + COALESCE((SELECT sum(total_amount) FROM ord), 0)");
  });

  it('uses the same invoice-date cohort for attributed and total invoiced values', () => {
    expect(sql).toContain("'app_invoiced_value', COALESCE((SELECT sum(total_amount) FROM inv WHERE is_app), 0)");
    expect(sql).toContain("'total_invoiced_value', COALESCE((SELECT sum(total_amount) FROM inv), 0)");
    expect(sql).not.toMatch(/'app_invoiced_value', CASE settings\.primary_kind/);
  });

  it('backfills invoice attribution only through existing buyer-app links', () => {
    expect(sql).toContain('SET is_buyer_app_invoice = true');
    expect(sql).toContain('e.id = i.estimate_id');
    expect(sql).toContain('e.converted_to_invoice_id = i.id');
    expect(sql).toContain('o.id = i.order_id');
    expect(sql).not.toMatch(/SET\s+(estimate_id|order_id)\s*=/i);
  });

  it('keeps the RPC service-side and pins its search path', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO 'pg_catalog', 'app'");
    expect(sql).toContain('REVOKE ALL ON FUNCTION app._pulse_window_metrics(uuid, date, date) FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION app._pulse_window_metrics(uuid, date, date) TO service_role');
  });
});
