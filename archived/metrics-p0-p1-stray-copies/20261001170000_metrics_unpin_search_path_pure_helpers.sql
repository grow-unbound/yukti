-- Unpin `search_path` on 17 pure scalar SQL helpers so the planner can inline them.
--
-- Background: 20260830_* ("Pin search_path on remaining SECURITY INVOKER functions") set
--   search_path = pg_catalog, app, catalog, public, extensions
-- on every function, including tiny SQL helpers such as app.invoice_status_has_receivable and
-- app.metric_day_ist. Postgres never inlines a function that carries a proconfig (SET) clause, so
-- every call from the metrics refresh (and every dashboard predicate) pays a per-row function call
-- instead of becoming a plain expression the planner can cost and push into index scans.
--
-- Measured on yukti-dev (rolled-back runs of the real tick compute, large tenant d601c35c):
--   setup      3.8 s / 1.9 s  ->  0.34 s / 0.25 s
--   commercial 11.3 s / 5.2 s ->  2.1 s  / 1.7 s
--   one helper over 27k invoices: 162 ms -> 10 ms
--
-- Scope (explicit list, nothing else is touched). Every function below is LANGUAGE sql,
-- SECURITY INVOKER, IMMUTABLE or STABLE, takes scalars, reads no table, and its body only uses
-- built-in operators and functions (COALESCE, CASE, IN, comparisons, AT TIME ZONE, now(), GREATEST)
-- plus fully schema-qualified calls to other helpers in this list.
--
-- Why this is safe: pg_catalog is always searched first unless it is listed explicitly later in
-- search_path, so built-in operators and functions on built-in types cannot be shadowed by objects
-- in app/public/extensions, and the bodies call no unqualified non-built-in function. The only
-- effect of removing the pin is that these bodies are inlined into the caller.
--
-- Trade-off: the Supabase security advisor (function_search_path_mutable) will flag these 17
-- functions. That is expected and accepted for this list; do not extend the list to functions that
-- read tables, are SECURITY DEFINER, or call unqualified functions.
--
-- Rollback (restores the previous pin on every function in the list):
--   ALTER FUNCTION <signature> SET search_path = pg_catalog, app, catalog, public, extensions;

ALTER FUNCTION app.derive_buyer_app_status(boolean, boolean) RESET search_path;
ALTER FUNCTION app.derive_gmv_90d_bucket(numeric) RESET search_path;
ALTER FUNCTION app.derive_last_order_bucket(timestamp with time zone) RESET search_path;
ALTER FUNCTION app.derive_sales_90d_level(numeric) RESET search_path;
ALTER FUNCTION app.derive_stock_status_bucket(numeric, numeric, boolean) RESET search_path;
ALTER FUNCTION app.estimate_status_counts_as_demand(text) RESET search_path;
ALTER FUNCTION app.estimate_status_is_open(text) RESET search_path;
ALTER FUNCTION app.invoice_is_overdue(text, timestamp with time zone, numeric) RESET search_path;
ALTER FUNCTION app.invoice_status_gmv_included(text) RESET search_path;
ALTER FUNCTION app.invoice_status_has_receivable(text, numeric) RESET search_path;
ALTER FUNCTION app.invoice_status_in_flow(text) RESET search_path;
ALTER FUNCTION app.metric_day_ist(date, timestamp with time zone) RESET search_path;
ALTER FUNCTION app.metrics_source_type_valid(text, text) RESET search_path;
ALTER FUNCTION app.order_status_in_flow(text) RESET search_path;
ALTER FUNCTION app.order_status_is_downstream_quality(text) RESET search_path;
ALTER FUNCTION app.order_status_is_open(text) RESET search_path;
ALTER FUNCTION app.sync_job_rebuild_days(text, timestamp with time zone, integer) RESET search_path;

-- Guard: fail the migration if any function is still pinned, or if the list was ever widened to a
-- function that is not a plain SQL, SECURITY INVOKER scalar helper.
DO $guard$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.oid IN (
    'app.derive_buyer_app_status(boolean, boolean)'::regprocedure,
    'app.derive_gmv_90d_bucket(numeric)'::regprocedure,
    'app.derive_last_order_bucket(timestamp with time zone)'::regprocedure,
    'app.derive_sales_90d_level(numeric)'::regprocedure,
    'app.derive_stock_status_bucket(numeric, numeric, boolean)'::regprocedure,
    'app.estimate_status_counts_as_demand(text)'::regprocedure,
    'app.estimate_status_is_open(text)'::regprocedure,
    'app.invoice_is_overdue(text, timestamp with time zone, numeric)'::regprocedure,
    'app.invoice_status_gmv_included(text)'::regprocedure,
    'app.invoice_status_has_receivable(text, numeric)'::regprocedure,
    'app.invoice_status_in_flow(text)'::regprocedure,
    'app.metric_day_ist(date, timestamp with time zone)'::regprocedure,
    'app.metrics_source_type_valid(text, text)'::regprocedure,
    'app.order_status_in_flow(text)'::regprocedure,
    'app.order_status_is_downstream_quality(text)'::regprocedure,
    'app.order_status_is_open(text)'::regprocedure,
    'app.sync_job_rebuild_days(text, timestamp with time zone, integer)'::regprocedure
  )
  AND (p.proconfig IS NOT NULL OR p.prosecdef OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'metrics_unpin_search_path_guard_failed: %', v_bad;
  END IF;
END
$guard$;
