-- Tenant master facts. Params: {{TENANTS}}
select coalesce(jsonb_agg(jsonb_build_object(
  'tenant_id', t.id, 'name', t.business_name, 'slug', t.slug, 'plan', t.plan, 'created_at', t.created_at,
  'buyers_total', (select count(*) from app.buyers b where b.tenant_id = t.id and b.deleted_at is null),
  'buyers_app_enabled', (select count(*) from app.buyers b where b.tenant_id = t.id and b.deleted_at is null and b.buyer_app_enabled),
  'products_active', (select count(*) from app.tenant_products p where p.tenant_id = t.id and p.deleted_at is null and p.is_active),
  'seller_users_active', (select count(*) from app.tenant_users u where u.tenant_id = t.id and u.deleted_at is null and u.is_active)
)), '[]'::jsonb) as d
from app.tenants t
where t.id in ({{TENANTS}}) and t.deleted_at is null;
