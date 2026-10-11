-- P1: cooperative wall-clock deadline for the metrics refresh compute stage.
--
-- Problem: app.metrics_refresh_tick('compute', ...) read tick_wall_budget_ms but only compared it with
-- elapsed time AFTER the whole group had finished. Each statement is capped by statement_timeout
-- (3 s), but a group is many statements, so one group could run for tens of seconds (observed
-- 16-35 s regularly) and, once a real statement cancel disarms the timer for the rest of the CALL,
-- far longer (4m42s at 14:40 UTC on 2026-10-01). The group was then rolled back and the snapshot
-- stayed stale (daily `metrics_tick_wall_budget_exceeded` failures, orphaned `started` rows).
--
-- Change (behaviour-preserving when a group finishes inside the budget):
--   1. app._metrics_check_deadline(): raises the existing `metrics_tick_wall_budget_exceeded`
--      (SQLSTATE 57014) once clock_timestamp() passes the deadline published by the tick, and is a
--      no-op when no deadline is set (backfill drivers, manual calls).
--   2. app.metrics_refresh_tick: the compute stage publishes the deadline
--      (v_started + tick_wall_budget_ms) in the transaction-local setting app.metrics_tick_deadline.
--   3. app._metrics_v4_refresh_claimed_periods and app._metrics_v4_refresh_setup_now call the helper
--      between statement groups, so a group stops after at most one statement past the budget instead
--      of finishing the whole group. metrics_refresh_tick_run already treats this exact message as its
--      own budget guard (it records the failure and keeps going; it only stops on a foreign 57014).
--
-- Function bodies below are the live definitions (identical on yukti-dev and yukti-prod) plus only the
-- added lines marked above; setup_now additionally keeps the invoice-count predicate from
-- 20261001163219_metrics_setup_now_invoice_counts_use_partial_index.sql.
--
-- Not changed here (separate, explicit config step): metrics_runtime_control.tick_wall_budget_ms is
-- 45000 today; lowering it (e.g. to 15000) is what makes the guard bite earlier.

CREATE OR REPLACE FUNCTION app._metrics_check_deadline()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  v_deadline text := current_setting('app.metrics_tick_deadline', true);
BEGIN
  IF v_deadline IS NOT NULL AND v_deadline <> ''
     AND clock_timestamp() > v_deadline::timestamptz THEN
    RAISE EXCEPTION 'metrics_tick_wall_budget_exceeded' USING ERRCODE = '57014';
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION app._metrics_check_deadline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._metrics_check_deadline() TO service_role;

CREATE OR REPLACE FUNCTION app.metrics_refresh_tick(p_stage text, p_owner_token uuid, p_fencing_epoch bigint DEFAULT NULL::bigint, p_tenant_id uuid DEFAULT NULL::uuid, p_domain text DEFAULT NULL::text, p_error_text text DEFAULT NULL::text)
 RETURNS TABLE(status text, owner_token uuid, fencing_epoch bigint, tenant_id uuid, domain text, dirty_sources integer, refresh_keys integer, statement_groups integer, has_more boolean, lease_until timestamp with time zone, error_text text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
 SET work_mem TO '32MB'
AS $function$
#variable_conflict use_column
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows integer := 0;
  v_groups integer := 0;
  v_sources integer := 0;
  v_keys integer := 0;
  v_has_more boolean := false;
  v_watermark timestamptz;
  v_lease_until timestamptz;
  v_dead integer := 0;
  v_lock_timeout_ms integer := 100;
  v_statement_timeout_ms integer := 3000;
  v_wall_budget_ms integer := 5000;
  v_statement_group_budget integer := 25;
  v_error_text text;
BEGIN
  IF p_stage = 'claim' THEN
    RETURN QUERY SELECT * FROM app.metrics_claim_dirty_work(p_owner_token);
    RETURN;
  END IF;

  IF p_stage <> ALL (ARRAY['compute', 'acknowledge', 'fail', 'release']) THEN
    RAISE EXCEPTION 'metrics_tick_stage_invalid:%', p_stage USING ERRCODE = '22023';
  END IF;
  IF p_fencing_epoch IS NULL OR p_tenant_id IS NULL OR p_domain IS NULL THEN
    RAISE EXCEPTION 'metrics_claim_identity_required' USING ERRCODE = '22023';
  END IF;

  SELECT
    COALESCE(MIN(c.lock_timeout_ms), 100),
    COALESCE(MIN(c.statement_timeout_ms), 3000),
    COALESCE(MIN(c.tick_wall_budget_ms), 5000),
    COALESCE(MIN(c.max_statement_groups_per_tick), 25)
  INTO v_lock_timeout_ms, v_statement_timeout_ms, v_wall_budget_ms, v_statement_group_budget
  FROM app.metrics_runtime_control c
  WHERE c.control_scope = 'global'
     OR (
       c.control_scope = 'tenant'
       AND c.tenant_id = p_tenant_id
       AND (c.domain IS NULL OR c.domain = p_domain)
     );

  PERFORM set_config('lock_timeout', v_lock_timeout_ms::text || 'ms', true);
  PERFORM set_config('statement_timeout', v_statement_timeout_ms::text || 'ms', true);
  -- Cooperative wall-clock deadline for the refresh functions (see app._metrics_check_deadline).
  PERFORM set_config('app.metrics_tick_deadline',
    (v_started + make_interval(secs => v_wall_budget_ms / 1000.0))::text, true);

  IF p_stage = 'compute' THEN
    v_lease_until := app._metrics_assert_refresh_fence(
      p_owner_token, p_fencing_epoch, p_tenant_id, p_domain
    );
    UPDATE app.metrics_dirty_work w
    SET cursor_kind = CASE p_domain
          WHEN 'commercial' THEN 'buyer'
          WHEN 'inventory' THEN 'product'
          ELSE 'done'
        END,
        cursor_id = NULL, cursor_aux_id = NULL, cursor_day = NULL, updated_at = clock_timestamp()
    WHERE w.lease_owner = p_owner_token AND w.state = 'claimed'
      AND w.claimed_version = w.dirty_version
      AND w.dirty_from IS NOT NULL AND w.cursor_kind IS NULL;
    PERFORM set_config('app.metrics_cursor_stage', COALESCE((
      SELECT w.cursor_kind FROM app.metrics_dirty_work w
      WHERE w.lease_owner = p_owner_token AND w.state = 'claimed' AND w.dirty_from IS NOT NULL
      ORDER BY w.created_at, w.id LIMIT 1
    ), ''), true);
    SELECT COUNT(*)::integer,
      COALESCE(SUM(
        1 + (old_buyer_id IS NOT NULL)::integer + (new_buyer_id IS NOT NULL)::integer
          + (old_tenant_product_id IS NOT NULL)::integer + (new_tenant_product_id IS NOT NULL)::integer
          + (old_location_id IS NOT NULL)::integer + (new_location_id IS NOT NULL)::integer
          + (old_day IS NOT NULL)::integer + (new_day IS NOT NULL)::integer
      ), 0)::integer
    INTO v_sources, v_keys
    FROM app.metrics_dirty_work
    WHERE lease_owner = p_owner_token AND state = 'claimed' AND claimed_version IS NOT NULL;

    IF p_domain = 'commercial' THEN
      SELECT r.rows_written, r.statement_groups, r.source_watermark
      INTO v_rows, v_groups, v_watermark
      FROM app._metrics_refresh_commercial(p_owner_token, p_fencing_epoch, p_tenant_id) r;
    ELSIF p_domain = 'inventory' THEN
      SELECT r.rows_written, r.statement_groups, r.source_watermark
      INTO v_rows, v_groups, v_watermark
      FROM app._metrics_refresh_inventory(p_owner_token, p_fencing_epoch, p_tenant_id) r;
    ELSIF p_domain = 'buyer_app' THEN
      SELECT r.rows_written, r.statement_groups, r.source_watermark
      INTO v_rows, v_groups, v_watermark
      FROM app._metrics_refresh_buyer_app(p_owner_token, p_fencing_epoch, p_tenant_id) r;
    ELSIF p_domain = 'setup' THEN
      SELECT r.rows_written, r.statement_groups, r.source_watermark
      INTO v_rows, v_groups, v_watermark
      FROM app._metrics_refresh_setup(p_owner_token, p_fencing_epoch, p_tenant_id) r;
    ELSE
      RAISE EXCEPTION 'metrics_domain_invalid' USING ERRCODE = '22023';
    END IF;

    IF v_groups > v_statement_group_budget THEN
      RAISE EXCEPTION 'metrics_statement_group_budget_exceeded' USING ERRCODE = '54000';
    END IF;
    IF EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000 > v_wall_budget_ms THEN
      RAISE EXCEPTION 'metrics_tick_wall_budget_exceeded' USING ERRCODE = '57014';
    END IF;

    UPDATE app.metrics_execution_history h
    SET statement_groups_executed = v_groups,
        snapshot_rows_updated = v_rows,
        compute_completed_at = clock_timestamp()
    WHERE h.id = (
      SELECT id FROM app.metrics_execution_history
      WHERE owner_token = p_owner_token AND status = 'started'
      ORDER BY started_at DESC LIMIT 1
      FOR UPDATE
    );

    RETURN QUERY SELECT 'computed', p_owner_token, p_fencing_epoch, p_tenant_id, p_domain,
      v_sources, v_keys, v_groups, true, v_lease_until, NULL::text;
    RETURN;
  END IF;

  IF p_stage = 'acknowledge' THEN
    v_lease_until := app._metrics_assert_refresh_fence(
      p_owner_token, p_fencing_epoch, p_tenant_id, p_domain
    );

    IF NOT EXISTS (
      SELECT 1
      FROM app.metrics_execution_history h
      WHERE h.owner_token = p_owner_token
        AND h.tenant_id = p_tenant_id
        AND h.domain = p_domain
        AND h.fencing_epoch = p_fencing_epoch
        AND h.status = 'started'
        AND h.compute_completed_at IS NOT NULL
      ORDER BY h.started_at DESC
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'metrics_compute_required_before_acknowledge' USING ERRCODE = '55000';
    END IF;

    WITH acknowledged AS (
      UPDATE app.metrics_dirty_work w
      SET
        state = CASE
          WHEN w.dirty_version <> w.claimed_version THEN 'pending'
          WHEN w.dirty_from IS NOT NULL AND w.cursor_kind IS DISTINCT FROM 'done' THEN 'pending'
          ELSE 'completed'
        END,
        cursor_kind = CASE WHEN w.dirty_version = w.claimed_version
          AND (w.dirty_from IS NULL OR w.cursor_kind = 'done') THEN NULL ELSE w.cursor_kind END,
        cursor_id = CASE WHEN w.dirty_version = w.claimed_version
          AND (w.dirty_from IS NULL OR w.cursor_kind = 'done') THEN NULL ELSE w.cursor_id END,
        cursor_aux_id = CASE WHEN w.dirty_version = w.claimed_version
          AND (w.dirty_from IS NULL OR w.cursor_kind = 'done') THEN NULL ELSE w.cursor_aux_id END,
        cursor_day = CASE WHEN w.dirty_version = w.claimed_version
          AND (w.dirty_from IS NULL OR w.cursor_kind = 'done') THEN NULL ELSE w.cursor_day END,
        attempts = CASE WHEN w.dirty_version <> w.claimed_version THEN 0 ELSE w.attempts END,
        next_attempt_at = clock_timestamp(),
        lease_owner = NULL,
        lease_until = NULL,
        claimed_version = NULL,
        last_error = NULL,
        completed_at = CASE
          WHEN w.dirty_version = w.claimed_version
            AND (w.dirty_from IS NULL OR w.cursor_kind = 'done')
          THEN clock_timestamp() ELSE NULL END,
        updated_at = clock_timestamp()
      WHERE w.lease_owner = p_owner_token
        AND w.tenant_id = p_tenant_id
        AND w.domain = p_domain
        AND w.state = 'claimed'
      RETURNING state, dirty_version
    )
    SELECT COUNT(*)::integer, COALESCE(bool_or(state <> 'completed'), false)
    INTO v_sources, v_has_more
    FROM acknowledged;

    SELECT v_has_more OR EXISTS (
      SELECT 1 FROM app.metrics_dirty_work pending
      WHERE pending.tenant_id = p_tenant_id
        AND pending.domain = p_domain
        AND pending.state = ANY (ARRAY['pending', 'retry', 'claimed'])
    ) INTO v_has_more;

    UPDATE app.metrics_refresh_state s
    SET last_completed_version = GREATEST(s.last_completed_version, COALESCE((
          SELECT MAX(w.dirty_version) FROM app.metrics_dirty_work w
          WHERE w.tenant_id = p_tenant_id AND w.domain = p_domain AND w.state = 'completed'
        ), s.last_completed_version)),
        source_watermark = COALESCE((
          SELECT MAX(x.source_watermark) FROM (
            SELECT MAX(t.source_watermark) AS source_watermark FROM app.metrics_tenant_period_summary t
              WHERE t.tenant_id = p_tenant_id AND t.deleted_at IS NULL AND p_domain = 'commercial'
            UNION ALL SELECT MAX(l.source_watermark) FROM app.metrics_location_period_summary l
              WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL AND p_domain = 'inventory'
            UNION ALL SELECT MAX(w2.source_watermark) FROM app.metrics_warehouse_period_summary w2
              WHERE w2.tenant_id = p_tenant_id AND w2.deleted_at IS NULL AND p_domain = 'inventory'
            UNION ALL SELECT MAX(cp.source_watermark) FROM app.metrics_campaign_period_summary cp
              WHERE cp.tenant_id = p_tenant_id AND cp.deleted_at IS NULL AND p_domain = 'buyer_app'
            UNION ALL SELECT MAX(co.source_watermark) FROM app.metrics_cohort_period_summary co
              WHERE co.tenant_id = p_tenant_id AND co.deleted_at IS NULL AND p_domain = 'buyer_app'
            UNION ALL SELECT MAX(lk.source_watermark) FROM app.metrics_landing_kpi_snapshot lk
              WHERE lk.tenant_id = p_tenant_id AND lk.deleted_at IS NULL AND p_domain = 'setup'
          ) x
        ), s.source_watermark),
        last_successful_computation_at = clock_timestamp(),
        last_duration_ms = ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000)::integer,
        freshness_state = CASE WHEN v_has_more THEN 'stale' ELSE 'fresh' END,
        stale_after = CASE WHEN v_has_more THEN clock_timestamp() ELSE clock_timestamp() + interval '15 minutes' END,
        last_error = NULL,
        updated_at = clock_timestamp()
    WHERE s.tenant_id = p_tenant_id AND s.domain = p_domain;

    UPDATE app.metrics_execution_history h
    SET status = 'success', finished_at = clock_timestamp(),
        duration_ms = ROUND(EXTRACT(epoch FROM (clock_timestamp() - h.started_at)) * 1000)::integer
    WHERE h.id = (
      SELECT id FROM app.metrics_execution_history
      WHERE owner_token = p_owner_token AND status = 'started'
      ORDER BY started_at DESC LIMIT 1 FOR UPDATE
    );

    UPDATE app.metrics_refresh_leases
    SET owner_token = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = clock_timestamp()
    WHERE lease_scope = 'tenant_domain' AND tenant_id = p_tenant_id AND domain = p_domain
      AND owner_token = p_owner_token AND fencing_epoch = p_fencing_epoch;
    UPDATE app.metrics_refresh_leases
    SET owner_token = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = clock_timestamp()
    WHERE lease_scope = 'global' AND owner_token = p_owner_token AND fencing_epoch = p_fencing_epoch;

    RETURN QUERY SELECT 'acknowledged', p_owner_token, p_fencing_epoch, p_tenant_id, p_domain,
      v_sources, 0, 0, v_has_more, v_lease_until, NULL::text;
    RETURN;
  END IF;

  IF p_stage = 'fail' THEN
    v_lease_until := app._metrics_assert_refresh_fence(
      p_owner_token, p_fencing_epoch, p_tenant_id, p_domain
    );
    v_error_text := COALESCE(p_error_text, 'metrics_compute_failed');

    -- A failure is version-scoped. A newer dirty version is immediately reset
    -- to pending and never inherits an older version's attempts/backoff.
    WITH failed AS (
      UPDATE app.metrics_dirty_work w
      SET attempts = CASE WHEN w.dirty_version = w.claimed_version THEN w.attempts + 1 ELSE 0 END,
        state = CASE
          WHEN w.dirty_version <> w.claimed_version THEN 'pending'
          WHEN w.attempts + 1 >= 3 THEN 'dead_letter'
          ELSE 'retry'
        END,
        next_attempt_at = CASE
          WHEN w.dirty_version <> w.claimed_version THEN clock_timestamp()
          ELSE clock_timestamp()
            + make_interval(secs => LEAST(300, (2 ^ LEAST(w.attempts + 1, 8))::integer))
            + make_interval(secs => floor(random() * 3)::integer)
        END,
        lease_owner = NULL, lease_until = NULL, claimed_version = NULL,
        last_error = CASE WHEN w.dirty_version = w.claimed_version THEN v_error_text ELSE NULL END,
        updated_at = clock_timestamp()
      WHERE w.lease_owner = p_owner_token AND w.tenant_id = p_tenant_id
        AND w.domain = p_domain AND w.state = 'claimed'
      RETURNING state
    )
    SELECT COUNT(*)::integer, COUNT(*) FILTER (WHERE state = 'dead_letter')::integer
    INTO v_sources, v_dead FROM failed;

    IF v_sources = 0 THEN
      RAISE EXCEPTION 'metrics_no_claimed_work_to_fail' USING ERRCODE = '55000';
    END IF;

    UPDATE app.metrics_refresh_state
    SET freshness_state = CASE WHEN v_dead > 0 THEN 'error' ELSE 'stale' END,
        last_error = v_error_text, updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND domain = p_domain;
    UPDATE app.metrics_execution_history h
    SET status = CASE WHEN v_dead > 0 THEN 'dead_letter' ELSE 'failed' END,
        dead_letter_count = v_dead, error_text = v_error_text,
        finished_at = clock_timestamp(),
        duration_ms = ROUND(EXTRACT(epoch FROM (clock_timestamp() - h.started_at)) * 1000)::integer
    WHERE h.id = (
      SELECT id FROM app.metrics_execution_history
      WHERE owner_token = p_owner_token AND status = 'started'
      ORDER BY started_at DESC LIMIT 1 FOR UPDATE
    );

    RETURN QUERY SELECT CASE WHEN v_dead > 0 THEN 'dead_letter' ELSE 'retry' END,
      p_owner_token, p_fencing_epoch, p_tenant_id, p_domain,
      v_sources, 0, 0, true, v_lease_until, v_error_text;
    RETURN;
  END IF;

  -- release is compare-and-release only; it never acknowledges dirty work.
  UPDATE app.metrics_refresh_leases
  SET owner_token = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = clock_timestamp()
  WHERE lease_scope = 'tenant_domain' AND tenant_id = p_tenant_id AND domain = p_domain
    AND owner_token = p_owner_token AND fencing_epoch = p_fencing_epoch;
  UPDATE app.metrics_refresh_leases
  SET owner_token = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = clock_timestamp()
  WHERE lease_scope = 'global' AND owner_token = p_owner_token AND fencing_epoch = p_fencing_epoch;
  RETURN QUERY SELECT 'released', p_owner_token, p_fencing_epoch, p_tenant_id, p_domain,
    0, 0, 0, true, NULL::timestamptz, NULL::text;
END;
$function$;

CREATE OR REPLACE FUNCTION app._metrics_v4_refresh_claimed_periods(p_owner_token uuid, p_fencing_epoch bigint, p_tenant_id uuid, p_domain text)
 RETURNS TABLE(rows_written integer, statement_groups integer, source_watermark timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  v_primary text := app.metrics_v4_primary_demand_kind(p_tenant_id);
  v_rows integer := 0;
  v_count integer;
  v_dirty_day_count integer := 0;
  v_buyer_key_count integer := 0;
  v_product_key_count integer := 0;
  v_watermark timestamptz;
  v_max_refresh_keys integer;
BEGIN
  PERFORM app._metrics_assert_refresh_fence(p_owner_token, p_fencing_epoch, p_tenant_id, p_domain);

  SELECT COALESCE(c.max_refresh_keys_per_tick, 100) INTO v_max_refresh_keys
  FROM app.metrics_runtime_control c
  WHERE c.control_scope = 'global'
  LIMIT 1;
  v_max_refresh_keys := COALESCE(v_max_refresh_keys, 100);

  IF EXISTS (
    SELECT 1
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token
      AND w.state = 'claimed'
      AND w.claimed_version = w.dirty_version
      AND w.dirty_from IS NOT NULL
      AND COALESCE(w.dirty_to, w.dirty_from) - w.dirty_from > 99
  ) THEN
    RAISE EXCEPTION 'metrics_v4_dirty_range_too_large: mark integration/import reconciliation in <=100 day windows';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_dirty_days(day date PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_period_keys(grain text NOT NULL, period_start date NOT NULL, period_end_exclusive date NOT NULL, PRIMARY KEY (grain, period_start)) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_buyer_ids(buyer_id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_product_ids(tenant_product_id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_buyer_period_keys(buyer_id uuid NOT NULL, grain text NOT NULL, period_start date NOT NULL, period_end_exclusive date NOT NULL, PRIMARY KEY (buyer_id, grain, period_start)) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_product_period_keys(tenant_product_id uuid NOT NULL, grain text NOT NULL, period_start date NOT NULL, period_end_exclusive date NOT NULL, PRIMARY KEY (tenant_product_id, grain, period_start)) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_product_agg(
    tenant_product_id uuid NOT NULL, grain text NOT NULL, period_start date NOT NULL,
    inv_units numeric, inv_value numeric, inv_count bigint, inv_buyers bigint, inv_watermark timestamptz,
    est_units numeric, est_value numeric, est_count bigint, est_watermark timestamptz,
    ord_units numeric, ord_value numeric, ord_count bigint, ord_watermark timestamptz,
    PRIMARY KEY (tenant_product_id, grain, period_start)
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_location_keys(location_id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.metrics_v4_key_collection_days(day date PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE pg_temp.metrics_v4_dirty_days, pg_temp.metrics_v4_period_keys, pg_temp.metrics_v4_buyer_ids, pg_temp.metrics_v4_product_ids, pg_temp.metrics_v4_buyer_period_keys, pg_temp.metrics_v4_product_period_keys, pg_temp.metrics_v4_location_keys, pg_temp.metrics_v4_key_collection_days, pg_temp.metrics_v4_product_agg;

  INSERT INTO pg_temp.metrics_v4_dirty_days(day)
  SELECT day
  FROM (
    SELECT w.old_day AS day FROM app.metrics_dirty_work w WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT w.new_day FROM app.metrics_dirty_work w WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT gs::date
    FROM app.metrics_dirty_work w
    CROSS JOIN LATERAL generate_series(w.dirty_from, COALESCE(w.dirty_to, w.dirty_from), interval '1 day') gs
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL AND w.dirty_from IS NOT NULL
  ) d
  WHERE day IS NOT NULL
  ORDER BY day
  LIMIT 100
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_dirty_day_count = ROW_COUNT;
  PERFORM app._metrics_check_deadline();

  IF NOT EXISTS (SELECT 1 FROM pg_temp.metrics_v4_dirty_days) THEN
    INSERT INTO pg_temp.metrics_v4_dirty_days(day) VALUES (v_today) ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO pg_temp.metrics_v4_key_collection_days(day)
  SELECT day FROM pg_temp.metrics_v4_dirty_days ORDER BY day LIMIT 1
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.metrics_v4_period_keys(grain, period_start, period_end_exclusive)
  SELECT grain, period_start, period_end_exclusive
  FROM (
    SELECT 'day'::text AS grain, d.day AS period_start, d.day + 1 AS period_end_exclusive
    FROM pg_temp.metrics_v4_dirty_days d
    UNION
    SELECT 'week', (d.day - ((EXTRACT(isodow FROM d.day)::integer - 1) * interval '1 day'))::date,
      ((d.day - ((EXTRACT(isodow FROM d.day)::integer - 1) * interval '1 day')) + interval '7 days')::date
    FROM pg_temp.metrics_v4_dirty_days d
    UNION
    SELECT 'month', date_trunc('month', d.day)::date, (date_trunc('month', d.day) + interval '1 month')::date
    FROM pg_temp.metrics_v4_dirty_days d
    UNION
    SELECT 'quarter', date_trunc('quarter', d.day)::date, (date_trunc('quarter', d.day) + interval '3 months')::date
    FROM pg_temp.metrics_v4_dirty_days d
  ) p
  ON CONFLICT DO NOTHING;

  IF p_domain = 'commercial' THEN
  PERFORM app._metrics_check_deadline();
  INSERT INTO pg_temp.metrics_v4_buyer_ids(buyer_id)
  SELECT buyer_id
  FROM (
    SELECT w.old_buyer_id AS buyer_id
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT w.new_buyer_id
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT e.buyer_id
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(e.estimate_date, e.created_at))
    UNION
    SELECT o.buyer_id
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(o.order_date, o.created_at))
    UNION
    SELECT i.buyer_id
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(i.invoice_date, i.created_at))
  ) k
  WHERE buyer_id IS NOT NULL
  ORDER BY buyer_id
  LIMIT (v_max_refresh_keys + 1)
  ON CONFLICT DO NOTHING;
  SELECT COUNT(*) INTO v_buyer_key_count FROM pg_temp.metrics_v4_buyer_ids;
  IF v_buyer_key_count > v_max_refresh_keys THEN
    RAISE EXCEPTION 'metrics_v4_buyer_key_budget_exceeded: split reconciliation/import dirty work into smaller windows';
  END IF;

  INSERT INTO pg_temp.metrics_v4_buyer_period_keys(buyer_id, grain, period_start, period_end_exclusive)
  SELECT b.buyer_id, p.grain, p.period_start, p.period_end_exclusive
  FROM pg_temp.metrics_v4_buyer_ids b
  CROSS JOIN pg_temp.metrics_v4_period_keys p
  WHERE p.grain IN ('month','quarter')
  ON CONFLICT DO NOTHING;

  PERFORM app._metrics_check_deadline();
  INSERT INTO pg_temp.metrics_v4_product_ids(tenant_product_id)
  SELECT tenant_product_id
  FROM (
    SELECT w.old_tenant_product_id AS tenant_product_id
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT w.new_tenant_product_id
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT ei.tenant_product_id
    FROM app.estimate_items ei JOIN app.estimates e ON e.id = ei.estimate_id AND e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
    WHERE ei.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(e.estimate_date, e.created_at))
    UNION
    SELECT oi.tenant_product_id
    FROM app.order_items oi JOIN app.orders o ON o.id = oi.order_id AND o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
    WHERE oi.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(o.order_date, o.created_at))
    UNION
    SELECT ii.tenant_product_id
    FROM app.invoice_items ii JOIN app.invoices i ON i.id = ii.invoice_id AND i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
    WHERE ii.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(i.invoice_date, i.created_at))
  ) k
  WHERE tenant_product_id IS NOT NULL
  ORDER BY tenant_product_id
  LIMIT (v_max_refresh_keys + 1)
  ON CONFLICT DO NOTHING;
  SELECT COUNT(*) INTO v_product_key_count FROM pg_temp.metrics_v4_product_ids;
  IF v_product_key_count > v_max_refresh_keys THEN
    RAISE EXCEPTION 'metrics_v4_product_key_budget_exceeded: split reconciliation/import dirty work into smaller windows';
  END IF;

  INSERT INTO pg_temp.metrics_v4_product_period_keys(tenant_product_id, grain, period_start, period_end_exclusive)
  SELECT pr.tenant_product_id, p.grain, p.period_start, p.period_end_exclusive
  FROM pg_temp.metrics_v4_product_ids pr
  CROSS JOIN pg_temp.metrics_v4_period_keys p
  WHERE p.grain IN ('month','quarter')
  ON CONFLICT DO NOTHING;
  END IF;

  IF p_domain = 'commercial' OR p_domain = 'inventory' THEN
  PERFORM app._metrics_check_deadline();
  INSERT INTO pg_temp.metrics_v4_location_keys(location_id)
  SELECT location_id
  FROM (
    SELECT w.old_location_id AS location_id
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT w.new_location_id
    FROM app.metrics_dirty_work w
    WHERE w.lease_owner = p_owner_token AND w.claimed_version IS NOT NULL
    UNION
    SELECT e.location_id
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(e.estimate_date, e.created_at))
    UNION
    SELECT o.location_id
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(o.order_date, o.created_at))
    UNION
    SELECT i.location_id
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM pg_temp.metrics_v4_key_collection_days d WHERE d.day = app.metric_day_ist(i.invoice_date, i.created_at))
  ) k
  WHERE location_id IS NOT NULL
  ORDER BY location_id
  LIMIT (v_max_refresh_keys + 1)
  ON CONFLICT DO NOTHING;
  IF (SELECT COUNT(*) FROM pg_temp.metrics_v4_location_keys) > v_max_refresh_keys THEN
    RAISE EXCEPTION 'metrics_v4_location_key_budget_exceeded: split reconciliation/import dirty work into smaller windows';
  END IF;
  END IF;

  IF p_domain = 'commercial' THEN

  INSERT INTO app.metrics_tenant_period_summary (
    tenant_id, external_ref, grain, period_start, period_end_exclusive,
    invoice_count, invoice_value, invoice_units, invoice_buyer_count, invoice_product_count,
    estimate_count, estimate_value, estimate_units, estimate_buyer_count, estimate_product_count,
    order_count, order_value, order_units, order_buyer_count, order_product_count,
    app_estimate_count, app_estimate_value, app_estimate_buyer_count,
    app_order_count, app_order_value, app_order_buyer_count,
    primary_demand_kind, primary_demand_count, primary_demand_value, primary_demand_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT p_tenant_id, concat_ws(':', p_tenant_id::text, 'tenant', p.grain, p.period_start::text),
    p.grain, p.period_start, p.period_end_exclusive,
    COALESCE(inv.invoice_count,0), COALESCE(inv.invoice_value,0), COALESCE(inv.invoice_units,0), COALESCE(inv.invoice_buyer_count,0), COALESCE(inv.invoice_product_count,0),
    COALESCE(est.estimate_count,0), COALESCE(est.estimate_value,0), COALESCE(est.estimate_units,0), COALESCE(est.estimate_buyer_count,0), COALESCE(est.estimate_product_count,0),
    COALESCE(ord.order_count,0), COALESCE(ord.order_value,0), COALESCE(ord.order_units,0), COALESCE(ord.order_buyer_count,0), COALESCE(ord.order_product_count,0),
    COALESCE(est.app_estimate_count,0), COALESCE(est.app_estimate_value,0), COALESCE(est.app_estimate_buyer_count,0),
    COALESCE(ord.app_order_count,0), COALESCE(ord.app_order_value,0), COALESCE(ord.app_order_buyer_count,0),
    v_primary,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_count,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_count,0) ELSE 0 END,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_value,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_value,0) ELSE 0 END,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_buyer_count,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_buyer_count,0) ELSE 0 END,
    GREATEST(inv.watermark, est.watermark, ord.watermark), v_now, v_now, NULL
  FROM pg_temp.metrics_v4_period_keys p
  LEFT JOIN LATERAL (
    WITH hdr AS (
      SELECT COUNT(DISTINCT i.id) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_count,
        COALESCE(SUM(i.total_amount) FILTER (WHERE app.invoice_status_gmv_included(i.status)),0)::numeric AS invoice_value,
        COUNT(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_buyer_count,
        MAX(i.updated_at) AS watermark_h
      FROM app.invoices i
      WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
        AND app.metric_day_ist(i.invoice_date, i.created_at) >= p.period_start
        AND app.metric_day_ist(i.invoice_date, i.created_at) < p.period_end_exclusive
    ), items AS (
      SELECT COALESCE(SUM(ii.qty) FILTER (WHERE app.invoice_status_gmv_included(i.status)),0)::numeric AS invoice_units,
        COUNT(DISTINCT ii.tenant_product_id) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_product_count,
        MAX(ii.updated_at) AS watermark_i
      FROM app.invoices i LEFT JOIN app.invoice_items ii ON ii.invoice_id = i.id AND ii.deleted_at IS NULL
      WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
        AND app.metric_day_ist(i.invoice_date, i.created_at) >= p.period_start
        AND app.metric_day_ist(i.invoice_date, i.created_at) < p.period_end_exclusive
    )
    SELECT hdr.invoice_count, hdr.invoice_value, items.invoice_units, hdr.invoice_buyer_count, items.invoice_product_count,
      GREATEST(hdr.watermark_h, items.watermark_i) AS watermark
    FROM hdr, items
  ) inv ON true
  LEFT JOIN LATERAL (
    WITH hdr AS (
      SELECT COUNT(DISTINCT e.id) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_count,
        COALESCE(SUM(e.total_amount) FILTER (WHERE app.estimate_status_counts_as_demand(e.status)),0)::numeric AS estimate_value,
        COUNT(DISTINCT e.buyer_id) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_buyer_count,
        COUNT(DISTINCT e.id) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status)))::bigint AS app_estimate_count,
        COALESCE(SUM(e.total_amount) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status))),0)::numeric AS app_estimate_value,
        COUNT(DISTINCT e.buyer_id) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status)))::bigint AS app_estimate_buyer_count,
        MAX(e.updated_at) AS watermark_h
      FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p.period_start
        AND app.metric_day_ist(e.estimate_date, e.created_at) < p.period_end_exclusive
    ), items AS (
      SELECT COALESCE(SUM(ei.qty) FILTER (WHERE app.estimate_status_counts_as_demand(e.status)),0)::numeric AS estimate_units,
        COUNT(DISTINCT ei.tenant_product_id) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_product_count,
        MAX(ei.updated_at) AS watermark_i
      FROM app.estimates e LEFT JOIN app.estimate_items ei ON ei.estimate_id = e.id AND ei.deleted_at IS NULL
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p.period_start
        AND app.metric_day_ist(e.estimate_date, e.created_at) < p.period_end_exclusive
    )
    SELECT hdr.estimate_count, hdr.estimate_value, items.estimate_units, hdr.estimate_buyer_count, items.estimate_product_count,
      hdr.app_estimate_count, hdr.app_estimate_value, hdr.app_estimate_buyer_count,
      GREATEST(hdr.watermark_h, items.watermark_i) AS watermark
    FROM hdr, items
  ) est ON true
  LEFT JOIN LATERAL (
    WITH hdr AS (
      SELECT COUNT(DISTINCT o.id) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_count,
        COALESCE(SUM(o.total_amount) FILTER (WHERE app.order_status_in_flow(o.status)),0)::numeric AS order_value,
        COUNT(DISTINCT o.buyer_id) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_buyer_count,
        COUNT(DISTINCT o.id) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status))::bigint AS app_order_count,
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status)),0)::numeric AS app_order_value,
        COUNT(DISTINCT o.buyer_id) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status))::bigint AS app_order_buyer_count,
        MAX(o.updated_at) AS watermark_h
      FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
        AND app.metric_day_ist(o.order_date, o.created_at) >= p.period_start
        AND app.metric_day_ist(o.order_date, o.created_at) < p.period_end_exclusive
    ), items AS (
      SELECT COALESCE(SUM(oi.qty) FILTER (WHERE app.order_status_in_flow(o.status)),0)::numeric AS order_units,
        COUNT(DISTINCT oi.tenant_product_id) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_product_count,
        MAX(oi.updated_at) AS watermark_i
      FROM app.orders o LEFT JOIN app.order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
        AND app.metric_day_ist(o.order_date, o.created_at) >= p.period_start
        AND app.metric_day_ist(o.order_date, o.created_at) < p.period_end_exclusive
    )
    SELECT hdr.order_count, hdr.order_value, items.order_units, hdr.order_buyer_count, items.order_product_count,
      hdr.app_order_count, hdr.app_order_value, hdr.app_order_buyer_count,
      GREATEST(hdr.watermark_h, items.watermark_i) AS watermark
    FROM hdr, items
  ) ord ON true
  ON CONFLICT (tenant_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value, invoice_units = EXCLUDED.invoice_units, invoice_buyer_count = EXCLUDED.invoice_buyer_count, invoice_product_count = EXCLUDED.invoice_product_count,
    estimate_count = EXCLUDED.estimate_count, estimate_value = EXCLUDED.estimate_value, estimate_units = EXCLUDED.estimate_units, estimate_buyer_count = EXCLUDED.estimate_buyer_count, estimate_product_count = EXCLUDED.estimate_product_count,
    order_count = EXCLUDED.order_count, order_value = EXCLUDED.order_value, order_units = EXCLUDED.order_units, order_buyer_count = EXCLUDED.order_buyer_count, order_product_count = EXCLUDED.order_product_count,
    app_estimate_count = EXCLUDED.app_estimate_count, app_estimate_value = EXCLUDED.app_estimate_value, app_estimate_buyer_count = EXCLUDED.app_estimate_buyer_count,
    app_order_count = EXCLUDED.app_order_count, app_order_value = EXCLUDED.app_order_value, app_order_buyer_count = EXCLUDED.app_order_buyer_count,
    primary_demand_kind = EXCLUDED.primary_demand_kind, primary_demand_count = EXCLUDED.primary_demand_count, primary_demand_value = EXCLUDED.primary_demand_value, primary_demand_buyer_count = EXCLUDED.primary_demand_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_buyer_period_summary (
    tenant_id, buyer_id, external_ref, grain, period_start, period_end_exclusive,
    invoice_count, invoice_value, estimate_count, estimate_value, order_count, order_value,
    app_demand_count, app_demand_value, primary_demand_count, primary_demand_value,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT p_tenant_id, k.buyer_id, concat_ws(':', p_tenant_id::text, k.buyer_id::text, k.grain, k.period_start::text), k.grain, k.period_start, k.period_end_exclusive,
    COALESCE(inv.invoice_count,0), COALESCE(inv.invoice_value,0),
    COALESCE(est.estimate_count,0), COALESCE(est.estimate_value,0),
    COALESCE(ord.order_count,0), COALESCE(ord.order_value,0),
    COALESCE(est.app_estimate_count,0) + COALESCE(ord.app_order_count,0),
    COALESCE(est.app_estimate_value,0) + COALESCE(ord.app_order_value,0),
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_count,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_count,0) ELSE 0 END,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_value,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_value,0) ELSE 0 END,
    GREATEST(inv.watermark, est.watermark, ord.watermark), v_now, v_now, NULL
  FROM pg_temp.metrics_v4_buyer_period_keys k
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_count,
      COALESCE(SUM(i.total_amount) FILTER (WHERE app.invoice_status_gmv_included(i.status)),0)::numeric AS invoice_value,
      MAX(i.updated_at) AS watermark
    FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.buyer_id = k.buyer_id AND i.deleted_at IS NULL
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= k.period_start AND app.metric_day_ist(i.invoice_date, i.created_at) < k.period_end_exclusive
  ) inv ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_count,
      COALESCE(SUM(e.total_amount) FILTER (WHERE app.estimate_status_counts_as_demand(e.status)),0)::numeric AS estimate_value,
      COUNT(*) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status)))::bigint AS app_estimate_count,
      COALESCE(SUM(e.total_amount) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status))),0)::numeric AS app_estimate_value,
      MAX(e.updated_at) AS watermark
    FROM app.estimates e WHERE e.tenant_id = p_tenant_id AND e.buyer_id = k.buyer_id AND e.deleted_at IS NULL
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= k.period_start AND app.metric_day_ist(e.estimate_date, e.created_at) < k.period_end_exclusive
  ) est ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE app.order_status_in_flow(o.status)),0)::numeric AS order_value,
      COUNT(*) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status))::bigint AS app_order_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE o.is_buyer_app_order AND app.order_status_in_flow(o.status)),0)::numeric AS app_order_value,
      MAX(o.updated_at) AS watermark
    FROM app.orders o WHERE o.tenant_id = p_tenant_id AND o.buyer_id = k.buyer_id AND o.deleted_at IS NULL
      AND app.metric_day_ist(o.order_date, o.created_at) >= k.period_start AND app.metric_day_ist(o.order_date, o.created_at) < k.period_end_exclusive
  ) ord ON true
  WHERE COALESCE(inv.invoice_count,0) > 0 OR COALESCE(est.estimate_count,0) > 0 OR COALESCE(ord.order_count,0) > 0
  ON CONFLICT (tenant_id, buyer_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value,
    estimate_count = EXCLUDED.estimate_count, estimate_value = EXCLUDED.estimate_value,
    order_count = EXCLUDED.order_count, order_value = EXCLUDED.order_value,
    app_demand_count = EXCLUDED.app_demand_count, app_demand_value = EXCLUDED.app_demand_value,
    primary_demand_count = EXCLUDED.primary_demand_count, primary_demand_value = EXCLUDED.primary_demand_value,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  DELETE FROM app.metrics_buyer_period_summary s
  USING pg_temp.metrics_v4_buyer_period_keys k
  WHERE s.tenant_id = p_tenant_id AND s.buyer_id = k.buyer_id AND s.grain = k.grain AND s.period_start = k.period_start AND s.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.buyer_id = k.buyer_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status) AND app.metric_day_ist(i.invoice_date, i.created_at) >= k.period_start AND app.metric_day_ist(i.invoice_date, i.created_at) < k.period_end_exclusive
      UNION ALL SELECT 1 FROM app.estimates e WHERE e.tenant_id = p_tenant_id AND e.buyer_id = k.buyer_id AND e.deleted_at IS NULL AND (app.estimate_status_counts_as_demand(e.status)) AND app.metric_day_ist(e.estimate_date, e.created_at) >= k.period_start AND app.metric_day_ist(e.estimate_date, e.created_at) < k.period_end_exclusive
      UNION ALL SELECT 1 FROM app.orders o WHERE o.tenant_id = p_tenant_id AND o.buyer_id = k.buyer_id AND o.deleted_at IS NULL AND app.order_status_in_flow(o.status) AND app.metric_day_ist(o.order_date, o.created_at) >= k.period_start AND app.metric_day_ist(o.order_date, o.created_at) < k.period_end_exclusive
    );
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  -- metrics_buyer_now_summary: now also carries receivable_invoice_count /
  -- overdue_invoice_count alongside the money columns, same
  -- outstanding_balance > 0 narrowing as the money aggregates (see the
  -- comment on `inv` below) so the new counts and the existing partial index
  -- agree on which invoices they're counting.
  INSERT INTO app.metrics_buyer_now_summary (
    tenant_id, buyer_id, external_ref,
    credit_limit, receivable_amount, receivable_invoice_count, overdue_amount, overdue_invoice_count, credit_available,
    last_invoice_date,
    last_buyer_app_activity_at,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id,
    b.id,
    concat_ws(':', p_tenant_id::text, b.id::text, 'buyer-now'),
    COALESCE(b.credit_limit, 0),
    COALESCE(inv.receivable_amount, 0),
    COALESCE(inv.receivable_invoice_count, 0),
    COALESCE(inv.overdue_amount, 0),
    COALESCE(inv.overdue_invoice_count, 0),
    COALESCE(b.credit_limit, 0) - COALESCE(inv.receivable_amount, 0),
    li.last_invoice_date,
    app_act.last_buyer_app_activity_at,
    GREATEST(b.updated_at, inv.watermark),
    v_now,
    v_now,
    NULL
  FROM (
    SELECT DISTINCT buyer_id FROM pg_temp.metrics_v4_buyer_period_keys
  ) k
  JOIN app.buyers b ON b.id = k.buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(i.outstanding_balance) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)), 0)::numeric AS receivable_amount,
      COUNT(*) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance))::bigint AS receivable_invoice_count,
      COALESCE(SUM(i.outstanding_balance) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)), 0)::numeric AS overdue_amount,
      COUNT(*) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance))::bigint AS overdue_invoice_count,
      MAX(i.updated_at) AS watermark
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id
      AND i.buyer_id = b.id
      AND i.deleted_at IS NULL
      AND i.outstanding_balance > 0
  ) inv ON true
  LEFT JOIN LATERAL (
    SELECT MAX(app.metric_day_ist(i2.invoice_date, i2.created_at)) AS last_invoice_date
    FROM app.invoices i2
    WHERE i2.tenant_id = p_tenant_id
      AND i2.buyer_id = b.id
      AND i2.deleted_at IS NULL
      AND app.invoice_status_gmv_included(i2.status)
  ) li ON true
  LEFT JOIN LATERAL (
    SELECT GREATEST(
      (SELECT MAX(i3.invoice_date::timestamptz) FROM app.invoices i3 WHERE i3.tenant_id = p_tenant_id AND i3.buyer_id = b.id AND i3.deleted_at IS NULL AND i3.is_buyer_app_invoice),
      (SELECT MAX(o3.placed_at) FROM app.orders o3 WHERE o3.tenant_id = p_tenant_id AND o3.buyer_id = b.id AND o3.deleted_at IS NULL AND o3.is_buyer_app_order)
    ) AS last_buyer_app_activity_at
  ) app_act ON true
  ON CONFLICT (tenant_id, buyer_id) WHERE deleted_at IS NULL DO UPDATE SET
    credit_limit = EXCLUDED.credit_limit,
    receivable_amount = EXCLUDED.receivable_amount,
    receivable_invoice_count = EXCLUDED.receivable_invoice_count,
    overdue_amount = EXCLUDED.overdue_amount,
    overdue_invoice_count = EXCLUDED.overdue_invoice_count,
    last_invoice_date = EXCLUDED.last_invoice_date,
    last_buyer_app_activity_at = EXCLUDED.last_buyer_app_activity_at,
    credit_available = EXCLUDED.credit_available,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  -- metrics_location_now_summary: now also carries overdue/receivable invoice
  -- and buyer counts plus open estimate/order value, mirroring what
  -- metrics_tenant_now_summary already tracks tenant-wide.
  INSERT INTO app.metrics_location_now_summary (
    tenant_id, location_id, external_ref,
    open_estimate_count, open_estimate_value, open_order_count, open_order_value,
    overdue_amount, overdue_invoice_count, overdue_buyer_count,
    receivable_amount, receivable_invoice_count, receivable_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id,
    l.id,
    concat_ws(':', p_tenant_id::text, l.id::text, 'location-now'),
    COALESCE(est.open_estimate_count, 0),
    COALESCE(est.open_estimate_value, 0),
    COALESCE(ord.open_order_count, 0),
    COALESCE(ord.open_order_value, 0),
    COALESCE(inv.overdue_amount, 0),
    COALESCE(inv.overdue_invoice_count, 0),
    COALESCE(inv.overdue_buyer_count, 0),
    COALESCE(inv.receivable_amount, 0),
    COALESCE(inv.receivable_invoice_count, 0),
    COALESCE(inv.receivable_buyer_count, 0),
    GREATEST(l.updated_at, est.watermark, ord.watermark, inv.watermark),
    v_now,
    v_now,
    NULL
  FROM pg_temp.metrics_v4_location_keys k
  JOIN app.locations l ON l.id = k.location_id AND l.tenant_id = p_tenant_id AND l.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS open_estimate_count,
      COALESCE(SUM(e.total_amount), 0)::numeric AS open_estimate_value,
      MAX(e.updated_at) AS watermark
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.location_id = l.id AND e.deleted_at IS NULL
      AND app.estimate_status_is_open(e.status)
  ) est ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS open_order_count,
      COALESCE(SUM(o.total_amount), 0)::numeric AS open_order_value,
      MAX(o.updated_at) AS watermark
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.location_id = l.id AND o.deleted_at IS NULL
      AND app.order_status_is_open(o.status)
  ) ord ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(i.outstanding_balance) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)), 0)::numeric AS overdue_amount,
      COUNT(*) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance))::bigint AS overdue_invoice_count,
      COUNT(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance))::bigint AS overdue_buyer_count,
      COALESCE(SUM(i.outstanding_balance) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)), 0)::numeric AS receivable_amount,
      COUNT(*) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance))::bigint AS receivable_invoice_count,
      COUNT(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance))::bigint AS receivable_buyer_count,
      MAX(i.updated_at) AS watermark
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.location_id = l.id AND i.deleted_at IS NULL
      AND i.outstanding_balance > 0
  ) inv ON true
  ON CONFLICT (tenant_id, location_id) WHERE deleted_at IS NULL DO UPDATE SET
    open_estimate_count = EXCLUDED.open_estimate_count,
    open_estimate_value = EXCLUDED.open_estimate_value,
    open_order_count = EXCLUDED.open_order_count,
    open_order_value = EXCLUDED.open_order_value,
    overdue_amount = EXCLUDED.overdue_amount,
    overdue_invoice_count = EXCLUDED.overdue_invoice_count,
    overdue_buyer_count = EXCLUDED.overdue_buyer_count,
    receivable_amount = EXCLUDED.receivable_amount,
    receivable_invoice_count = EXCLUDED.receivable_invoice_count,
    receivable_buyer_count = EXCLUDED.receivable_buyer_count,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  -- Materialize per-(product, grain, period) aggregates ONCE. Each of the
  -- three branches scans its parent doc table once per distinct period (not
  -- once per product x period), joins down to its item table, and groups by
  -- product. Branches emit NULL for the columns they do not own; the outer
  -- GROUP BY collapses them with MAX, which is safe because each branch
  -- contributes at most one row per (product, grain, period).
  INSERT INTO pg_temp.metrics_v4_product_agg(
    tenant_product_id, grain, period_start,
    inv_units, inv_value, inv_count, inv_buyers, inv_watermark,
    est_units, est_value, est_count, est_watermark,
    ord_units, ord_value, ord_count, ord_watermark
  )
  SELECT u.tenant_product_id, u.grain, u.period_start,
    MAX(u.inv_units), MAX(u.inv_value), MAX(u.inv_count), MAX(u.inv_buyers), MAX(u.inv_watermark),
    MAX(u.est_units), MAX(u.est_value), MAX(u.est_count), MAX(u.est_watermark),
    MAX(u.ord_units), MAX(u.ord_value), MAX(u.ord_count), MAX(u.ord_watermark)
  FROM (
    SELECT ii.tenant_product_id, d.grain, d.period_start,
      COALESCE(SUM(ii.qty),0)::numeric AS inv_units, COALESCE(SUM(ii.line_total),0)::numeric AS inv_value,
      COUNT(DISTINCT d.id)::bigint AS inv_count, COUNT(DISTINCT d.buyer_id)::bigint AS inv_buyers,
      MAX(GREATEST(d.updated_at, ii.updated_at)) AS inv_watermark,
      NULL::numeric AS est_units, NULL::numeric AS est_value, NULL::bigint AS est_count, NULL::timestamptz AS est_watermark,
      NULL::numeric AS ord_units, NULL::numeric AS ord_value, NULL::bigint AS ord_count, NULL::timestamptz AS ord_watermark
    FROM (
      SELECT p.grain, p.period_start, i.id, i.buyer_id, i.updated_at
      FROM (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_product_period_keys) p
      JOIN app.invoices i ON i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
        AND app.invoice_status_gmv_included(i.status)
        AND app.metric_day_ist(i.invoice_date, i.created_at) >= p.period_start
        AND app.metric_day_ist(i.invoice_date, i.created_at) <  p.period_end_exclusive
    ) d
    JOIN app.invoice_items ii ON ii.invoice_id = d.id AND ii.deleted_at IS NULL
    WHERE EXISTS (SELECT 1 FROM pg_temp.metrics_v4_product_ids pr WHERE pr.tenant_product_id = ii.tenant_product_id)
    GROUP BY 1,2,3
    UNION ALL
    SELECT ei.tenant_product_id, d.grain, d.period_start,
      NULL, NULL, NULL, NULL, NULL,
      COALESCE(SUM(ei.qty),0)::numeric, COALESCE(SUM(ei.line_total),0)::numeric,
      COUNT(DISTINCT d.id)::bigint, MAX(GREATEST(d.updated_at, ei.updated_at)),
      NULL, NULL, NULL, NULL
    FROM (
      SELECT p.grain, p.period_start, e.id, e.updated_at
      FROM (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_product_period_keys) p
      JOIN app.estimates e ON e.tenant_id = p_tenant_id AND e.deleted_at IS NULL
        AND (app.estimate_status_counts_as_demand(e.status))
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p.period_start
        AND app.metric_day_ist(e.estimate_date, e.created_at) <  p.period_end_exclusive
    ) d
    JOIN app.estimate_items ei ON ei.estimate_id = d.id AND ei.deleted_at IS NULL
    WHERE EXISTS (SELECT 1 FROM pg_temp.metrics_v4_product_ids pr WHERE pr.tenant_product_id = ei.tenant_product_id)
    GROUP BY 1,2,3
    UNION ALL
    SELECT oi.tenant_product_id, d.grain, d.period_start,
      NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      COALESCE(SUM(oi.qty),0)::numeric, COALESCE(SUM(oi.line_total),0)::numeric,
      COUNT(DISTINCT d.id)::bigint, MAX(GREATEST(d.updated_at, oi.updated_at))
    FROM (
      SELECT p.grain, p.period_start, o.id, o.updated_at
      FROM (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_product_period_keys) p
      JOIN app.orders o ON o.tenant_id = p_tenant_id AND o.deleted_at IS NULL
        AND app.order_status_in_flow(o.status)
        AND app.metric_day_ist(o.order_date, o.created_at) >= p.period_start
        AND app.metric_day_ist(o.order_date, o.created_at) <  p.period_end_exclusive
    ) d
    JOIN app.order_items oi ON oi.order_id = d.id AND oi.deleted_at IS NULL
    WHERE EXISTS (SELECT 1 FROM pg_temp.metrics_v4_product_ids pr WHERE pr.tenant_product_id = oi.tenant_product_id)
    GROUP BY 1,2,3
  ) u
  GROUP BY 1,2,3
  ON CONFLICT DO NOTHING;

  INSERT INTO app.metrics_product_period_summary (
    tenant_id, tenant_product_id, external_ref, grain, period_start, period_end_exclusive,
    invoice_units, invoice_value, invoice_count, invoice_buyer_count,
    estimate_units, estimate_value, estimate_count,
    order_units, order_value, order_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT p_tenant_id, k.tenant_product_id, concat_ws(':', p_tenant_id::text, k.tenant_product_id::text, k.grain, k.period_start::text), k.grain, k.period_start, k.period_end_exclusive,
    COALESCE(a.inv_units,0), COALESCE(a.inv_value,0), COALESCE(a.inv_count,0), COALESCE(a.inv_buyers,0),
    COALESCE(a.est_units,0), COALESCE(a.est_value,0), COALESCE(a.est_count,0),
    COALESCE(a.ord_units,0), COALESCE(a.ord_value,0), COALESCE(a.ord_count,0),
    GREATEST(a.inv_watermark, a.est_watermark, a.ord_watermark), v_now, v_now, NULL
  FROM pg_temp.metrics_v4_product_period_keys k
  JOIN pg_temp.metrics_v4_product_agg a
    ON a.tenant_product_id = k.tenant_product_id AND a.grain = k.grain AND a.period_start = k.period_start
  WHERE COALESCE(a.inv_count,0) > 0 OR COALESCE(a.est_count,0) > 0 OR COALESCE(a.ord_count,0) > 0
  ON CONFLICT (tenant_id, tenant_product_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    invoice_units = EXCLUDED.invoice_units, invoice_value = EXCLUDED.invoice_value, invoice_count = EXCLUDED.invoice_count, invoice_buyer_count = EXCLUDED.invoice_buyer_count,
    estimate_units = EXCLUDED.estimate_units, estimate_value = EXCLUDED.estimate_value, estimate_count = EXCLUDED.estimate_count,
    order_units = EXCLUDED.order_units, order_value = EXCLUDED.order_value, order_count = EXCLUDED.order_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  DELETE FROM app.metrics_product_period_summary s
  USING pg_temp.metrics_v4_product_period_keys k
  WHERE s.tenant_id = p_tenant_id AND s.tenant_product_id = k.tenant_product_id AND s.grain = k.grain AND s.period_start = k.period_start AND s.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_temp.metrics_v4_product_agg a
      WHERE a.tenant_product_id = k.tenant_product_id AND a.grain = k.grain AND a.period_start = k.period_start
        AND (COALESCE(a.inv_count,0) > 0 OR COALESCE(a.est_count,0) > 0 OR COALESCE(a.ord_count,0) > 0)
    );
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_brand_period_summary (
    tenant_id, tenant_brand_id, external_ref, grain, period_start, period_end_exclusive,
    invoice_count, invoice_value, invoice_units, invoice_product_count, invoice_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT p_tenant_id, tp.tenant_brand_id, concat_ws(':', p_tenant_id::text, tp.tenant_brand_id::text, p.grain, p.period_start::text),
    p.grain, p.period_start, p.period_end_exclusive,
    SUM(ps.invoice_count)::bigint, SUM(ps.invoice_value), SUM(ps.invoice_units), COUNT(DISTINCT ps.tenant_product_id)::bigint, SUM(ps.invoice_buyer_count)::bigint,
    MAX(ps.source_watermark), v_now, v_now, NULL
  FROM (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_product_period_keys) p
  JOIN app.metrics_product_period_summary ps
    ON ps.tenant_id = p_tenant_id AND ps.grain = p.grain AND ps.period_start = p.period_start AND ps.deleted_at IS NULL AND ps.invoice_count > 0
  JOIN app.tenant_products tp ON tp.id = ps.tenant_product_id AND tp.tenant_brand_id IS NOT NULL
  GROUP BY tp.tenant_brand_id, p.grain, p.period_start, p.period_end_exclusive
  ON CONFLICT (tenant_id, tenant_brand_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value, invoice_units = EXCLUDED.invoice_units,
    invoice_product_count = EXCLUDED.invoice_product_count, invoice_buyer_count = EXCLUDED.invoice_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  DELETE FROM app.metrics_brand_period_summary s
  WHERE s.tenant_id = p_tenant_id AND s.deleted_at IS NULL
    AND (s.grain, s.period_start) IN (SELECT DISTINCT k.grain, k.period_start FROM pg_temp.metrics_v4_product_period_keys k)
    AND NOT EXISTS (
      SELECT 1
      FROM app.metrics_product_period_summary ps
      JOIN app.tenant_products tp ON tp.id = ps.tenant_product_id
      WHERE ps.tenant_id = p_tenant_id AND ps.grain = s.grain AND ps.period_start = s.period_start
        AND ps.deleted_at IS NULL AND ps.invoice_count > 0 AND tp.tenant_brand_id = s.tenant_brand_id
    );
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_category_period_summary (
    tenant_id, tenant_category_id, external_ref, grain, period_start, period_end_exclusive,
    invoice_count, invoice_value, invoice_product_count, invoice_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT p_tenant_id, tp.tenant_category_id, concat_ws(':', p_tenant_id::text, tp.tenant_category_id::text, p.grain, p.period_start::text),
    p.grain, p.period_start, p.period_end_exclusive,
    SUM(ps.invoice_count)::bigint, SUM(ps.invoice_value), COUNT(DISTINCT ps.tenant_product_id)::bigint, SUM(ps.invoice_buyer_count)::bigint,
    MAX(ps.source_watermark), v_now, v_now, NULL
  FROM (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_product_period_keys) p
  JOIN app.metrics_product_period_summary ps
    ON ps.tenant_id = p_tenant_id AND ps.grain = p.grain AND ps.period_start = p.period_start AND ps.deleted_at IS NULL AND ps.invoice_count > 0
  JOIN app.tenant_products tp ON tp.id = ps.tenant_product_id AND tp.tenant_category_id IS NOT NULL
  GROUP BY tp.tenant_category_id, p.grain, p.period_start, p.period_end_exclusive
  ON CONFLICT (tenant_id, tenant_category_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value,
    invoice_product_count = EXCLUDED.invoice_product_count, invoice_buyer_count = EXCLUDED.invoice_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  DELETE FROM app.metrics_category_period_summary s
  WHERE s.tenant_id = p_tenant_id AND s.deleted_at IS NULL
    AND (s.grain, s.period_start) IN (SELECT DISTINCT k.grain, k.period_start FROM pg_temp.metrics_v4_product_period_keys k)
    AND NOT EXISTS (
      SELECT 1
      FROM app.metrics_product_period_summary ps
      JOIN app.tenant_products tp ON tp.id = ps.tenant_product_id
      WHERE ps.tenant_id = p_tenant_id AND ps.grain = s.grain AND ps.period_start = s.period_start
        AND ps.deleted_at IS NULL AND ps.invoice_count > 0 AND tp.tenant_category_id = s.tenant_category_id
    );
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  ELSIF p_domain = 'inventory' THEN

  INSERT INTO app.metrics_location_period_summary (
    tenant_id, location_id, external_ref, grain, period_start, period_end_exclusive,
    invoice_count, invoice_value, invoice_buyer_count,
    estimate_count, estimate_value, estimate_buyer_count,
    order_count, order_value, order_buyer_count,
    primary_demand_kind, primary_demand_count, primary_demand_value, primary_demand_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, l.id, concat_ws(':', p_tenant_id::text, l.id::text, p.grain, p.period_start::text),
    p.grain, p.period_start, p.period_end_exclusive,
    COALESCE(inv.invoice_count, 0), COALESCE(inv.invoice_value, 0), COALESCE(inv.invoice_buyer_count, 0),
    COALESCE(est.estimate_count, 0), COALESCE(est.estimate_value, 0), COALESCE(est.estimate_buyer_count, 0),
    COALESCE(ord.order_count, 0), COALESCE(ord.order_value, 0), COALESCE(ord.order_buyer_count, 0),
    v_primary,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_count, 0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_count, 0) ELSE 0 END,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_value, 0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_value, 0) ELSE 0 END,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_buyer_count, 0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_buyer_count, 0) ELSE 0 END,
    GREATEST(inv.watermark, est.watermark, ord.watermark), v_now, v_now, NULL
  FROM app.locations l
  CROSS JOIN pg_temp.metrics_v4_period_keys p
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_count,
      COALESCE(SUM(i.total_amount) FILTER (WHERE app.invoice_status_gmv_included(i.status)), 0)::numeric AS invoice_value,
      COUNT(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_buyer_count,
      MAX(i.updated_at) AS watermark
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.location_id = l.id AND i.deleted_at IS NULL
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p.period_start
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p.period_end_exclusive
  ) inv ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_count,
      COALESCE(SUM(e.total_amount) FILTER (WHERE app.estimate_status_counts_as_demand(e.status)), 0)::numeric AS estimate_value,
      COUNT(DISTINCT e.buyer_id) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_buyer_count,
      MAX(e.updated_at) AS watermark
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.location_id = l.id AND e.deleted_at IS NULL
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p.period_start
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p.period_end_exclusive
  ) est ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE app.order_status_in_flow(o.status)), 0)::numeric AS order_value,
      COUNT(DISTINCT o.buyer_id) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_buyer_count,
      MAX(o.updated_at) AS watermark
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.location_id = l.id AND o.deleted_at IS NULL
      AND app.metric_day_ist(o.order_date, o.created_at) >= p.period_start
      AND app.metric_day_ist(o.order_date, o.created_at) < p.period_end_exclusive
  ) ord ON true
  WHERE l.tenant_id = p_tenant_id AND l.deleted_at IS NULL
    AND (COALESCE(inv.invoice_count,0) > 0 OR COALESCE(est.estimate_count,0) > 0 OR COALESCE(ord.order_count,0) > 0)
  ON CONFLICT (tenant_id, location_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value, invoice_buyer_count = EXCLUDED.invoice_buyer_count,
    estimate_count = EXCLUDED.estimate_count, estimate_value = EXCLUDED.estimate_value, estimate_buyer_count = EXCLUDED.estimate_buyer_count,
    order_count = EXCLUDED.order_count, order_value = EXCLUDED.order_value, order_buyer_count = EXCLUDED.order_buyer_count,
    primary_demand_kind = EXCLUDED.primary_demand_kind, primary_demand_count = EXCLUDED.primary_demand_count, primary_demand_value = EXCLUDED.primary_demand_value, primary_demand_buyer_count = EXCLUDED.primary_demand_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_warehouse_period_summary (
    tenant_id, warehouse_id, external_ref, grain, period_start, period_end_exclusive,
    sold_sku_count, sold_units, invoice_value, source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT p_tenant_id, wh.id, concat_ws(':', p_tenant_id::text, wh.id::text, ps.grain, ps.period_start::text),
    ps.grain, ps.period_start, ps.period_end_exclusive,
    COUNT(DISTINCT ps.tenant_product_id)::bigint, SUM(ps.invoice_units), SUM(ps.invoice_value),
    MAX(ps.source_watermark), v_now, v_now, NULL
  FROM app.warehouses wh
  JOIN app.tenant_inventory ti ON ti.warehouse_id = wh.id AND ti.deleted_at IS NULL
  JOIN app.metrics_product_period_summary ps ON ps.tenant_id = p_tenant_id AND ps.tenant_product_id = ti.tenant_product_id AND ps.deleted_at IS NULL AND ps.invoice_count > 0
  JOIN (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_product_period_keys) p
    ON p.grain = ps.grain AND p.period_start = ps.period_start
  WHERE wh.tenant_id = p_tenant_id AND wh.deleted_at IS NULL
  GROUP BY wh.id, ps.grain, ps.period_start, ps.period_end_exclusive
  ON CONFLICT (tenant_id, warehouse_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    sold_sku_count = EXCLUDED.sold_sku_count, sold_units = EXCLUDED.sold_units, invoice_value = EXCLUDED.invoice_value,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  ELSIF p_domain = 'buyer_app' THEN

  INSERT INTO app.metrics_campaign_period_summary (
    tenant_id, campaign_id, external_ref, grain, period_start, period_end_exclusive,
    viewed_buyer_count, view_count,
    estimate_count, estimate_value, order_count, order_value, invoice_count, invoice_value,
    demand_buyer_count, revenue_buyer_count, source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, c.id, concat_ws(':', p_tenant_id::text, c.id::text, p.grain, p.period_start::text),
    p.grain, p.period_start, p.period_end_exclusive,
    COALESCE(v.viewed_buyer_count, 0), COALESCE(v.view_count, 0),
    COALESCE(est.estimate_count, 0), COALESCE(est.estimate_value, 0),
    COALESCE(ord.order_count, 0), COALESCE(ord.order_value, 0),
    COALESCE(inv.invoice_count, 0), COALESCE(inv.invoice_value, 0),
    COALESCE(est.demand_buyer_count, 0) + COALESCE(ord.demand_buyer_count, 0),
    COALESCE(inv.revenue_buyer_count, 0), v_now, v_now, v_now, NULL
  FROM app.campaigns c
  CROSS JOIN (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_period_keys WHERE grain IN ('month','quarter')) p
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS view_count, COUNT(DISTINCT cv.buyer_id)::bigint AS viewed_buyer_count
    FROM app.campaign_views cv
    WHERE cv.tenant_id = p_tenant_id AND cv.campaign_id = c.id AND cv.deleted_at IS NULL
      AND (cv.viewed_at AT TIME ZONE 'Asia/Kolkata')::date >= p.period_start
      AND (cv.viewed_at AT TIME ZONE 'Asia/Kolkata')::date < p.period_end_exclusive
  ) v ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS estimate_count,
      COALESCE(SUM(e.total_amount) FILTER (WHERE app.estimate_status_counts_as_demand(e.status)), 0)::numeric AS estimate_value,
      COUNT(DISTINCT e.buyer_id) FILTER (WHERE app.estimate_status_counts_as_demand(e.status))::bigint AS demand_buyer_count
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.campaign_id = c.id AND e.deleted_at IS NULL
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p.period_start
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p.period_end_exclusive
  ) est ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS order_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE app.order_status_in_flow(o.status)), 0)::numeric AS order_value,
      COUNT(DISTINCT o.buyer_id) FILTER (WHERE app.order_status_in_flow(o.status))::bigint AS demand_buyer_count
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.campaign_id = c.id AND o.deleted_at IS NULL
      AND app.metric_day_ist(o.order_date, o.created_at) >= p.period_start
      AND app.metric_day_ist(o.order_date, o.created_at) < p.period_end_exclusive
  ) ord ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS invoice_count,
      COALESCE(SUM(i.total_amount) FILTER (WHERE app.invoice_status_gmv_included(i.status)), 0)::numeric AS invoice_value,
      COUNT(DISTINCT i.buyer_id) FILTER (WHERE app.invoice_status_gmv_included(i.status))::bigint AS revenue_buyer_count
    FROM app.invoices i
    JOIN app.orders o ON o.id = i.order_id AND o.campaign_id = c.id
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p.period_start
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p.period_end_exclusive
  ) inv ON true
  WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
    AND (COALESCE(v.view_count,0) > 0 OR COALESCE(est.estimate_count,0) > 0 OR COALESCE(ord.order_count,0) > 0 OR COALESCE(inv.invoice_count,0) > 0)
  ON CONFLICT (tenant_id, campaign_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    viewed_buyer_count = EXCLUDED.viewed_buyer_count, view_count = EXCLUDED.view_count,
    estimate_count = EXCLUDED.estimate_count, estimate_value = EXCLUDED.estimate_value,
    order_count = EXCLUDED.order_count, order_value = EXCLUDED.order_value,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value,
    demand_buyer_count = EXCLUDED.demand_buyer_count, revenue_buyer_count = EXCLUDED.revenue_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_cohort_period_summary (
    tenant_id, cohort_id, external_ref, grain, period_start, period_end_exclusive,
    member_count, active_member_count, demand_count, demand_value, invoice_count, invoice_value,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, c.id, concat_ws(':', p_tenant_id::text, c.id::text, p.grain, p.period_start::text),
    p.grain, p.period_start, p.period_end_exclusive,
    COUNT(DISTINCT cm.buyer_id)::bigint,
    COUNT(DISTINCT bps.buyer_id) FILTER (WHERE bps.primary_demand_count > 0)::bigint,
    COALESCE(SUM(bps.primary_demand_count), 0)::bigint,
    COALESCE(SUM(bps.primary_demand_value), 0)::numeric,
    COALESCE(SUM(bps.invoice_count), 0)::bigint,
    COALESCE(SUM(bps.invoice_value), 0)::numeric,
    v_now, v_now, v_now, NULL
  FROM app.cohorts c
  CROSS JOIN (SELECT DISTINCT grain, period_start, period_end_exclusive FROM pg_temp.metrics_v4_period_keys WHERE grain IN ('month','quarter')) p
  LEFT JOIN app.cohort_members_active cm ON cm.cohort_id = c.id
  LEFT JOIN app.metrics_buyer_period_summary bps
    ON bps.tenant_id = p_tenant_id AND bps.buyer_id = cm.buyer_id
   AND bps.grain = p.grain AND bps.period_start = p.period_start AND bps.deleted_at IS NULL
  WHERE c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
  GROUP BY c.id, p.grain, p.period_start, p.period_end_exclusive
  ON CONFLICT (tenant_id, cohort_id, grain, period_start) WHERE deleted_at IS NULL DO UPDATE SET
    period_end_exclusive = EXCLUDED.period_end_exclusive,
    member_count = EXCLUDED.member_count, active_member_count = EXCLUDED.active_member_count,
    demand_count = EXCLUDED.demand_count, demand_value = EXCLUDED.demand_value,
    invoice_count = EXCLUDED.invoice_count, invoice_value = EXCLUDED.invoice_value,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  END IF;

  SELECT MAX(s.source_watermark) INTO v_watermark
  FROM app.metrics_tenant_period_summary s
  WHERE s.tenant_id = p_tenant_id AND s.deleted_at IS NULL
    AND (s.grain, s.period_start) IN (SELECT k.grain, k.period_start FROM pg_temp.metrics_v4_period_keys k);

  v_rows := v_rows + app._metrics_v4_refresh_landing_kpis(p_tenant_id, p_domain => p_domain, p_dirty_days => (SELECT array_agg(day) FROM pg_temp.metrics_v4_dirty_days));

  UPDATE app.metrics_dirty_work w
  SET cursor_kind = 'done',
      cursor_id = NULL,
      cursor_aux_id = NULL,
      cursor_day = NULL,
      updated_at = clock_timestamp()
  WHERE w.lease_owner = p_owner_token
    AND w.state = 'claimed'
    AND w.claimed_version = w.dirty_version
    AND w.dirty_from IS NOT NULL;

  RETURN QUERY SELECT v_rows,
    CASE p_domain WHEN 'commercial' THEN 5 WHEN 'inventory' THEN 2 WHEN 'buyer_app' THEN 2 ELSE 0 END,
    COALESCE(v_watermark, v_now);
END;
$function$;

CREATE OR REPLACE FUNCTION app._metrics_v4_refresh_setup_now(
  p_tenant_id uuid,
  p_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_as_of, clock_timestamp());
  v_quarter_start date := date_trunc('quarter', (COALESCE(p_as_of, clock_timestamp()) AT TIME ZONE 'Asia/Kolkata'))::date;
  v_rows integer := 0;
  v_count integer;
  v_watermark timestamptz;
BEGIN
  PERFORM app._metrics_check_deadline();
  SELECT MAX(x.updated_at) INTO v_watermark
  FROM (
    SELECT MAX(updated_at) AS updated_at FROM app.buyers WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(bu.updated_at) FROM app.buyer_users bu JOIN app.buyers b ON b.id = bu.buyer_id WHERE b.tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.tenant_brands WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.tenant_products WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.locations WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.warehouses WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.campaigns WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.cohorts WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.price_lists WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.invoices WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.estimates WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(updated_at) FROM app.orders WHERE tenant_id = p_tenant_id
    UNION ALL SELECT MAX(ti.updated_at) FROM app.tenant_inventory ti JOIN app.tenant_products tp ON tp.id = ti.tenant_product_id WHERE tp.tenant_id = p_tenant_id
  ) x;

  INSERT INTO app.metrics_tenant_now_summary (
    tenant_id, external_ref,
    receivable_amount, receivable_invoice_count, receivable_buyer_count,
    overdue_amount, overdue_invoice_count, overdue_buyer_count,
    open_estimate_count, open_estimate_value, open_order_count, open_order_value,
    active_buyer_count, active_brand_count, active_product_count, active_category_count, active_location_count,
    active_warehouse_count, active_campaign_count, active_cohort_count, active_price_list_count,
    enabled_buyer_count, sellable_units, sellable_sku_count, low_stock_product_count, oos_product_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, concat_ws(':', p_tenant_id::text, 'tenant-now'),
    COALESCE((SELECT SUM(receivable_amount) FROM app.metrics_buyer_now_summary WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.outstanding_balance > 0 AND app.invoice_status_has_receivable(i.status, i.outstanding_balance)),0),
    COALESCE((SELECT COUNT(*) FROM app.metrics_buyer_now_summary WHERE tenant_id = p_tenant_id AND receivable_amount > 0 AND deleted_at IS NULL),0),
    COALESCE((SELECT SUM(overdue_amount) FROM app.metrics_buyer_now_summary WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.outstanding_balance > 0 AND app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)),0),
    COALESCE((SELECT COUNT(*) FROM app.metrics_buyer_now_summary WHERE tenant_id = p_tenant_id AND overdue_amount > 0 AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.estimates e WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_is_open(e.status)),0),
    COALESCE((SELECT SUM(e.total_amount) FROM app.estimates e WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND app.estimate_status_is_open(e.status)),0),
    COALESCE((SELECT COUNT(*) FROM app.orders o WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_is_open(o.status)),0),
    COALESCE((SELECT SUM(o.total_amount) FROM app.orders o WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND app.order_status_is_open(o.status)),0),
    COALESCE((SELECT COUNT(*) FROM app.buyers WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.tenant_brands WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.tenant_products WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.tenant_categories WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND is_active),0),
    COALESCE((SELECT COUNT(*) FROM app.locations WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.warehouses WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.campaigns WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND status = 'published'),0),
    COALESCE((SELECT COUNT(*) FROM app.cohorts WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.price_lists WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.buyers WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND buyer_app_enabled),0),
    COALESCE((SELECT SUM(ti.qty_available) FROM app.tenant_inventory ti JOIN app.tenant_products tp ON tp.id = ti.tenant_product_id WHERE tp.tenant_id = p_tenant_id AND ti.deleted_at IS NULL AND tp.deleted_at IS NULL AND ti.qty_available > 0),0),
    COALESCE((SELECT COUNT(DISTINCT ti.tenant_product_id) FROM app.tenant_inventory ti JOIN app.tenant_products tp ON tp.id = ti.tenant_product_id WHERE tp.tenant_id = p_tenant_id AND ti.deleted_at IS NULL AND tp.deleted_at IS NULL AND ti.qty_available > 0),0),
    COALESCE((SELECT COUNT(DISTINCT ti.tenant_product_id) FROM app.tenant_inventory ti JOIN app.tenant_products tp ON tp.id = ti.tenant_product_id WHERE tp.tenant_id = p_tenant_id AND ti.deleted_at IS NULL AND tp.deleted_at IS NULL AND ti.qty_available > 0 AND ti.qty_available <= 10),0),
    COALESCE((SELECT COUNT(*) FROM (SELECT tp.id FROM app.tenant_products tp LEFT JOIN app.tenant_inventory ti ON ti.tenant_product_id = tp.id AND ti.deleted_at IS NULL WHERE tp.tenant_id = p_tenant_id AND tp.deleted_at IS NULL GROUP BY tp.id HAVING COALESCE(SUM(ti.qty_available),0) <= 0) oos),0),
    v_watermark, v_now, v_now, NULL
  ON CONFLICT (tenant_id) WHERE deleted_at IS NULL DO UPDATE SET
    receivable_amount = EXCLUDED.receivable_amount,
    receivable_invoice_count = EXCLUDED.receivable_invoice_count,
    receivable_buyer_count = EXCLUDED.receivable_buyer_count,
    overdue_amount = EXCLUDED.overdue_amount,
    overdue_invoice_count = EXCLUDED.overdue_invoice_count,
    overdue_buyer_count = EXCLUDED.overdue_buyer_count,
    open_estimate_count = EXCLUDED.open_estimate_count,
    open_estimate_value = EXCLUDED.open_estimate_value,
    open_order_count = EXCLUDED.open_order_count,
    open_order_value = EXCLUDED.open_order_value,
    active_buyer_count = EXCLUDED.active_buyer_count,
    active_brand_count = EXCLUDED.active_brand_count,
    active_product_count = EXCLUDED.active_product_count,
    active_category_count = EXCLUDED.active_category_count,
    active_location_count = EXCLUDED.active_location_count,
    active_warehouse_count = EXCLUDED.active_warehouse_count,
    active_campaign_count = EXCLUDED.active_campaign_count,
    active_cohort_count = EXCLUDED.active_cohort_count,
    active_price_list_count = EXCLUDED.active_price_list_count,
    enabled_buyer_count = EXCLUDED.enabled_buyer_count,
    sellable_units = EXCLUDED.sellable_units,
    sellable_sku_count = EXCLUDED.sellable_sku_count,
    low_stock_product_count = EXCLUDED.low_stock_product_count,
    oos_product_count = EXCLUDED.oos_product_count,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_brand_now_summary (
    tenant_id, tenant_brand_id, external_ref,
    member_product_count, selling_product_out_of_stock_count, low_stock_product_count,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, tb.id, concat_ws(':', p_tenant_id::text, tb.id::text, 'brand-now'),
    COALESCE(prod.member_product_count, 0),
    COALESCE(prod.selling_out_of_stock_count, 0),
    COALESCE(prod.low_stock_count, 0),
    v_watermark, v_now, v_now, NULL
  FROM app.tenant_brands tb
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::bigint AS member_product_count,
      COUNT(*) FILTER (
        WHERE COALESCE(stock.qty_available, 0) <= 0
          AND EXISTS (
            SELECT 1 FROM app.metrics_product_period_summary qps
            WHERE qps.tenant_product_id = tp.id AND qps.grain = 'quarter'
              AND qps.period_start = v_quarter_start AND qps.deleted_at IS NULL AND qps.invoice_count > 0
          )
      )::bigint AS selling_out_of_stock_count,
      COUNT(*) FILTER (WHERE stock.qty_available > 0 AND stock.qty_available <= 10)::bigint AS low_stock_count
    FROM app.tenant_products tp
    LEFT JOIN LATERAL (
      SELECT SUM(ti.qty_available) AS qty_available
      FROM app.tenant_inventory ti
      WHERE ti.tenant_product_id = tp.id AND ti.deleted_at IS NULL
    ) stock ON true
    WHERE tp.tenant_brand_id = tb.id AND tp.deleted_at IS NULL
  ) prod ON true
  WHERE tb.tenant_id = p_tenant_id AND tb.deleted_at IS NULL
  ON CONFLICT (tenant_id, tenant_brand_id) WHERE deleted_at IS NULL DO UPDATE SET
    member_product_count = EXCLUDED.member_product_count,
    selling_product_out_of_stock_count = EXCLUDED.selling_product_out_of_stock_count,
    low_stock_product_count = EXCLUDED.low_stock_product_count,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_category_now_summary (
    tenant_id, tenant_category_id, external_ref,
    product_count, brand_count, source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, tc.id, concat_ws(':', p_tenant_id::text, tc.id::text, 'category-now'),
    COALESCE(agg.product_count, 0), COALESCE(agg.brand_count, 0),
    v_watermark, v_now, v_now, NULL
  FROM app.tenant_categories tc
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS product_count, COUNT(DISTINCT tp.tenant_brand_id)::bigint AS brand_count
    FROM app.tenant_products tp
    WHERE tp.tenant_category_id = tc.id AND tp.deleted_at IS NULL
  ) agg ON true
  WHERE tc.tenant_id = p_tenant_id AND tc.deleted_at IS NULL
  ON CONFLICT (tenant_id, tenant_category_id) WHERE deleted_at IS NULL DO UPDATE SET
    product_count = EXCLUDED.product_count,
    brand_count = EXCLUDED.brand_count,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_warehouse_now_summary (
    tenant_id, warehouse_id, external_ref,
    available_product_count, in_stock_product_count, sellable_units,
    low_stock_product_count, out_of_stock_product_count, idle_stock_product_count, idle_stock_units,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, wh.id, concat_ws(':', p_tenant_id::text, wh.id::text, 'warehouse-now'),
    COALESCE(agg.available_product_count, 0), COALESCE(agg.in_stock_product_count, 0), COALESCE(agg.sellable_units, 0),
    COALESCE(agg.low_stock_product_count, 0), COALESCE(agg.out_of_stock_product_count, 0),
    COALESCE(agg.idle_stock_product_count, 0), COALESCE(agg.idle_stock_units, 0),
    v_watermark, v_now, v_now, NULL
  FROM app.warehouses wh
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE ti.qty_available > 0)::bigint AS available_product_count,
      COUNT(*) FILTER (WHERE ti.qty_available > 0)::bigint AS in_stock_product_count,
      COALESCE(SUM(ti.qty_available) FILTER (WHERE ti.qty_available > 0), 0)::numeric AS sellable_units,
      COUNT(*) FILTER (WHERE ti.qty_available > 0 AND ti.qty_available <= 10)::bigint AS low_stock_product_count,
      COUNT(*) FILTER (WHERE COALESCE(ti.qty_available,0) <= 0)::bigint AS out_of_stock_product_count,
      COUNT(*) FILTER (
        WHERE ti.qty_available > 0
          AND NOT EXISTS (
            SELECT 1 FROM app.metrics_product_period_summary qps
            WHERE qps.tenant_product_id = ti.tenant_product_id AND qps.grain = 'quarter'
              AND qps.period_start = v_quarter_start AND qps.deleted_at IS NULL AND qps.invoice_count > 0
          )
      )::bigint AS idle_stock_product_count,
      COALESCE(SUM(ti.qty_available) FILTER (
        WHERE ti.qty_available > 0
          AND NOT EXISTS (
            SELECT 1 FROM app.metrics_product_period_summary qps
            WHERE qps.tenant_product_id = ti.tenant_product_id AND qps.grain = 'quarter'
              AND qps.period_start = v_quarter_start AND qps.deleted_at IS NULL AND qps.invoice_count > 0
          )
      ), 0)::numeric AS idle_stock_units
    FROM app.tenant_inventory ti
    JOIN app.tenant_products tp ON tp.id = ti.tenant_product_id AND tp.tenant_id = p_tenant_id AND tp.deleted_at IS NULL
    WHERE ti.warehouse_id = wh.id AND ti.deleted_at IS NULL
  ) agg ON true
  WHERE wh.tenant_id = p_tenant_id AND wh.deleted_at IS NULL
  ON CONFLICT (tenant_id, warehouse_id) WHERE deleted_at IS NULL DO UPDATE SET
    available_product_count = EXCLUDED.available_product_count,
    in_stock_product_count = EXCLUDED.in_stock_product_count,
    sellable_units = EXCLUDED.sellable_units,
    low_stock_product_count = EXCLUDED.low_stock_product_count,
    out_of_stock_product_count = EXCLUDED.out_of_stock_product_count,
    idle_stock_product_count = EXCLUDED.idle_stock_product_count,
    idle_stock_units = EXCLUDED.idle_stock_units,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  -- assigned_buyer_count de-dupes buyers reachable through more than one
  -- assignment (a direct buyer assignment AND a cohort they also belong to)
  -- via UNION over the three target_type branches before counting distinct.
  -- The 'all_buyers' branch is gated behind an EXISTS check on this specific
  -- price list's assignments so the planner can skip the app.buyers scan
  -- entirely for the common case (no all_buyers assignment) instead of
  -- paying for a full tenant-wide buyers scan per price list regardless.
  INSERT INTO app.metrics_price_lists_now_summary (
    tenant_id, price_list_id, external_ref,
    member_product_count, assigned_cohort_count, assigned_buyer_count,
    avg_discount_pct, avg_margin_pct,
    source_watermark, computed_at, updated_at, deleted_at
  )
  SELECT
    p_tenant_id, pl.id, concat_ws(':', p_tenant_id::text, pl.id::text, 'price-list-now'),
    COALESCE(items.member_product_count, 0),
    COALESCE(cohort_ct.assigned_cohort_count, 0),
    COALESCE(buyer_ct.assigned_buyer_count, 0),
    COALESCE(items.avg_discount_pct, 0),
    COALESCE(items.avg_margin_pct, 0),
    v_watermark, v_now, v_now, NULL
  FROM app.price_lists pl
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::bigint AS member_product_count,
      COALESCE(AVG(
        CASE WHEN tp.base_selling_price > 0 THEN (tp.base_selling_price - pli.price) / tp.base_selling_price * 100 END
      ), 0)::numeric AS avg_discount_pct,
      COALESCE(AVG(
        CASE WHEN pli.price > 0 AND tp.cost_price IS NOT NULL THEN (pli.price - tp.cost_price) / pli.price * 100 END
      ), 0)::numeric AS avg_margin_pct
    FROM app.price_list_items pli
    JOIN app.tenant_products tp ON tp.id = pli.tenant_product_id AND tp.deleted_at IS NULL
    WHERE pli.price_list_id = pl.id AND pli.deleted_at IS NULL
  ) items ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE a.target_type = 'cohort')::bigint AS assigned_cohort_count
    FROM app.price_list_assignments a
    WHERE a.price_list_id = pl.id AND a.deleted_at IS NULL
  ) cohort_ct ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT buyer_id)::bigint AS assigned_buyer_count
    FROM (
      SELECT a.target_id AS buyer_id
      FROM app.price_list_assignments a
      WHERE a.price_list_id = pl.id AND a.deleted_at IS NULL AND a.target_type = 'buyer'
      UNION
      SELECT cm.buyer_id
      FROM app.price_list_assignments a
      JOIN app.cohort_members_active cm ON cm.cohort_id = a.target_id
      WHERE a.price_list_id = pl.id AND a.deleted_at IS NULL AND a.target_type = 'cohort'
      UNION
      SELECT b.id
      FROM app.buyers b
      WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM app.price_list_assignments a2
          WHERE a2.price_list_id = pl.id AND a2.deleted_at IS NULL AND a2.target_type = 'all_buyers'
        )
    ) buyer_ids
  ) buyer_ct ON true
  WHERE pl.tenant_id = p_tenant_id AND pl.deleted_at IS NULL
  ON CONFLICT (tenant_id, price_list_id) WHERE deleted_at IS NULL DO UPDATE SET
    member_product_count = EXCLUDED.member_product_count,
    assigned_cohort_count = EXCLUDED.assigned_cohort_count,
    assigned_buyer_count = EXCLUDED.assigned_buyer_count,
    avg_discount_pct = EXCLUDED.avg_discount_pct,
    avg_margin_pct = EXCLUDED.avg_margin_pct,
    source_watermark = EXCLUDED.source_watermark,
    computed_at = EXCLUDED.computed_at,
    generation_id = gen_random_uuid(),
    updated_at = EXCLUDED.updated_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  RETURN v_rows;
END;
$$;
