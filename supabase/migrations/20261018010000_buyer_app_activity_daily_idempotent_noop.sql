-- Slim buyer_app_activity ledger, step A: a duplicate (tenant_id, idempotency_key) is now a no-op.
-- The caller keys presence events per buyer / event / IST day (see src/lib/server/buyer-app-activity.ts),
-- so the first write of the day wins and later duplicates no longer rewrite the row (WAL) or touch
-- triggers. A conflicting call returns NULL. CREATE OR REPLACE with an unchanged signature preserves
-- existing grants.

CREATE OR REPLACE FUNCTION app.record_buyer_app_activity(
  p_tenant_id uuid,
  p_buyer_id uuid,
  p_event_name text,
  p_occurred_at timestamp with time zone DEFAULT now(),
  p_location_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL::text,
  p_qualifies_for_engagement boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $$
DECLARE
  v_claim_tenant uuid := app.jwt_tenant_id();
  v_claim_buyer uuid := app.jwt_buyer_id();
  v_occurred_at timestamptz := COALESCE(p_occurred_at, now());
  v_occurred_day date := (COALESCE(p_occurred_at, now()) AT TIME ZONE 'Asia/Kolkata')::date;
  v_activity_id uuid;
BEGIN
  IF btrim(COALESCE(p_event_name, '')) = '' THEN
    RAISE EXCEPTION 'event_name_required' USING ERRCODE = '22023';
  END IF;

  IF v_claim_tenant IS NOT NULL AND v_claim_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_claim_buyer IS NOT NULL AND v_claim_buyer <> p_buyer_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM app.buyers b
  WHERE b.id = p_buyer_id
    AND b.tenant_id = p_tenant_id
    AND b.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'buyer_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_location_id IS NOT NULL THEN
    PERFORM 1
    FROM app.locations l
    WHERE l.id = p_location_id
      AND l.tenant_id = p_tenant_id
      AND l.deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'location_not_found' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO app.buyer_app_activity (
      tenant_id,
      buyer_id,
      location_id,
      event_name,
      event_source,
      source_entity_id,
      occurred_at,
      occurred_day,
      qualifies_for_engagement,
      metadata,
      idempotency_key,
      created_by,
      updated_by,
      deleted_at
    )
    VALUES (
      p_tenant_id,
      p_buyer_id,
      p_location_id,
      btrim(p_event_name),
      'route',
      NULL,
      v_occurred_at,
      v_occurred_day,
      p_qualifies_for_engagement,
      COALESCE(p_metadata, '{}'::jsonb),
      p_idempotency_key,
      auth.uid(),
      auth.uid(),
      NULL
    )
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_activity_id;
  ELSE
    INSERT INTO app.buyer_app_activity (
      tenant_id,
      buyer_id,
      location_id,
      event_name,
      event_source,
      source_entity_id,
      occurred_at,
      occurred_day,
      qualifies_for_engagement,
      metadata,
      idempotency_key,
      created_by,
      updated_by,
      deleted_at
    )
    VALUES (
      p_tenant_id,
      p_buyer_id,
      p_location_id,
      btrim(p_event_name),
      'route',
      NULL,
      v_occurred_at,
      v_occurred_day,
      p_qualifies_for_engagement,
      COALESCE(p_metadata, '{}'::jsonb),
      NULL,
      auth.uid(),
      auth.uid(),
      NULL
    )
    RETURNING id INTO v_activity_id;
  END IF;

  RETURN v_activity_id;
END;
$$;
