-- Partial index for app.buyer_app_engagement (buyer-app estimate branch).
-- The view reads only buyer-app estimates; estimates_metrics_tenant_day_idx covers every estimate, so
-- the planner scans and discards the non-app rows (about 570 of 573 for a 30-day range on dev).
-- Key order serves tenant + metric-day range with buyer_id for DISTINCT/GROUP BY; location_id is
-- INCLUDEd so the view can be answered index-only.
--
-- CONCURRENTLY: avoids blocking estimate writes during the build. Single statement, no BEGIN/COMMIT,
-- because CREATE INDEX CONCURRENTLY cannot run inside a transaction block under `supabase db push`
-- (same pattern as 20260713144545_idx_buyer_app_activity_buyer_id_fk_concurrent.sql).
CREATE INDEX CONCURRENTLY IF NOT EXISTS estimates_buyer_app_engagement_day_idx
  ON app.estimates (tenant_id, (app.metric_day_ist(estimate_date, created_at)), buyer_id)
  INCLUDE (location_id)
  WHERE deleted_at IS NULL AND is_buyer_app_estimate AND buyer_id IS NOT NULL;
