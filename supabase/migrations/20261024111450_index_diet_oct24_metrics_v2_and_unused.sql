-- Index diet (2026-10-24). Follows 20260920130430_index_diet_unused_and_duplicate.sql and the same rules:
-- only plain (non-unique, non-PK, non-constraint) indexes; FK, created_by/updated_by audit, search
-- (trgm/gin/search_vector) and unique/idempotency indexes are KEPT.
--
-- Evidence: pg_stat_user_indexes on yukti-prod, 2026-10-24 (idx_scan / last_idx_scan). Prod is ~420 MB of
-- table+index data; each extra index on invoices/estimates/estimate_items/buyers is write amplification on the
-- Zoho sync and buyer-app write paths. Total reclaimed ~25.7 MB.
--
-- Dropped:
--   Metrics V2 landing/summary indexes, superseded by the direct-from-raw readers
--   (20261018073453_buyer_access_readers_direct_from_raw.sql, 20261018074120_..._covering_concurrent.sql),
--   which use invoices_metrics_tenant_day_idx / invoices_metric_day_covering_idx / idx_invoices_is_buyer_app
--   (all KEPT):
--     invoices_metrics_tenant_status_day_idx      9.9 MB   86 scans
--     invoices_metrics_tenant_due_idx             0.6 MB    0 scans
--     invoices_now_location_receivable_idx        0.6 MB    0 scans
--     estimates_metrics_tenant_status_day_idx     2.0 MB  141 scans
--     idx_estimates_campaign_metric_day           0.9 MB   17 scans
--   Unused, no code or SQL reader names them:
--     idx_estimate_items_product_estimate         8.3 MB   18 scans  (invoice_items twin has 103k scans and is KEPT)
--     idx_estimates_tenant_location_created_at    1.4 MB    8 scans
--     idx_buyers_tenant_name                      1.4 MB    9 scans  (buyers_metrics_tenant_name_idx covers the same lookup and is KEPT)
--     idx_buyers_email                            0.2 MB    0 scans
--     idx_app_buyers_deleted_at                   0.2 MB    0 scans  (btree on a ~100% NULL column)
--     idx_buyers_tier                             0.2 MB    1 scan
--
-- Deliberately NOT dropped (need a decision, not evidence): integration_entity_map_lookup_idx (12.5 MB, 340
-- scans), idx_buyer_app_activity_buyer_lookup (5.5 MB, 28 scans), the duplicate partial/full unique pair on
-- estimates (tenant_id, external_ref), and zero-scan FK-covering indexes.
--
-- Rollback = recreate from 20260709000001_prod_bootstrap.sql / 20260716092549_metrics_v2_phase_6_landing_pages.sql /
-- 20260803131547_bound_now_summary_lifetime_scans.sql / 20260714114957_search_landing_document_indexes.sql.
-- Idempotent. Plain DROP INDEX takes a short ACCESS EXCLUSIVE lock; lock_timeout makes it fail fast instead of queueing.

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS app.invoices_metrics_tenant_status_day_idx;
DROP INDEX IF EXISTS app.invoices_metrics_tenant_due_idx;
DROP INDEX IF EXISTS app.invoices_now_location_receivable_idx;
DROP INDEX IF EXISTS app.estimates_metrics_tenant_status_day_idx;
DROP INDEX IF EXISTS app.idx_estimates_campaign_metric_day;
DROP INDEX IF EXISTS app.idx_estimate_items_product_estimate;
DROP INDEX IF EXISTS app.idx_estimates_tenant_location_created_at;
DROP INDEX IF EXISTS app.idx_buyers_tenant_name;
DROP INDEX IF EXISTS app.idx_buyers_email;
DROP INDEX IF EXISTS app.idx_app_buyers_deleted_at;
DROP INDEX IF EXISTS app.idx_buyers_tier;
