-- Read-your-own-membership for one buyer.
--
-- Problem: a buyer enabled in the seller app gets a pending `buyer_candidate` row in
-- app.membership_dirty_work, but cohort / campaign-audience membership only lands when
-- app.membership_refresh_tick_run() next drains it (job 18, every 15 min). Until then
-- getVisibleBuyerCatalogs() cannot see cohort-scoped campaigns for that buyer, so browse falls
-- back to the General price list while an estimate placed after the tick is campaign-priced.
--
-- Fix: let the request path flush that ONE buyer's pending candidate row synchronously, using the
-- same evaluators the tick calls. No due pending row => one index lookup and 'none'. The tick and
-- this function never double-process: the row is locked with FOR UPDATE SKIP LOCKED, the tick moves
-- rows to state='claimed' before running them, and both take the same advisory lock.
--
-- Safety:
--   * honours the membership kill switch (app.membership_runtime_control.dispatch_enabled), so it
--     adds no DB work while membership processing is deliberately off (incident mode);
--   * single-flight with the tick (same advisory lock key); returns 'busy' instead of waiting;
--   * 3 s statement_timeout; failures use the tick's attempts/backoff/dead-letter accounting;
--   * never raises into the request;
--   * service_role only (called from the Next.js server with the admin client).
-- Returns text: flushed | none | busy | failed.

CREATE OR REPLACE FUNCTION app.flush_buyer_membership(p_tenant_id uuid, p_buyer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
SET statement_timeout TO '3s'
AS $function$
DECLARE
  -- same single-flight key as app.membership_refresh_tick_run: the tick and this flush must never
  -- run the evaluators (which rewrite shared cohort_members / campaign_buyer_members rows) at once
  c_lock_key constant bigint := hashtextextended('app.membership_refresh_tick_run', 0);
  v_work_id uuid;
  v_attempts integer;
BEGIN
  IF p_tenant_id IS NULL OR p_buyer_id IS NULL THEN
    RETURN 'none';
  END IF;

  -- kill switch (missing row = enabled), same semantics as membership_refresh_tick_run
  IF NOT COALESCE((
    SELECT c.dispatch_enabled
    FROM app.membership_runtime_control c
    WHERE c.control_scope = 'global' AND c.deleted_at IS NULL
    LIMIT 1
  ), true) THEN
    RETURN 'none';
  END IF;

  -- the buyer must belong to the caller-supplied tenant (service_role has no JWT to check)
  IF NOT EXISTS (
    SELECT 1 FROM app.buyers b WHERE b.id = p_buyer_id AND b.tenant_id = p_tenant_id
  ) THEN
    RETURN 'none';
  END IF;

  -- due, unclaimed work only (honours the tick's backoff); SKIP LOCKED never waits on a tick claim
  SELECT w.id, w.attempts
    INTO v_work_id, v_attempts
  FROM app.membership_dirty_work w
  WHERE w.tenant_id = p_tenant_id
    AND w.entity_type = 'buyer_candidate'
    AND w.entity_id = p_buyer_id
    AND w.state = 'pending'
    AND w.next_attempt_at <= now()
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_work_id IS NULL THEN
    RETURN 'none';
  END IF;

  -- tick (or another flush) is running the evaluators: do not pile on, the caller retries shortly
  IF NOT pg_try_advisory_xact_lock(c_lock_key) THEN
    RETURN 'busy';
  END IF;

  BEGIN
    PERFORM app.evaluate_buyer_for_cohorts_v2(p_buyer_id);
    PERFORM app.evaluate_buyer_for_campaign_buyers(p_buyer_id);

    UPDATE app.membership_dirty_work
    SET state = 'done',
        lease_owner = NULL,
        lease_until = NULL,
        last_error = NULL,
        updated_at = now()
    WHERE id = v_work_id;

    RETURN 'flushed';
  EXCEPTION
    -- OTHERS does not catch query_canceled (statement_timeout), so it is listed explicitly.
    WHEN query_canceled THEN
      -- Evaluator work rolled back with the sub-transaction. Account for the failure the way the
      -- tick does so a permanently failing row backs off and dead-letters instead of being retried
      -- on every request.
      UPDATE app.membership_dirty_work
      SET state = CASE WHEN v_attempts + 1 >= 5 THEN 'dead_letter' ELSE 'pending' END,
          attempts = v_attempts + 1,
          next_attempt_at = now() + LEAST(interval '30 minutes', interval '30 seconds' * power(2, v_attempts + 1)),
          last_error = left(SQLERRM, 500),
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = now()
      WHERE id = v_work_id;
      RETURN 'failed';
    WHEN OTHERS THEN
      -- Evaluator work rolled back with the sub-transaction. Account for the failure the way the
      -- tick does so a permanently failing row backs off and dead-letters instead of being retried
      -- on every request.
      UPDATE app.membership_dirty_work
      SET state = CASE WHEN v_attempts + 1 >= 5 THEN 'dead_letter' ELSE 'pending' END,
          attempts = v_attempts + 1,
          next_attempt_at = now() + LEAST(interval '30 minutes', interval '30 seconds' * power(2, v_attempts + 1)),
          last_error = left(SQLERRM, 500),
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = now()
      WHERE id = v_work_id;
      RETURN 'failed';
  END;
END;
$function$;

REVOKE ALL ON FUNCTION app.flush_buyer_membership(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.flush_buyer_membership(uuid, uuid) TO service_role;

COMMENT ON FUNCTION app.flush_buyer_membership(uuid, uuid) IS
  'Synchronously applies one buyer''s due pending buyer_candidate membership work (cohorts + campaign audiences). Returns flushed | none | busy | failed. Single-flight with the membership tick; 3s statement_timeout; service_role only; honours the membership kill switch.';
