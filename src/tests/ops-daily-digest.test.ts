import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildDigestMessage,
  formatDocumentMetric,
  formatTenantActivity,
  tenantActivityScore,
  type DigestRollupRow,
} from '../../supabase/functions/_shared/ops-daily-digest';

const baseRow: DigestRollupRow = {
  tenant_id: null,
  estimates_enabled: true,
  orders_enabled: true,
  invoices_enabled: true,
  primary_demand_kind: 'mixed',
  estimate_count: 10,
  estimate_value: 125_000,
  estimate_buyer_count: 7,
  estimate_void_count: 1,
  order_count: 5,
  order_value: 75_000,
  order_buyer_count: 4,
  order_cancelled_count: 1,
  invoice_count: 4,
  invoice_value: 65_000,
  invoice_buyer_count: 3,
  invoice_excluded_count: 1,
  app_estimate_count: 8,
  app_estimate_value: 100_000,
  app_estimate_buyer_count: 6,
  app_order_count: 3,
  app_order_value: 45_000,
  app_order_buyer_count: 3,
  app_invoice_count: 2,
  app_invoice_value: 32_500,
  app_invoice_buyer_count: 2,
  app_user_count: 12,
  app_demand_buyer_count: 8,
  repeat_app_demand_buyer_count: 2,
  first_time_app_user_count: 3,
  new_customer_record_count: 4,
  webhook_event_count: 100,
  webhook_failed_event_count: 2,
  webhook_error_count: 5,
  webhook_retryable_error_count: 4,
  webhook_error_critical_count: 1,
  sync_job_success_count: 3,
  sync_job_failure_count: 1,
  stale_integration_count: 0,
  post_sync_rebuild_failure_count: 0,
  active_tenant_count: 2,
  computed_at: '2026-10-24T03:16:00.000Z',
  calculation_version: 2,
};

describe('ops daily digest formatter', () => {
  it('shows value, document count and distinct buyers together', () => {
    expect(formatDocumentMetric(865_526, 146, 122, 'invoice'))
      .toBe('₹8,65,526 · 146 invoices · 122 buyers');
  });

  it('uses tenant feature visibility and leads with estimates', () => {
    const estimateOnly = {
      ...baseRow,
      tenant_id: 'wine-yard',
      estimates_enabled: true,
      orders_enabled: false,
      invoices_enabled: true,
      primary_demand_kind: 'estimates',
    };
    const text = formatTenantActivity(estimateOnly, 'Wine Yard Technologies');
    expect(text).toContain('*Wine Yard Technologies*\nEstimates:');
    expect(text).toContain('\nInvoices:');
    expect(text).not.toContain('\nOrders:');
  });

  it('ranks an enquiry-enabled tenant by estimate value', () => {
    const estimateTenant = {
      ...baseRow,
      tenant_id: 'estimate-tenant',
      estimate_value: 500_000,
      invoice_value: 10,
      estimates_enabled: true,
      orders_enabled: false,
      primary_demand_kind: 'estimates',
    };
    const invoiceTenant = {
      ...baseRow,
      tenant_id: 'invoice-tenant',
      estimate_value: 0,
      invoice_value: 900_000,
      estimates_enabled: false,
      orders_enabled: false,
      invoices_enabled: true,
      primary_demand_kind: 'none',
    };
    expect(tenantActivityScore(estimateTenant)).toBe(500_000);
    expect(tenantActivityScore(invoiceTenant)).toBe(900_000);
  });

  it('renders freshness, explicit health and critical alerts before warnings', () => {
    const message = buildDigestMessage({
      day: '2026-10-23',
      globalRow: baseRow,
      tenantRows: [{ ...baseRow, tenant_id: 'tenant-1', primary_demand_kind: 'estimates' }],
      tenants: [{ id: 'tenant-1', business_name: 'Tenant One' }],
      flags: [
        { tenant_id: 'tenant-1', metric: 'sync', severity: 'warning', current_value: 1, baseline_value: 0, delta_pct: null, message: '1 failed sync job; 3 completed' },
        { tenant_id: 'tenant-1', metric: 'webhook', severity: 'critical', current_value: 1, baseline_value: 0, delta_pct: null, message: '1 non-retryable webhook error across 1 failed event' },
      ],
    });
    const rendered = JSON.stringify(message.blocks);
    expect(rendered).toContain('calculation v2');
    expect(rendered).toContain('100 events · 5 errors · 1 non-retryable');
    expect(rendered).toContain('₹1,00,000 · 8 estimates · 6 buyers · 80% of value');
    expect(rendered).toContain('₹32,500 · 2 invoices · 2 buyers · 50% of value');
    expect(rendered.indexOf('non-retryable webhook error')).toBeLessThan(rendered.indexOf('failed sync job'));
    expect(message.text).toContain('1 critical alert');
  });

  it('does not overclaim normality when no alert rules trigger', () => {
    const message = buildDigestMessage({
      day: '2026-10-23',
      globalRow: { ...baseRow, webhook_error_count: 0, webhook_error_critical_count: 0, sync_job_failure_count: 0 },
      tenantRows: [],
      tenants: [{ id: 'tenant-1', business_name: 'Tenant One' }],
      flags: [],
    });
    const rendered = JSON.stringify(message.blocks);
    expect(rendered).toContain('No alerts triggered across 1 tenants');
    expect(rendered).not.toContain('all metrics within normal range');
  });
});

describe('ops daily digest v2 migration and delivery wiring', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261024035738_ops_daily_digest_v2.sql'),
    'utf8',
  );
  const edgeFunction = readFileSync(
    join(process.cwd(), 'supabase/functions/ops-daily-digest/index.ts'),
    'utf8',
  );

  it('uses canonical dates and shared status predicates for every document type', () => {
    expect(migration).toContain('app.metric_day_ist(e.estimate_date, e.created_at) = p_day');
    expect(migration).toContain('app.metric_day_ist(o.order_date, o.created_at) = p_day');
    expect(migration).toContain('app.metric_day_ist(i.invoice_date, i.created_at) = p_day');
    expect(migration).toContain('app.estimate_status_counts_as_demand(e.status)');
    expect(migration).toContain('app.order_status_in_flow(o.status)');
    expect(migration).toContain('app.invoice_status_gmv_included(i.status)');
  });

  it('persists feature-aware buyer counts, operational health and calculation v2', () => {
    for (const fragment of [
      'estimate_buyer_count',
      'order_buyer_count',
      'invoice_buyer_count',
      'app_user_count',
      'app_demand_buyer_count',
      'webhook_failed_event_count',
      'stale_integration_count',
      'calculation_version',
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).toContain('v_computed_at, 2');
  });

  it('protects delivery state, retries once and returns non-2xx failure responses', () => {
    expect(migration).toContain('alter table app.ops_daily_digest_deliveries enable row level security');
    expect(migration).toContain("'ops-daily-digest-retry'");
    expect(edgeFunction).toContain("skipped: 'already_sent'");
    expect(edgeFunction).toContain("fail(503, 'no_rollup_for_day')");
    expect(edgeFunction).toContain("fail(502, 'slack_post_failed'");
    expect(edgeFunction).toContain("status: 'sent'");
  });
});
