-- Product / category / brand performance on buyer-app estimates. conv = invoiced / (invoiced+expired+declined) estimates containing the item.
-- Params: {{TENANTS}} {{START}} {{END_EXCL}}
with x as (
  select e.tenant_id, ei.tenant_product_id as pid, coalesce(tp.name_override, p.name, tp.internal_sku) as nm, tp.internal_sku as sku,
    coalesce(tb.display_name_override, br.name, 'Unbranded') as brand, coalesce(tc.name, 'Uncategorised') as cat,
    e.status, ei.qty, ei.line_total, e.buyer_id, e.id as eid
  from app.estimate_items ei
  join app.estimates e on e.id = ei.estimate_id and e.deleted_at is null
  join app.tenant_products tp on tp.id = ei.tenant_product_id
  left join catalog.products p on p.id = tp.master_product_id
  left join app.tenant_brands tb on tb.id = tp.tenant_brand_id
  left join catalog.brands br on br.id = tb.master_brand_id
  left join app.tenant_categories tc on tc.id = tp.tenant_category_id
  where e.tenant_id in ({{TENANTS}}) and e.is_buyer_app_estimate
    and app.metric_day_ist(e.estimate_date, e.created_at) >= date '{{START}}' and app.metric_day_ist(e.estimate_date, e.created_at) < date '{{END_EXCL}}' and app.estimate_status_counts_as_demand(e.status) and ei.deleted_at is null
),
prod as (
  select tenant_id, pid, nm, sku, brand, cat, count(distinct eid) as est_n, count(distinct buyer_id) as q_buyers,
    coalesce(sum(qty) filter (where status = 'invoiced'), 0) as units_inv, round(coalesce(sum(line_total) filter (where status = 'invoiced'), 0)) as val_inv,
    count(distinct buyer_id) filter (where status = 'invoiced') as buyers_inv,
    round(100.0 * count(distinct eid) filter (where status = 'invoiced') / nullif(count(distinct eid) filter (where status in ('invoiced', 'expired', 'declined')), 0)) as conv,
    count(distinct eid) filter (where status = 'invoiced') as inv_n, count(distinct eid) filter (where status = 'expired') as exp_n,
    round(coalesce(sum(line_total) filter (where status = 'expired'), 0)) as exp_v, round(coalesce(sum(line_total), 0)) as q_val
  from x group by 1, 2, 3, 4, 5, 6
),
pr as (select *, row_number() over (partition by tenant_id order by val_inv desc) as r_top, row_number() over (partition by tenant_id order by exp_v desc) as r_lost from prod),
cat as (
  select tenant_id, cat as name, count(distinct eid) as n, round(coalesce(sum(line_total), 0)) as q_val, round(coalesce(sum(line_total) filter (where status = 'invoiced'), 0)) as inv_val,
    round(100.0 * count(distinct eid) filter (where status = 'invoiced') / nullif(count(distinct eid) filter (where status in ('invoiced', 'expired', 'declined')), 0)) as conv
  from x group by 1, 2
),
brand as (
  select tenant_id, brand as name, count(distinct eid) as n, round(coalesce(sum(line_total), 0)) as q_val, round(coalesce(sum(line_total) filter (where status = 'invoiced'), 0)) as inv_val,
    round(100.0 * count(distinct eid) filter (where status = 'invoiced') / nullif(count(distinct eid) filter (where status in ('invoiced', 'expired', 'declined')), 0)) as conv
  from x group by 1, 2
)
select jsonb_build_object(
  'top', coalesce((select jsonb_agg(to_jsonb(pr) - 'r_top' - 'r_lost' order by tenant_id, r_top) from pr where r_top <= 15), '[]'::jsonb),
  'lost', coalesce((select jsonb_agg(to_jsonb(pr) - 'r_top' - 'r_lost' order by tenant_id, r_lost) from pr where r_lost <= 8 and exp_n >= 3), '[]'::jsonb),
  'cats', coalesce((select jsonb_agg(to_jsonb(c) order by tenant_id, inv_val desc) from cat c), '[]'::jsonb),
  'brands', coalesce((select jsonb_agg(to_jsonb(b) order by tenant_id, inv_val desc) from brand b), '[]'::jsonb)
) as d;
