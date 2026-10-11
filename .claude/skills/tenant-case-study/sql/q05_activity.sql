-- Buyer-app engagement from app.buyer_app_activity (qualifying events), IST dates, distinct buyer_id.
-- Params: {{TENANTS}} {{START}} {{END}} {{END_EXCL}}
with a as (
  select tenant_id, buyer_id, event_name, (occurred_at at time zone 'Asia/Kolkata')::date as d
  from app.buyer_app_activity
  where tenant_id in ({{TENANTS}}) and deleted_at is null and qualifies_for_engagement
    and (occurred_at at time zone 'Asia/Kolkata')::date between date '{{START}}' and date '{{END}}'
),
tn as (select distinct tenant_id from a),
days as (select tn.tenant_id, g::date as d from tn, generate_series(date '{{START}}', date '{{END}}', interval '1 day') g),
dau as (
  select days.tenant_id, days.d, count(distinct a.buyer_id) as u
  from days left join a on a.tenant_id = days.tenant_id and a.d = days.d group by 1, 2
),
mm as (select distinct tenant_id, buyer_id, date_trunc('month', d)::date as m from a),
first_m as (select tenant_id, buyer_id, min(m) as fm from mm group by 1, 2),
monthly as (
  select mm.tenant_id, to_char(mm.m, 'YYYY-MM') as month, count(*) as mau,
    count(*) filter (where f.fm = mm.m) as new_buyers, count(*) filter (where f.fm < mm.m) as returning_buyers,
    count(*) filter (where exists (select 1 from mm n2 where n2.tenant_id = mm.tenant_id and n2.buyer_id = mm.buyer_id
                                   and n2.m = (mm.m + interval '1 month')::date)) as retained_next
  from mm join first_m f using (tenant_id, buyer_id) group by 1, 2
),
mdau as (
  select tenant_id, to_char(d, 'YYYY-MM') as month, round(avg(u), 1) as avg_dau, max(u) as peak_dau, count(*) as days_in_window
  from dau group by 1, 2
),
mev as (
  select tenant_id, to_char(d, 'YYYY-MM') as month, count(*) as events, count(*) filter (where event_name = 'session_started') as sessions
  from a group by 1, 2
),
weekly as (select tenant_id, (date_trunc('week', d))::date as wk, count(distinct buyer_id) as wau from a group by 1, 2),
per_buyer as (select tenant_id, buyer_id, count(distinct d) as dd from a group by 1, 2),
depth as (
  select tenant_id, case when dd = 1 then '1' when dd <= 3 then '2-3' when dd <= 7 then '4-7' when dd <= 14 then '8-14' else '15+' end as bucket, count(*) as n
  from per_buyer group by 1, 2
),
quoters as (
  select distinct tenant_id, buyer_id from app.estimates
  where tenant_id in ({{TENANTS}}) and deleted_at is null and is_buyer_app_estimate and app.estimate_status_counts_as_demand(status)
    and app.metric_day_ist(estimate_date, created_at) >= date '{{START}}' and app.metric_day_ist(estimate_date, created_at) < date '{{END_EXCL}}'
),
funnel as (
  select tn.tenant_id,
    (select count(distinct buyer_id) from a where a.tenant_id = tn.tenant_id) as active,
    (select count(distinct buyer_id) from a where a.tenant_id = tn.tenant_id and event_name = 'catalog_viewed') as browsed,
    (select count(distinct buyer_id) from a where a.tenant_id = tn.tenant_id and event_name = 'catalog_viewed'
        and buyer_id not in (select buyer_id from quoters q where q.tenant_id = tn.tenant_id)) as browsed_no_est
  from tn
)
select jsonb_build_object(
  'monthly', coalesce((select jsonb_agg(jsonb_build_object('tenant_id', m.tenant_id, 'month', m.month, 'mau', m.mau, 'new', m.new_buyers,
      'returning', m.returning_buyers, 'retained_next', m.retained_next, 'avg_dau', d.avg_dau, 'peak_dau', d.peak_dau,
      'days_in_window', d.days_in_window, 'events', v.events, 'sessions', v.sessions) order by m.tenant_id, m.month)
      from monthly m left join mdau d using (tenant_id, month) left join mev v using (tenant_id, month)), '[]'::jsonb),
  'weekly', coalesce((select jsonb_agg(to_jsonb(w) order by tenant_id, wk) from weekly w), '[]'::jsonb),
  'depth', coalesce((select jsonb_agg(to_jsonb(x)) from depth x), '[]'::jsonb),
  'funnel', coalesce((select jsonb_agg(to_jsonb(f)) from funnel f), '[]'::jsonb)
) as d;
