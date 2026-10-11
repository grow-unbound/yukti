-- Product views/carts (PostHog) joined to buyer-app quote/invoice outcomes. Rendered by `yukti_case.py posthog`; not a plain template.
-- Params: {{TENANTS}} {{START}} {{END_EXCL}} {{PH_VALUES}}
with ph(tenant_id, pid, viewers, views, carters) as (
  values
  {{PH_VALUES}}
),
q as (
  select e.tenant_id, ei.tenant_product_id as pid, count(distinct e.buyer_id) as q_buyers,
    count(distinct e.buyer_id) filter (where e.status = 'invoiced') as inv_buyers,
    round(coalesce(sum(ei.line_total) filter (where e.status = 'invoiced'), 0)) as inv_v
  from app.estimate_items ei
  join app.estimates e on e.id = ei.estimate_id and e.deleted_at is null
  where e.tenant_id in ({{TENANTS}}) and e.is_buyer_app_estimate
    and app.metric_day_ist(e.estimate_date, e.created_at) >= date '{{START}}' and app.metric_day_ist(e.estimate_date, e.created_at) < date '{{END_EXCL}}' and app.estimate_status_counts_as_demand(e.status) and ei.deleted_at is null
  group by 1, 2
)
select coalesce(jsonb_agg(to_jsonb(r) order by r.tenant_id, r.viewers desc), '[]'::jsonb) as d
from (
  select ph.tenant_id, ph.pid, coalesce(tp.name_override, p.name, tp.internal_sku) as nm, tc.name as cat,
    tp.base_selling_price as price, ph.viewers, ph.views, ph.carters,
    coalesce(q.q_buyers, 0) as q_buyers, coalesce(q.inv_buyers, 0) as inv_buyers, coalesce(q.inv_v, 0) as inv_v
  from ph
  join app.tenant_products tp on tp.id = ph.pid
  left join catalog.products p on p.id = tp.master_product_id
  left join app.tenant_categories tc on tc.id = tp.tenant_category_id
  left join q on q.tenant_id = ph.tenant_id and q.pid = ph.pid
) r;
