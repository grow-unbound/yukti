-- Pulse gap 5: app.metrics_tenant_daily and app.metrics_location_daily.
--
-- Both tables have no writers (no function, trigger or cron inserts into them) and their newest row is
-- 2026-08-01, yet app.get_buyer_app_dashboard_v4 (GET /api/tenant/buyer-app) still read them for the
-- "contribution over time" chart and the per-location app values, so those views were frozen. This
-- migration repoints the function to live sources. Dropping the two tables is a separate, explicitly
-- approved step (see the guard at the bottom, which proves nothing reads them any more).
--
--  * contribution over time: app.metrics_tenant_period_summary, grain = 'month'. The app "invoice" line is
--    converted buyer-app estimates for estimate-led tenants (same basis as the Pulse card, see
--    20261007101427) and flagged buyer-app invoices for order-led tenants.
--  * adoption by location: bounded raw lookups on the is_buyer_app_* partial indexes over the 90-day horizon.
--    Documented exception to the aggregate rule: metrics_location_period_summary carries no app/non-app
--    split yet. The old query also fanned out SUM() across the activity join; the per-location values are
--    now computed in a LATERAL so they are not multiplied by activity rows.
--
-- Patched from the live definition with asserted anchors (fails loudly on drift).

CREATE OR REPLACE FUNCTION pg_temp.patch_fn(p_def text, p_old text, p_new text, p_expect integer, p_label text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_hits integer;
BEGIN
  v_hits := (length(p_def) - length(replace(p_def, p_old, ''))) / greatest(length(p_old), 1);
  IF v_hits <> p_expect THEN
    RAISE EXCEPTION 'pulse patch % expected % anchor hit(s), found %', p_label, p_expect, v_hits;
  END IF;
  RETURN replace(p_def, p_old, p_new);
END $$;

DO $patch$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('app.get_buyer_app_dashboard_v4(uuid,text,uuid[],timestamptz)'::regprocedure);

  v_def := pg_temp.patch_fn(v_def,
$a$    SELECT date_trunc('month', d.day)::date AS month_start,
      SUM(CASE WHEN v_primary = 'orders' THEN d.app_order_value ELSE d.app_estimate_value END) AS app_demand_value,
      SUM(CASE WHEN v_primary = 'orders' THEN d.order_value ELSE d.estimate_value END) AS total_demand_value,
      SUM(d.app_invoice_value) AS app_invoice_value,
      SUM(d.invoice_value) AS total_invoice_value
    FROM app.metrics_tenant_daily d
    WHERE d.tenant_id = p_tenant_id AND d.deleted_at IS NULL AND d.day >= v_12m_start AND d.day <= v_today
    GROUP BY date_trunc('month', d.day)::date$a$,
$b$    SELECT s.period_start AS month_start,
      CASE WHEN v_primary = 'orders' THEN s.app_order_value ELSE s.app_estimate_value END AS app_demand_value,
      CASE WHEN v_primary = 'orders' THEN s.order_value ELSE s.estimate_value END AS total_demand_value,
      CASE WHEN v_primary = 'estimates' THEN s.app_estimate_converted_value
        ELSE COALESCE((
          SELECT SUM(i.total_amount) FROM app.invoices i
          WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.is_buyer_app_invoice
            AND app.invoice_status_gmv_included(i.status)
            AND app.metric_day_ist(i.invoice_date, i.created_at) >= s.period_start
            AND app.metric_day_ist(i.invoice_date, i.created_at) < s.period_end_exclusive
        ), 0)
      END AS app_invoice_value,
      s.invoice_value AS total_invoice_value
    FROM app.metrics_tenant_period_summary s
    WHERE s.tenant_id = p_tenant_id AND s.deleted_at IS NULL AND s.grain = 'month'
      AND s.period_start >= date_trunc('month', v_12m_start)::date AND s.period_start <= v_today$b$, 1, 'contribution over time');

  v_def := pg_temp.patch_fn(v_def,
$a$      COALESCE(SUM(ld.app_invoice_value), 0) AS invoice_value,
      COALESCE(SUM(CASE WHEN v_primary = 'orders' THEN ld.app_order_value ELSE ld.app_estimate_value END), 0) AS demand_value,
      COALESCE(SUM(CASE WHEN v_primary = 'orders' THEN ld.app_order_count ELSE ld.app_estimate_count END), 0) AS demand_doc_count,
      COUNT(DISTINCT a.buyer_id) AS active_buyers
    FROM app.locations l
    LEFT JOIN app.metrics_location_daily ld ON ld.tenant_id = l.tenant_id AND ld.location_id = l.id AND ld.deleted_at IS NULL AND ld.day >= v_horizon_start$a$,
$b$      COALESCE(MAX(ld.invoice_value), 0) AS invoice_value,
      COALESCE(MAX(ld.demand_value), 0) AS demand_value,
      COALESCE(MAX(ld.demand_doc_count), 0) AS demand_doc_count,
      COUNT(DISTINCT a.buyer_id) AS active_buyers
    FROM app.locations l
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN v_primary = 'estimates' THEN COALESCE((
            SELECT SUM(e.total_amount) FROM app.estimates e
            WHERE e.tenant_id = l.tenant_id AND e.location_id = l.id AND e.deleted_at IS NULL
              AND e.is_buyer_app_estimate AND e.status IN ('invoiced','converted')
              AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_horizon_start
              AND app.metric_day_ist(e.estimate_date, e.created_at) <= v_today), 0)
          ELSE COALESCE((
            SELECT SUM(i.total_amount) FROM app.invoices i
            WHERE i.tenant_id = l.tenant_id AND i.location_id = l.id AND i.deleted_at IS NULL
              AND i.is_buyer_app_invoice AND app.invoice_status_gmv_included(i.status)
              AND app.metric_day_ist(i.invoice_date, i.created_at) >= v_horizon_start
              AND app.metric_day_ist(i.invoice_date, i.created_at) <= v_today), 0)
        END AS invoice_value,
        CASE WHEN v_primary = 'orders' THEN COALESCE((
            SELECT SUM(o.total_amount) FROM app.orders o
            WHERE o.tenant_id = l.tenant_id AND o.location_id = l.id AND o.deleted_at IS NULL
              AND o.is_buyer_app_order AND app.order_status_in_flow(o.status)
              AND app.metric_day_ist(o.order_date, o.created_at) >= v_horizon_start
              AND app.metric_day_ist(o.order_date, o.created_at) <= v_today), 0)
          ELSE COALESCE((
            SELECT SUM(e.total_amount) FROM app.estimates e
            WHERE e.tenant_id = l.tenant_id AND e.location_id = l.id AND e.deleted_at IS NULL
              AND e.is_buyer_app_estimate AND app.estimate_status_counts_as_demand(e.status)
              AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_horizon_start
              AND app.metric_day_ist(e.estimate_date, e.created_at) <= v_today), 0)
        END AS demand_value,
        CASE WHEN v_primary = 'orders' THEN COALESCE((
            SELECT COUNT(*) FROM app.orders o
            WHERE o.tenant_id = l.tenant_id AND o.location_id = l.id AND o.deleted_at IS NULL
              AND o.is_buyer_app_order AND app.order_status_in_flow(o.status)
              AND app.metric_day_ist(o.order_date, o.created_at) >= v_horizon_start
              AND app.metric_day_ist(o.order_date, o.created_at) <= v_today), 0)
          ELSE COALESCE((
            SELECT COUNT(*) FROM app.estimates e
            WHERE e.tenant_id = l.tenant_id AND e.location_id = l.id AND e.deleted_at IS NULL
              AND e.is_buyer_app_estimate AND app.estimate_status_counts_as_demand(e.status)
              AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_horizon_start
              AND app.metric_day_ist(e.estimate_date, e.created_at) <= v_today), 0)
        END AS demand_doc_count
    ) ld ON true$b$, 1, 'adoption by location');

  IF position('metrics_tenant_daily' IN v_def) > 0 OR position('metrics_location_daily' IN v_def) > 0 THEN
    RAISE EXCEPTION 'get_buyer_app_dashboard_v4 still references a stale daily table after patch';
  END IF;

  EXECUTE v_def;
END
$patch$;

-- Guard: nothing else may read the stale tables (function bodies are not tracked by pg_depend).
DO $guard$
DECLARE v_readers text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_readers
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('app', 'public')
    AND p.prokind IN ('f', 'p')
    AND p.proname <> 'metrics_location_daily_purge_soft_deleted_on_insert'
    AND (pg_get_functiondef(p.oid) LIKE '%metrics_tenant_daily%' OR pg_get_functiondef(p.oid) LIKE '%metrics_location_daily%');
  IF v_readers IS NOT NULL THEN
    RAISE EXCEPTION 'stale daily tables still referenced by: %', v_readers;
  END IF;
END
$guard$;
