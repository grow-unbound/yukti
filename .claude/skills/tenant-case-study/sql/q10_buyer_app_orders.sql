-- Buyer-app orders (Pulse counts these as demand alongside estimates). Params: {{TENANTS}} {{START}} {{END_EXCL}}
select coalesce(jsonb_agg(to_jsonb(r) order by r.tenant_id, r.month), '[]'::jsonb) as d
from (
  select tenant_id, to_char(app.metric_day_ist(order_date, created_at), 'YYYY-MM') as month,
    count(*) as n, round(coalesce(sum(total_amount), 0)) as v, count(distinct buyer_id) as buyers
  from app.orders
  where tenant_id in ({{TENANTS}}) and deleted_at is null and is_buyer_app_order and app.order_status_in_flow(status)
    and app.metric_day_ist(order_date, created_at) >= date '{{START}}' and app.metric_day_ist(order_date, created_at) < date '{{END_EXCL}}'
  group by 1, 2
) r;
