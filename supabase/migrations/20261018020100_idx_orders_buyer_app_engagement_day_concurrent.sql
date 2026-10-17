-- Partial index for app.buyer_app_engagement (buyer-app order branch). See
-- 20261018020000_idx_estimates_buyer_app_engagement_day_concurrent.sql for the rationale.
-- CONCURRENTLY, single statement, no BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_buyer_app_engagement_day_idx
  ON app.orders (tenant_id, (app.metric_day_ist(order_date, created_at)), buyer_id)
  INCLUDE (location_id)
  WHERE deleted_at IS NULL AND is_buyer_app_order AND buyer_id IS NOT NULL;
