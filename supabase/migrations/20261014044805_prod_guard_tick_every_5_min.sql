-- P6 of specs/2026-10-14-prod-resource-diet-nano.md: run the prod load guard every 5 min, not 2.
-- It is ~2.3 % of DB CPU on the t3a.nano and writes ~8 k cron.job_run_details rows / 6 d.
-- The classifier's trip conditions are minutes-scale (tick overruns, cron startup timeouts), so a
-- 5 min cadence still detects an incident within one window.
--
-- OPS DEPENDENCY: app.prod_guard_tick pings healthchecks.io on every run (missed ping = dead-man
-- alert). Raise the check's Period to >= 5 min (and keep Grace >= 5 min) BEFORE applying this to
-- prod, otherwise it false-alarms.
--
-- Only the schedule changes; the command (shadow/enforce mode) is left as-is. Idempotent.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'prod-guard-tick';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '1-59/5 * * * *');
  END IF;
END
$$;
