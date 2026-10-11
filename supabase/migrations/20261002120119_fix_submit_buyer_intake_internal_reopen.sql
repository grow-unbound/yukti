-- Fix buyer resubmission after seller "request more info".
--
-- Root cause: app.submit_buyer_intake internally reopened a waiting approval
-- entry by calling app.apply_entry_action(..., NULL, 'reopen'). The approval
-- action RPC was later hardened so every action on business_approval /
-- new_user_login entries requires a seller_admin actor. That is correct for
-- external callers, but it made this internal buyer-resubmission reopen fail
-- with admin_only_entry_action.
--
-- Keep the public/admin-only guard intact. submit_buyer_intake already owns
-- the buyer and the captured waiting entry in the same transaction, so it can
-- perform the narrow internal reopen itself and write the same audit event.

CREATE OR REPLACE FUNCTION app.submit_buyer_intake(
  p_buyer_id uuid,
  p_full_name text,
  p_email text,
  p_is_business boolean,
  p_business_name text,
  p_gstin text,
  p_geography jsonb,
  p_billing_address jsonb,
  p_document_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS app.buyers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
DECLARE
  v_buyer app.buyers%ROWTYPE;
  v_old_onboarding_status text;
  v_entry_id uuid;
  v_entry_status text;
BEGIN
  SELECT * INTO v_buyer
  FROM app.buyers
  WHERE id = p_buyer_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF v_buyer.id IS NULL THEN
    RAISE EXCEPTION 'buyer_not_found' USING ERRCODE = '02000';
  END IF;

  v_old_onboarding_status := v_buyer.onboarding_status;

  -- Defense-in-depth: every claimed document id must exist, belong to this
  -- buyer, and not be soft-deleted. Prevents a client from claiming someone
  -- else's uploaded document id. Read-only check -- no writes here.
  IF p_document_ids IS NOT NULL AND array_length(p_document_ids, 1) > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM unnest(p_document_ids) AS doc_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM app.buyer_documents bd
        WHERE bd.id = doc_id
          AND bd.buyer_id = p_buyer_id
          AND bd.deleted_at IS NULL
      )
    ) THEN
      RAISE EXCEPTION 'invalid_document_id' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE app.buyers
  SET contact_name = NULLIF(trim(p_full_name), ''),
      email = NULLIF(trim(p_email), ''),
      business_name = CASE
        WHEN p_is_business AND NULLIF(trim(p_business_name), '') IS NOT NULL
          THEN trim(p_business_name)
        ELSE COALESCE(NULLIF(trim(p_full_name), ''), business_name)
      END,
      gstin = NULLIF(trim(p_gstin), ''),
      geography = COALESCE(p_geography, geography),
      billing_address = COALESCE(p_billing_address, billing_address),
      custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object(
        'is_business', p_is_business,
        'intake_submitted_at', now()
      ),
      onboarding_status = CASE
        WHEN onboarding_status = 'needs_more_info' THEN 'pending_approval'
        ELSE onboarding_status
      END,
      updated_at = now(),
      updated_by = v_buyer.user_id
  WHERE id = p_buyer_id
  RETURNING * INTO v_buyer;

  -- Captured BEFORE sync_entry_from_buyer runs. For an already-enabled buyer,
  -- sync_entry_from_buyer can auto-resolve the entry before this function
  -- reopens it for seller review.
  IF v_old_onboarding_status = 'needs_more_info' THEN
    SELECT e.id, e.status INTO v_entry_id, v_entry_status
    FROM app.entries e
    WHERE e.tenant_id = v_buyer.tenant_id
      AND e.source_entity_type = 'buyer'
      AND e.source_entity_id = v_buyer.id
      AND e.entry_type IN ('business_approval', 'new_user_login')
      AND e.deleted_at IS NULL
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1;
  END IF;

  PERFORM app.sync_entry_from_buyer(p_buyer_id);

  IF v_old_onboarding_status = 'needs_more_info'
     AND v_entry_id IS NOT NULL
     AND v_entry_status = 'waiting' THEN
    UPDATE app.entries
    SET status = 'new',
        remind_at = NULL,
        priority_at = now(),
        last_actor_id = NULL,
        last_action = 'reopen',
        last_action_at = now(),
        resolution_reason = NULL,
        resolved_at = NULL,
        resolved_by = NULL,
        external_sync_status = 'not_required',
        updated_at = now(),
        updated_by = NULL
    WHERE id = v_entry_id
      AND tenant_id = v_buyer.tenant_id
      AND deleted_at IS NULL;

    INSERT INTO app.entry_events (
      tenant_id, entry_id, actor_user_id, action, from_status, to_status,
      note, metadata, created_by, updated_by
    )
    VALUES (
      v_buyer.tenant_id, v_entry_id, NULL, 'reopen', v_entry_status, 'new',
      NULL, '{}'::jsonb, NULL, NULL
    );
  END IF;

  RETURN v_buyer;
END;
$function$;

REVOKE ALL ON FUNCTION app.submit_buyer_intake(uuid, text, text, boolean, text, text, jsonb, jsonb, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_buyer_intake(uuid, text, text, boolean, text, text, jsonb, jsonb, uuid[]) TO service_role;
