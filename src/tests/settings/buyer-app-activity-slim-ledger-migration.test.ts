import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
const noop = read('20261018010000_buyer_app_activity_daily_idempotent_noop.sql');
const fanout = read('20261018010100_buyer_app_activity_drop_fanout_engagement_view.sql');

describe('slim buyer_app_activity ledger migrations', () => {
  it('makes a duplicate idempotency key a no-op instead of a row rewrite', () => {
    expect(noop).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
    expect(noop).not.toContain('DO UPDATE');
    expect(noop).toContain("auth.uid()"); // claim checks and inserted audit columns kept
    expect(noop).toContain("RAISE EXCEPTION 'forbidden'");
  });

  it('exposes engagement days as ledger UNION buyer-app estimates/orders by canonical metric day', () => {
    const view = fanout.slice(fanout.indexOf('CREATE OR REPLACE VIEW app.buyer_app_engagement'), fanout.indexOf('COMMENT ON VIEW'));
    expect(view).toContain('security_invoker = true');
    expect(view).toContain('FROM app.buyer_app_activity a');
    expect(view).toContain('app.metric_day_ist(e.estimate_date, e.created_at)');
    expect(view).toContain('e.is_buyer_app_estimate');
    expect(view).toContain('app.metric_day_ist(o.order_date, o.created_at)');
    expect(view).toContain('o.is_buyer_app_order');
    expect(fanout).toMatch(/REVOKE ALL ON app\.buyer_app_engagement FROM PUBLIC, anon/);
    expect(fanout).not.toMatch(/GRANT[^;]*buyer_app_engagement TO (?:anon|PUBLIC)/i);
  });

  it('drops the per-row write fan-out and keeps mirror callers valid as no-ops', () => {
    for (const trg of [
      'DROP TRIGGER IF EXISTS trg_metrics_v2_capture_buyer_app_activity ON app.buyer_app_activity',
      'DROP TRIGGER IF EXISTS trg_metrics_v2_capture_buyer_app_activity_upd ON app.buyer_app_activity',
      'DROP TRIGGER IF EXISTS trg_estimates_dispatch ON app.estimates',
      'DROP TRIGGER IF EXISTS trg_orders_dispatch ON app.orders',
    ]) {
      expect(fanout).toContain(trg);
    }
    expect(fanout).toContain('CREATE OR REPLACE FUNCTION app.sync_buyer_app_activity_from_estimate(p_estimate_id uuid)');
    expect(fanout).toContain('CREATE OR REPLACE FUNCTION app.sync_buyer_app_activity_from_order(p_order_id uuid)');
    expect(fanout).not.toContain('DROP FUNCTION IF EXISTS app.sync_buyer_app_activity_from');
    expect(fanout).toContain('DROP INDEX IF EXISTS app.idx_buyer_app_activity_source_lookup');
  });

  it('repoints engagement readers to the view and no longer reads the raw table', () => {
    const dash = fanout.slice(fanout.indexOf('FUNCTION app.get_buyer_app_dashboard_v4'), fanout.indexOf('FUNCTION app.compute_ops_daily_rollup', fanout.indexOf('FUNCTION app.get_buyer_app_dashboard_v4')));
    const ops = fanout.slice(fanout.toLowerCase().indexOf('function app.compute_ops_daily_rollup'));
    expect(dash).toContain('app.buyer_app_engagement');
    expect(dash).not.toContain('app.buyer_app_activity');
    expect(ops).toContain('from app.buyer_app_engagement');
    expect(ops).not.toContain('from app.buyer_app_activity');
  });
});
