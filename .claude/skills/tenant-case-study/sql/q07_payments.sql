-- Payment status of invoiced buyer-app estimates (best-match invoice: estimate_id link, else same buyer+amount within 10 days)
-- plus the invoices generated directly from buyer-app estimates. Params: {{TENANTS}} {{START}} {{END}} {{END_EXCL}}
with ie as (
  select e.id, e.tenant_id, app.metric_day_ist(e.estimate_date, e.created_at) as estimate_date, e.total_amount, e.buyer_id, e.created_at
  from app.estimates e
  where e.tenant_id in ({{TENANTS}}) and e.deleted_at is null and e.is_buyer_app_estimate and e.status = 'invoiced'
    and app.metric_day_ist(e.estimate_date, e.created_at) >= date '{{START}}' and app.metric_day_ist(e.estimate_date, e.created_at) < date '{{END_EXCL}}'
),
m as (
  select ie.*, i.status as inv_status, i.total_amount as inv_total, i.outstanding_balance as outst
  from ie left join lateral (
    select i.* from app.invoices i
    where i.tenant_id = ie.tenant_id and i.deleted_at is null and i.status <> 'void'
      and (i.estimate_id = ie.id or (i.buyer_id = ie.buyer_id and i.total_amount = ie.total_amount
           and i.created_at >= ie.created_at - interval '1 day' and i.created_at <= ie.created_at + interval '10 days'))
    order by (i.estimate_id = ie.id) desc, i.created_at limit 1
  ) i on true
),
bymonth as (
  select tenant_id, to_char(estimate_date, 'YYYY-MM') as month, count(*) as inv_est,
    count(*) filter (where inv_status is not null) as matched,
    count(*) filter (where inv_status = 'paid') as paid_n, round(coalesce(sum(inv_total) filter (where inv_status = 'paid'), 0)) as paid_v,
    count(*) filter (where inv_status is not null and inv_status <> 'paid') as open_n,
    round(coalesce(sum(outst) filter (where inv_status is not null and inv_status <> 'paid'), 0)) as outst_v,
    round(coalesce(sum(inv_total) filter (where inv_status is not null), 0)) as matched_v,
    count(*) filter (where inv_status is null) as nomatch_n, round(coalesce(sum(total_amount) filter (where inv_status is null), 0)) as nomatch_v
  from m group by 1, 2
),
auto as (
  select i.tenant_id, count(*) as n, round(coalesce(sum(i.total_amount), 0)) as v,
    count(*) filter (where i.status = 'paid') as paid_n, round(coalesce(sum(i.total_amount) filter (where i.status = 'paid'), 0)) as paid_v,
    count(*) filter (where i.status <> 'paid') as open_n, round(coalesce(sum(i.outstanding_balance) filter (where i.status <> 'paid'), 0)) as open_v,
    min((i.created_at at time zone 'Asia/Kolkata')::date) as first_day,
    round((percentile_cont(0.5) within group (order by extract(epoch from (i.created_at - e.created_at)) / 60))::numeric, 1) as median_min
  from app.invoices i left join app.estimates e on e.id = i.estimate_id
  where i.tenant_id in ({{TENANTS}}) and i.deleted_at is null and i.status <> 'void' and i.is_buyer_app_invoice
    and (i.created_at at time zone 'Asia/Kolkata')::date between date '{{START}}' and date '{{END}}'
  group by 1
)
select jsonb_build_object(
  'by_month', coalesce((select jsonb_agg(to_jsonb(b) order by tenant_id, month) from bymonth b), '[]'::jsonb),
  'auto', coalesce((select jsonb_agg(to_jsonb(a)) from auto a), '[]'::jsonb)
) as d;
