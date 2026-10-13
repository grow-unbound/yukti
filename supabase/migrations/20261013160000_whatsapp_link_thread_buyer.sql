-- WhatsApp inbox P0 G6: seller resolution of ambiguous / unknown senders.
--
-- 1. app.link_whatsapp_thread_buyer: a seller links a WhatsApp thread to an
--    existing buyer of the same tenant. Actor role and tenant are re-checked in
--    the database (the route runs as service_role). Updates the thread and its
--    Today entry, logs an entry event, and removes the auto-created
--    "Customer <phone>" placeholder buyer when nothing else references it.
--    The linked buyer gets no buyer-app access and no buyer-admin contact role,
--    so financial context stays off until a seller deliberately grants it.
-- 2. app.process_whatsapp_inbound_message (full body re-declared from
--    20261013150000; unchanged except as noted): a seller-confirmed link wins
--    over phone matching and persists for that sender across threads. Without
--    this the link would be overwritten by the next inbound message, and a
--    linked buyer whose phone differs from the sender would be replaced by a
--    fresh placeholder buyer every time.

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
  v_manual_buyer_id uuid;
  v_recent_messages jsonb;
  v_body text;
  v_caption text := NULLIF(trim(COALESCE(p_text_body, '')), '');
  v_sanitized_payload jsonb := COALESCE(p_raw_payload, '{}'::jsonb) - 'text' - 'button' - 'caption';
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
  IF COALESCE(p_message_type, 'text') NOT IN (
       'text', 'button', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts'
     ) THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'unsupported_message_type');
  END IF;
  -- Text and button replies carry their content in p_text_body. Media,
  -- location and contact messages are stored with a readable placeholder (plus
  -- the caption when there is one); the media id/mime stay in raw_payload so a
  -- later phase can fetch the file. No media bytes are stored.
  IF COALESCE(p_message_type, 'text') IN ('text', 'button') THEN
    IF v_caption IS NULL THEN
      RETURN jsonb_build_object('processed', false, 'skipped', 'empty_text_body');
    END IF;
    v_body := p_text_body;
  ELSE
    v_body := CASE p_message_type
      WHEN 'image' THEN 'Sent an image'
      WHEN 'audio' THEN 'Sent a voice or audio message'
      WHEN 'video' THEN 'Sent a video'
      WHEN 'document' THEN 'Sent a document'
      WHEN 'sticker' THEN 'Sent a sticker'
      WHEN 'location' THEN 'Shared a location'
      WHEN 'contacts' THEN 'Shared a contact'
    END;
    IF v_caption IS NOT NULL THEN
      v_body := v_body || ': ' || v_caption;
    END IF;
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

  -- A seller-confirmed buyer link (app.link_whatsapp_thread_buyer) wins over
  -- phone matching and persists for this sender across threads. Without it,
  -- a linked buyer whose phone differs from the sender would be replaced by a
  -- fresh "Customer ..." placeholder on the very next message.
  SELECT t.buyer_id
  INTO v_manual_buyer_id
  FROM app.whatsapp_threads t
  JOIN app.buyers lb
    ON lb.id = t.buyer_id
   AND lb.tenant_id = t.tenant_id
   AND lb.deleted_at IS NULL
   AND lb.is_active = true
  WHERE t.tenant_id = v_tenant_id
    AND t.sender_phone = v_sender_phone
    AND t.deleted_at IS NULL
    AND t.metadata->>'manual_buyer_link' = 'true'
  ORDER BY t.updated_at DESC
  LIMIT 1;

  IF v_manual_buyer_id IS NOT NULL THEN
    v_buyer_id := v_manual_buyer_id;
    v_resolution_status := 'matched';
    v_contact_kind := 'seller_linked';
    v_contact_role := NULL;
    v_ambiguity := '{}'::jsonb;
  ELSE
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
    jsonb_build_object('last_provider_message_id', p_provider_message_id)
      || CASE WHEN v_manual_buyer_id IS NOT NULL THEN jsonb_build_object('manual_buyer_link', true) ELSE '{}'::jsonb END,
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
    left(v_body, 4000),
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
    'message_type', sub.message_type,
    'created_at', sub.created_at,
    'provider_message_id', sub.provider_message_id
  ) ORDER BY sub.created_at), '[]'::jsonb)
  INTO v_recent_messages
  FROM (
    SELECT id, direction, text_body, message_type, created_at, provider_message_id
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
      'last_inbound_text', left(v_body, 500),
      'last_inbound_type', COALESCE(p_message_type, 'text'),
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

CREATE OR REPLACE FUNCTION app.link_whatsapp_thread_buyer(
  p_tenant_id uuid,
  p_entry_id uuid,
  p_actor_user_id uuid,
  p_buyer_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_entry app.entries%ROWTYPE;
  v_thread app.whatsapp_threads%ROWTYPE;
  v_buyer_ok boolean;
  v_prev_buyer_id uuid;
  v_prev_is_placeholder boolean := false;
  v_placeholder_removed boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.tenant_users tu
    WHERE tu.tenant_id = p_tenant_id
      AND tu.user_id = p_actor_user_id
      AND tu.role IN ('seller_admin', 'seller_assistant')
      AND COALESCE(tu.is_active, true)
      AND tu.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'actor_not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_entry
  FROM app.entries
  WHERE id = p_entry_id
    AND tenant_id = p_tenant_id
    AND entry_type = 'whatsapp_buyer_message'
    AND source_entity_type = 'whatsapp_thread'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'entry_not_found' USING ERRCODE = '02000';
  END IF;

  SELECT * INTO v_thread
  FROM app.whatsapp_threads
  WHERE id = v_entry.source_entity_id
    AND tenant_id = p_tenant_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF v_thread.id IS NULL THEN
    RAISE EXCEPTION 'thread_not_found' USING ERRCODE = '02000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM app.buyers b
    WHERE b.id = p_buyer_id
      AND b.tenant_id = p_tenant_id
      AND b.deleted_at IS NULL
      AND b.is_active = true
  ) INTO v_buyer_ok;
  IF NOT v_buyer_ok THEN
    RAISE EXCEPTION 'buyer_not_found' USING ERRCODE = '02000';
  END IF;

  IF v_thread.buyer_id = p_buyer_id AND v_thread.metadata->>'manual_buyer_link' = 'true' THEN
    RETURN jsonb_build_object(
      'thread_id', v_thread.id,
      'buyer_id', p_buyer_id,
      'previous_buyer_id', p_buyer_id,
      'placeholder_removed', false,
      'unchanged', true
    );
  END IF;

  v_prev_buyer_id := v_thread.buyer_id;
  IF v_prev_buyer_id IS NOT NULL AND v_prev_buyer_id <> p_buyer_id THEN
    SELECT COALESCE(b.custom_fields->>'whatsapp_unknown_sender' = 'true', false)
           AND COALESCE(b.buyer_app_enabled, false) = false
    INTO v_prev_is_placeholder
    FROM app.buyers b
    WHERE b.id = v_prev_buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL;
  END IF;

  UPDATE app.whatsapp_threads
  SET buyer_id = p_buyer_id,
      resolution_status = 'matched',
      buyer_contact_kind = 'seller_linked',
      buyer_contact_role = NULL,
      ambiguity_metadata = '{}'::jsonb,
      metadata = metadata || jsonb_build_object(
        'manual_buyer_link', true,
        'linked_by', p_actor_user_id,
        'linked_at', now()
      ),
      updated_by = p_actor_user_id
  WHERE id = v_thread.id;

  UPDATE app.entries
  SET buyer_id = p_buyer_id,
      metadata = metadata || jsonb_build_object(
        'resolution_status', 'matched',
        'buyer_contact_kind', 'seller_linked',
        'buyer_contact_role', NULL,
        'ambiguity', '{}'::jsonb
      ),
      last_actor_id = p_actor_user_id,
      last_action = 'link_whatsapp_buyer',
      last_action_at = now(),
      version = version + 1,
      updated_by = p_actor_user_id
  WHERE id = v_entry.id;

  IF v_prev_is_placeholder
     AND NOT EXISTS (
       SELECT 1 FROM app.whatsapp_threads t
       WHERE t.tenant_id = p_tenant_id AND t.buyer_id = v_prev_buyer_id
         AND t.id <> v_thread.id AND t.deleted_at IS NULL
     )
     AND NOT EXISTS (SELECT 1 FROM app.orders o WHERE o.tenant_id = p_tenant_id AND o.buyer_id = v_prev_buyer_id AND o.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM app.estimates s WHERE s.tenant_id = p_tenant_id AND s.buyer_id = v_prev_buyer_id AND s.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.buyer_id = v_prev_buyer_id AND i.deleted_at IS NULL)
  THEN
    UPDATE app.buyers
    SET deleted_at = now(),
        is_active = false,
        updated_by = p_actor_user_id
    WHERE id = v_prev_buyer_id AND tenant_id = p_tenant_id;
    v_placeholder_removed := true;
  END IF;

  INSERT INTO app.entry_events (
    tenant_id, entry_id, actor_user_id, action, from_status, to_status, metadata, created_by, updated_by
  )
  VALUES (
    p_tenant_id,
    v_entry.id,
    p_actor_user_id,
    'link_whatsapp_buyer',
    v_entry.status,
    v_entry.status,
    jsonb_build_object(
      'thread_id', v_thread.id,
      'buyer_id', p_buyer_id,
      'previous_buyer_id', v_prev_buyer_id,
      'previous_resolution_status', v_thread.resolution_status,
      'placeholder_removed', v_placeholder_removed
    ),
    p_actor_user_id,
    p_actor_user_id
  );

  RETURN jsonb_build_object(
    'thread_id', v_thread.id,
    'buyer_id', p_buyer_id,
    'previous_buyer_id', v_prev_buyer_id,
    'placeholder_removed', v_placeholder_removed,
    'unchanged', false
  );
END;
$$;

REVOKE ALL ON FUNCTION app.link_whatsapp_thread_buyer(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.link_whatsapp_thread_buyer(uuid, uuid, uuid, uuid) TO service_role;
