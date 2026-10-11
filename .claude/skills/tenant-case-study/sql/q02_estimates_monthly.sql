-- Estimates by tenant x month x group. grp: buyer_app (is_buyer_app_estimate) | seller | other (e.g. Zoho imports).
-- Canonical rules (metrics dictionary): day = metric_day_ist(estimate_date, created_at); demand excludes void (estimate_status_counts_as_demand).
-- src_mismatch = buyer-app rows whose source is not 'buyer_app' (sync/overwrite bugs).
-- Params: {{TENANTS}} {{START}} {{END_EXCL}}
with e as (
  select e.tenant_id, e.buyer_id, app.metric_day_ist(e.estimate_date, e.created_at) as estimate_date, e.status, e.total_amount, e.source, e.valid_until,
         case when e.is_buyer_app_estimate then 'buyer_app' when e.source = 'seller' then 'seller' else 'other' end as grp
  from app.estimates e
  where e.tenant_id in ({{TENANTS}}) and e.deleted_at is null
    and app.metric_day_ist(e.estimate_date, e.created_at) >= date '{{START}}' and app.metric_day_ist(e.estimate_date, e.created_at) < date '{{END_EXCL}}'
    and app.estimate_status_counts_as_demand(e.status)
)
select coalesce(jsonb_agg(to_jsonb(r) order by r.tenant_id, r.month, r.grp), '[]'::jsonb) as d
from (
  select tenant_id, to_char(estimate_date, 'YYYY-MM') as month, grp,
    count(*) as n, round(coalesce(sum(total_amount), 0)) as v, count(distinct buyer_id) as buyers,
    count(*) filter (where status = 'invoiced') as inv_n,
    round(coalesce(sum(total_amount) filter (where status = 'invoiced'), 0)) as inv_v,
    count(distinct buyer_id) filter (where status = 'invoiced') as inv_buyers,
    count(*) filter (where status in ('sent', 'accepted')) as open_n,
    round(coalesce(sum(total_amount) filter (where status in ('sent', 'accepted')), 0)) as open_v,
    count(*) filter (where status in ('sent', 'accepted') and valid_until < current_date) as stale_open_n,
    round(coalesce(sum(total_amount) filter (where status in ('sent', 'accepted') and valid_until < current_date), 0)) as stale_open_v,
    count(*) filter (where status = 'expired') as exp_n,
    round(coalesce(sum(total_amount) filter (where status = 'expired'), 0)) as exp_v,
    count(*) filter (where status = 'declined') as declined_n,
    count(*) filter (where status = 'draft') as draft_n,
    count(*) filter (where grp = 'buyer_app' and source <> 'buyer_app') as src_mismatch
  from e group by 1, 2, 3
) r;
