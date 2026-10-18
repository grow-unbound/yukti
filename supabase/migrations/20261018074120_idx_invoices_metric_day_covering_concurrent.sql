-- Covering index for request-time invoice aggregates by metric day (access search month-to-date spend,
-- Pulse scorecards): tenant + metric-day range, with buyer_id/total_amount/status carried in the index so the
-- planner does not fetch one heap page per invoice. On dev, a one-month per-buyer sum read 3,475 buffers via
-- invoices_metrics_tenant_day_idx and 237 via this index.
-- Replaces no existing index; invoices_metrics_tenant_day_idx stays (it serves id-ordered readers).
--
-- CONCURRENTLY: avoids blocking invoice writes during the build. Single statement, no BEGIN/COMMIT, because
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block under `supabase db push`
-- (same pattern as 20261018020000_idx_estimates_buyer_app_engagement_day_concurrent.sql).
CREATE INDEX CONCURRENTLY IF NOT EXISTS invoices_metric_day_covering_idx
  ON app.invoices (tenant_id, (app.metric_day_ist(invoice_date, created_at)))
  INCLUDE (buyer_id, total_amount, status)
  WHERE deleted_at IS NULL;
