-- Seller-side activity and WhatsApp usage (internal-only context). Params: {{TENANTS}} {{START}} {{END}} {{END_EXCL}}
select jsonb_build_object(
  'audit', coalesce((select jsonb_agg(to_jsonb(r)) from (
      select tenant_id, entity_type, action, count(*) as n, count(distinct actor_user_id) as actors
      from app.audit_log
      where tenant_id in ({{TENANTS}}) and (ts at time zone 'Asia/Kolkata')::date between date '{{START}}' and date '{{END}}'
      group by 1, 2, 3 order by n desc limit 40) r), '[]'::jsonb),
  'broadcasts', coalesce((select jsonb_agg(to_jsonb(r) order by tenant_id, month) from (
      select tenant_id, to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, count(*) as n,
        coalesce(sum(sent_count), 0) as sent, coalesce(sum(delivered_count), 0) as delivered, coalesce(sum(failed_count), 0) as failed
      from app.whatsapp_broadcasts
      where tenant_id in ({{TENANTS}}) and deleted_at is null
        and (created_at at time zone 'Asia/Kolkata')::date between date '{{START}}' and date '{{END}}'
      group by 1, 2) r), '[]'::jsonb)
) as d;
