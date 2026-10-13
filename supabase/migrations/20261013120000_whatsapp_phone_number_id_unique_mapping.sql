-- WhatsApp inbound routing resolves the tenant from Meta's phone_number_id, so
-- one connected phone_number_id must map to exactly one tenant. The webhook
-- previously took the most recent match (limit 1); this makes ambiguity
-- impossible at the data layer. Disconnected / soft-deleted rows are excluded
-- so a number can move between tenants after a disconnect.
--
-- Pre-check (must return 0 rows before applying):
--   SELECT config->>'phone_number_id', count(*)
--   FROM app.tenant_integrations
--   WHERE integration_type_id = 'whatsapp_business' AND status = 'connected'
--     AND deleted_at IS NULL AND config->>'phone_number_id' IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_integrations_whatsapp_phone_number_id_unique
  ON app.tenant_integrations ((config->>'phone_number_id'))
  WHERE integration_type_id = 'whatsapp_business'
    AND status = 'connected'
    AND deleted_at IS NULL
    AND config->>'phone_number_id' IS NOT NULL;
