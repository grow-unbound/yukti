-- WhatsApp inbox P0 G7: reply audit table.
--
-- The scope doc requires every send to record actor, the draft before edit,
-- the final sent text, channel and provider id. app.whatsapp_reply_drafts holds
-- the seller-authored part (draft / final text / generation mode / the inbound
-- messages replied to); delivery state and provider id stay on the send ledger
-- (app.whatsapp_messages) and are reached through whatsapp_message_id, so there
-- is exactly one source of truth for delivery.
--
-- P0 replies are manual: draft_text is NULL and generation_mode='manual'. The
-- intent / template / model / token columns are the contract P1 (deterministic
-- templates) and P2 (LLM drafts) will fill, so those phases need no new
-- migration. record_whatsapp_thread_outbound_reply keeps its signature and now
-- also writes the audit row in the same transaction.

CREATE TABLE IF NOT EXISTS app.whatsapp_reply_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  entry_id uuid NOT NULL REFERENCES app.entries(id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL REFERENCES app.whatsapp_threads(id) ON DELETE RESTRICT,
  buyer_id uuid REFERENCES app.buyers(id) ON DELETE RESTRICT,
  thread_message_id uuid REFERENCES app.whatsapp_thread_messages(id) ON DELETE RESTRICT,
  whatsapp_message_id uuid REFERENCES app.whatsapp_messages(id) ON DELETE RESTRICT,
  generation_mode text NOT NULL DEFAULT 'manual',
  intent text,
  template_id text,
  template_version text,
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  draft_text text,
  final_text text NOT NULL,
  source_thread_message_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  CONSTRAINT whatsapp_reply_drafts_mode_check
    CHECK (generation_mode = ANY (ARRAY['manual', 'deterministic_template', 'llm'])),
  CONSTRAINT whatsapp_reply_drafts_tokens_check
    CHECK ((input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_reply_drafts_whatsapp_message_uk
  ON app.whatsapp_reply_drafts (whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS whatsapp_reply_drafts_entry_created_idx
  ON app.whatsapp_reply_drafts (tenant_id, entry_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS whatsapp_reply_drafts_thread_message_idx
  ON app.whatsapp_reply_drafts (thread_message_id)
  WHERE thread_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_reply_drafts_buyer_idx
  ON app.whatsapp_reply_drafts (buyer_id)
  WHERE buyer_id IS NOT NULL;

DROP TRIGGER IF EXISTS whatsapp_reply_drafts_updated_at ON app.whatsapp_reply_drafts;
CREATE TRIGGER whatsapp_reply_drafts_updated_at
  BEFORE UPDATE ON app.whatsapp_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.whatsapp_reply_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "seller members can read whatsapp reply drafts" ON app.whatsapp_reply_drafts;
CREATE POLICY "seller members can read whatsapp reply drafts"
  ON app.whatsapp_reply_drafts FOR SELECT
  TO authenticated
  USING (
    tenant_id = (select app.jwt_tenant_id())
    AND (select app.is_seller())
    AND deleted_at IS NULL
  );

REVOKE ALL ON TABLE app.whatsapp_reply_drafts FROM anon, authenticated;
GRANT SELECT ON TABLE app.whatsapp_reply_drafts TO authenticated;
GRANT ALL ON TABLE app.whatsapp_reply_drafts TO service_role;

CREATE OR REPLACE FUNCTION app.record_whatsapp_thread_outbound_reply(
  p_tenant_id uuid,
  p_entry_id uuid,
  p_actor_user_id uuid,
  p_reply_text text,
  p_whatsapp_message_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_entry app.entries%ROWTYPE;
  v_thread app.whatsapp_threads%ROWTYPE;
  v_message_id uuid;
BEGIN
  IF NULLIF(trim(COALESCE(p_reply_text, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reply_text_required' USING ERRCODE = '22023';
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

  INSERT INTO app.whatsapp_thread_messages (
    tenant_id,
    thread_id,
    direction,
    whatsapp_message_id,
    sender_phone,
    recipient_phone,
    message_type,
    text_body,
    sent_by_user_id,
    sent_at,
    processing_status,
    created_by,
    updated_by
  )
  VALUES (
    p_tenant_id,
    v_thread.id,
    'outbound',
    p_whatsapp_message_id,
    v_thread.recipient_phone_number_id,
    v_thread.sender_phone,
    'text',
    left(p_reply_text, 4000),
    p_actor_user_id,
    now(),
    'processed',
    p_actor_user_id,
    p_actor_user_id
  )
  ON CONFLICT (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL AND deleted_at IS NULL
  DO UPDATE SET updated_at = now()
  RETURNING id INTO v_message_id;

  -- Audit: what was actually sent, by whom, in reply to which inbound
  -- messages. Delivery state is NOT copied here; it stays on the send ledger
  -- (whatsapp_message_id) so the two cannot drift.
  INSERT INTO app.whatsapp_reply_drafts (
    tenant_id,
    entry_id,
    thread_id,
    buyer_id,
    thread_message_id,
    whatsapp_message_id,
    generation_mode,
    final_text,
    source_thread_message_ids,
    created_by,
    updated_by
  )
  VALUES (
    p_tenant_id,
    p_entry_id,
    v_thread.id,
    v_thread.buyer_id,
    v_message_id,
    p_whatsapp_message_id,
    'manual',
    left(p_reply_text, 4000),
    COALESCE((
      SELECT array_agg(m.id ORDER BY m.created_at DESC)
      FROM (
        SELECT id, created_at
        FROM app.whatsapp_thread_messages
        WHERE thread_id = v_thread.id
          AND direction = 'inbound'
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 5
      ) m
    ), ARRAY[]::uuid[]),
    p_actor_user_id,
    p_actor_user_id
  )
  ON CONFLICT (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL AND deleted_at IS NULL
  DO NOTHING;

  UPDATE app.whatsapp_threads
  SET last_outbound_message_at = now(),
      updated_by = p_actor_user_id
  WHERE id = v_thread.id;

  UPDATE app.entries
  SET status = 'in_progress',
      last_actor_id = p_actor_user_id,
      last_action = 'reply_whatsapp',
      last_action_at = now(),
      metadata = metadata || jsonb_build_object(
        'last_outbound_at', now(),
        'last_outbound_preview', left(p_reply_text, 160)
      ),
      updated_by = p_actor_user_id
  WHERE id = p_entry_id;

  INSERT INTO app.entry_events (
    tenant_id,
    entry_id,
    actor_user_id,
    action,
    from_status,
    to_status,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    p_tenant_id,
    p_entry_id,
    p_actor_user_id,
    'reply_whatsapp',
    v_entry.status,
    'in_progress',
    jsonb_build_object('thread_id', v_thread.id, 'thread_message_id', v_message_id, 'whatsapp_message_id', p_whatsapp_message_id),
    p_actor_user_id,
    p_actor_user_id
  );

  RETURN jsonb_build_object('thread_id', v_thread.id, 'thread_message_id', v_message_id);
END;
$$;
