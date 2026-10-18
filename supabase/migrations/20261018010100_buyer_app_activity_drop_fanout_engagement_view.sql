-- Slim buyer_app_activity ledger, step B.
-- 1. app.buyer_app_engagement: engagement-days view = presence ledger rows UNION buyer-app
--    estimates/orders (by canonical metric day). Estimates/orders already live in their own tables, so
--    they are no longer mirrored into buyer_app_activity.
-- 2. Drop the per-row write fan-out: metrics capture triggers on buyer_app_activity and the
--    estimate/order dispatch triggers whose only job was the mirror upsert.
-- 3. Make the mirror functions no-ops (keeps rebuild_* / post_sync_rebuild callers valid until the
--    metrics tick is retired).
-- 4. Repoint engagement readers (dashboard v4, ops rollup) to the view.

CREATE OR REPLACE VIEW app.buyer_app_engagement
WITH (security_invoker = true) AS
  SELECT a.tenant_id, a.buyer_id, a.location_id, a.occurred_day,
         true AS qualifies_for_engagement, NULL::timestamptz AS deleted_at
  FROM app.buyer_app_activity a
  WHERE a.deleted_at IS NULL AND a.qualifies_for_engagement
  UNION ALL
  SELECT e.tenant_id, e.buyer_id, e.location_id, app.metric_day_ist(e.estimate_date, e.created_at),
         true, NULL::timestamptz
  FROM app.estimates e
  WHERE e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
  UNION ALL
  SELECT o.tenant_id, o.buyer_id, o.location_id, app.metric_day_ist(o.order_date, o.created_at),
         true, NULL::timestamptz
  FROM app.orders o
  WHERE o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL;

COMMENT ON VIEW app.buyer_app_engagement IS
  'Buyer-app engagement days: presence ledger (buyer_app_activity) UNION buyer-app estimates/orders. Filter by tenant_id and occurred_day.';

REVOKE ALL ON app.buyer_app_engagement FROM PUBLIC, anon;
GRANT SELECT ON app.buyer_app_engagement TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_metrics_v2_capture_buyer_app_activity ON app.buyer_app_activity;
DROP TRIGGER IF EXISTS trg_metrics_v2_capture_buyer_app_activity_upd ON app.buyer_app_activity;
DROP TRIGGER IF EXISTS trg_estimates_dispatch ON app.estimates;
DROP TRIGGER IF EXISTS trg_orders_dispatch ON app.orders;
DROP FUNCTION IF EXISTS app.dispatch_from_estimates();
DROP FUNCTION IF EXISTS app.dispatch_from_orders();

CREATE OR REPLACE FUNCTION app.sync_buyer_app_activity_from_estimate(p_estimate_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- No-op: buyer-app estimates are read from app.estimates via app.buyer_app_engagement.
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION app.sync_buyer_app_activity_from_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- No-op: buyer-app orders are read from app.orders via app.buyer_app_engagement.
  RETURN;
END;
$$;

-- Duplicates buyer_app_activity_tenant_source_entity_unique (same columns, partial).
DROP INDEX IF EXISTS app.idx_buyer_app_activity_source_lookup;

CREATE OR REPLACE FUNCTION app.get_buyer_app_dashboard_v4(
  p_tenant_id uuid,
  p_role text DEFAULT NULL,
  p_location_ids uuid[] DEFAULT NULL,
  p_as_of timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_as_of timestamptz := COALESCE(p_as_of, now());
  v_today date := (COALESCE(p_as_of, now()) AT TIME ZONE 'Asia/Kolkata')::date;
  v_horizon_start date := ((COALESCE(p_as_of, now()) AT TIME ZONE 'Asia/Kolkata')::date - 89);
  v_12m_start date := ((COALESCE(p_as_of, now()) AT TIME ZONE 'Asia/Kolkata')::date - 364);
  v_scope_location_ids uuid[] := CASE
    WHEN p_location_ids IS NULL OR array_length(p_location_ids, 1) IS NULL THEN NULL
    ELSE p_location_ids
  END;
  v_tenant_scoped boolean := v_scope_location_ids IS NULL;
  v_primary text := app.metrics_v4_primary_demand_kind(p_tenant_id);
  v_quarter record;
  v_now_summary app.metrics_tenant_now_summary%ROWTYPE;
  v_period_summary app.metrics_tenant_period_summary%ROWTYPE;
  v_enabled_buyers bigint := 0;
  v_total_buyers bigint := 0;
  v_used_buyers bigint := 0;
  v_demand_customers bigint := 0;
  v_repeat_customers bigint := 0;
  v_app_demand_value numeric := 0;
  v_total_demand_value numeric := 0;
  v_app_invoiced_value numeric := 0;
  v_total_invoiced_value numeric := 0;
  v_cancelled_count bigint := 0;
  v_demand_count bigint := 0;
  v_assisted_without_access jsonb := '[]'::jsonb;
  v_assisted_without_access_count bigint := 0;
  v_enabled_never_used jsonb := '[]'::jsonb;
  v_enabled_never_used_count bigint := 0;
  v_used_no_demand jsonb := '[]'::jsonb;
  v_used_no_demand_count bigint := 0;
  v_inactive_after_demand jsonb := '[]'::jsonb;
  v_inactive_after_demand_count bigint := 0;
  v_operational_action jsonb := '[]'::jsonb;
  v_operational_action_count bigint := 0;
  v_business_through_app jsonb := '{}'::jsonb;
  v_contribution_over_time jsonb := '[]'::jsonb;
  v_adoption_by_location jsonb := '[]'::jsonb;
  v_adoption_by_group jsonb := '[]'::jsonb;
  v_assisted_quality jsonb := '{}'::jsonb;
  v_moving_to_app jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_quarter FROM app.metrics_v4_period_bounds('this_quarter', v_as_of);

  SELECT COUNT(DISTINCT a.buyer_id)
  INTO v_used_buyers
  FROM app.buyer_app_engagement a
  WHERE a.tenant_id = p_tenant_id
    AND a.deleted_at IS NULL
    AND a.qualifies_for_engagement
    AND a.occurred_day >= v_horizon_start
    AND (v_scope_location_ids IS NULL OR a.location_id = ANY(v_scope_location_ids));

  IF v_tenant_scoped THEN
    SELECT * INTO v_now_summary
    FROM app.metrics_tenant_now_summary
    WHERE tenant_id = p_tenant_id AND deleted_at IS NULL;

    SELECT * INTO v_period_summary
    FROM app.metrics_tenant_period_summary
    WHERE tenant_id = p_tenant_id AND grain = 'quarter' AND period_start = v_quarter.period_start AND deleted_at IS NULL;

    v_enabled_buyers := COALESCE(v_now_summary.enabled_buyer_count, 0);
    v_total_buyers := COALESCE(v_now_summary.active_buyer_count, 0);

    SELECT
      COUNT(*) FILTER (WHERE bp.app_demand_count >= 1),
      COUNT(*) FILTER (WHERE bp.app_demand_count >= 2)
    INTO v_demand_customers, v_repeat_customers
    FROM app.metrics_buyer_period_summary bp
    WHERE bp.tenant_id = p_tenant_id AND bp.grain = 'quarter' AND bp.period_start = v_quarter.period_start AND bp.deleted_at IS NULL;

    v_app_demand_value := CASE WHEN v_primary = 'orders' THEN COALESCE(v_period_summary.app_order_value, 0) ELSE COALESCE(v_period_summary.app_estimate_value, 0) END;
    v_total_demand_value := COALESCE(v_period_summary.primary_demand_value, 0);
    v_demand_count := CASE WHEN v_primary = 'orders' THEN COALESCE(v_period_summary.app_order_count, 0) ELSE COALESCE(v_period_summary.app_estimate_count, 0) END;
    v_total_invoiced_value := COALESCE(v_period_summary.invoice_value, 0);

    SELECT COALESCE(SUM(i.total_amount) FILTER (WHERE app.invoice_status_gmv_included(i.status)), 0)
    INTO v_app_invoiced_value
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id
      AND i.deleted_at IS NULL
      AND i.is_buyer_app_invoice
      AND i.invoice_date >= v_quarter.period_start
      AND i.invoice_date < v_quarter.period_end_exclusive;

    IF v_primary = 'orders' THEN
      SELECT COUNT(*) INTO v_cancelled_count
      FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order
        AND o.status = ANY (ARRAY['cancelled','rejected','archived'])
        AND app.metric_day_ist(o.order_date, o.created_at) >= v_quarter.period_start;
    END IF;

    WITH enabled_buyer_ids AS (
      -- buyer_app_enabled=true is the selective side (~2-3% of buyers on
      -- Wine Yard) -- anti-join against it instead of scanning buyers
      -- WHERE NOT buyer_app_enabled (~97% of the table, a seq scan in a
      -- NOT-filter costume).
      SELECT id FROM app.buyers WHERE tenant_id = p_tenant_id AND buyer_app_enabled
    ),
    assisted_all AS (
      SELECT bp.buyer_id, b.business_name, bp.invoice_value, bp.invoice_count
      FROM app.metrics_buyer_period_summary bp
      JOIN app.buyers b ON b.id = bp.buyer_id
      WHERE bp.tenant_id = p_tenant_id AND bp.grain = 'quarter' AND bp.period_start = v_quarter.period_start AND bp.deleted_at IS NULL
        AND bp.invoice_value > 0
        AND NOT EXISTS (SELECT 1 FROM enabled_buyer_ids eb WHERE eb.id = bp.buyer_id)
    ),
    assisted AS (
      SELECT * FROM assisted_all ORDER BY invoice_value DESC, business_name LIMIT 100
    )
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('buyer_id', buyer_id, 'name', business_name, 'invoice_value_qtd', invoice_value, 'invoice_count_qtd', invoice_count)) FROM assisted), '[]'::jsonb),
      (SELECT COUNT(*) FROM assisted_all)
    INTO v_assisted_without_access, v_assisted_without_access_count;
  ELSE
    SELECT COUNT(*), COUNT(*) FILTER (WHERE b.buyer_app_enabled)
    INTO v_total_buyers, v_enabled_buyers
    FROM app.buyers b
    WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND b.is_active;

    SELECT COUNT(DISTINCT buyer_id)
    INTO v_demand_customers
    FROM (
      SELECT o.buyer_id FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order
        AND app.metric_day_ist(o.order_date, o.created_at) >= v_horizon_start
        AND o.location_id = ANY(v_scope_location_ids)
      UNION
      SELECT e.buyer_id FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_horizon_start
        AND e.location_id = ANY(v_scope_location_ids)
    ) demand_buyers;

    SELECT COUNT(*) FILTER (WHERE doc_count >= 2)
    INTO v_repeat_customers
    FROM (
      SELECT buyer_id, COUNT(*) AS doc_count FROM (
        SELECT o.buyer_id FROM app.orders o
        WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order
          AND app.metric_day_ist(o.order_date, o.created_at) >= v_horizon_start
          AND o.location_id = ANY(v_scope_location_ids)
        UNION ALL
        SELECT e.buyer_id FROM app.estimates e
        WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate
          AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_horizon_start
          AND e.location_id = ANY(v_scope_location_ids)
        UNION ALL
        SELECT i.buyer_id FROM app.invoices i
        WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.is_buyer_app_invoice
          AND app.metric_day_ist(i.invoice_date, i.created_at) >= v_horizon_start
          AND i.location_id = ANY(v_scope_location_ids)
      ) docs GROUP BY buyer_id
    ) counts;

    IF v_primary = 'orders' THEN
      SELECT
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status)), 0),
        COALESCE(SUM(o.total_amount) FILTER (WHERE app.order_status_in_flow(o.status)), 0),
        COUNT(*) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status)),
        COUNT(*) FILTER (WHERE o.is_buyer_app_order AND o.status = ANY (ARRAY['cancelled','rejected','archived']))
      INTO v_app_demand_value, v_total_demand_value, v_demand_count, v_cancelled_count
      FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
        AND app.metric_day_ist(o.order_date, o.created_at) >= v_horizon_start
        AND o.location_id = ANY(v_scope_location_ids);
    ELSIF v_primary = 'estimates' THEN
      SELECT
        COALESCE(SUM(e.total_amount) FILTER (WHERE e.is_buyer_app_estimate), 0),
        COALESCE(SUM(e.total_amount), 0),
        COUNT(*) FILTER (WHERE e.is_buyer_app_estimate),
        0
      INTO v_app_demand_value, v_total_demand_value, v_demand_count, v_cancelled_count
      FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_horizon_start
        AND e.location_id = ANY(v_scope_location_ids);
    END IF;

    SELECT
      COALESCE(SUM(i.total_amount) FILTER (WHERE i.is_buyer_app_invoice AND app.invoice_status_gmv_included(i.status)), 0),
      COALESCE(SUM(i.total_amount) FILTER (WHERE app.invoice_status_gmv_included(i.status)), 0)
    INTO v_app_invoiced_value, v_total_invoiced_value
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= v_horizon_start
      AND i.location_id = ANY(v_scope_location_ids);

    WITH enabled_buyer_ids AS (
      SELECT id FROM app.buyers WHERE tenant_id = p_tenant_id AND buyer_app_enabled
    ),
    assisted_all AS (
      SELECT bp.buyer_id, b.business_name, bp.invoice_value, bp.invoice_count
      FROM app.metrics_buyer_period_summary bp
      JOIN app.buyers b ON b.id = bp.buyer_id
      WHERE bp.tenant_id = p_tenant_id AND bp.grain = 'quarter' AND bp.period_start = v_quarter.period_start AND bp.deleted_at IS NULL
        AND bp.invoice_value > 0
        AND NOT EXISTS (SELECT 1 FROM enabled_buyer_ids eb WHERE eb.id = bp.buyer_id)
    ),
    assisted AS (
      SELECT * FROM assisted_all ORDER BY invoice_value DESC, business_name LIMIT 100
    )
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('buyer_id', buyer_id, 'name', business_name, 'invoice_value_qtd', invoice_value, 'invoice_count_qtd', invoice_count)) FROM assisted), '[]'::jsonb),
      (SELECT COUNT(*) FROM assisted_all)
    INTO v_assisted_without_access, v_assisted_without_access_count;
  END IF;

  WITH used AS (
    SELECT DISTINCT a.buyer_id
    FROM app.buyer_app_engagement a
    WHERE a.tenant_id = p_tenant_id AND a.deleted_at IS NULL AND a.qualifies_for_engagement
      AND a.occurred_day >= v_horizon_start
  ), demand AS (
    SELECT DISTINCT buyer_id FROM app.orders
    WHERE v_primary = 'orders' AND tenant_id = p_tenant_id AND deleted_at IS NULL AND is_buyer_app_order
      AND app.metric_day_ist(order_date, created_at) >= v_horizon_start
    UNION
    SELECT DISTINCT buyer_id FROM app.estimates
    WHERE v_primary = 'estimates' AND tenant_id = p_tenant_id AND deleted_at IS NULL AND is_buyer_app_estimate
      AND app.metric_day_ist(estimate_date, created_at) >= v_horizon_start
  ), enabled_never_used_all AS (
    SELECT
      b.id,
      b.business_name,
      COALESCE(bp.invoice_value, 0) AS invoice_value_qtd,
      COALESCE(bp.invoice_count, 0) AS invoice_count_qtd
    FROM app.buyers b
    LEFT JOIN used u ON u.buyer_id = b.id
    LEFT JOIN app.metrics_buyer_period_summary bp ON bp.tenant_id = b.tenant_id AND bp.buyer_id = b.id AND bp.grain = 'quarter' AND bp.period_start = v_quarter.period_start AND bp.deleted_at IS NULL
    WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND b.is_active AND b.buyer_app_enabled AND u.buyer_id IS NULL
  ), used_no_demand_all AS (
    SELECT
      b.id,
      b.business_name,
      COALESCE(bp.invoice_value, 0) AS invoice_value_qtd,
      COALESCE(bp.invoice_count, 0) AS invoice_count_qtd
    FROM app.buyers b
    JOIN used u ON u.buyer_id = b.id
    LEFT JOIN demand d ON d.buyer_id = b.id
    LEFT JOIN app.metrics_buyer_period_summary bp ON bp.tenant_id = b.tenant_id AND bp.buyer_id = b.id AND bp.grain = 'quarter' AND bp.period_start = v_quarter.period_start AND bp.deleted_at IS NULL
    WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND d.buyer_id IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('buyer_id', ranked.id, 'name', ranked.business_name, 'invoice_value_qtd', ranked.invoice_value_qtd, 'invoice_count_qtd', ranked.invoice_count_qtd) ORDER BY ranked.invoice_value_qtd DESC, ranked.business_name)
      FROM (SELECT * FROM enabled_never_used_all ORDER BY invoice_value_qtd DESC, business_name LIMIT 100) ranked), '[]'::jsonb),
    (SELECT COUNT(*) FROM enabled_never_used_all),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('buyer_id', ranked.id, 'name', ranked.business_name, 'invoice_value_qtd', ranked.invoice_value_qtd, 'invoice_count_qtd', ranked.invoice_count_qtd) ORDER BY ranked.invoice_value_qtd DESC, ranked.business_name)
      FROM (SELECT * FROM used_no_demand_all ORDER BY invoice_value_qtd DESC, business_name LIMIT 100) ranked), '[]'::jsonb),
    (SELECT COUNT(*) FROM used_no_demand_all)
  INTO v_enabled_never_used, v_enabled_never_used_count, v_used_no_demand, v_used_no_demand_count;

  WITH app_demand AS (
    SELECT buyer_id, MAX(app.metric_day_ist(order_date, created_at)) AS last_day, SUM(total_amount) AS value
    FROM app.orders
    WHERE v_primary = 'orders' AND tenant_id = p_tenant_id AND deleted_at IS NULL AND is_buyer_app_order
    GROUP BY buyer_id
    UNION ALL
    SELECT buyer_id, MAX(app.metric_day_ist(estimate_date, created_at)) AS last_day, SUM(total_amount) AS value
    FROM app.estimates
    WHERE v_primary = 'estimates' AND tenant_id = p_tenant_id AND deleted_at IS NULL AND is_buyer_app_estimate
    GROUP BY buyer_id
  ), inactive_after_demand_all AS (
    SELECT b.id, b.business_name, ad.last_day, ad.value
    FROM app_demand ad
    JOIN app.buyers b ON b.id = ad.buyer_id
    WHERE ad.last_day < v_today - 30
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('buyer_id', ranked.id, 'name', ranked.business_name, 'last_demand_day', ranked.last_day, 'value', ranked.value) ORDER BY ranked.last_day NULLS FIRST, ranked.value DESC)
      FROM (SELECT * FROM inactive_after_demand_all ORDER BY last_day NULLS FIRST, value DESC LIMIT 20) ranked), '[]'::jsonb),
    (SELECT COUNT(*) FROM inactive_after_demand_all)
  INTO v_inactive_after_demand, v_inactive_after_demand_count;

  IF v_primary = 'orders' THEN
    WITH operational_action_all AS (
      SELECT o.id, o.buyer_id, o.status, o.total_amount, o.updated_at
      FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND app.order_status_is_open(o.status)
    )
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ranked.id, 'buyer_id', ranked.buyer_id, 'status', ranked.status, 'value', ranked.total_amount) ORDER BY ranked.updated_at NULLS FIRST, ranked.total_amount DESC)
        FROM (SELECT * FROM operational_action_all ORDER BY updated_at NULLS FIRST, total_amount DESC LIMIT 20) ranked), '[]'::jsonb),
      (SELECT COUNT(*) FROM operational_action_all)
    INTO v_operational_action, v_operational_action_count;
  ELSIF v_primary = 'estimates' THEN
    WITH operational_action_all AS (
      SELECT e.id, e.buyer_id, e.status, e.total_amount, e.updated_at
      FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND app.estimate_status_is_open(e.status)
    )
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ranked.id, 'buyer_id', ranked.buyer_id, 'status', ranked.status, 'value', ranked.total_amount) ORDER BY ranked.updated_at NULLS FIRST, ranked.total_amount DESC)
        FROM (SELECT * FROM operational_action_all ORDER BY updated_at NULLS FIRST, total_amount DESC LIMIT 20) ranked), '[]'::jsonb),
      (SELECT COUNT(*) FROM operational_action_all)
    INTO v_operational_action, v_operational_action_count;
  END IF;

  v_business_through_app := jsonb_build_object(
    'primary_demand_kind', v_primary,
    'app_primary_demand_value_90d', v_app_demand_value,
    'total_primary_demand_value_90d', v_total_demand_value,
    'app_invoiced_sales_90d', v_app_invoiced_value,
    'total_invoiced_sales_90d', v_total_invoiced_value
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'month', month_start,
    'app_demand_value', app_demand_value,
    'total_demand_value', total_demand_value,
    'app_invoice_value', app_invoice_value,
    'total_invoice_value', total_invoice_value
  ) ORDER BY month_start), '[]'::jsonb)
  INTO v_contribution_over_time
  FROM (
    SELECT date_trunc('month', d.day)::date AS month_start,
      SUM(CASE WHEN v_primary = 'orders' THEN d.app_order_value ELSE d.app_estimate_value END) AS app_demand_value,
      SUM(CASE WHEN v_primary = 'orders' THEN d.order_value ELSE d.estimate_value END) AS total_demand_value,
      SUM(d.app_invoice_value) AS app_invoice_value,
      SUM(d.invoice_value) AS total_invoice_value
    FROM app.metrics_tenant_daily d
    WHERE d.tenant_id = p_tenant_id AND d.deleted_at IS NULL AND d.day >= v_12m_start AND d.day <= v_today
    GROUP BY date_trunc('month', d.day)::date
  ) monthly;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'location_id', l.id,
    'name', l.name,
    'app_demand_value_90d', demand_value,
    'app_invoiced_sales_90d', invoice_value,
    'app_demand_doc_count_90d', demand_doc_count,
    'active_buyers_90d', active_buyers
  ) ORDER BY invoice_value DESC, demand_value DESC), '[]'::jsonb)
  INTO v_adoption_by_location
  FROM (
    SELECT l.id, l.name,
      COALESCE(SUM(ld.app_invoice_value), 0) AS invoice_value,
      COALESCE(SUM(CASE WHEN v_primary = 'orders' THEN ld.app_order_value ELSE ld.app_estimate_value END), 0) AS demand_value,
      COALESCE(SUM(CASE WHEN v_primary = 'orders' THEN ld.app_order_count ELSE ld.app_estimate_count END), 0) AS demand_doc_count,
      COUNT(DISTINCT a.buyer_id) AS active_buyers
    FROM app.locations l
    LEFT JOIN app.metrics_location_daily ld ON ld.tenant_id = l.tenant_id AND ld.location_id = l.id AND ld.deleted_at IS NULL AND ld.day >= v_horizon_start
    LEFT JOIN app.buyer_app_engagement a ON a.tenant_id = l.tenant_id AND a.location_id = l.id AND a.deleted_at IS NULL AND a.qualifies_for_engagement AND a.occurred_day >= v_horizon_start
    WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL
      AND (v_scope_location_ids IS NULL OR l.id = ANY(v_scope_location_ids))
    GROUP BY l.id, l.name
  ) l;

  WITH enabled_buyer_ids_for_groups AS (
    SELECT id FROM app.buyers WHERE tenant_id = p_tenant_id AND buyer_app_enabled
  ), group_rows AS (
    SELECT c.id, c.name,
      COUNT(DISTINCT cm.buyer_id) FILTER (WHERE eb.id IS NOT NULL) AS enabled_buyers,
      COUNT(DISTINCT a.buyer_id) AS active_buyers
    FROM app.cohorts c
    JOIN app.cohort_members cm ON cm.cohort_id = c.id
    LEFT JOIN enabled_buyer_ids_for_groups eb ON eb.id = cm.buyer_id
    LEFT JOIN app.buyer_app_engagement a ON a.tenant_id = c.tenant_id AND a.buyer_id = cm.buyer_id AND a.deleted_at IS NULL AND a.qualifies_for_engagement AND a.occurred_day >= v_horizon_start
    WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
    GROUP BY c.id, c.name
    ORDER BY active_buyers DESC, enabled_buyers DESC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('group_id', id, 'name', name, 'enabled_buyers', enabled_buyers, 'active_buyers', active_buyers)), '[]'::jsonb)
  INTO v_adoption_by_group
  FROM group_rows;

  v_assisted_quality := jsonb_build_object(
    'available', v_primary = 'orders',
    'unavailable_reason', CASE WHEN v_primary <> 'orders' THEN 'Cancellation quality comparison is available only for Order-primary tenants.' ELSE NULL END,
    'app_cancellation_rate_pct', CASE WHEN v_demand_count > 0 THEN ROUND((v_cancelled_count::numeric / v_demand_count::numeric) * 100, 2) ELSE NULL END
  );

  v_moving_to_app := jsonb_build_array();

  RETURN jsonb_build_object(
    'as_of', v_as_of,
    'commercial_horizon_days', CASE WHEN v_tenant_scoped THEN NULL ELSE 90 END,
    'table_period', CASE WHEN v_tenant_scoped THEN 'this_quarter' ELSE NULL END,
    'primary_demand_kind', v_primary,
    'calculation_version', 4,
    'source_watermark', v_now_summary.source_watermark,
    'freshness', jsonb_build_object(
      'tenant_now_source_watermark', v_now_summary.source_watermark,
      'tenant_now_computed_at', v_now_summary.computed_at,
      'tenant_period_source_watermark', v_period_summary.source_watermark,
      'tenant_period_computed_at', v_period_summary.computed_at
    ),
    'availability', jsonb_build_object(
      'primary_demand', jsonb_build_object('available', v_primary <> 'none', 'kind', v_primary),
      'demand_cancellation_rate', v_assisted_quality,
      'adoption_by_customer_group', jsonb_build_object('available', jsonb_array_length(v_adoption_by_group) > 0)
    ),
    'metrics', jsonb_build_array(
      app.metrics_v2_foundation_item('customers_with_access', 'Customers with Buyer App access', 'NOW', 'READY', NULL, v_enabled_buyers, 'count'),
      app.metrics_v2_foundation_item('customers_submitting_app_demand', 'Customers submitting app demand', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'READY', NULL, v_demand_customers, 'count'),
      app.metrics_v2_foundation_item('app_sourced_invoiced_sales_share', 'App-sourced invoiced sales + share', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'READY', CASE WHEN v_total_invoiced_value > 0 THEN ROUND((v_app_invoiced_value / v_total_invoiced_value) * 100, 2) ELSE 0 END, NULL, 'percent', true, NULL, jsonb_build_object('app_invoiced_sales_90d', v_app_invoiced_value, 'total_invoiced_sales_90d', v_total_invoiced_value)),
      app.metrics_v2_foundation_item('repeat_app_customers', 'Repeat app customers', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'READY', NULL, v_repeat_customers, 'count'),
      app.metrics_v2_foundation_item('app_sourced_demand_value_share', 'App-sourced demand value + share', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'REWORK', CASE WHEN v_total_demand_value > 0 THEN ROUND((v_app_demand_value / v_total_demand_value) * 100, 2) ELSE 0 END, v_demand_count, 'percent', v_primary <> 'none', CASE WHEN v_primary = 'none' THEN 'No primary demand module is enabled.' ELSE NULL END, jsonb_build_object('app_demand_value_90d', v_app_demand_value, 'total_demand_value_90d', v_total_demand_value)),
      app.metrics_v2_foundation_item('customers_who_used_app', 'Customers who used the app', '90D', 'READY', NULL, v_used_buyers, 'count'),
      app.metrics_v2_foundation_item('demand_cancellation_rate', 'Demand cancellation rate', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'CONDITIONAL', CASE WHEN v_demand_count > 0 THEN ROUND((v_cancelled_count::numeric / v_demand_count::numeric) * 100, 2) ELSE NULL END, v_cancelled_count, 'percent', v_primary = 'orders', CASE WHEN v_primary <> 'orders' THEN 'Cancellation rate is only reliable for Order-primary tenants.' ELSE NULL END, '{}'::jsonb),
      app.metrics_v2_foundation_item('average_demand_docs_per_enabled_customer', 'Average demand documents per enabled customer', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'REWORK', CASE WHEN v_enabled_buyers > 0 THEN ROUND(v_demand_count::numeric / v_enabled_buyers::numeric, 2) ELSE NULL END, v_demand_count, 'ratio', v_primary <> 'none', CASE WHEN v_primary = 'none' THEN 'No primary demand module is enabled.' ELSE NULL END, '{}'::jsonb)
    ),
    'actions', jsonb_build_array(
      app.metrics_v2_foundation_item('valuable_assisted_customers_without_access', 'Valuable assisted customers without app access', CASE WHEN v_tenant_scoped THEN 'NOW + QTD' ELSE 'NOW + 90D' END, 'READY', NULL, v_assisted_without_access_count, 'count', true, NULL, jsonb_build_object('rows', v_assisted_without_access)),
      app.metrics_v2_foundation_item('access_enabled_but_never_used', 'Access enabled but never used', 'NOW', 'READY', NULL, v_enabled_never_used_count, 'count', true, NULL, jsonb_build_object('rows', v_enabled_never_used)),
      app.metrics_v2_foundation_item('used_app_but_no_demand', 'Used the app but submitted no demand', 'NOW + 90D', 'REWORK', NULL, v_used_no_demand_count, 'count', v_primary <> 'none', CASE WHEN v_primary = 'none' THEN 'No primary demand module is enabled.' ELSE NULL END, jsonb_build_object('rows', v_used_no_demand)),
      app.metrics_v2_foundation_item('previously_submitted_app_demand_now_inactive', 'Previously submitted app demand, now inactive', 'NOW + 90D', 'REWORK', NULL, v_inactive_after_demand_count, 'count', v_primary <> 'none', CASE WHEN v_primary = 'none' THEN 'No primary demand module is enabled.' ELSE NULL END, jsonb_build_object('rows', v_inactive_after_demand)),
      app.metrics_v2_foundation_item('app_demand_needing_operational_action', 'App demand needing operational action', 'NOW', 'REWORK', NULL, v_operational_action_count, 'count', v_primary <> 'none', CASE WHEN v_primary = 'none' THEN 'No primary demand module is enabled.' ELSE NULL END, jsonb_build_object('rows', v_operational_action))
    ),
    'explore', jsonb_build_array(
      app.metrics_v2_foundation_item('adoption_funnel', 'Adoption funnel', '90D', 'REWORK', NULL, NULL, NULL, true, NULL, jsonb_build_object('access', v_enabled_buyers, 'used', v_used_buyers, 'submitted_primary_demand', v_demand_customers, 'repeat', v_repeat_customers)),
      app.metrics_v2_foundation_item('business_through_app', 'Business through the app', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'REWORK', NULL, NULL, NULL, true, NULL, v_business_through_app),
      app.metrics_v2_foundation_item('app_contribution_over_time', 'App contribution over time', '12M', 'REWORK', NULL, NULL, NULL, true, NULL, jsonb_build_object('months', v_contribution_over_time)),
      app.metrics_v2_foundation_item('adoption_by_location', 'Adoption by location', '90D', 'REWORK', NULL, NULL, NULL, true, NULL, jsonb_build_object('locations', v_adoption_by_location)),
      app.metrics_v2_foundation_item('adoption_by_customer_group', 'Adoption by Customer Group', '90D', 'CONDITIONAL', NULL, NULL, NULL, jsonb_array_length(v_adoption_by_group) > 0, CASE WHEN jsonb_array_length(v_adoption_by_group) = 0 THEN 'No current customer groups are available.' ELSE NULL END, jsonb_build_object('groups', v_adoption_by_group)),
      app.metrics_v2_foundation_item('assisted_versus_app_order_quality', 'Assisted versus app order quality', CASE WHEN v_tenant_scoped THEN 'QTD' ELSE '90D' END, 'CONDITIONAL', NULL, NULL, NULL, v_primary = 'orders', CASE WHEN v_primary <> 'orders' THEN 'Order quality comparison is only available for Order-primary tenants.' ELSE NULL END, v_assisted_quality),
      app.metrics_v2_foundation_item('customers_moving_from_assisted_to_app', 'Customers moving from assisted to app', '90D', 'ON-OPEN', NULL, NULL, NULL, true, NULL, jsonb_build_object('rows', v_moving_to_app))
    )
  );
END;
$$;

create or replace function app.compute_ops_daily_rollup(p_day date)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'app'
as $function$
declare
  v_computed_at timestamptz := now();
begin
  delete from app.ops_daily_rollup where day = p_day;

  with tenant_orders as (
    select tenant_id,
           count(*) filter (where status not in ('draft', 'cancelled')) as order_count,
           coalesce(sum(total_amount) filter (where status not in ('draft', 'cancelled')), 0) as order_value,
           count(*) filter (where status not in ('draft', 'cancelled') and is_buyer_app_order) as app_order_count,
           coalesce(sum(total_amount) filter (where status not in ('draft', 'cancelled') and is_buyer_app_order), 0) as app_order_value
    from app.orders
    where order_date = p_day and deleted_at is null
    group by tenant_id
  ),
  tenant_invoices as (
    select tenant_id, count(*) as invoice_count, coalesce(sum(total_amount), 0) as invoice_value
    from app.invoices
    where invoice_date = p_day and deleted_at is null
    group by tenant_id
  ),
  tenant_estimates as (
    select tenant_id, count(*) as estimate_count, coalesce(sum(total_amount), 0) as estimate_value
    from app.estimates
    where estimate_date = p_day and deleted_at is null
    group by tenant_id
  ),
  tenant_new_buyers as (
    select tenant_id, count(*) as new_buyer_count
    from app.buyers
    where deleted_at is null and (created_at at time zone 'Asia/Kolkata')::date = p_day
    group by tenant_id
  ),
  tenant_active_buyers as (
    select tenant_id, count(distinct buyer_id) as active_buyer_count
    from app.buyer_app_engagement
    where occurred_day = p_day and qualifies_for_engagement and deleted_at is null
    group by tenant_id
  ),
  tenant_webhook_errors as (
    select tenant_id,
           count(*) as webhook_error_count,
           count(*) filter (where retryable is false) as webhook_error_critical_count
    from app.integration_webhook_errors
    where deleted_at is null and (created_at at time zone 'Asia/Kolkata')::date = p_day
    group by tenant_id
  ),
  tenant_sync_failures as (
    select tenant_id, count(*) as sync_job_failure_count
    from app.integration_sync_jobs
    where deleted_at is null and status = 'failed'
      and (coalesce(completed_at, updated_at) at time zone 'Asia/Kolkata')::date = p_day
    group by tenant_id
  ),
  tenant_rows as (
    select
      t.id as tenant_id,
      coalesce(o.order_count, 0) as order_count,
      coalesce(o.order_value, 0) as order_value,
      coalesce(o.app_order_count, 0) as app_order_count,
      coalesce(o.app_order_value, 0) as app_order_value,
      coalesce(i.invoice_count, 0) as invoice_count,
      coalesce(i.invoice_value, 0) as invoice_value,
      coalesce(e.estimate_count, 0) as estimate_count,
      coalesce(e.estimate_value, 0) as estimate_value,
      coalesce(ab.active_buyer_count, 0) as active_buyer_count,
      coalesce(nb.new_buyer_count, 0) as new_buyer_count,
      coalesce(we.webhook_error_count, 0) as webhook_error_count,
      coalesce(we.webhook_error_critical_count, 0) as webhook_error_critical_count,
      coalesce(sf.sync_job_failure_count, 0) as sync_job_failure_count
    from app.tenants t
    left join tenant_orders o on o.tenant_id = t.id
    left join tenant_invoices i on i.tenant_id = t.id
    left join tenant_estimates e on e.tenant_id = t.id
    left join tenant_active_buyers ab on ab.tenant_id = t.id
    left join tenant_new_buyers nb on nb.tenant_id = t.id
    left join tenant_webhook_errors we on we.tenant_id = t.id
    left join tenant_sync_failures sf on sf.tenant_id = t.id
    where t.deleted_at is null
  )
  insert into app.ops_daily_rollup (
    day, tenant_id, order_count, order_value, app_order_count, app_order_value,
    invoice_count, invoice_value, estimate_count, estimate_value,
    active_buyer_count, new_buyer_count, webhook_error_count, webhook_error_critical_count,
    sync_job_failure_count, active_tenant_count, computed_at
  )
  select p_day, tenant_id, order_count, order_value, app_order_count, app_order_value,
         invoice_count, invoice_value, estimate_count, estimate_value,
         active_buyer_count, new_buyer_count, webhook_error_count, webhook_error_critical_count,
         sync_job_failure_count, 0, v_computed_at
  from tenant_rows;

  insert into app.ops_daily_rollup (
    day, tenant_id, order_count, order_value, app_order_count, app_order_value,
    invoice_count, invoice_value, estimate_count, estimate_value,
    active_buyer_count, new_buyer_count, webhook_error_count, webhook_error_critical_count,
    sync_job_failure_count, active_tenant_count, computed_at
  )
  select
    p_day, null,
    sum(order_count), sum(order_value), sum(app_order_count), sum(app_order_value),
    sum(invoice_count), sum(invoice_value), sum(estimate_count), sum(estimate_value),
    sum(active_buyer_count), sum(new_buyer_count), sum(webhook_error_count), sum(webhook_error_critical_count),
    sum(sync_job_failure_count),
    count(*) filter (where order_count > 0 or invoice_count > 0 or estimate_count > 0 or active_buyer_count > 0),
    v_computed_at
  from app.ops_daily_rollup
  where day = p_day and tenant_id is not null;

  perform app.compute_ops_daily_flags(p_day);
end;
$function$;
