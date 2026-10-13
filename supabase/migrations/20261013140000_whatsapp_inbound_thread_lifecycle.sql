-- WhatsApp inbox P0 G2: thread / entry lifecycle for inbound messages.
--
-- Changes to app.process_whatsapp_inbound_message (full body re-declared from
-- 20260928125155; everything not listed below is unchanged):
--   1. Quiet threshold: a RESOLVED entry whose resolution is > 24h old closes
--      its thread, so the next message opens a fresh thread + fresh Today entry
--      instead of resurrecting an old one with a long history. Inside 24h the
--      same entry is reopened.
--   2. Any inbound message flips an existing entry back to 'new' and clears
--      remind_at. Previously an entry in 'waiting' (hidden until remind_at) or
--      'in_progress' (after a seller reply) stayed there and the buyer's reply
--      was invisible / did not count toward the unread badge.
--   3. Stale resolution fields (resolved_at/by, resolution_reason) are cleared
--      when an entry is reopened.
--   4. Out-of-order webhooks can no longer shrink the 24h service window or
--      move last_inbound_message_at backwards.
--   5. entry_events 'whatsapp_inbound_received' now records from_status.
--   0. BUG FIX: buyer resolution used min(buyer_id) over a uuid column, which
--      does not exist in Postgres, so EVERY inbound message failed at this
--      statement ("function min(uuid) does not exist") and no thread, entry or
--      buyer was ever created. Replaced with (array_agg(buyer_id))[1]; the
--      value is only used when exactly one candidate matched.
--   6. If the entry type is disabled for the tenant (upsert_entry returns
--      NULL) the message is still stored on the thread and the RPC returns
--      skipped='entry_type_disabled' instead of failing on a NULL entry id.
--
-- Debounce (scope doc 6, 90s bundling): intentionally not implemented as a
-- separate timer. One active thread already maps to one active entry, so a
-- burst of fragments extends the same entry and bundle; there is no
-- per-fragment entry or notification to suppress.

CREATE OR REPLACE FUNCTION app.process_whatsapp_inbound_message(
  p_provider_message_id text,
  p_sender_phone text,
  p_recipient_phone_number_id text,
  p_recipient_display_phone text,
  p_message_type text,
  p_text_body text,
  p_received_at timestamptz,
  p_raw_payload jsonb DEFAULT '{}'::jsonb,
  p_platform_phone_number_id text DEFAULT NULL,
  p_platform_tenant_id uuid DEFAULT NULL,
  p_feature_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_tenant_id uuid;
  v_sender_phone text := regexp_replace(COALESCE(p_sender_phone, ''), '\D', '', 'g');
  v_received_at timestamptz := COALESCE(p_received_at, now());
  v_thread_id uuid;
  v_message_id uuid;
  v_buyer_id uuid;
  v_resolution_status text := 'unknown';
  v_contact_kind text;
  v_contact_role text;
  v_candidate_count integer := 0;
  v_ambiguity jsonb := '{}'::jsonb;
  v_entry_id uuid;
  v_quiet_thread_id uuid;
  v_quiet_status text;
  v_quiet_at timestamptz;
  v_prev_status text;
  v_recent_messages jsonb;
  v_sanitized_payload jsonb := COALESCE(p_raw_payload, '{}'::jsonb) - 'text' - 'button';
BEGIN
  IF COALESCE(p_feature_enabled, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'feature_disabled');
  END IF;
  IF NULLIF(trim(COALESCE(p_provider_message_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'missing_provider_message_id');
  END IF;
  IF NULLIF(trim(COALESCE(p_recipient_phone_number_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'missing_recipient_phone_number_id');
  END IF;
  IF v_sender_phone = '' THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'missing_sender_phone');
  END IF;
  IF COALESCE(p_message_type, 'text') NOT IN ('text', 'button') THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'unsupported_message_type');
  END IF;
  IF NULLIF(trim(COALESCE(p_text_body, '')), '') IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'empty_text_body');
  END IF;

  SELECT ti.tenant_id
  INTO v_tenant_id
  FROM app.tenant_integrations ti
  WHERE ti.integration_type_id = 'whatsapp_business'
    AND ti.status = 'connected'
    AND ti.deleted_at IS NULL
    AND ti.config->>'phone_number_id' = p_recipient_phone_number_id
  ORDER BY ti.connected_at DESC NULLS LAST, ti.created_at DESC
  LIMIT 1;

  IF v_tenant_id IS NULL
     AND p_platform_tenant_id IS NOT NULL
     AND NULLIF(trim(COALESCE(p_platform_phone_number_id, '')), '') = p_recipient_phone_number_id
  THEN
    v_tenant_id := p_platform_tenant_id;
  END IF;

  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'tenant_not_resolved');
  END IF;

  SELECT m.id
  INTO v_message_id
  FROM app.whatsapp_thread_messages m
  WHERE m.tenant_id = v_tenant_id
    AND m.provider_message_id = p_provider_message_id
    AND m.deleted_at IS NULL
  LIMIT 1;
  IF v_message_id IS NOT NULL THEN
    RETURN jsonb_build_object('processed', true, 'duplicate', true, 'message_id', v_message_id);
  END IF;

  WITH candidates AS (
    SELECT *
    FROM app.find_buyer_login_candidates(v_sender_phone)
    WHERE tenant_id = v_tenant_id
      AND buyer_is_active = true
      AND buyer_deleted_at IS NULL
  )
  SELECT count(*), (array_agg(buyer_id))[1], min(kind), min(role),
         COALESCE(jsonb_agg(jsonb_build_object(
           'kind', kind,
           'buyer_id', buyer_id,
           'role', role,
           'business_name', business_name,
           'buyer_app_enabled', buyer_app_enabled
         )), '[]'::jsonb)
  INTO v_candidate_count, v_buyer_id, v_contact_kind, v_contact_role, v_ambiguity
  FROM candidates;

  IF v_candidate_count = 1 THEN
    v_resolution_status := 'matched';
    v_ambiguity := '{}'::jsonb;
  ELSIF v_candidate_count > 1 THEN
    v_buyer_id := NULL;
    v_resolution_status := 'ambiguous';
    v_contact_kind := NULL;
    v_contact_role := NULL;
    v_ambiguity := jsonb_build_object('candidate_count', v_candidate_count, 'candidates', v_ambiguity);
  ELSE
    SELECT b.id
    INTO v_buyer_id
    FROM app.buyers b
    WHERE b.tenant_id = v_tenant_id
      AND b.phone = right(v_sender_phone, 10)
      AND b.deleted_at IS NULL
    ORDER BY b.created_at DESC
    LIMIT 1;

    IF v_buyer_id IS NULL AND length(v_sender_phone) >= 10 THEN
      INSERT INTO app.buyers (
        tenant_id,
        business_name,
        contact_name,
        phone,
        buyer_app_enabled,
        is_active,
        custom_fields,
        external_ref
      )
      VALUES (
        v_tenant_id,
        'Customer ' || right(v_sender_phone, 10),
        NULL,
        right(v_sender_phone, 10),
        false,
        true,
        jsonb_build_object(
          'source', 'whatsapp_inbox',
          'storefront_self_registered', false,
          'whatsapp_unknown_sender', true
        ),
        'whatsapp_unknown:' || v_tenant_id::text || ':' || right(v_sender_phone, 10)
      )
      ON CONFLICT (tenant_id, external_ref)
      DO UPDATE SET updated_at = now()
      RETURNING id INTO v_buyer_id;
    END IF;
    v_resolution_status := 'unknown';
  END IF;

  -- Thread/entry lifecycle (scope doc 14): one active thread = one Today entry.
  -- A resolved entry whose quiet threshold (24h after resolution) has passed
  -- closes its thread so this message starts a fresh thread and a fresh entry.
  -- Inside the threshold the same entry is reopened below; an inbound message
  -- is never left on a resolved entry where the seller cannot see it.
  SELECT t.id, e.status, COALESCE(e.resolved_at, e.last_action_at, e.updated_at)
  INTO v_quiet_thread_id, v_quiet_status, v_quiet_at
  FROM app.whatsapp_threads t
  LEFT JOIN app.entries e
    ON e.tenant_id = t.tenant_id
   AND e.dedupe_key = concat_ws(':', t.tenant_id::text, 'whatsapp_buyer_message', 'whatsapp_thread', t.id::text)
   AND e.deleted_at IS NULL
  WHERE t.tenant_id = v_tenant_id
    AND t.recipient_phone_number_id = p_recipient_phone_number_id
    AND t.sender_phone = v_sender_phone
    AND t.status = 'active'
    AND t.deleted_at IS NULL
  FOR UPDATE OF t;

  IF v_quiet_thread_id IS NOT NULL
     AND v_quiet_status = 'resolved'
     AND v_quiet_at < v_received_at - interval '24 hours'
  THEN
    UPDATE app.whatsapp_threads
    SET status = 'closed'
    WHERE id = v_quiet_thread_id;
  END IF;

  INSERT INTO app.whatsapp_threads (
    tenant_id,
    buyer_id,
    sender_phone,
    recipient_phone_number_id,
    recipient_display_phone,
    status,
    resolution_status,
    buyer_contact_kind,
    buyer_contact_role,
    ambiguity_metadata,
    last_inbound_message_at,
    service_window_opened_at,
    service_window_expires_at,
    metadata,
    external_ref
  )
  VALUES (
    v_tenant_id,
    v_buyer_id,
    v_sender_phone,
    p_recipient_phone_number_id,
    p_recipient_display_phone,
    'active',
    v_resolution_status,
    v_contact_kind,
    v_contact_role,
    COALESCE(v_ambiguity, '{}'::jsonb),
    v_received_at,
    v_received_at,
    v_received_at + interval '24 hours',
    jsonb_build_object('last_provider_message_id', p_provider_message_id),
    'whatsapp_thread:' || v_tenant_id::text || ':' || p_recipient_phone_number_id || ':' || v_sender_phone
  )
  ON CONFLICT (tenant_id, recipient_phone_number_id, sender_phone) WHERE deleted_at IS NULL AND status = 'active'
  DO UPDATE SET
    buyer_id = COALESCE(EXCLUDED.buyer_id, app.whatsapp_threads.buyer_id),
    recipient_display_phone = COALESCE(EXCLUDED.recipient_display_phone, app.whatsapp_threads.recipient_display_phone),
    resolution_status = EXCLUDED.resolution_status,
    buyer_contact_kind = EXCLUDED.buyer_contact_kind,
    buyer_contact_role = EXCLUDED.buyer_contact_role,
    ambiguity_metadata = EXCLUDED.ambiguity_metadata,
    -- GREATEST: webhooks can arrive out of order; an older message must not
    -- shrink the customer-service window.
    last_inbound_message_at = GREATEST(app.whatsapp_threads.last_inbound_message_at, EXCLUDED.last_inbound_message_at),
    service_window_opened_at = GREATEST(app.whatsapp_threads.service_window_opened_at, EXCLUDED.service_window_opened_at),
    service_window_expires_at = GREATEST(app.whatsapp_threads.service_window_expires_at, EXCLUDED.service_window_expires_at),
    metadata = app.whatsapp_threads.metadata || EXCLUDED.metadata
  RETURNING id INTO v_thread_id;

  INSERT INTO app.whatsapp_thread_messages (
    tenant_id,
    thread_id,
    direction,
    provider_message_id,
    sender_phone,
    recipient_phone,
    message_type,
    text_body,
    raw_payload,
    received_at,
    processing_status,
    external_ref
  )
  VALUES (
    v_tenant_id,
    v_thread_id,
    'inbound',
    p_provider_message_id,
    v_sender_phone,
    p_recipient_phone_number_id,
    COALESCE(p_message_type, 'text'),
    left(p_text_body, 4000),
    v_sanitized_payload,
    v_received_at,
    'processed',
    'whatsapp_inbound:' || p_provider_message_id
  )
  ON CONFLICT (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL AND deleted_at IS NULL
  DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('processed', true, 'duplicate', true, 'thread_id', v_thread_id);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', sub.id,
    'direction', sub.direction,
    'text_body', sub.text_body,
    'created_at', sub.created_at,
    'provider_message_id', sub.provider_message_id
  ) ORDER BY sub.created_at), '[]'::jsonb)
  INTO v_recent_messages
  FROM (
    SELECT id, direction, text_body, created_at, provider_message_id
    FROM app.whatsapp_thread_messages
    WHERE thread_id = v_thread_id
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  ) sub;

  SELECT e.status
  INTO v_prev_status
  FROM app.entries e
  WHERE e.tenant_id = v_tenant_id
    AND e.dedupe_key = concat_ws(':', v_tenant_id::text, 'whatsapp_buyer_message', 'whatsapp_thread', v_thread_id::text)
    AND e.deleted_at IS NULL;

  v_entry_id := app.upsert_entry(
    v_tenant_id,
    'whatsapp_buyer_message',
    'whatsapp',
    'whatsapp_thread',
    v_thread_id,
    v_buyer_id,
    NULL,
    v_received_at,
    jsonb_build_object(
      'thread_id', v_thread_id,
      'sender_phone', v_sender_phone,
      'recipient_phone_number_id', p_recipient_phone_number_id,
      'recipient_display_phone', p_recipient_display_phone,
      'resolution_status', v_resolution_status,
      'buyer_contact_kind', v_contact_kind,
      'buyer_contact_role', v_contact_role,
      'ambiguity', COALESCE(v_ambiguity, '{}'::jsonb),
      'last_inbound_text', left(p_text_body, 500),
      'last_inbound_at', v_received_at,
      'service_window_opened_at', v_received_at,
      'service_window_expires_at', v_received_at + interval '24 hours',
      'message_bundle', v_recent_messages
    ),
    'not_required',
    NULL
  );

  IF v_entry_id IS NULL THEN
    RETURN jsonb_build_object(
      'processed', true,
      'duplicate', false,
      'skipped', 'entry_type_disabled',
      'tenant_id', v_tenant_id,
      'thread_id', v_thread_id,
      'message_id', v_message_id
    );
  END IF;

  -- A buyer message is new work whatever the entry was doing: surface it as
  -- unread, take it out of "waiting" (hidden until remind_at) and drop stale
  -- resolution fields left from an earlier resolve.
  UPDATE app.entries
  SET status = 'new',
      remind_at = NULL,
      resolution_reason = NULL,
      resolved_at = NULL,
      resolved_by = NULL,
      version = version + 1
  WHERE id = v_entry_id
    AND (status <> 'new' OR remind_at IS NOT NULL OR resolved_at IS NOT NULL OR resolution_reason IS NOT NULL);

  INSERT INTO app.entry_events (
    tenant_id,
    entry_id,
    action,
    from_status,
    to_status,
    metadata
  )
  VALUES (
    v_tenant_id,
    v_entry_id,
    'whatsapp_inbound_received',
    v_prev_status,
    'new',
    jsonb_build_object('thread_id', v_thread_id, 'thread_message_id', v_message_id, 'provider_message_id', p_provider_message_id)
  );

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'tenant_id', v_tenant_id,
    'thread_id', v_thread_id,
    'message_id', v_message_id,
    'entry_id', v_entry_id,
    'resolution_status', v_resolution_status
  );
END;
$$;
