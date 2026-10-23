-- Email inbox P1 hardening (review findings on 20261023112240):
--   * reply-header threading requires the same sender (a Message-ID is visible to
--     every recipient, so it cannot be used to inject mail into someone's thread)
--   * thread_key is sender scoped
--   * a seller link / manual link matched on an unauthenticated From is capped at
--     'medium' confidence; 'high' needs aligned DKIM or DMARC
--   * per-tenant hourly cap (500) on top of the per-sender daily cap
-- Full body of app.process_email_inbound_message re-declared; everything not
-- listed above is unchanged.

CREATE OR REPLACE FUNCTION app.process_email_inbound_message(
  p_alias_token_hash text,
  p_payload jsonb,
  p_feature_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_free_domains constant text[] := ARRAY[
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.in','yahoo.in','ymail.com','outlook.com',
    'hotmail.com','live.com','msn.com','rediffmail.com','rediff.com','icloud.com','me.com',
    'aol.com','proton.me','protonmail.com','zoho.com','zohomail.in','gmx.com','mail.com'
  ];
  v_tenant_id uuid;
  v_received_at timestamptz := COALESCE(NULLIF(p_payload->>'received_at', '')::timestamptz, now());
  v_from text := lower(trim(COALESCE(p_payload->>'from_address', '')));
  v_original_from text := lower(trim(COALESCE(p_payload->>'original_from_address', '')));
  v_sender text;
  v_sender_source text;
  v_sender_domain text;
  v_rfc_id text := NULLIF(trim(COALESCE(p_payload->>'rfc_message_id', '')), '');
  v_in_reply_to text := NULLIF(trim(COALESCE(p_payload->>'in_reply_to', '')), '');
  v_refs text[] := COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'references', '[]'::jsonb))), '{}'::text[]);
  v_ref_ids text[];
  v_subject text := left(COALESCE(p_payload->>'subject', ''), 500);
  v_subject_norm text;
  v_body text := left(COALESCE(p_payload->>'text_body', ''), 20000);
  v_snippet text;
  v_kind text := COALESCE(NULLIF(p_payload->>'message_kind', ''), 'message');
  v_filter_reason text := NULLIF(p_payload->>'filter_reason', '');
  v_auth jsonb := COALESCE(p_payload->'auth', '{}'::jsonb);
  v_auth_pass boolean;
  v_dedupe_key text;
  v_gstins text[] := COALESCE(ARRAY(SELECT upper(jsonb_array_elements_text(COALESCE(p_payload->'gstins', '[]'::jsonb)))), '{}'::text[]);
  v_rule record;
  v_buyer_id uuid;
  v_resolution text := 'unknown';
  v_method text;
  v_confidence text;
  v_ambiguity jsonb := '{}'::jsonb;
  v_count integer;
  v_cands jsonb;
  v_thread_id uuid;
  v_thread_key text;
  v_thread app.email_threads%ROWTYPE;
  v_entry_status text;
  v_entry_at timestamptz;
  v_message_id uuid;
  v_entry_id uuid;
  v_prev_status text;
  v_bundle jsonb;
  v_att jsonb;
  v_att_count integer := 0;
  v_sender_recent integer;
  v_tenant_recent integer;
BEGIN
  IF COALESCE(p_feature_enabled, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'feature_disabled');
  END IF;
  IF NULLIF(trim(COALESCE(p_alias_token_hash, '')), '') IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'missing_alias_token');
  END IF;
  IF position('@' IN v_from) < 2 THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'missing_sender');
  END IF;

  SELECT ti.tenant_id INTO v_tenant_id
  FROM app.tenant_integrations ti
  WHERE ti.integration_type_id = 'email_forwarding'
    AND ti.status = 'connected'
    AND ti.deleted_at IS NULL
    AND ti.config->>'alias_token_hash' = p_alias_token_hash
  LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'tenant_not_resolved');
  END IF;

  -- Idempotency. Message-ID alone can be forged or repeated across senders, so
  -- key on (Message-ID, From). Missing Message-ID falls back to a content hash.
  IF v_rfc_id IS NULL THEN
    v_rfc_id := 'noid:' || md5(concat_ws('|', v_from, v_subject, v_received_at::text, left(v_body, 500)));
  END IF;
  v_dedupe_key := lower(v_rfc_id) || '|' || v_from;
  SELECT m.id INTO v_message_id
  FROM app.email_messages m
  WHERE m.tenant_id = v_tenant_id AND m.dedupe_key = v_dedupe_key AND m.deleted_at IS NULL
  LIMIT 1;
  IF v_message_id IS NOT NULL THEN
    RETURN jsonb_build_object('processed', true, 'duplicate', true, 'message_id', v_message_id);
  END IF;

  -- Per-sender daily cap: an open MX is a spam target.
  SELECT count(*) INTO v_sender_recent
  FROM app.email_messages m
  WHERE m.tenant_id = v_tenant_id AND m.from_address = v_from
    AND m.received_at > v_received_at - interval '24 hours' AND m.deleted_at IS NULL;
  IF v_sender_recent >= 100 THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'sender_rate_limited', 'tenant_id', v_tenant_id);
  END IF;
  -- From is forgeable, so also cap the tenant as a whole.
  SELECT count(*) INTO v_tenant_recent
  FROM app.email_messages m
  WHERE m.tenant_id = v_tenant_id AND m.received_at > v_received_at - interval '1 hour' AND m.deleted_at IS NULL;
  IF v_tenant_recent >= 500 THEN
    RETURN jsonb_build_object('processed', false, 'skipped', 'tenant_rate_limited', 'tenant_id', v_tenant_id);
  END IF;

  -- Effective sender: a parsed forward wrapper lowers confidence but is the
  -- only way to find the real buyer when staff forward by hand.
  IF position('@' IN v_original_from) > 1 THEN
    v_sender := v_original_from;
    v_sender_source := 'parsed_forward';
  ELSE
    v_sender := v_from;
    v_sender_source := 'header';
  END IF;
  v_sender_domain := split_part(v_sender, '@', 2);

  v_subject_norm := lower(trim(regexp_replace(v_subject, '^\s*((re|fwd?|fw|aw|sv)\s*(\[\d+\])?\s*:\s*)+', '', 'i')));
  v_snippet := left(regexp_replace(trim(v_body), '\s+', ' ', 'g'), 300);
  -- The normalizer only reports dkim='pass' when the signing domain aligns
  -- with the From domain. A parsed forward wrapper proves nothing about the
  -- original sender, so it is never "verified".
  v_auth_pass := v_sender_source = 'header'
    AND (lower(COALESCE(v_auth->>'dkim', '')) = 'pass' OR lower(COALESCE(v_auth->>'dmarc', '')) = 'pass');

  -- Sender rules (tenant scoped).
  SELECT r.rule, r.buyer_id INTO v_rule
  FROM app.email_sender_rules r
  WHERE r.tenant_id = v_tenant_id AND r.address = v_sender AND r.deleted_at IS NULL
  LIMIT 1;
  IF v_rule.rule IN ('supplier', 'ignore') AND v_filter_reason IS NULL AND v_kind = 'message' THEN
    v_filter_reason := 'sender_rule_' || v_rule.rule;
  END IF;

  -- Stored-but-not-surfaced mail: bounces, bulk, auto-replies, supplier/ignore
  -- rules, and Gmail forwarding-verification mail (kept so setup can read it).
  IF v_filter_reason IS NOT NULL OR v_kind = 'setup_verification' THEN
    INSERT INTO app.email_messages (
      tenant_id, thread_id, rfc_message_id, dedupe_key, in_reply_to, reference_ids,
      from_address, from_name, to_addresses, subject, text_body, snippet, raw_r2_key, html_r2_key,
      received_at, auth_spf, auth_dkim, auth_dmarc, message_kind, processing_status, filter_reason,
      headers, external_ref
    ) VALUES (
      v_tenant_id, NULL, v_rfc_id, v_dedupe_key, v_in_reply_to, v_refs,
      v_from, left(p_payload->>'from_name', 200),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'to_addresses', '[]'::jsonb))), '{}'::text[]),
      v_subject, v_body, v_snippet, p_payload->>'raw_r2_key', p_payload->>'html_r2_key',
      v_received_at, v_auth->>'spf', v_auth->>'dkim', v_auth->>'dmarc', v_kind,
      CASE WHEN v_filter_reason IS NULL THEN 'processed' ELSE 'filtered' END, v_filter_reason,
      COALESCE(p_payload->'headers', '{}'::jsonb), 'email_inbound:' || v_dedupe_key
    )
    ON CONFLICT (tenant_id, dedupe_key) WHERE deleted_at IS NULL DO NOTHING
    RETURNING id INTO v_message_id;
    RETURN jsonb_build_object(
      'processed', true, 'duplicate', v_message_id IS NULL, 'filtered', v_filter_reason IS NOT NULL,
      'filter_reason', v_filter_reason, 'message_kind', v_kind, 'message_id', v_message_id, 'tenant_id', v_tenant_id
    );
  END IF;

  -- Buyer ladder: stop at the first confident hit.
  IF v_rule.rule = 'buyer_link' AND v_sender_source = 'header' AND EXISTS (
    SELECT 1 FROM app.buyers b WHERE b.id = v_rule.buyer_id AND b.tenant_id = v_tenant_id AND b.deleted_at IS NULL AND b.is_active = true
  ) THEN
    v_buyer_id := v_rule.buyer_id;
    v_resolution := 'matched'; v_method := 'seller_link';
    v_confidence := CASE WHEN v_auth_pass THEN 'high' ELSE 'medium' END;
  END IF;

  IF v_buyer_id IS NULL THEN
    WITH c AS (
      SELECT b.id, b.business_name
      FROM app.buyers b
      WHERE b.tenant_id = v_tenant_id AND b.deleted_at IS NULL AND b.is_active = true
        AND lower(b.email) = v_sender
      UNION
      SELECT b.id, b.business_name
      FROM app.buyer_users u
      JOIN app.buyers b ON b.id = u.buyer_id
      WHERE b.tenant_id = v_tenant_id AND b.deleted_at IS NULL AND b.is_active = true
        AND u.deleted_at IS NULL AND lower(u.email) = v_sender
    )
    SELECT count(*), (array_agg(id))[1],
           COALESCE(jsonb_agg(jsonb_build_object('buyer_id', id, 'business_name', business_name)), '[]'::jsonb)
    INTO v_count, v_buyer_id, v_cands FROM c;
    IF v_count = 1 THEN
      v_resolution := 'matched'; v_method := 'exact_email';
      v_confidence := CASE WHEN v_auth_pass THEN 'high' ELSE 'low' END;
    ELSIF v_count > 1 THEN
      v_buyer_id := NULL; v_resolution := 'ambiguous'; v_method := 'exact_email';
      v_ambiguity := jsonb_build_object('candidate_count', v_count, 'candidates', v_cands);
    ELSE
      v_buyer_id := NULL;
    END IF;
  END IF;

  IF v_buyer_id IS NULL AND v_resolution = 'unknown' AND cardinality(v_gstins) > 0 THEN
    WITH c AS (
      SELECT b.id, b.business_name FROM app.buyers b
      WHERE b.tenant_id = v_tenant_id AND b.deleted_at IS NULL AND b.is_active = true
        AND upper(b.gstin) = ANY (v_gstins)
    )
    SELECT count(*), (array_agg(id))[1],
           COALESCE(jsonb_agg(jsonb_build_object('buyer_id', id, 'business_name', business_name)), '[]'::jsonb)
    INTO v_count, v_buyer_id, v_cands FROM c;
    IF v_count = 1 THEN
      v_resolution := 'matched'; v_method := 'gstin'; v_confidence := 'medium';
    ELSIF v_count > 1 THEN
      v_buyer_id := NULL; v_resolution := 'ambiguous'; v_method := 'gstin';
      v_ambiguity := jsonb_build_object('candidate_count', v_count, 'candidates', v_cands);
    ELSE
      v_buyer_id := NULL;
    END IF;
  END IF;

  -- Domain match only ever suggests (ambiguous); never auto-matches.
  IF v_resolution = 'unknown' AND v_sender_domain <> '' AND NOT (v_sender_domain = ANY (v_free_domains)) THEN
    WITH c AS (
      SELECT b.id, b.business_name FROM app.buyers b
      WHERE b.tenant_id = v_tenant_id AND b.deleted_at IS NULL AND b.is_active = true
        AND split_part(lower(b.email), '@', 2) = v_sender_domain
      UNION
      SELECT b.id, b.business_name
      FROM app.buyer_users u JOIN app.buyers b ON b.id = u.buyer_id
      WHERE b.tenant_id = v_tenant_id AND b.deleted_at IS NULL AND b.is_active = true AND u.deleted_at IS NULL
        AND split_part(lower(u.email), '@', 2) = v_sender_domain
    )
    SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('buyer_id', id, 'business_name', business_name)), '[]'::jsonb)
    INTO v_count, v_cands FROM c;
    IF v_count > 0 THEN
      v_resolution := 'ambiguous'; v_method := 'domain';
      v_ambiguity := jsonb_build_object('candidate_count', v_count, 'candidates', v_cands, 'suggested_by', 'domain');
    END IF;
  END IF;

  -- Thread lookup: reply headers first, then a bounded subject fallback.
  v_ref_ids := v_refs;
  IF v_in_reply_to IS NOT NULL THEN v_ref_ids := v_ref_ids || v_in_reply_to; END IF;
  IF cardinality(v_ref_ids) > 0 THEN
    SELECT t.id INTO v_thread_id
    FROM app.email_threads t
    JOIN app.email_messages m ON m.thread_id = t.id AND m.tenant_id = t.tenant_id AND m.deleted_at IS NULL
    WHERE t.tenant_id = v_tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
      AND t.sender_address = v_sender
      AND m.rfc_message_id = ANY (v_ref_ids)
    ORDER BY t.last_inbound_at DESC NULLS LAST
    LIMIT 1;
  END IF;
  IF v_thread_id IS NULL AND v_subject_norm <> '' THEN
    SELECT t.id INTO v_thread_id
    FROM app.email_threads t
    WHERE t.tenant_id = v_tenant_id AND t.status = 'active' AND t.deleted_at IS NULL
      AND t.sender_address = v_sender AND t.subject_normalized = v_subject_norm
      AND t.last_inbound_at > v_received_at - interval '7 days'
    ORDER BY t.last_inbound_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  -- Quiet threshold (same rule as WhatsApp): a resolved entry older than 24h
  -- closes its thread so this message opens a fresh one.
  IF v_thread_id IS NOT NULL THEN
    SELECT t.* INTO v_thread FROM app.email_threads t WHERE t.id = v_thread_id FOR UPDATE;
    SELECT e.status, COALESCE(e.resolved_at, e.last_action_at, e.updated_at)
    INTO v_entry_status, v_entry_at
    FROM app.entries e
    WHERE e.tenant_id = v_tenant_id
      AND e.dedupe_key = concat_ws(':', v_tenant_id::text, 'email_buyer_message', 'email_thread', v_thread_id::text)
      AND e.deleted_at IS NULL;
    IF v_entry_status = 'resolved' AND v_entry_at < v_received_at - interval '24 hours' THEN
      UPDATE app.email_threads SET status = 'closed' WHERE id = v_thread_id;
      v_thread_id := NULL;
    ELSIF v_thread.metadata->>'manual_buyer_link' = 'true' THEN
      -- Seller already linked this thread: never let a later automatic result override it.
      v_buyer_id := v_thread.buyer_id; v_resolution := 'matched'; v_method := 'seller_link';
      v_confidence := CASE WHEN v_auth_pass THEN 'high' ELSE 'medium' END; v_ambiguity := '{}'::jsonb;
    END IF;
  END IF;

  v_thread_key := v_sender || '|' || COALESCE(v_refs[1], v_in_reply_to, v_rfc_id);

  IF v_thread_id IS NULL THEN
    INSERT INTO app.email_threads (
      tenant_id, buyer_id, thread_key, subject_normalized, sender_address, sender_source,
      status, resolution_status, match_method, match_confidence, ambiguity_metadata,
      last_inbound_at, metadata, external_ref
    ) VALUES (
      v_tenant_id, v_buyer_id, v_thread_key, v_subject_norm, v_sender, v_sender_source,
      'active', v_resolution, v_method, v_confidence, v_ambiguity,
      v_received_at, jsonb_build_object('auth_pass', v_auth_pass),
      'email_thread:' || v_tenant_id::text || ':' || v_thread_key
    )
    ON CONFLICT (tenant_id, thread_key) WHERE deleted_at IS NULL AND status = 'active'
    DO UPDATE SET last_inbound_at = GREATEST(app.email_threads.last_inbound_at, EXCLUDED.last_inbound_at)
    RETURNING id INTO v_thread_id;
  ELSE
    UPDATE app.email_threads
    SET buyer_id = v_buyer_id,
        resolution_status = v_resolution,
        match_method = v_method,
        match_confidence = v_confidence,
        ambiguity_metadata = v_ambiguity,
        last_inbound_at = GREATEST(last_inbound_at, v_received_at),
        metadata = metadata || jsonb_build_object('auth_pass', v_auth_pass)
    WHERE id = v_thread_id;
  END IF;

  INSERT INTO app.email_messages (
    tenant_id, thread_id, rfc_message_id, dedupe_key, in_reply_to, reference_ids,
    from_address, from_name, to_addresses, subject, text_body, snippet, raw_r2_key, html_r2_key,
    received_at, auth_spf, auth_dkim, auth_dmarc, message_kind, processing_status, headers, external_ref
  ) VALUES (
    v_tenant_id, v_thread_id, v_rfc_id, v_dedupe_key, v_in_reply_to, v_refs,
    v_from, left(p_payload->>'from_name', 200),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'to_addresses', '[]'::jsonb))), '{}'::text[]),
    v_subject, v_body, v_snippet, p_payload->>'raw_r2_key', p_payload->>'html_r2_key',
    v_received_at, v_auth->>'spf', v_auth->>'dkim', v_auth->>'dmarc', 'message', 'processed',
    COALESCE(p_payload->'headers', '{}'::jsonb), 'email_inbound:' || v_dedupe_key
  )
  ON CONFLICT (tenant_id, dedupe_key) WHERE deleted_at IS NULL DO NOTHING
  RETURNING id INTO v_message_id;
  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('processed', true, 'duplicate', true, 'thread_id', v_thread_id);
  END IF;

  FOR v_att IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'attachments', '[]'::jsonb)) LIMIT 50 LOOP
    INSERT INTO app.email_attachments (tenant_id, message_id, filename, mime_type, size_bytes, sha256, r2_key, scan_status, external_ref)
    VALUES (
      v_tenant_id, v_message_id,
      left(COALESCE(NULLIF(v_att->>'filename', ''), 'attachment'), 255),
      left(v_att->>'mime_type', 120),
      NULLIF(v_att->>'size_bytes', '')::bigint,
      v_att->>'sha256',
      v_att->>'r2_key',
      CASE WHEN (v_att->>'blocked')::boolean IS TRUE THEN 'blocked' ELSE 'skipped' END,
      'email_attachment:' || v_message_id::text || ':' || v_att_count::text
    );
    v_att_count := v_att_count + 1;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'from_address', s.from_address, 'subject', s.subject, 'snippet', s.snippet, 'received_at', s.received_at
         ) ORDER BY s.received_at), '[]'::jsonb)
  INTO v_bundle
  FROM (
    SELECT id, from_address, subject, snippet, received_at
    FROM app.email_messages
    WHERE thread_id = v_thread_id AND deleted_at IS NULL
    ORDER BY received_at DESC
    LIMIT 10
  ) s;

  SELECT e.status INTO v_prev_status
  FROM app.entries e
  WHERE e.tenant_id = v_tenant_id
    AND e.dedupe_key = concat_ws(':', v_tenant_id::text, 'email_buyer_message', 'email_thread', v_thread_id::text)
    AND e.deleted_at IS NULL;

  SELECT t.buyer_id, t.resolution_status, t.match_method, t.match_confidence, t.ambiguity_metadata
  INTO v_buyer_id, v_resolution, v_method, v_confidence, v_ambiguity
  FROM app.email_threads t WHERE t.id = v_thread_id;

  v_entry_id := app.upsert_entry(
    v_tenant_id,
    'email_buyer_message',
    'email',
    'email_thread',
    v_thread_id,
    v_buyer_id,
    NULL,
    v_received_at,
    jsonb_build_object(
      'thread_id', v_thread_id,
      'sender_address', v_sender,
      'sender_name', left(p_payload->>'from_name', 200),
      'sender_source', v_sender_source,
      'subject', v_subject,
      'resolution_status', v_resolution,
      'match_method', v_method,
      'match_confidence', v_confidence,
      'auth_verified', v_auth_pass,
      'ambiguity', COALESCE(v_ambiguity, '{}'::jsonb),
      'last_inbound_text', left(v_snippet, 300),
      'last_inbound_at', v_received_at,
      'attachment_count', v_att_count,
      'message_bundle', v_bundle
    ),
    'not_required',
    NULL
  );

  IF v_entry_id IS NULL THEN
    RETURN jsonb_build_object(
      'processed', true, 'duplicate', false, 'skipped', 'entry_type_disabled',
      'tenant_id', v_tenant_id, 'thread_id', v_thread_id, 'message_id', v_message_id
    );
  END IF;

  UPDATE app.entries
  SET status = 'new', remind_at = NULL, resolution_reason = NULL, resolved_at = NULL, resolved_by = NULL,
      version = version + 1
  WHERE id = v_entry_id
    AND (status <> 'new' OR remind_at IS NOT NULL OR resolved_at IS NOT NULL OR resolution_reason IS NOT NULL);

  INSERT INTO app.entry_events (tenant_id, entry_id, action, from_status, to_status, metadata)
  VALUES (
    v_tenant_id, v_entry_id, 'email_inbound_received', v_prev_status, 'new',
    jsonb_build_object('thread_id', v_thread_id, 'email_message_id', v_message_id)
  );

  RETURN jsonb_build_object(
    'processed', true, 'duplicate', false,
    'tenant_id', v_tenant_id, 'thread_id', v_thread_id, 'message_id', v_message_id,
    'entry_id', v_entry_id, 'resolution_status', v_resolution, 'match_method', v_method
  );
END;
$$;

REVOKE ALL ON FUNCTION app.process_email_inbound_message(text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.process_email_inbound_message(text, jsonb, boolean) TO service_role;
