-- Buyer-level stats for buyer-app estimates: summary, top 10, first-quote cohorts, ticket sizes, weekday, items.
-- Params: {{TENANTS}} {{START}} {{END_EXCL}}
with e as (
  select tenant_id, buyer_id, status, total_amount, app.metric_day_ist(estimate_date, created_at) as estimate_date, item_count
  from app.estimates
  where tenant_id in ({{TENANTS}}) and deleted_at is null and is_buyer_app_estimate and app.estimate_status_counts_as_demand(status)
    and app.metric_day_ist(estimate_date, created_at) >= date '{{START}}' and app.metric_day_ist(estimate_date, created_at) < date '{{END_EXCL}}'
),
b as (
  select tenant_id, buyer_id, count(*) as n, count(*) filter (where status = 'invoiced') as ni,
    coalesce(sum(total_amount) filter (where status = 'invoiced'), 0) as v, coalesce(sum(total_amount), 0) as qv,
    min(estimate_date) as first_d, max(estimate_date) as last_d, count(distinct estimate_date) as days
  from e group by 1, 2
),
ranked as (
  select b.*, bu.business_name, row_number() over (partition by b.tenant_id order by b.v desc, b.qv desc) as rk
  from b join app.buyers bu on bu.id = b.buyer_id
),
summary as (
  select tenant_id, count(*) as quoters, count(*) filter (where ni >= 1) as inv_buyers,
    count(*) filter (where n >= 2) as quote_2plus, count(*) filter (where ni >= 2) as inv_2plus, count(*) filter (where ni >= 5) as inv_5plus,
    round(coalesce(sum(v), 0)) as inv_v_total, round(coalesce(sum(v) filter (where rk <= 10), 0)) as top10_inv_v
  from ranked group by 1
),
first_q as (select tenant_id, buyer_id, min(to_char(estimate_date, 'YYYY-MM')) as fm from e group by 1, 2),
cohort as (
  select f.tenant_id, f.fm as month, count(*) as buyers,
    count(*) filter (where exists (select 1 from e e2 where e2.tenant_id = f.tenant_id and e2.buyer_id = f.buyer_id
                                   and to_char(e2.estimate_date, 'YYYY-MM') > f.fm)) as quoted_again
  from first_q f group by 1, 2
),
ticket as (
  select tenant_id,
    round((percentile_cont(0.5) within group (order by total_amount))::numeric) as median_est,
    round((percentile_cont(0.5) within group (order by total_amount) filter (where status = 'invoiced'))::numeric) as median_inv_est,
    count(*) filter (where total_amount >= 50000) as big_n, round(coalesce(sum(total_amount) filter (where total_amount >= 50000), 0)) as big_v,
    count(*) filter (where total_amount >= 50000 and status = 'invoiced') as big_inv_n,
    count(*) filter (where total_amount < 5000) as small_n, count(*) filter (where total_amount < 5000 and status = 'invoiced') as small_inv_n
  from e group by 1
),
items as (select tenant_id, to_char(estimate_date, 'YYYY-MM') as month, round(avg(item_count), 1) as avg_items from e group by 1, 2),
dow as (select tenant_id, extract(isodow from estimate_date)::int as dow, count(*) as n from e group by 1, 2)
select jsonb_build_object(
  'summary', coalesce((select jsonb_agg(to_jsonb(s)) from summary s), '[]'::jsonb),
  'top', coalesce((select jsonb_agg(jsonb_build_object('tenant_id', tenant_id, 'rk', rk, 'name', business_name, 'n', n, 'ni', ni,
            'v', round(v), 'qv', round(qv), 'first_d', first_d, 'last_d', last_d, 'days', days) order by tenant_id, rk)
            from ranked where rk <= 10), '[]'::jsonb),
  'cohorts', coalesce((select jsonb_agg(to_jsonb(c) order by tenant_id, month) from cohort c), '[]'::jsonb),
  'ticket', coalesce((select jsonb_agg(to_jsonb(t)) from ticket t), '[]'::jsonb),
  'items', coalesce((select jsonb_agg(to_jsonb(i) order by tenant_id, month) from items i), '[]'::jsonb),
  'dow', coalesce((select jsonb_agg(to_jsonb(w) order by tenant_id, dow) from dow w), '[]'::jsonb)
) as d;
