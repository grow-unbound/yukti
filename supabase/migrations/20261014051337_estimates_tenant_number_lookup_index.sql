-- P4 of specs/2026-10-14-prod-resource-diet-nano.md: index the estimate-number batch lookup.
--
-- PostgREST query (pg_stat_statements, prod, 6 d): 1,816 calls, 1.07 s mean, 1,940 s total (#1 estimates
-- statement, ~5.8 % of DB time):
--   select external_ref, source, estimate_number, is_buyer_app_estimate from app.estimates
--   where tenant_id = $1 and estimate_number = any($2) and deleted_at is null limit $3
-- No existing index leads with (tenant_id, estimate_number); the planner falls back to
-- idx_estimates_tenant_id and filters every tenant row. Partial on deleted_at IS NULL to match the
-- predicate; INCLUDE the selected columns so the lookup is an index-only scan. ~11 k rows, < 1 MB.
--
-- CONCURRENTLY: single statement per file (cannot run in a transaction under `supabase db push`).
-- If interrupted it leaves an invalid index of this name: drop it and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_estimates_tenant_estimate_number
  ON app.estimates (tenant_id, estimate_number)
  INCLUDE (external_ref, source, is_buyer_app_estimate)
  WHERE deleted_at IS NULL;
