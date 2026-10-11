-- Reconcile the seller-app /pulse aggregates (metrics_tenant_period_summary -> metrics_landing_kpi_snapshot 'buyer_app') against raw tables,
-- using the same predicates as the refresh pipeline. Params: {{TENANTS}} {{START}} {{END}}
with tn as (select unnest(array[{{TENANTS}}]::uuid[]) as tenant_id),
months as (
  select tn.tenant_id, g::date as ms
  from tn, generate_series(date_trunc('month', date '{{START}}'), date '{{END}}', interval '1 month') g
),
raw as (
  select m.tenant_id, m.ms,
    (select count(*) from app.estimates e where e.tenant_id = m.tenant_id and e.deleted_at is null and e.is_buyer_app_estimate and app.estimate_status_counts_as_demand(e.status)
       and app.metric_day_ist(e.estimate_date, e.created_at) >= m.ms and app.metric_day_ist(e.estimate_date, e.created_at) < (m.ms + interval '1 month')::date) as app_est_n,
    (select round(coalesce(sum(e.total_amount), 0)) from app.estimates e where e.tenant_id = m.tenant_id and e.deleted_at is null and e.is_buyer_app_estimate and app.estimate_status_counts_as_demand(e.status)
       and app.metric_day_ist(e.estimate_date, e.created_at) >= m.ms and app.metric_day_ist(e.estimate_date, e.created_at) < (m.ms + interval '1 month')::date) as app_est_v,
    (select count(distinct e.buyer_id) from app.estimates e where e.tenant_id = m.tenant_id and e.deleted_at is null and e.is_buyer_app_estimate and app.estimate_status_counts_as_demand(e.status)
       and app.metric_day_ist(e.estimate_date, e.created_at) >= m.ms and app.metric_day_ist(e.estimate_date, e.created_at) < (m.ms + interval '1 month')::date) as app_est_buyers,
    (select count(*) from app.invoices i where i.tenant_id = m.tenant_id and i.deleted_at is null and app.invoice_status_gmv_included(i.status)
       and app.metric_day_ist(i.invoice_date, i.created_at) >= m.ms and app.metric_day_ist(i.invoice_date, i.created_at) < (m.ms + interval '1 month')::date) as inv_n,
    (select round(coalesce(sum(i.total_amount), 0)) from app.invoices i where i.tenant_id = m.tenant_id and i.deleted_at is null and app.invoice_status_gmv_included(i.status)
       and app.metric_day_ist(i.invoice_date, i.created_at) >= m.ms and app.metric_day_ist(i.invoice_date, i.created_at) < (m.ms + interval '1 month')::date) as inv_v,
    (select count(*) from app.invoices i where i.tenant_id = m.tenant_id and i.deleted_at is null and i.is_buyer_app_invoice and app.invoice_status_gmv_included(i.status)
       and app.metric_day_ist(i.invoice_date, i.created_at) >= m.ms and app.metric_day_ist(i.invoice_date, i.created_at) < (m.ms + interval '1 month')::date) as app_inv_n,
    (select round(coalesce(sum(i.total_amount), 0)) from app.invoices i where i.tenant_id = m.tenant_id and i.deleted_at is null and i.is_buyer_app_invoice and app.invoice_status_gmv_included(i.status)
       and app.metric_day_ist(i.invoice_date, i.created_at) >= m.ms and app.metric_day_ist(i.invoice_date, i.created_at) < (m.ms + interval '1 month')::date) as app_inv_v
  from months m
),
qtd as (
  select tn.tenant_id, date_trunc('quarter', date '{{END}}')::date as qs,
    (select count(*) from app.estimates e where e.tenant_id = tn.tenant_id and e.deleted_at is null and e.is_buyer_app_estimate and app.estimate_status_counts_as_demand(e.status)
       and app.metric_day_ist(e.estimate_date, e.created_at) >= date_trunc('quarter', date '{{END}}')::date and app.metric_day_ist(e.estimate_date, e.created_at) < (date_trunc('quarter', date '{{END}}') + interval '3 month')::date) as demand_n,
    (select round(coalesce(sum(e.total_amount), 0)) from app.estimates e where e.tenant_id = tn.tenant_id and e.deleted_at is null and e.is_buyer_app_estimate and app.estimate_status_counts_as_demand(e.status)
       and app.metric_day_ist(e.estimate_date, e.created_at) >= date_trunc('quarter', date '{{END}}')::date and app.metric_day_ist(e.estimate_date, e.created_at) < (date_trunc('quarter', date '{{END}}') + interval '3 month')::date) as demand_v,
    (select count(*) from app.invoices i where i.tenant_id = tn.tenant_id and i.is_buyer_app_invoice and app.invoice_status_gmv_included(i.status) and i.deleted_at is null
       and i.invoice_date >= date_trunc('quarter', date '{{END}}')::date and i.invoice_date < (date_trunc('quarter', date '{{END}}') + interval '3 month')::date) as app_inv_n,
    (select round(coalesce(sum(i.total_amount), 0)) from app.invoices i where i.tenant_id = tn.tenant_id and i.is_buyer_app_invoice and app.invoice_status_gmv_included(i.status) and i.deleted_at is null
       and i.invoice_date >= date_trunc('quarter', date '{{END}}')::date and i.invoice_date < (date_trunc('quarter', date '{{END}}') + interval '3 month')::date) as app_inv_v,
    (select count(*) from app.buyers b where b.tenant_id = tn.tenant_id and b.deleted_at is null and b.buyer_app_enabled) as enabled_buyers
  from tn
)
select jsonb_build_object(
  'months', coalesce((select jsonb_agg(jsonb_build_object(
      'tenant_id', r.tenant_id, 'month', to_char(r.ms, 'YYYY-MM'),
      'agg_est_n', a.app_estimate_count, 'agg_est_v', round(a.app_estimate_value), 'agg_est_buyers', a.app_estimate_buyer_count,
      'agg_inv_n', a.invoice_count, 'agg_inv_v', round(a.invoice_value), 'agg_computed_at', a.computed_at, 'agg_watermark', a.source_watermark,
      'raw_est_n', r.app_est_n, 'raw_est_v', r.app_est_v, 'raw_est_buyers', r.app_est_buyers,
      'raw_inv_n', r.inv_n, 'raw_inv_v', r.inv_v, 'raw_app_inv_n', r.app_inv_n, 'raw_app_inv_v', r.app_inv_v) order by r.tenant_id, r.ms)
      from raw r left join app.metrics_tenant_period_summary a
        on a.tenant_id = r.tenant_id and a.grain = 'month' and a.period_start = r.ms and a.deleted_at is null), '[]'::jsonb),
  'qtd', coalesce((select jsonb_agg(jsonb_build_object('tenant_id', q.tenant_id, 'quarter_start', q.qs,
      'raw_demand_n', q.demand_n, 'raw_demand_v', q.demand_v, 'raw_app_inv_n', q.app_inv_n, 'raw_app_inv_v', q.app_inv_v, 'raw_enabled', q.enabled_buyers,
      'snapshot', (select jsonb_build_object('computed_at', s.computed_at, 'kpis', s.kpis) from app.metrics_landing_kpi_snapshot s
                   where s.tenant_id = q.tenant_id and s.page_key = 'buyer_app' and s.period_key = 'this_quarter' and s.scope_kind = 'tenant'
                     and s.scope_id is null and s.period_start = q.qs and s.deleted_at is null limit 1))) from qtd q), '[]'::jsonb),
  'daily_last_day', coalesce((select jsonb_object_agg(tenant_id::text, d) from (select tenant_id, max(day) as d from app.metrics_tenant_daily where tenant_id in ({{TENANTS}}) and deleted_at is null group by 1) x), '{}'::jsonb),
  'tick', coalesce((select jsonb_agg(jsonb_build_object('job', jobname, 'active', active, 'schedule', schedule)) from cron.job where jobname = 'metrics-refresh-tick'), '[]'::jsonb)
) as d;
