-- List-page KPI strips computed at request time from raw tables (tier 1: header tables only).
-- Replaces app.get_landing_metrics_v4 (snapshot read, frozen since the metrics tick stopped) for: dashboard,
-- estimates, orders, invoices, customers, locations, buyer_app, customer_groups, price_lists, campaigns.
-- Item-level pages (products, categories, brands, warehouses) stay on the old function until their own migration.
--
-- Contract: same JSON as get_landing_metrics_v4 {page_key, period{...}, computed_at, source_watermark, cards[]};
-- card ids, time_basis and filter_preset are byte-identical to what app._metrics_v4_refresh_landing_kpis emitted, so
-- the clients, deep links and types do not change. Definitions come from that builder and the summary builders it read
-- (metrics_tenant/buyer/location/campaign/cohort summaries); canonical helpers only (metric_day_ist, *_status_* ).
-- Deliberate differences: invoice windows use app.metric_day_ist(invoice_date, created_at) everywhere (the old
-- buyer_app invoiced card used invoice_date); computed_at = now(); source_watermark = null.
--
-- Internal page functions are LANGUAGE sql with a single statement so they can be exercised as plain SELECTs.
-- Parameters: p_tenant_id, p_period_key, p_grain, p_start/p_end_excl (the requested period), p_q_start/p_q_end_excl
-- (the calendar quarter of p_as_of), p_now.

CREATE OR REPLACE FUNCTION app._landing_kpis_dashboard(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH prm AS (SELECT app.metrics_v4_primary_demand_kind(p_tenant_id) AS kind),
  inv AS (
    SELECT COALESCE(sum(i.total_amount), 0) AS v, count(DISTINCT i.buyer_id) AS b, count(*) AS c
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_end_excl
  ), dem AS (
    SELECT COALESCE(sum(x.amt), 0) AS v, count(DISTINCT x.buyer_id) AS b, count(*) AS c FROM (
      SELECT e.buyer_id, e.total_amount AS amt FROM app.estimates e, prm
      WHERE prm.kind = 'estimates' AND e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_counts_as_demand(e.status)
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_start AND app.metric_day_ist(e.estimate_date, e.created_at) < p_end_excl
      UNION ALL
      SELECT o.buyer_id, o.total_amount FROM app.orders o, prm
      WHERE prm.kind = 'orders' AND o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_in_flow(o.status)
        AND app.metric_day_ist(o.order_date, o.created_at) >= p_start AND app.metric_day_ist(o.order_date, o.created_at) < p_end_excl
    ) x
  ), rec AS (
    SELECT
      COALESCE(sum(i.outstanding_balance) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)), 0) AS rv,
      count(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)) AS rb,
      count(*) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)) AS rc,
      COALESCE(sum(i.outstanding_balance) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)), 0) AS ov,
      count(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)) AS ob,
      count(*) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)) AS oc
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.outstanding_balance > 0
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('invoiced_sales', inv.v, inv.b, inv.c, NULL, p_grain, jsonb_build_object('target', 'invoices', 'date_period', p_period_key)),
    app.metrics_v4_kpi('demand', dem.v, dem.b, dem.c, NULL, p_grain, jsonb_build_object('target', prm.kind, 'date_period', p_period_key)),
    app.metrics_v4_kpi('outstanding_dues', rec.rv, rec.rb, rec.rc, NULL, 'now', jsonb_build_object('target', 'invoices', 'balance_gt', 0)),
    app.metrics_v4_kpi('overdue_receivables', rec.ov, rec.ob, rec.oc, NULL, 'now', jsonb_build_object('target', 'invoices', 'overdue', true))
  ) FROM prm, inv, dem, rec;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_estimates(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH w AS (
    SELECT COALESCE(sum(e.total_amount), 0) AS v, count(DISTINCT e.buyer_id) AS b, count(*) AS c
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_start AND app.metric_day_ist(e.estimate_date, e.created_at) < p_end_excl
  ), st AS (
    -- every now-state filter below is a subset of status IN ('draft','sent','accepted')
    SELECT
      COALESCE(sum(e.total_amount) FILTER (WHERE app.estimate_status_is_open(e.status)), 0) AS ov,
      count(DISTINCT e.buyer_id) FILTER (WHERE app.estimate_status_is_open(e.status)) AS ob,
      count(*) FILTER (WHERE app.estimate_status_is_open(e.status)) AS oc,
      COALESCE(sum(e.total_amount) FILTER (WHERE e.status = 'sent' AND COALESCE(e.sent_at, e.created_at) < p_now - interval '3 days'), 0) AS av,
      count(DISTINCT e.buyer_id) FILTER (WHERE e.status = 'sent' AND COALESCE(e.sent_at, e.created_at) < p_now - interval '3 days') AS ab,
      count(*) FILTER (WHERE e.status = 'sent' AND COALESCE(e.sent_at, e.created_at) < p_now - interval '3 days') AS ac,
      COALESCE(sum(e.total_amount) FILTER (WHERE (app.estimate_status_is_open(e.status) OR e.status = 'accepted') AND e.valid_until <= (p_now AT TIME ZONE 'Asia/Kolkata')::date + 7), 0) AS xv,
      count(DISTINCT e.buyer_id) FILTER (WHERE (app.estimate_status_is_open(e.status) OR e.status = 'accepted') AND e.valid_until <= (p_now AT TIME ZONE 'Asia/Kolkata')::date + 7) AS xb,
      count(*) FILTER (WHERE (app.estimate_status_is_open(e.status) OR e.status = 'accepted') AND e.valid_until <= (p_now AT TIME ZONE 'Asia/Kolkata')::date + 7) AS xc
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.status IN ('draft', 'sent', 'accepted')
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('estimate_value_created', w.v, w.b, w.c, NULL, p_grain, jsonb_build_object('date_period', p_period_key)),
    app.metrics_v4_kpi('open_estimates', st.ov, st.ob, st.oc, NULL, 'now', jsonb_build_object('status', 'open')),
    app.metrics_v4_kpi('awaiting_action_3d', st.av, st.ab, st.ac, NULL, 'now', jsonb_build_object('status', 'sent', 'age_gte_days', 3)),
    app.metrics_v4_kpi('expiring_7d', st.xv, st.xb, st.xc, NULL, 'now', jsonb_build_object('expiry_lte_days', 7))
  ) FROM w, st;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_orders(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH w AS (
    SELECT COALESCE(sum(o.total_amount), 0) AS v, count(DISTINCT o.buyer_id) AS b, count(*) AS c
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= p_start AND app.metric_day_ist(o.order_date, o.created_at) < p_end_excl
  ), st AS (
    SELECT
      COALESCE(sum(o.total_amount), 0) AS ov, count(DISTINCT o.buyer_id) AS ob, count(*) AS oc,
      COALESCE(sum(o.total_amount) FILTER (WHERE o.status = 'received'), 0) AS wv,
      count(DISTINCT o.buyer_id) FILTER (WHERE o.status = 'received') AS wb,
      count(*) FILTER (WHERE o.status = 'received') AS wc,
      COALESCE(sum(o.total_amount) FILTER (WHERE o.status = 'confirmed' AND COALESCE(o.confirmed_at, o.updated_at, o.created_at) < p_now - interval '3 days'), 0) AS dv,
      count(DISTINCT o.buyer_id) FILTER (WHERE o.status = 'confirmed' AND COALESCE(o.confirmed_at, o.updated_at, o.created_at) < p_now - interval '3 days') AS db,
      count(*) FILTER (WHERE o.status = 'confirmed' AND COALESCE(o.confirmed_at, o.updated_at, o.created_at) < p_now - interval '3 days') AS dc
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_is_open(o.status)
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('order_value_created', w.v, w.b, w.c, NULL, p_grain, jsonb_build_object('date_period', p_period_key)),
    app.metrics_v4_kpi('open_orders', st.ov, st.ob, st.oc, NULL, 'now', jsonb_build_object('status', 'open')),
    app.metrics_v4_kpi('waiting_confirmation', st.wv, st.wb, st.wc, NULL, 'now', jsonb_build_object('status', 'received')),
    app.metrics_v4_kpi('awaiting_dispatch_3d', st.dv, st.db, st.dc, NULL, 'now', jsonb_build_object('status', 'confirmed', 'age_gte_days', 3))
  ) FROM w, st;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_invoices(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH inv AS (
    SELECT COALESCE(sum(i.total_amount), 0) AS v, count(DISTINCT i.buyer_id) AS b, count(*) AS c
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_end_excl
  ), rec AS (
    SELECT
      COALESCE(sum(i.outstanding_balance) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)), 0) AS rv,
      count(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)) AS rb,
      count(*) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)) AS rc,
      COALESCE(sum(i.outstanding_balance) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)), 0) AS ov,
      count(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)) AS ob,
      count(*) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)) AS oc,
      COALESCE(sum(i.outstanding_balance) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance) AND i.due_date < p_now + interval '7 days'), 0) AS dv,
      count(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance) AND i.due_date < p_now + interval '7 days') AS db,
      count(*) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance) AND i.due_date < p_now + interval '7 days') AS dc
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.outstanding_balance > 0
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('invoiced_sales', inv.v, inv.b, inv.c, NULL, p_grain, jsonb_build_object('date_period', p_period_key)),
    app.metrics_v4_kpi('outstanding_dues', rec.rv, rec.rb, rec.rc, NULL, 'now', jsonb_build_object('balance_gt', 0)),
    app.metrics_v4_kpi('overdue_receivables', rec.ov, rec.ob, rec.oc, NULL, 'now', jsonb_build_object('overdue', true)),
    app.metrics_v4_kpi('due_7d', rec.dv, rec.db, rec.dc, NULL, 'now', jsonb_build_object('due_lte_days', 7))
  ) FROM inv, rec;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_customers(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH q AS (
    SELECT i.buyer_id, sum(i.total_amount) AS v
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_q_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_q_end_excl
    GROUP BY i.buyer_id
  ), ranked AS (
    SELECT sum(q.v) OVER (ORDER BY q.v DESC) AS running, sum(q.v) OVER () AS total FROM q WHERE q.v > 0
  ), agg AS (
    SELECT (SELECT count(*) FROM q) AS active,
           (SELECT count(*) FROM app.buyers b WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL) AS buyers_total,
           (SELECT count(*) FROM ranked WHERE total > 0 AND running <= total * 0.8) AS top80
  ), rec AS (
    SELECT COALESCE(sum(i.outstanding_balance) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)), 0) AS ov,
           count(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)) AS ob,
           count(*) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)) AS oc
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.outstanding_balance > 0
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('active_customers', agg.active, agg.active, NULL, NULL, 'quarter', jsonb_build_object('purchased_gte', 1, 'period', 'this_quarter')),
    app.metrics_v4_kpi('dormant_customers', GREATEST(agg.buyers_total - agg.active, 0), GREATEST(agg.buyers_total - agg.active, 0), NULL, NULL, 'quarter', jsonb_build_object('dormant_period', 'this_quarter')),
    app.metrics_v4_kpi('overdue_receivables', rec.ov, rec.ob, rec.oc, NULL, 'now', jsonb_build_object('overdue', true)),
    app.metrics_v4_kpi('top80_customers', agg.top80, agg.top80, NULL, NULL, 'quarter', jsonb_build_object('sort', 'invoice_value_desc', 'cutoff', 'top80'))
  ) FROM agg, rec;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_locations(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH loc AS (
    SELECT i.location_id, sum(i.total_amount) AS v, count(*) AS c
    FROM app.invoices i
    JOIN app.locations l ON l.id = i.location_id AND l.tenant_id = p_tenant_id AND l.deleted_at IS NULL
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_end_excl
    GROUP BY i.location_id
  ), ranked AS (
    SELECT sum(loc.v) OVER (ORDER BY loc.v DESC) AS running, sum(loc.v) OVER () AS total FROM loc WHERE loc.v > 0
  ), sales AS (
    SELECT COALESCE(sum(loc.v), 0) AS v, count(*) FILTER (WHERE loc.v > 0) AS n, COALESCE(sum(loc.c), 0)::bigint AS c,
           (SELECT count(*) FROM ranked WHERE total > 0 AND running <= total * 0.8) AS top80
    FROM loc
  ), open_dem AS (
    SELECT COALESCE(sum(x.amt), 0) AS v, count(*) AS c, count(DISTINCT x.location_id) FILTER (WHERE x.location_id IS NOT NULL) AS n FROM (
      SELECT e.location_id, e.total_amount AS amt FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_is_open(e.status)
      UNION ALL
      SELECT o.location_id, o.total_amount FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_is_open(o.status)
    ) x
  ), od AS (
    SELECT COALESCE(sum(i.outstanding_balance), 0) AS v, count(*) AS c, count(DISTINCT i.location_id) FILTER (WHERE i.location_id IS NOT NULL) AS n
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.outstanding_balance > 0
      AND app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('invoiced_sales', sales.v, sales.n, sales.c, NULL, 'month', jsonb_build_object('target', 'invoices', 'period', 'this_month')),
    app.metrics_v4_kpi('open_demand', open_dem.v, open_dem.n, open_dem.c, NULL, 'now', jsonb_build_object('open_demand', true)),
    app.metrics_v4_kpi('overdue_receivables', od.v, od.n, od.c, NULL, 'now', jsonb_build_object('overdue', true)),
    app.metrics_v4_kpi('top80_locations', sales.top80, sales.top80, NULL, NULL, 'month', jsonb_build_object('sort', 'invoice_value_desc', 'cutoff', 'top80'))
  ) FROM sales, open_dem, od;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_buyer_app(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH est AS (
    SELECT e.buyer_id, e.total_amount, e.is_buyer_app_estimate AS is_app
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_q_start AND app.metric_day_ist(e.estimate_date, e.created_at) < p_q_end_excl
  ), ord AS (
    SELECT o.buyer_id, o.total_amount, o.is_buyer_app_order AS is_app
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= p_q_start AND app.metric_day_ist(o.order_date, o.created_at) < p_q_end_excl
  ), inv AS (
    SELECT i.buyer_id, i.total_amount, i.is_buyer_app_invoice AS is_app
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_q_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_q_end_excl
  ), b AS (
    SELECT count(*) AS total, count(*) FILTER (WHERE b.buyer_app_enabled) AS enabled
    FROM app.buyers b WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
  ), dem AS (
    SELECT
      (COALESCE((SELECT sum(total_amount) FROM est WHERE is_app), 0) + COALESCE((SELECT sum(total_amount) FROM ord WHERE is_app), 0)) AS v,
      ((SELECT count(DISTINCT buyer_id) FROM est WHERE is_app) + (SELECT count(DISTINCT buyer_id) FROM ord WHERE is_app)) AS buyers,
      ((SELECT count(*) FROM est WHERE is_app) + (SELECT count(*) FROM ord WHERE is_app)) AS docs,
      (COALESCE((SELECT sum(total_amount) FROM est), 0) + COALESCE((SELECT sum(total_amount) FROM ord), 0)) AS tenant_v,
      (SELECT count(DISTINCT buyer_id) FROM (SELECT buyer_id FROM est WHERE is_app UNION ALL SELECT buyer_id FROM ord WHERE is_app) a) AS demand_buyers
  ), ai AS (
    SELECT COALESCE(sum(total_amount) FILTER (WHERE is_app), 0) AS v, count(DISTINCT buyer_id) FILTER (WHERE is_app) AS buyers,
           count(*) FILTER (WHERE is_app) AS docs, COALESCE(sum(total_amount), 0) AS tenant_v
    FROM inv
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('customers_with_access', b.enabled, b.enabled, NULL, b.total, 'now', jsonb_build_object('buyer_app_enabled', true)),
    app.metrics_v4_kpi('app_sourced_demand_qtd', dem.v, dem.buyers, dem.docs, dem.tenant_v, 'quarter', jsonb_build_object('source', 'buyer_app', 'period', 'this_quarter')),
    app.metrics_v4_kpi('app_sourced_invoiced_sales_qtd', ai.v, ai.buyers, ai.docs, ai.tenant_v, 'quarter', jsonb_build_object('source', 'buyer_app', 'period', 'this_quarter', 'is_buyer_app_invoice', true)),
    app.metrics_v4_kpi('app_no_order_customers_qtd', GREATEST(b.enabled - dem.demand_buyers, 0), GREATEST(b.enabled - dem.demand_buyers, 0), NULL, b.enabled, 'quarter',
                       jsonb_build_object('source', 'buyer_app', 'period', 'this_quarter', 'buyer_app_enabled', true, 'app_demand_count_is_zero', true))
  ) FROM b, dem, ai;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_customer_groups(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH prm AS (SELECT app.metrics_v4_primary_demand_kind(p_tenant_id) AS kind),
  grp AS (
    SELECT (SELECT count(*) FROM app.cohorts c WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL) AS active_groups,
           (SELECT count(DISTINCT cm.buyer_id) FROM app.cohorts c JOIN app.cohort_members_active cm ON cm.cohort_id = c.id
             WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL) AS grouped_buyers,
           (SELECT count(*) FROM app.buyers b WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL) AS buyers_total
  ), inv AS (
    SELECT i.buyer_id FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_q_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_q_end_excl
    GROUP BY i.buyer_id HAVING sum(i.total_amount) > 0
  ), demand_buyers AS (
    SELECT x.buyer_id FROM (
      SELECT e.buyer_id FROM app.estimates e, prm
      WHERE prm.kind = 'estimates' AND e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_counts_as_demand(e.status)
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_q_start AND app.metric_day_ist(e.estimate_date, e.created_at) < p_q_end_excl
      UNION
      SELECT o.buyer_id FROM app.orders o, prm
      WHERE prm.kind = 'orders' AND o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_in_flow(o.status)
        AND app.metric_day_ist(o.order_date, o.created_at) >= p_q_start AND app.metric_day_ist(o.order_date, o.created_at) < p_q_end_excl
    ) x
  ), agg AS (
    SELECT (SELECT count(*) FROM inv WHERE NOT EXISTS (SELECT 1 FROM app.cohort_members_active cm WHERE cm.buyer_id = inv.buyer_id)) AS valuable_no_group,
           (SELECT count(DISTINCT c.id) FROM app.cohorts c
              JOIN app.cohort_members_active cm ON cm.cohort_id = c.id
              JOIN demand_buyers d ON d.buyer_id = cm.buyer_id
             WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL) AS grouped_purchased
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('active_groups', grp.active_groups, grp.active_groups, NULL, grp.grouped_buyers, 'now', jsonb_build_object('status', 'active')),
    app.metrics_v4_kpi('customers_assigned', grp.grouped_buyers, grp.grouped_buyers, NULL, grp.buyers_total, 'now', jsonb_build_object('group', 'not_null')),
    app.metrics_v4_kpi('valuable_no_group', agg.valuable_no_group, agg.valuable_no_group, NULL, NULL, 'quarter_now', jsonb_build_object('group', 'none', 'valuable_period', 'this_quarter')),
    app.metrics_v4_kpi('grouped_purchased', agg.grouped_purchased, agg.grouped_purchased, NULL, NULL, 'quarter', jsonb_build_object('member_purchased_period', 'this_quarter'))
  ) FROM grp, agg;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_price_lists(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH pl AS (
    SELECT count(DISTINCT pli.tenant_product_id) AS custom_products,
           count(DISTINCT pli.tenant_product_id) FILTER (WHERE pli.price < tp.base_selling_price) AS below_base
    FROM app.price_list_items pli
    JOIN app.price_lists l ON l.id = pli.price_list_id
    JOIN app.tenant_products tp ON tp.id = pli.tenant_product_id
    WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL AND pli.deleted_at IS NULL
      AND l.is_active AND l.valid_from <= p_now AND (l.valid_to IS NULL OR l.valid_to >= p_now)
  ), pb AS (
    SELECT count(DISTINCT x.buyer_id) AS buyers FROM (
      SELECT pla.target_id AS buyer_id
      FROM app.price_list_assignments pla JOIN app.price_lists l ON l.id = pla.price_list_id
      WHERE l.tenant_id = p_tenant_id AND pla.deleted_at IS NULL AND pla.target_type = 'buyer'
        AND l.deleted_at IS NULL AND l.is_active AND l.valid_from <= p_now AND (l.valid_to IS NULL OR l.valid_to >= p_now)
      UNION
      SELECT cm.buyer_id
      FROM app.price_list_assignments pla
      JOIN app.price_lists l ON l.id = pla.price_list_id
      JOIN app.cohort_members_active cm ON cm.cohort_id = pla.target_id
      WHERE l.tenant_id = p_tenant_id AND pla.deleted_at IS NULL AND pla.target_type = 'cohort'
        AND l.deleted_at IS NULL AND l.is_active AND l.valid_from <= p_now AND (l.valid_to IS NULL OR l.valid_to >= p_now)
    ) x WHERE x.buyer_id IS NOT NULL
  ), ex AS (
    SELECT count(*) AS n FROM app.price_lists l
    WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL AND l.is_active
      AND l.valid_to IS NOT NULL AND l.valid_to >= p_now AND l.valid_to < p_now + interval '7 days'
  ), tot AS (
    SELECT (SELECT count(*) FROM app.tenant_products t WHERE t.tenant_id = p_tenant_id AND t.deleted_at IS NULL) AS products,
           (SELECT count(*) FROM app.buyers b WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL) AS buyers
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('custom_price_products', pl.custom_products, pl.custom_products, NULL, tot.products, 'now', jsonb_build_object('has_custom_price', true)),
    app.metrics_v4_kpi('custom_price_customers', pb.buyers, pb.buyers, NULL, tot.buyers, 'now', jsonb_build_object('has_custom_pricing', true)),
    app.metrics_v4_kpi('below_base_products', pl.below_base, pl.below_base, NULL, NULL, 'now', jsonb_build_object('price_below_base', true)),
    app.metrics_v4_kpi('expiring_7d', ex.n, ex.n, NULL, NULL, 'now', jsonb_build_object('expiry_lte_days', 7))
  ) FROM pl, pb, ex, tot;
$function$;

CREATE OR REPLACE FUNCTION app._landing_kpis_campaigns(
  p_tenant_id uuid, p_period_key text, p_grain text, p_start date, p_end_excl date, p_q_start date, p_q_end_excl date, p_now timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH live AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE c.valid_to IS NOT NULL AND c.valid_to < p_now + interval '7 days') AS expiring
    FROM app.campaigns c
    WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL AND c.status = 'published'
      AND c.valid_from <= p_now AND (c.valid_to IS NULL OR c.valid_to >= p_now)
  ), vw AS (
    SELECT COALESCE(sum(v.vc), 0)::bigint AS views, COALESCE(sum(v.vb), 0)::bigint AS openers FROM (
      SELECT cv.campaign_id, count(*) AS vc, count(DISTINCT cv.buyer_id) AS vb
      FROM app.campaign_views cv
      JOIN app.campaigns c ON c.id = cv.campaign_id AND c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
      WHERE cv.tenant_id = p_tenant_id AND cv.deleted_at IS NULL
        AND (cv.viewed_at AT TIME ZONE 'Asia/Kolkata')::date >= p_q_start AND (cv.viewed_at AT TIME ZONE 'Asia/Kolkata')::date < p_q_end_excl
      GROUP BY cv.campaign_id
    ) v
  ), dem AS (
    SELECT COALESCE(sum(d.cnt), 0)::bigint AS cnt, COALESCE(sum(d.val), 0) AS val, COALESCE(sum(d.buyers), 0)::bigint AS buyers FROM (
      SELECT x.campaign_id, count(*) AS cnt, sum(x.amt) AS val, count(DISTINCT x.buyer_id) AS buyers FROM (
        SELECT e.campaign_id, e.buyer_id, e.total_amount AS amt FROM app.estimates e
        JOIN app.campaigns c ON c.id = e.campaign_id AND c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
        WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.campaign_id IS NOT NULL AND app.estimate_status_counts_as_demand(e.status)
          AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_q_start AND app.metric_day_ist(e.estimate_date, e.created_at) < p_q_end_excl
        UNION ALL
        SELECT o.campaign_id, o.buyer_id, o.total_amount FROM app.orders o
        JOIN app.campaigns c ON c.id = o.campaign_id AND c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
        WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.campaign_id IS NOT NULL AND app.order_status_in_flow(o.status)
          AND app.metric_day_ist(o.order_date, o.created_at) >= p_q_start AND app.metric_day_ist(o.order_date, o.created_at) < p_q_end_excl
      ) x GROUP BY x.campaign_id
    ) d
  ), rev AS (
    SELECT COALESCE(sum(r.cnt), 0)::bigint AS cnt, COALESCE(sum(r.val), 0) AS val, COALESCE(sum(r.buyers), 0)::bigint AS buyers FROM (
      SELECT o.campaign_id, count(*) AS cnt, sum(i.total_amount) AS val, count(DISTINCT i.buyer_id) AS buyers
      FROM app.invoices i
      JOIN app.orders o ON o.id = i.order_id AND o.campaign_id IS NOT NULL
      JOIN app.campaigns c ON c.id = o.campaign_id AND c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
      WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
        AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_q_start AND app.metric_day_ist(i.invoice_date, i.created_at) < p_q_end_excl
      GROUP BY o.campaign_id
    ) r
  )
  SELECT jsonb_build_array(
    app.metrics_v4_kpi('live_campaigns', live.n, live.n, NULL, live.expiring, 'now', jsonb_build_object('status', 'live')),
    app.metrics_v4_kpi('campaign_open_rate', vw.openers, vw.openers, vw.views, NULL, 'quarter', jsonb_build_object('period', 'this_quarter', 'has_views', true)),
    app.metrics_v4_kpi('campaign_demand', dem.val, dem.buyers, dem.cnt, NULL, 'quarter', jsonb_build_object('period', 'this_quarter', 'has_demand', true)),
    app.metrics_v4_kpi('campaign_revenue', rev.val, rev.buyers, rev.cnt, NULL, 'quarter', jsonb_build_object('period', 'this_quarter', 'has_revenue', true))
  ) FROM live, vw, dem, rev;
$function$;

-- Dispatcher. Pages not migrated yet (products, categories, brands, warehouses) are served by the caller via
-- get_landing_metrics_v4 until their own migration; asking for them here raises unsupported_page.
CREATE OR REPLACE FUNCTION app.get_landing_kpis(
  p_tenant_id uuid,
  p_page_key text,
  p_period_key text DEFAULT 'this_month',
  p_as_of timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_now timestamptz := COALESCE(p_as_of, now());
  v_b record;
  v_q record;
  v_cards jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_page_key IS NULL THEN
    RAISE EXCEPTION 'landing_identity_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_b FROM app.metrics_v4_period_bounds(COALESCE(p_period_key, 'this_month'), v_now);
  IF v_b.period_start IS NULL THEN
    RAISE EXCEPTION 'landing_period_invalid:%', p_period_key USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_q FROM app.metrics_v4_period_bounds('this_quarter', v_now);

  v_cards := CASE p_page_key
    WHEN 'dashboard' THEN app._landing_kpis_dashboard(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'estimates' THEN app._landing_kpis_estimates(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'orders' THEN app._landing_kpis_orders(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'invoices' THEN app._landing_kpis_invoices(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'customers' THEN app._landing_kpis_customers(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'locations' THEN app._landing_kpis_locations(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'buyer_app' THEN app._landing_kpis_buyer_app(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'customer_groups' THEN app._landing_kpis_customer_groups(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'price_lists' THEN app._landing_kpis_price_lists(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    WHEN 'campaigns' THEN app._landing_kpis_campaigns(p_tenant_id, v_b.period_key, v_b.grain, v_b.period_start, v_b.period_end_exclusive, v_q.period_start, v_q.period_end_exclusive, v_now)
    ELSE NULL
  END;
  IF v_cards IS NULL THEN
    RAISE EXCEPTION 'landing_page_unsupported:%', p_page_key USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'page_key', p_page_key,
    'period', jsonb_build_object(
      'period_key', v_b.period_key,
      'grain', v_b.grain,
      'period_start', v_b.period_start,
      'period_end_exclusive', v_b.period_end_exclusive,
      'label', v_b.label
    ),
    'computed_at', now(),
    'source_watermark', NULL,
    'cards', v_cards
  );
END;
$function$;

REVOKE ALL ON FUNCTION app._landing_kpis_dashboard(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_estimates(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_orders(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_invoices(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_customers(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_locations(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_buyer_app(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_customer_groups(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_price_lists(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._landing_kpis_campaigns(uuid, text, text, date, date, date, date, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_landing_kpis(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_landing_kpis(uuid, text, text, timestamptz) TO service_role;

COMMENT ON FUNCTION app.get_landing_kpis(uuid, text, text, timestamptz) IS 'List-page KPI strips computed at request time from raw tables (tier 1 pages). Same JSON as get_landing_metrics_v4. service_role only.';
COMMENT ON FUNCTION app._landing_kpis_dashboard(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the dashboard page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_estimates(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the estimates page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_orders(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the orders page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_invoices(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the invoices page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_customers(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the customers page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_locations(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the locations page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_buyer_app(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the buyer-app page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_customer_groups(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the customer-groups page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_price_lists(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the price-lists page (raw tables).';
COMMENT ON FUNCTION app._landing_kpis_campaigns(uuid, text, text, date, date, date, date, timestamptz) IS 'Landing KPI cards for the campaigns page (raw tables).';
