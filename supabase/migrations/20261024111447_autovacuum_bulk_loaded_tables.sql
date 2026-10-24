-- Per-table autovacuum for tables that are bulk-loaded or heavily updated by the Zoho sync.
--
-- Defaults (scale factor 0.2) mean autovacuum waits for ~16k new rows on invoices, ~19k on invoice_items and
-- ~25k dead/new rows on integration_entity_map. On prod these tables had last_autovacuum = NULL (invoices,
-- invoice_items, integration_entity_map, buyers, buyer_users) and no visibility-map bits until a manual
-- VACUUM on 2026-10-24, which blocks index-only scans (e.g. idx_invoice_items_product_invoice,
-- invoices_metric_day_covering_idx) and let dead tuples build (integration_entity_map: 16.6k dead / 120k live,
-- 38.5k updates vs 5k inserts).
--
-- Same 2 % pattern other app tables already use (campaign_views, locations, tenant_integrations, ...), plus the
-- insert-triggered vacuum settings so append-only growth also gets vacuumed and its visibility map set.
-- ALTER TABLE ... SET (storage parameter) takes SHARE UPDATE EXCLUSIVE: no blocking of reads/writes.
-- Rollback: ALTER TABLE ... RESET (...) on the same parameters. Idempotent.

SET LOCAL lock_timeout = '5s';

ALTER TABLE app.invoices SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50,
  autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 50
);
ALTER TABLE app.invoice_items SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50,
  autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 50
);
ALTER TABLE app.integration_entity_map SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50,
  autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 50
);
ALTER TABLE app.estimate_items SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50,
  autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 50
);
ALTER TABLE app.buyers SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 50
);
ALTER TABLE app.buyer_users SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 50
);
