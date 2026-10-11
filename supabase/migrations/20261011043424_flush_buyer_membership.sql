-- Read-your-own-membership for one buyer.
--
-- Problem: a buyer enabled in the seller app gets a pending `buyer_candidate` row in
-- app.membership_dirty_work, but cohort / campaign-audience membership only lands when
-- app.membership_refresh_tick_run() next drains it (job 18, every 15 min). Until then
-- getVisibleBuyerCatalogs() cannot see cohort-scoped campaigns for that buyer, so browse falls
-- back to the General price list while an estimate placed after the tick is campaign-priced.
--
-- Fix: let the request path flush that ONE buyer's pending candidate row synchronously, using the
-- same evaluators the tick calls. No pending row => one index lookup and false. The tick and this
-- function never double-process: the row is claimed with FOR UPDATE SKIP LOCKED and the tick moves
-- rows to state='claimed' before running them.
--
-- Safety:
--   * honours the membership kill switch (app.membership_runtime_control.dispatch_enabled), so it
--     adds no DB work while membership processing is deliberately off (incident mode);
--   * never raises into the request: evaluator errors leave the row pending for the tick;
--   * service_role only (called from the Next.js server with the admin client).

CREATE OR REPLACE FUNCTION app.flush_buyer_membership(p_tenant_id uuid, p_buyer_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
DECLARE
  v_work_id uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_buyer_id IS NULL THEN
    RETURN false;
  END IF;

  -- kill switch (missing row = enabled), same semantics as membership_refresh_tick_run
  IF NOT COALESCE((
    SELECT c.dispatch_enabled
    FROM app.membership_runtime_control c
    WHERE c.control_scope = 'global' AND c.deleted_at IS NULL
    LIMIT 1
  ), true) THEN
    RETURN false;
  END IF;

  -- the buyer must belong to the caller-supplied tenant (service_role has no JWT to check)
  IF NOT EXISTS (
    SELECT 1 FROM app.buyers b WHERE b.id = p_buyer_id AND b.tenant_id = p_tenant_id
  ) THEN
    RETURN false;
  END IF;

  SELECT w.id
    INTO v_work_id
  FROM app.membership_dirty_work w
  WHERE w.tenant_id = p_tenant_id
    AND w.entity_type = 'buyer_candidate'
    AND w.entity_id = p_buyer_id
    AND w.state = 'pending'
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_work_id IS NULL THEN
    RETURN false;
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

    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    -- Sub-transaction rolled back: the row is still 'pending' for the tick to retry.
    RETURN false;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION app.flush_buyer_membership(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.flush_buyer_membership(uuid, uuid) TO service_role;

COMMENT ON FUNCTION app.flush_buyer_membership(uuid, uuid) IS
  'Synchronously applies one buyer''s pending buyer_candidate membership work (cohorts + campaign audiences). Returns true when work was applied. service_role only; honours the membership kill switch.';
