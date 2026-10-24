import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'supabase/migrations');
const name = readdirSync(dir).find((f) => f.endsWith('_landing_kpis_from_raw_tier1.sql'))!;
const sql = readFileSync(path.join(dir, name), 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

const PAGES = ['dashboard', 'estimates', 'orders', 'invoices', 'customers', 'locations', 'buyer_app', 'customer_groups', 'price_lists', 'campaigns'];

describe('landing KPIs tier 1 (raw tables)', () => {
  it('reads no metrics_* summary or snapshot table', () => {
    expect(code).not.toMatch(/app\.metrics_(?!v4_kpi|v4_period_bounds|v4_primary_demand_kind)[a-z_0-9]+/);
  });

  it('dispatches every tier-1 page and rejects the rest', () => {
    for (const page of PAGES) expect(code).toContain(`WHEN '${page}' THEN app._landing_kpis_${page}(`);
    expect(code).toContain("'landing_page_unsupported:%'");
    expect(code).toContain("'landing_period_invalid:%'");
    expect(code).toContain("'landing_identity_required'");
    for (const page of ['products', 'categories', 'brands', 'warehouses']) expect(code).not.toContain(`WHEN '${page}' THEN`);
  });

  it('keeps card ids that clients key on', () => {
    for (const id of [
      'invoiced_sales', 'demand', 'outstanding_dues', 'overdue_receivables', 'estimate_value_created', 'open_estimates', 'awaiting_action_3d',
      'expiring_7d', 'order_value_created', 'open_orders', 'waiting_confirmation', 'awaiting_dispatch_3d', 'due_7d', 'active_customers',
      'dormant_customers', 'top80_customers', 'open_demand', 'top80_locations', 'customers_with_access', 'app_sourced_demand_qtd',
      'app_sourced_invoiced_sales_qtd', 'app_no_order_customers_qtd', 'active_groups', 'customers_assigned', 'valuable_no_group',
      'grouped_purchased', 'custom_price_products', 'custom_price_customers', 'below_base_products', 'live_campaigns', 'campaign_open_rate',
      'campaign_demand', 'campaign_revenue',
    ]) {
      expect(code).toContain(`metrics_v4_kpi('${id}'`);
    }
  });

  it('is service_role only, pins search_path and keeps canonical helpers', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION app\.get_landing_kpis\(uuid, text, text, timestamptz\) FROM PUBLIC, anon, authenticated/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION app\.get_landing_kpis\(uuid, text, text, timestamptz\) TO service_role/);
    expect(code).not.toMatch(/GRANT[^;]*get_landing_kpis[^;]*(anon|authenticated|PUBLIC)/);
    expect(code).toMatch(/SECURITY DEFINER\s+SET search_path TO 'pg_catalog', 'app'/);
    for (const helper of ['app.metric_day_ist', 'app.invoice_status_gmv_included', 'app.estimate_status_counts_as_demand', 'app.order_status_in_flow']) {
      expect(code).toContain(helper);
    }
  });

  it('casts numeric sums to bigint where the KPI helper expects counts', () => {
    expect(code).toMatch(/COALESCE\(sum\(loc\.c\), 0\)::bigint/);
    expect(code).toMatch(/COALESCE\(sum\(d\.cnt\), 0\)::bigint/);
  });
});
