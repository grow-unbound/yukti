-- Healthchecks ping URLs are sometimes copied from the portal with a trailing slash.
-- The guard previously appended /fail to that value and sent the heartbeat URL as-is,
-- producing 404s from hc-ping.com. Normalize the URL once so both failure and recovery
-- pings target the canonical check endpoint.

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

  BEGIN
    v_hc_url := regexp_replace(btrim(app.get_ops_healthcheck_url()), '/+$', '');
    IF v_hc_url IS NOT NULL AND v_hc_url <> '' THEN
      PERFORM net.http_post(
        url := CASE WHEN v_state = 'trip' THEN v_hc_url || '/fail' ELSE v_hc_url END,
        headers := jsonb_build_object('Content-Type', 'application/json'),
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
