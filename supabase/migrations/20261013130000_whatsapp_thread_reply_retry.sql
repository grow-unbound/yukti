-- WhatsApp inbox P0 G1: retry a failed seller reply without duplicating the
-- send ledger. app.whatsapp_messages / whatsapp_send_queue are audit + credit
-- records ("one row per logical message"), so a retry re-queues the SAME failed
-- ledger row in place (same pattern as enqueue_whatsapp_message's failed-row
-- branch) instead of creating a new message. The thread message keeps pointing
-- at that ledger row, so delivery state is always read from the ledger and the
-- thread view cannot drift from billing/status.
--
-- Only 'failed' is retryable. 'opted_out' and 'blocked_by_recipient' are
-- terminal by policy. The service window and buyer opt-out are re-checked here,
-- not only in the API route, because this function is the source of truth.

CREATE OR REPLACE FUNCTION app.retry_whatsapp_thread_reply(
  p_tenant_id uuid,
  p_entry_id uuid,
  p_thread_message_id uuid,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_entry app.entries%ROWTYPE;
  v_thread app.whatsapp_threads%ROWTYPE;
  v_tm app.whatsapp_thread_messages%ROWTYPE;
  v_msg app.whatsapp_messages%ROWTYPE;
  v_opted_out timestamptz;
  v_queue_id uuid;
BEGIN
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

  SELECT * INTO v_tm
  FROM app.whatsapp_thread_messages
  WHERE id = p_thread_message_id
    AND tenant_id = p_tenant_id
    AND thread_id = v_thread.id
    AND direction = 'outbound'
    AND deleted_at IS NULL;
  IF v_tm.id IS NULL OR v_tm.whatsapp_message_id IS NULL THEN
    RAISE EXCEPTION 'reply_not_found' USING ERRCODE = '02000';
  END IF;

  SELECT * INTO v_msg
  FROM app.whatsapp_messages
  WHERE id = v_tm.whatsapp_message_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;
  IF v_msg.id IS NULL THEN
    RAISE EXCEPTION 'reply_not_found' USING ERRCODE = '02000';
  END IF;

  IF v_msg.status <> 'failed' THEN
    RAISE EXCEPTION 'reply_not_retryable' USING ERRCODE = '22023';
  END IF;

  IF v_thread.service_window_expires_at IS NULL OR v_thread.service_window_expires_at <= now() THEN
    RAISE EXCEPTION 'service_window_expired' USING ERRCODE = '22023';
  END IF;

  IF v_thread.buyer_id IS NOT NULL THEN
    SELECT whatsapp_opt_out_at INTO v_opted_out
    FROM app.buyers
    WHERE id = v_thread.buyer_id AND tenant_id = p_tenant_id AND deleted_at IS NULL;
    IF v_opted_out IS NOT NULL THEN
      RAISE EXCEPTION 'buyer_opted_out' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE app.whatsapp_messages
  SET status = 'queued',
      failure_reason = NULL,
      provider_message_id = NULL,
      sent_at = NULL,
      updated_at = now()
  WHERE id = v_msg.id;

  SELECT id INTO v_queue_id
  FROM app.whatsapp_send_queue
  WHERE whatsapp_message_id = v_msg.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_queue_id IS NOT NULL THEN
    UPDATE app.whatsapp_send_queue
    SET status = 'pending',
        priority = 1,
        scheduled_send_at = now(),
        failure_reason = NULL,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        updated_at = now()
    WHERE id = v_queue_id;
  ELSE
    INSERT INTO app.whatsapp_send_queue (tenant_id, whatsapp_message_id, priority, scheduled_send_at)
    VALUES (p_tenant_id, v_msg.id, 1, now());
  END IF;

  INSERT INTO app.entry_events (
    tenant_id, entry_id, actor_user_id, action, from_status, to_status, metadata, created_by, updated_by
  )
  VALUES (
    p_tenant_id,
    p_entry_id,
    p_actor_user_id,
    'retry_whatsapp_reply',
    v_entry.status,
    v_entry.status,
    jsonb_build_object(
      'thread_id', v_thread.id,
      'thread_message_id', v_tm.id,
      'whatsapp_message_id', v_msg.id
    ),
    p_actor_user_id,
    p_actor_user_id
  );

  RETURN jsonb_build_object('message_id', v_msg.id, 'thread_message_id', v_tm.id);
END;
$$;

REVOKE ALL ON FUNCTION app.retry_whatsapp_thread_reply(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.retry_whatsapp_thread_reply(uuid, uuid, uuid, uuid) TO service_role;
