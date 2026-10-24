-- Daily ops digest v2: canonical metric semantics, feature-aware tenant
-- presentation, explicit operational health, and idempotent delivery state.

alter table app.ops_daily_rollup
  add column if not exists estimates_enabled boolean not null default false,
  add column if not exists orders_enabled boolean not null default false,
  add column if not exists invoices_enabled boolean not null default false,
  add column if not exists primary_demand_kind text not null default 'none',
  add column if not exists estimate_buyer_count bigint not null default 0,
  add column if not exists estimate_void_count bigint not null default 0,
  add column if not exists app_estimate_count bigint not null default 0,
  add column if not exists app_estimate_value numeric not null default 0,
  add column if not exists app_estimate_buyer_count bigint not null default 0,
  add column if not exists order_buyer_count bigint not null default 0,
  add column if not exists order_cancelled_count bigint not null default 0,
  add column if not exists app_order_buyer_count bigint not null default 0,
  add column if not exists invoice_buyer_count bigint not null default 0,
  add column if not exists invoice_excluded_count bigint not null default 0,
  add column if not exists app_invoice_count bigint not null default 0,
  add column if not exists app_invoice_value numeric not null default 0,
  add column if not exists app_invoice_buyer_count bigint not null default 0,
  add column if not exists app_user_count bigint not null default 0,
  add column if not exists app_demand_buyer_count bigint not null default 0,
  add column if not exists repeat_app_demand_buyer_count bigint not null default 0,
  add column if not exists first_time_app_user_count bigint not null default 0,
  add column if not exists new_customer_record_count bigint not null default 0,
  add column if not exists webhook_event_count bigint not null default 0,
  add column if not exists webhook_failed_event_count bigint not null default 0,
  add column if not exists webhook_retryable_error_count bigint not null default 0,
  add column if not exists sync_job_success_count bigint not null default 0,
  add column if not exists stale_integration_count bigint not null default 0,
  add column if not exists post_sync_rebuild_failure_count bigint not null default 0;

comment on column app.ops_daily_rollup.primary_demand_kind is
  'Digest presentation mode. Estimates lead whenever enquiries are enabled; otherwise orders lead when sales orders are enabled.';
comment on column app.ops_daily_rollup.active_buyer_count is
  'Compatibility alias for app_user_count: distinct buyers with qualifying buyer-app engagement on the day.';
comment on column app.ops_daily_rollup.webhook_failed_event_count is
  'Distinct webhook events with one or more error records; avoids counting retries as separate failed events.';

create table if not exists app.ops_daily_digest_deliveries (
  day date primary key,
  status text not null default 'pending'
    check (status in ('pending', 'attempting', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  rollup_computed_at timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  response_status integer,
  error_category text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table app.ops_daily_digest_deliveries is
  'One idempotency and delivery-health row per Slack daily digest. Contains no webhook URL, token, or message payload.';

alter table app.ops_daily_digest_deliveries enable row level security;
revoke all on app.ops_daily_digest_deliveries from public, anon, authenticated;
grant select, insert, update on app.ops_daily_digest_deliveries to service_role;

create or replace function app.compute_ops_daily_rollup(p_day date)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'app'
as $function$
declare
  v_computed_at timestamptz := clock_timestamp();
begin
  delete from app.ops_daily_rollup where day = p_day;

  with tenant_config as materialized (
    select
      t.id as tenant_id,
      coalesce((ts.settings #>> '{orders,features,enquiries}')::boolean, false) as estimates_enabled,
      coalesce((ts.settings #>> '{orders,features,sales_orders}')::boolean, false) as orders_enabled,
      coalesce((ts.settings #>> '{orders,features,invoices}')::boolean, false) as invoices_enabled
    from app.tenants t
    left join app.tenant_settings ts on ts.tenant_id = t.id
    where t.deleted_at is null
  ),
  tenant_estimates as (
    select
      e.tenant_id,
      count(*) filter (where app.estimate_status_counts_as_demand(e.status)) as estimate_count,
      coalesce(sum(e.total_amount) filter (where app.estimate_status_counts_as_demand(e.status)), 0) as estimate_value,
      count(distinct e.buyer_id) filter (where app.estimate_status_counts_as_demand(e.status)) as estimate_buyer_count,
      count(*) filter (where not app.estimate_status_counts_as_demand(e.status)) as estimate_void_count,
      count(*) filter (where app.estimate_status_counts_as_demand(e.status) and e.is_buyer_app_estimate) as app_estimate_count,
      coalesce(sum(e.total_amount) filter (where app.estimate_status_counts_as_demand(e.status) and e.is_buyer_app_estimate), 0) as app_estimate_value,
      count(distinct e.buyer_id) filter (where app.estimate_status_counts_as_demand(e.status) and e.is_buyer_app_estimate) as app_estimate_buyer_count
    from app.estimates e
    where app.metric_day_ist(e.estimate_date, e.created_at) = p_day
      and e.deleted_at is null
    group by e.tenant_id
  ),
  tenant_orders as (
    select
      o.tenant_id,
      count(*) filter (where app.order_status_in_flow(o.status)) as order_count,
      coalesce(sum(o.total_amount) filter (where app.order_status_in_flow(o.status)), 0) as order_value,
      count(distinct o.buyer_id) filter (where app.order_status_in_flow(o.status)) as order_buyer_count,
      count(*) filter (where not app.order_status_in_flow(o.status)) as order_cancelled_count,
      count(*) filter (where app.order_status_in_flow(o.status) and o.is_buyer_app_order) as app_order_count,
      coalesce(sum(o.total_amount) filter (where app.order_status_in_flow(o.status) and o.is_buyer_app_order), 0) as app_order_value,
      count(distinct o.buyer_id) filter (where app.order_status_in_flow(o.status) and o.is_buyer_app_order) as app_order_buyer_count
    from app.orders o
    where app.metric_day_ist(o.order_date, o.created_at) = p_day
      and o.deleted_at is null
    group by o.tenant_id
  ),
  tenant_invoices as (
    select
      i.tenant_id,
      count(*) filter (where app.invoice_status_gmv_included(i.status)) as invoice_count,
      coalesce(sum(i.total_amount) filter (where app.invoice_status_gmv_included(i.status)), 0) as invoice_value,
      count(distinct i.buyer_id) filter (where app.invoice_status_gmv_included(i.status)) as invoice_buyer_count,
      count(*) filter (where not app.invoice_status_gmv_included(i.status)) as invoice_excluded_count,
      count(*) filter (where app.invoice_status_gmv_included(i.status) and i.is_buyer_app_invoice) as app_invoice_count,
      coalesce(sum(i.total_amount) filter (where app.invoice_status_gmv_included(i.status) and i.is_buyer_app_invoice), 0) as app_invoice_value,
      count(distinct i.buyer_id) filter (where app.invoice_status_gmv_included(i.status) and i.is_buyer_app_invoice) as app_invoice_buyer_count
    from app.invoices i
    where app.metric_day_ist(i.invoice_date, i.created_at) = p_day
      and i.deleted_at is null
    group by i.tenant_id
  ),
  tenant_new_customers as (
    select b.tenant_id, count(*) as new_customer_record_count
    from app.buyers b
    where b.deleted_at is null
      and (b.created_at at time zone 'Asia/Kolkata')::date = p_day
    group by b.tenant_id
  ),
  app_engagement_days as materialized (
    select a.tenant_id, a.buyer_id, a.occurred_day
    from app.buyer_app_activity a
    where a.deleted_at is null
      and a.qualifies_for_engagement
      and a.buyer_id is not null
    union
    select e.tenant_id, e.buyer_id, app.metric_day_ist(e.estimate_date, e.created_at)
    from app.estimates e
    where e.deleted_at is null
      and e.buyer_id is not null
      and e.is_buyer_app_estimate
      and app.estimate_status_counts_as_demand(e.status)
    union
    select o.tenant_id, o.buyer_id, app.metric_day_ist(o.order_date, o.created_at)
    from app.orders o
    where o.deleted_at is null
      and o.buyer_id is not null
      and o.is_buyer_app_order
      and app.order_status_in_flow(o.status)
  ),
  today_app_users as materialized (
    select distinct a.tenant_id, a.buyer_id
    from app_engagement_days a
    where a.occurred_day = p_day
  ),
  tenant_app_users as (
    select
      u.tenant_id,
      count(*) as app_user_count,
      count(*) filter (
        where not exists (
          select 1
          from app_engagement_days prior
          where prior.tenant_id = u.tenant_id
            and prior.buyer_id = u.buyer_id
            and prior.occurred_day < p_day
        )
      ) as first_time_app_user_count
    from today_app_users u
    group by u.tenant_id
  ),
  app_demand_documents as materialized (
    select e.tenant_id, e.buyer_id, e.id as document_id
    from app.estimates e
    join tenant_config tc on tc.tenant_id = e.tenant_id and tc.estimates_enabled
    where e.deleted_at is null
      and e.buyer_id is not null
      and e.is_buyer_app_estimate
      and app.estimate_status_counts_as_demand(e.status)
      and app.metric_day_ist(e.estimate_date, e.created_at) = p_day
    union all
    select o.tenant_id, o.buyer_id, o.id
    from app.orders o
    join tenant_config tc on tc.tenant_id = o.tenant_id and tc.orders_enabled
    where o.deleted_at is null
      and o.buyer_id is not null
      and o.is_buyer_app_order
      and app.order_status_in_flow(o.status)
      and app.metric_day_ist(o.order_date, o.created_at) = p_day
  ),
  tenant_app_demand as (
    select
      d.tenant_id,
      count(distinct d.buyer_id) as app_demand_buyer_count,
      count(*) filter (where d.document_count >= 2) as repeat_app_demand_buyer_count
    from (
      select tenant_id, buyer_id, count(*) as document_count
      from app_demand_documents
      group by tenant_id, buyer_id
    ) d
    group by d.tenant_id
  ),
  tenant_webhook_events as (
    select
      w.tenant_id,
      count(*) as webhook_event_count,
      count(*) filter (where w.processing_status = 'failed') as processing_failed_event_count
    from app.integration_webhook_events w
    where w.deleted_at is null
      and (w.received_at at time zone 'Asia/Kolkata')::date = p_day
    group by w.tenant_id
  ),
  tenant_webhook_errors as (
    select
      e.tenant_id,
      count(*) as webhook_error_count,
      count(*) filter (where e.retryable) as webhook_retryable_error_count,
      count(*) filter (where not e.retryable) as webhook_error_critical_count,
      count(distinct e.integration_webhook_event_id) filter (where e.integration_webhook_event_id is not null) as webhook_failed_event_count
    from app.integration_webhook_errors e
    where e.deleted_at is null
      and (e.created_at at time zone 'Asia/Kolkata')::date = p_day
    group by e.tenant_id
  ),
  tenant_sync_jobs as (
    select
      j.tenant_id,
      count(*) filter (where j.status = 'completed') as sync_job_success_count,
      count(*) filter (where j.status = 'failed') as sync_job_failure_count,
      count(*) filter (where coalesce((j.progress #>> '{meta,post_sync_rebuild_failed}')::boolean, false)) as post_sync_rebuild_failure_count
    from app.integration_sync_jobs j
    where j.deleted_at is null
      and j.master_job_id is null
      and (coalesce(j.completed_at, j.updated_at) at time zone 'Asia/Kolkata')::date = p_day
    group by j.tenant_id
  ),
  tenant_stale_integrations as (
    select ti.tenant_id, count(*) as stale_integration_count
    from app.tenant_integrations ti
    where ti.deleted_at is null
      and ti.integration_type_id in ('zoho_books', 'zoho_inventory')
      and not ti.sync_suspended
      and ti.status in ('connected', 'syncing', 'sync_failed')
      and not exists (
        select 1
        from app.integration_sync_jobs j
        where j.tenant_integration_id = ti.id
          and j.deleted_at is null
          and j.master_job_id is null
          and j.run_kind = 'daily_incremental'
          and j.status = 'completed'
          and (coalesce(j.completed_at, j.updated_at) at time zone 'Asia/Kolkata')::date = p_day
      )
    group by ti.tenant_id
  ),
  tenant_rows as (
    select
      tc.tenant_id,
      tc.estimates_enabled,
      tc.orders_enabled,
      tc.invoices_enabled,
      case when tc.estimates_enabled then 'estimates' when tc.orders_enabled then 'orders' else 'none' end as primary_demand_kind,
      coalesce(o.order_count, 0) as order_count,
      coalesce(o.order_value, 0) as order_value,
      coalesce(o.order_buyer_count, 0) as order_buyer_count,
      coalesce(o.order_cancelled_count, 0) as order_cancelled_count,
      coalesce(o.app_order_count, 0) as app_order_count,
      coalesce(o.app_order_value, 0) as app_order_value,
      coalesce(o.app_order_buyer_count, 0) as app_order_buyer_count,
      coalesce(i.invoice_count, 0) as invoice_count,
      coalesce(i.invoice_value, 0) as invoice_value,
      coalesce(i.invoice_buyer_count, 0) as invoice_buyer_count,
      coalesce(i.invoice_excluded_count, 0) as invoice_excluded_count,
      coalesce(i.app_invoice_count, 0) as app_invoice_count,
      coalesce(i.app_invoice_value, 0) as app_invoice_value,
      coalesce(i.app_invoice_buyer_count, 0) as app_invoice_buyer_count,
      coalesce(e.estimate_count, 0) as estimate_count,
      coalesce(e.estimate_value, 0) as estimate_value,
      coalesce(e.estimate_buyer_count, 0) as estimate_buyer_count,
      coalesce(e.estimate_void_count, 0) as estimate_void_count,
      coalesce(e.app_estimate_count, 0) as app_estimate_count,
      coalesce(e.app_estimate_value, 0) as app_estimate_value,
      coalesce(e.app_estimate_buyer_count, 0) as app_estimate_buyer_count,
      coalesce(au.app_user_count, 0) as app_user_count,
      coalesce(ad.app_demand_buyer_count, 0) as app_demand_buyer_count,
      coalesce(ad.repeat_app_demand_buyer_count, 0) as repeat_app_demand_buyer_count,
      coalesce(au.first_time_app_user_count, 0) as first_time_app_user_count,
      coalesce(nc.new_customer_record_count, 0) as new_customer_record_count,
      coalesce(wev.webhook_event_count, 0) as webhook_event_count,
      greatest(coalesce(wev.processing_failed_event_count, 0), coalesce(wer.webhook_failed_event_count, 0)) as webhook_failed_event_count,
      coalesce(wer.webhook_error_count, 0) as webhook_error_count,
      coalesce(wer.webhook_retryable_error_count, 0) as webhook_retryable_error_count,
      coalesce(wer.webhook_error_critical_count, 0) as webhook_error_critical_count,
      coalesce(sj.sync_job_success_count, 0) as sync_job_success_count,
      coalesce(sj.sync_job_failure_count, 0) as sync_job_failure_count,
      coalesce(si.stale_integration_count, 0) as stale_integration_count,
      coalesce(sj.post_sync_rebuild_failure_count, 0) as post_sync_rebuild_failure_count
    from tenant_config tc
    left join tenant_orders o on o.tenant_id = tc.tenant_id
    left join tenant_invoices i on i.tenant_id = tc.tenant_id
    left join tenant_estimates e on e.tenant_id = tc.tenant_id
    left join tenant_app_users au on au.tenant_id = tc.tenant_id
    left join tenant_app_demand ad on ad.tenant_id = tc.tenant_id
    left join tenant_new_customers nc on nc.tenant_id = tc.tenant_id
    left join tenant_webhook_events wev on wev.tenant_id = tc.tenant_id
    left join tenant_webhook_errors wer on wer.tenant_id = tc.tenant_id
    left join tenant_sync_jobs sj on sj.tenant_id = tc.tenant_id
    left join tenant_stale_integrations si on si.tenant_id = tc.tenant_id
  )
  insert into app.ops_daily_rollup (
    day, tenant_id,
    estimates_enabled, orders_enabled, invoices_enabled, primary_demand_kind,
    order_count, order_value, order_buyer_count, order_cancelled_count,
    app_order_count, app_order_value, app_order_buyer_count,
    invoice_count, invoice_value, invoice_buyer_count, invoice_excluded_count,
    app_invoice_count, app_invoice_value, app_invoice_buyer_count,
    estimate_count, estimate_value, estimate_buyer_count, estimate_void_count,
    app_estimate_count, app_estimate_value, app_estimate_buyer_count,
    active_buyer_count, app_user_count, app_demand_buyer_count,
    repeat_app_demand_buyer_count, first_time_app_user_count,
    new_buyer_count, new_customer_record_count,
    webhook_event_count, webhook_failed_event_count, webhook_error_count,
    webhook_retryable_error_count, webhook_error_critical_count,
    sync_job_success_count, sync_job_failure_count, stale_integration_count,
    post_sync_rebuild_failure_count, active_tenant_count, computed_at, calculation_version
  )
  select
    p_day, tenant_id,
    estimates_enabled, orders_enabled, invoices_enabled, primary_demand_kind,
    order_count, order_value, order_buyer_count, order_cancelled_count,
    app_order_count, app_order_value, app_order_buyer_count,
    invoice_count, invoice_value, invoice_buyer_count, invoice_excluded_count,
    app_invoice_count, app_invoice_value, app_invoice_buyer_count,
    estimate_count, estimate_value, estimate_buyer_count, estimate_void_count,
    app_estimate_count, app_estimate_value, app_estimate_buyer_count,
    app_user_count, app_user_count, app_demand_buyer_count,
    repeat_app_demand_buyer_count, first_time_app_user_count,
    new_customer_record_count, new_customer_record_count,
    webhook_event_count, webhook_failed_event_count, webhook_error_count,
    webhook_retryable_error_count, webhook_error_critical_count,
    sync_job_success_count, sync_job_failure_count, stale_integration_count,
    post_sync_rebuild_failure_count, 0, v_computed_at, 2
  from tenant_rows;

  insert into app.ops_daily_rollup (
    day, tenant_id,
    estimates_enabled, orders_enabled, invoices_enabled, primary_demand_kind,
    order_count, order_value, order_buyer_count, order_cancelled_count,
    app_order_count, app_order_value, app_order_buyer_count,
    invoice_count, invoice_value, invoice_buyer_count, invoice_excluded_count,
    app_invoice_count, app_invoice_value, app_invoice_buyer_count,
    estimate_count, estimate_value, estimate_buyer_count, estimate_void_count,
    app_estimate_count, app_estimate_value, app_estimate_buyer_count,
    active_buyer_count, app_user_count, app_demand_buyer_count,
    repeat_app_demand_buyer_count, first_time_app_user_count,
    new_buyer_count, new_customer_record_count,
    webhook_event_count, webhook_failed_event_count, webhook_error_count,
    webhook_retryable_error_count, webhook_error_critical_count,
    sync_job_success_count, sync_job_failure_count, stale_integration_count,
    post_sync_rebuild_failure_count, active_tenant_count, computed_at, calculation_version
  )
  select
    p_day, null,
    bool_or(estimates_enabled), bool_or(orders_enabled), bool_or(invoices_enabled), 'mixed',
    sum(order_count), sum(order_value), sum(order_buyer_count), sum(order_cancelled_count),
    sum(app_order_count), sum(app_order_value), sum(app_order_buyer_count),
    sum(invoice_count), sum(invoice_value), sum(invoice_buyer_count), sum(invoice_excluded_count),
    sum(app_invoice_count), sum(app_invoice_value), sum(app_invoice_buyer_count),
    sum(estimate_count), sum(estimate_value), sum(estimate_buyer_count), sum(estimate_void_count),
    sum(app_estimate_count), sum(app_estimate_value), sum(app_estimate_buyer_count),
    sum(app_user_count), sum(app_user_count), sum(app_demand_buyer_count),
    sum(repeat_app_demand_buyer_count), sum(first_time_app_user_count),
    sum(new_customer_record_count), sum(new_customer_record_count),
    sum(webhook_event_count), sum(webhook_failed_event_count), sum(webhook_error_count),
    sum(webhook_retryable_error_count), sum(webhook_error_critical_count),
    sum(sync_job_success_count), sum(sync_job_failure_count), sum(stale_integration_count),
    sum(post_sync_rebuild_failure_count),
    count(*) filter (
      where estimate_count > 0 or order_count > 0 or invoice_count > 0
         or app_user_count > 0 or webhook_event_count > 0
         or sync_job_success_count > 0 or sync_job_failure_count > 0
    ),
    v_computed_at, 2
  from app.ops_daily_rollup
  where day = p_day and tenant_id is not null;

  perform app.compute_ops_daily_flags(p_day);
end;
$function$;

revoke all on function app.compute_ops_daily_rollup(date) from public;
grant execute on function app.compute_ops_daily_rollup(date) to postgres, service_role;

create or replace function app.compute_ops_daily_flags(p_day date)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'app'
as $function$
begin
  delete from app.ops_daily_flags where day = p_day;

  drop table if exists pg_temp.ops_digest_scored;
  create temp table ops_digest_scored on commit drop as
  select
    t.*,
    b.sample_days,
    b.avg_primary_demand_count,
    b.avg_app_user_count,
    b.same_weekday_primary_demand_count
  from app.ops_daily_rollup t
  left join lateral (
    select
      count(*)::integer as sample_days,
      avg(case when t.primary_demand_kind = 'estimates' then h.estimate_count else h.order_count end) as avg_primary_demand_count,
      avg(h.app_user_count) as avg_app_user_count,
      avg(case when extract(isodow from h.day) = extract(isodow from p_day)
               then case when t.primary_demand_kind = 'estimates' then h.estimate_count else h.order_count end end)
        as same_weekday_primary_demand_count
    from app.ops_daily_rollup h
    where h.tenant_id = t.tenant_id
      and h.day >= p_day - 28
      and h.day < p_day
  ) b on true
  where t.day = p_day
    and t.tenant_id is not null;

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select p_day, tenant_id, 'webhook_non_retryable_errors', 'critical',
         webhook_error_critical_count, 0, null,
         format('%s non-retryable webhook error%s across %s failed event%s',
           webhook_error_critical_count,
           case when webhook_error_critical_count = 1 then '' else 's' end,
           webhook_failed_event_count,
           case when webhook_failed_event_count = 1 then '' else 's' end)
  from ops_digest_scored
  where webhook_error_critical_count > 0;

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select p_day, tenant_id, 'webhook_error_count', 'warning',
         webhook_error_count, webhook_event_count,
         case when webhook_event_count > 0 then round(webhook_error_count::numeric / webhook_event_count * 100, 1) else null end,
         format('%s webhook errors across %s received events (%s retryable)',
           webhook_error_count, webhook_event_count, webhook_retryable_error_count)
  from ops_digest_scored
  where webhook_error_count >= 5
    and webhook_error_critical_count = 0;

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select p_day, tenant_id, 'sync_job_failure_count', 'warning',
         sync_job_failure_count, sync_job_success_count, null,
         format('%s failed sync job%s; %s completed', sync_job_failure_count,
           case when sync_job_failure_count = 1 then '' else 's' end, sync_job_success_count)
  from ops_digest_scored
  where sync_job_failure_count > 0;

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select p_day, tenant_id, 'stale_integration_count', 'warning',
         stale_integration_count, 0, null,
         format('%s active integration%s had no successful daily sync', stale_integration_count,
           case when stale_integration_count = 1 then '' else 's' end)
  from ops_digest_scored
  where stale_integration_count > 0;

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select p_day, tenant_id, 'post_sync_rebuild_failure_count', 'critical',
         post_sync_rebuild_failure_count, 0, null,
         format('%s sync job%s completed with aggregate rebuild failures', post_sync_rebuild_failure_count,
           case when post_sync_rebuild_failure_count = 1 then '' else 's' end)
  from ops_digest_scored
  where post_sync_rebuild_failure_count > 0;

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select
    p_day,
    tenant_id,
    primary_demand_kind || '_count',
    'warning',
    case when primary_demand_kind = 'estimates' then estimate_count else order_count end,
    coalesce(same_weekday_primary_demand_count, avg_primary_demand_count),
    round((
      (case when primary_demand_kind = 'estimates' then estimate_count else order_count end)
      - coalesce(same_weekday_primary_demand_count, avg_primary_demand_count)
    ) / nullif(coalesce(same_weekday_primary_demand_count, avg_primary_demand_count), 0) * 100, 1),
    format('%s dropped to %s vs a baseline of %s',
      initcap(primary_demand_kind),
      case when primary_demand_kind = 'estimates' then estimate_count else order_count end,
      round(coalesce(same_weekday_primary_demand_count, avg_primary_demand_count), 1))
  from ops_digest_scored
  where primary_demand_kind in ('estimates', 'orders')
    and sample_days >= 7
    and coalesce(same_weekday_primary_demand_count, avg_primary_demand_count) >= 5
    and (case when primary_demand_kind = 'estimates' then estimate_count else order_count end)
      < 0.5 * coalesce(same_weekday_primary_demand_count, avg_primary_demand_count);

  insert into app.ops_daily_flags
    (day, tenant_id, metric, severity, current_value, baseline_value, delta_pct, message)
  select p_day, tenant_id, 'app_user_count', 'warning',
         app_user_count, avg_app_user_count,
         round((app_user_count - avg_app_user_count) / nullif(avg_app_user_count, 0) * 100, 1),
         format('App users dropped to %s vs a 28-day average of %s', app_user_count, round(avg_app_user_count, 1))
  from ops_digest_scored
  where sample_days >= 7
    and avg_app_user_count >= 5
    and app_user_count < 0.4 * avg_app_user_count;
end;
$function$;

revoke all on function app.compute_ops_daily_flags(date) from public;
grant execute on function app.compute_ops_daily_flags(date) to postgres, service_role;

-- A second invocation is safe because the edge function checks the delivery
-- ledger. It recovers transient pg_net / function / Slack failures without
-- posting a second digest after a successful first attempt.
select cron.schedule(
  'ops-daily-digest-retry',
  '40 3 * * *',
  $$
  select net.http_post(
    url := app.get_functions_base_url() || '/ops-daily-digest',
    headers := jsonb_build_object(
      'Content-type', 'application/json',
      'x-push-secret', app.get_integrations_dispatch_secret()
    ),
    body := jsonb_build_object('day', (((now() at time zone 'Asia/Kolkata')::date) - 1)::text),
    timeout_milliseconds := 10000
  );
  $$
);

-- Rebuild enough history for weekday-aware and rolling baselines. This is
-- bounded and each day is idempotent.
do $backfill$
declare
  v_day date;
begin
  for v_day in
    select generate_series(
      ((now() at time zone 'Asia/Kolkata')::date) - 35,
      ((now() at time zone 'Asia/Kolkata')::date) - 1,
      interval '1 day'
    )::date
  loop
    perform app.compute_ops_daily_rollup(v_day);
  end loop;
end;
$backfill$;
