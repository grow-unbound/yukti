-- Weekly buyer-app estimates (week starts Monday). Params: {{TENANTS}} {{START}} {{END_EXCL}}
select coalesce(jsonb_agg(to_jsonb(r) order by r.tenant_id, r.wk), '[]'::jsonb) as d
from (
  select tenant_id, (date_trunc('week', estimate_date))::date as wk,
    count(*) as n, round(coalesce(sum(total_amount), 0)) as v, count(distinct buyer_id) as buyers,
    count(*) filter (where status = 'invoiced') as inv_n,
    round(coalesce(sum(total_amount) filter (where status = 'invoiced'), 0)) as inv_v
  from (select tenant_id, buyer_id, status, total_amount, app.metric_day_ist(estimate_date, created_at) as estimate_date
        from app.estimates
        where tenant_id in ({{TENANTS}}) and deleted_at is null and is_buyer_app_estimate and app.estimate_status_counts_as_demand(status)) x
  where estimate_date >= date '{{START}}' and estimate_date < date '{{END_EXCL}}'
  group by 1, 2
) r;
