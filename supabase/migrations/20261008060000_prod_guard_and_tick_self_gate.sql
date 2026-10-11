-- Prod load guard (W1 of docs/incidents/2026-10-07-prod-stall.md).
--
-- Why: on Oct 7 the metrics tick ran 40-134 s per run for ~6 h, then pg_cron itself began failing
-- with "job startup timeout" and the API collapsed. Nothing alerted: /api/health is static and never
-- touches the DB. This adds:
--   1. app.prod_load_state()                 cheap read-only classifier -> ok | warn | trip (+ reasons)
--   2. app.metrics_refresh_tick_guarded()    thin wrapper: skips the tick while state = 'trip'
--   3. app.prod_guard_tick(p_enforce)        every 2 min: classify, heartbeat ping, Slack on state change,
--                                            and (only when p_enforce) flip the metrics kill switch + pause
--                                            the two metrics background jobs
--   4. app.ops_guard_events                  audit of state changes / actions (30 d retention, self-pruned)
--
-- No new feature flag and no config table: the guard's own cron job is the on/off switch, and its
-- command argument is the mode. It ships in SHADOW mode (p_enforce = false): it alerts but pauses
-- nothing. Switch to enforcing after calibration with:
--   select cron.alter_job((select jobid from cron.job where jobname = 'prod-guard-tick'),
--                         command := 'select app.prod_guard_tick(true);');
--
-- Alerting is armed only when the Vault secret 'app.healthchecks_ping_url' exists (prod). Without it
-- (dev) the guard still classifies and records events but sends nothing. Slack reuses the existing
-- 'app.ops_slack_webhook_url' secret. No secret is stored in this file.
--
-- Manual resume after an enforced trip (explicit, never automatic):
--   update app.metrics_runtime_control set dispatch_enabled = true, pause_reason = null
--     where control_scope = 'global';
--   select cron.alter_job(jobid, active := true) from cron.job
--     where jobname = 'metrics-v4-dead-letter-requeue';   -- metrics-refresh-tick stays paused until W2

-- ---------------------------------------------------------------------------------------------
-- 1. audit table (Metrics V2 operational-table exemption: bounded retention, service_role only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.ops_guard_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  state      text NOT NULL CHECK (state IN ('ok', 'warn', 'trip')),
  enforced   boolean NOT NULL,
  action     text NOT NULL,
  reasons    jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS ops_guard_events_created_at_idx ON app.ops_guard_events (created_at DESC);

ALTER TABLE app.ops_guard_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ops_guard_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON app.ops_guard_events TO service_role;

COMMENT ON TABLE app.ops_guard_events IS
  'Prod load guard audit: one row per state change or enforced action. Self-pruned to 30 days by app.prod_guard_tick.';

-- ---------------------------------------------------------------------------------------------
-- 2. healthcheck URL getter (same Vault pattern as app.get_ops_slack_webhook_url)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.get_ops_healthcheck_url()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'vault', 'app'
AS $function$
  SELECT (
    SELECT ds.decrypted_secret
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'app.healthchecks_ping_url'
    LIMIT 1
  );
$function$;

REVOKE ALL ON FUNCTION app.get_ops_healthcheck_url() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_ops_healthcheck_url() TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. classifier. Every signal is a bounded read; thresholds come from the Oct 5-7 prod data:
--    healthy tick avg 13-14 s / max 67-83 s; incident regime avg 38-53 s; collapse runs 129-134 s.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.prod_load_state()
RETURNS TABLE (state text, reasons jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'cron'
SET statement_timeout TO '2s'
SET lock_timeout TO '200ms'
AS $function$
DECLARE
  v_trip     text[] := '{}';
  v_warn     text[] := '{}';
  v_n        integer;
  v_x        numeric;
  v_dispatch boolean;
BEGIN
  -- TRIP T1: tick retry storm (>= 3 wall-budget failures / dead letters in 30 min)
  SELECT count(*) INTO v_n
  FROM app.metrics_execution_history h
  WHERE h.started_at > now() - interval '30 minutes'
    AND (h.status = 'dead_letter' OR h.error_text = 'metrics_tick_wall_budget_exceeded');
  IF v_n >= 3 THEN v_trip := v_trip || format('tick_failures_30m=%s', v_n); END IF;

  -- TRIP T2: a tick run longer than 100 s in the last hour (budget is 40 s; healthy max was 83 s)
  SELECT max(extract(epoch FROM d.end_time - d.start_time)) INTO v_x
  FROM cron.job_run_details d
  JOIN cron.job j ON j.jobid = d.jobid
  WHERE j.jobname = 'metrics-refresh-tick'
    AND d.start_time > now() - interval '60 minutes'
    AND d.end_time IS NOT NULL;
  IF v_x > 100 THEN v_trip := v_trip || format('tick_run_s=%s', round(v_x)); END IF;

  -- TRIP T3: pg_cron cannot start jobs (>= 3 startup timeouts in 10 min) = DB-wide stall
  SELECT count(*) INTO v_n
  FROM cron.job_run_details d
  WHERE d.start_time > now() - interval '10 minutes'
    AND d.status = 'failed'
    AND d.return_message ILIKE '%startup timeout%';
  IF v_n >= 3 THEN v_trip := v_trip || format('cron_startup_timeouts_10m=%s', v_n); END IF;

  -- TRIP T4: connection pile-up (normal is 2-4 active; max_connections is 60)
  SELECT count(*) INTO v_n
  FROM pg_stat_activity a
  WHERE a.state = 'active'
    AND a.pid <> pg_backend_pid()
    AND a.backend_type = 'client backend'
    AND coalesce(a.application_name, '') <> 'pg_cron scheduler';
  IF v_n > 15 THEN v_trip := v_trip || format('active_backends=%s', v_n); END IF;

  -- WARN W1: tick is drifting up (avg of last 4 successful runs in 90 min > 45 s; Oct 7 04:00-09:00 regime)
  SELECT avg(s.dur), count(*) INTO v_x, v_n
  FROM (
    SELECT extract(epoch FROM d.end_time - d.start_time) AS dur
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname = 'metrics-refresh-tick'
      AND d.status = 'succeeded'
      AND d.start_time > now() - interval '90 minutes'
    ORDER BY d.start_time DESC
    LIMIT 4
  ) s;
  IF v_n >= 3 AND v_x > 45 THEN v_warn := v_warn || format('tick_avg_s=%s', round(v_x)); END IF;

  -- WARN W2: queue not draining (oldest due dirty row > 120 min while dispatch is on AND the tick job is
  -- active; a deliberately paused tick must not warn forever)
  SELECT coalesce(rc.dispatch_enabled, false) INTO v_dispatch
  FROM app.metrics_runtime_control rc WHERE rc.control_scope = 'global' LIMIT 1;
  IF coalesce(v_dispatch, false)
     AND EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'metrics-refresh-tick' AND j.active) THEN
    SELECT extract(epoch FROM now() - min(w.created_at)) / 60 INTO v_x
    FROM app.metrics_dirty_work w
    WHERE w.state IN ('pending', 'retry') AND w.next_attempt_at <= now();
    IF v_x > 120 THEN v_warn := v_warn || format('queue_oldest_min=%s', round(v_x)); END IF;
  END IF;

  state := CASE WHEN cardinality(v_trip) > 0 THEN 'trip'
                WHEN cardinality(v_warn) > 0 THEN 'warn'
                ELSE 'ok' END;
  reasons := to_jsonb(v_trip || v_warn);
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION app.prod_load_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.prod_load_state() TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. guard tick: heartbeat + alert on state change + (optional) enforcement
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.prod_guard_tick(p_enforce boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'cron', 'net'
SET statement_timeout TO '3s'
SET lock_timeout TO '200ms'
AS $function$
DECLARE
  v_state    text;
  v_reasons  jsonb;
  v_prev     text;
  v_dispatch boolean;
  v_action   text := 'none';
  v_hc_url   text;
  v_slack    text;
BEGIN
  SELECT s.state, s.reasons INTO v_state, v_reasons FROM app.prod_load_state() s;

  SELECT e.state INTO v_prev FROM app.ops_guard_events e ORDER BY e.created_at DESC LIMIT 1;

  SELECT coalesce(rc.dispatch_enabled, false) INTO v_dispatch
  FROM app.metrics_runtime_control rc WHERE rc.control_scope = 'global' LIMIT 1;

  IF v_state = 'trip' THEN
    IF p_enforce AND coalesce(v_dispatch, false) THEN
      UPDATE app.metrics_runtime_control
         SET dispatch_enabled = false,
             pause_reason = left('prod_guard: ' || v_reasons::text, 500),
             updated_at = now()
       WHERE control_scope = 'global';
      PERFORM cron.alter_job(j.jobid, active := false)
        FROM cron.job j
       WHERE j.jobname IN ('metrics-refresh-tick', 'metrics-v4-dead-letter-requeue') AND j.active;
      v_action := 'paused_metrics';
    ELSIF NOT p_enforce THEN
      v_action := 'shadow_would_pause';
    END IF;
  END IF;

  IF v_state IS DISTINCT FROM v_prev OR v_action = 'paused_metrics' THEN
    INSERT INTO app.ops_guard_events (state, enforced, action, reasons)
    VALUES (v_state, p_enforce, v_action, v_reasons);
  END IF;

  DELETE FROM app.ops_guard_events
   WHERE id IN (SELECT id FROM app.ops_guard_events WHERE created_at < now() - interval '30 days' LIMIT 200);

  -- external notifications; never allowed to break the guard itself
  BEGIN
    v_hc_url := app.get_ops_healthcheck_url();
    IF v_hc_url IS NOT NULL THEN
      -- heartbeat: success ping every run; /fail on trip. A missing ping (DB stalled) is the dead-man alert.
      PERFORM net.http_post(
        url := CASE WHEN v_state = 'trip' THEN v_hc_url || '/fail' ELSE v_hc_url END,
        body := jsonb_build_object('state', v_state, 'reasons', v_reasons, 'enforced', p_enforce, 'action', v_action),
        timeout_milliseconds := 5000
      );
      IF v_state IS DISTINCT FROM v_prev AND (v_state <> 'ok' OR v_prev IN ('warn', 'trip')) THEN
        v_slack := app.get_ops_slack_webhook_url();
        IF v_slack IS NOT NULL THEN
          PERFORM net.http_post(
            url := v_slack,
            body := jsonb_build_object('text',
              format('yukti-prod guard: %s -> %s %s (%s)', coalesce(v_prev, 'n/a'), upper(v_state), v_reasons::text,
                     CASE WHEN p_enforce THEN 'enforcing: ' || v_action ELSE 'shadow mode, nothing paused' END)),
            timeout_milliseconds := 5000
          );
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_state;
END;
$function$;

REVOKE ALL ON FUNCTION app.prod_guard_tick(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.prod_guard_tick(boolean) TO postgres, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. tick wrapper: self-gate. The tick is untouched; point the cron at the wrapper when it is re-enabled:
--    cron.alter_job(111, command := 'CALL app.metrics_refresh_tick_guarded(40000, 25);')
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.metrics_refresh_tick_guarded(
  p_budget_ms integer DEFAULT 40000,
  p_max_groups integer DEFAULT 25
)
LANGUAGE plpgsql
AS $proc$
BEGIN
  IF (SELECT s.state FROM app.prod_load_state() s) = 'trip' THEN
    RETURN;
  END IF;
  CALL app.metrics_refresh_tick_run(p_budget_ms, p_max_groups);
END;
$proc$;

REVOKE ALL ON PROCEDURE app.metrics_refresh_tick_guarded(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE app.metrics_refresh_tick_guarded(integer, integer) TO service_role;

COMMENT ON PROCEDURE app.metrics_refresh_tick_guarded(integer, integer) IS
  'Cron entry point for the metrics tick: skips while app.prod_load_state() = trip, else CALL app.metrics_refresh_tick_run. Never call from a pooled/PostgREST session (uses COMMIT).';

-- ---------------------------------------------------------------------------------------------
-- 6. cron: every 2 min, SHADOW mode (alerts, pauses nothing). Never overwrite an existing job.
-- ---------------------------------------------------------------------------------------------
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prod-guard-tick') THEN
    RETURN;
  END IF;
  PERFORM cron.schedule('prod-guard-tick', '1-59/2 * * * *', $c$select app.prod_guard_tick(false);$c$);
END
$cron$;
