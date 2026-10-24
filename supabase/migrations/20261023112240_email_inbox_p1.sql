-- Email Inbox P1 (POC): inbound forwarded email as Today entries.
-- Spec: specs/Yukti_Email-Inbox_Spec_v1.md. Mirrors the WhatsApp inbox build
-- (20260928125155 / 20261013140000 / 20261013160000).
--
-- Deliberate departures from the spec (see plan review):
--   * Alias token is a bearer secret: only its sha256 is stored
--     (tenant_integrations.config->>'alias_token_hash').
--   * No placeholder buyers for unknown senders (WhatsApp creates them).
--   * Message bodies capped in Postgres (full raw .eml lives in R2).
--   * Filtered mail (bounce / bulk / auto-reply / sender rule) is stored but
--     never creates a thread or Today entry.
--   * Automatic matches never write a persistent sender link; only a
--     seller-confirmed link does (email_sender_rules.buyer_link).

-- ---------------------------------------------------------------------------
-- 1. Entry type / source entity plumbing
-- ---------------------------------------------------------------------------
ALTER TABLE app.entries
  DROP CONSTRAINT IF EXISTS entries_entry_type_check;
ALTER TABLE app.entries
  ADD CONSTRAINT entries_entry_type_check CHECK (
    entry_type = ANY (ARRAY[
      'business_approval',
      'new_user_login',
      'new_enquiry',
      'new_order_confirmation',
      'order_dispatch_needed',
      'invoice_due',
      'invoice_overdue',
      'credit_limit_breach',
      'whatsapp_buyer_message',
      'email_buyer_message'
    ])
  );

ALTER TABLE app.entries
  DROP CONSTRAINT IF EXISTS entries_source_entity_type_check;
ALTER TABLE app.entries
  ADD CONSTRAINT entries_source_entity_type_check CHECK (
    source_entity_type = ANY (ARRAY['buyer', 'estimate', 'order', 'invoice', 'whatsapp_thread', 'email_thread'])
  );

ALTER TABLE app.entry_type_settings
  DROP CONSTRAINT IF EXISTS entry_type_settings_entry_type_check;
ALTER TABLE app.entry_type_settings
  ADD CONSTRAINT entry_type_settings_entry_type_check CHECK (
    entry_type = ANY (ARRAY[
      'business_approval',
      'new_user_login',
      'new_enquiry',
      'new_order_confirmation',
      'order_dispatch_needed',
      'invoice_due',
      'invoice_overdue',
      'credit_limit_breach',
      'whatsapp_buyer_message',
      'email_buyer_message'
    ])
  );

-- ---------------------------------------------------------------------------
-- 2. Integration type: per-tenant forwarding address
-- ---------------------------------------------------------------------------
INSERT INTO catalog.integration_types (
  id, display_name, description, logo_url, auth_schema, capabilities, connectivity_mode, is_active
) VALUES (
  'email_forwarding',
  'Email (forwarding)',
  'Forward buyer email to your Yukti address and see it in Today next to the customer.',
  NULL,
  jsonb_build_object('oauth', false, 'fields', jsonb_build_array()),
  jsonb_build_object(
    'inbound_reference', jsonb_build_array(),
    'inbound_transactional', jsonb_build_array(),
    'outbound_transactional', jsonb_build_array(),
    'webhooks', false
  ),
  'cloud',
  true
)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  auth_schema = EXCLUDED.auth_schema,
  capabilities = EXCLUDED.capabilities,
  connectivity_mode = EXCLUDED.connectivity_mode,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- One live alias token hash maps to exactly one tenant integration.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_integrations_email_alias_hash_uk
  ON app.tenant_integrations ((config->>'alias_token_hash'))
  WHERE integration_type_id = 'email_forwarding'
    AND deleted_at IS NULL
    AND config->>'alias_token_hash' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.email_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  buyer_id uuid REFERENCES app.buyers(id) ON DELETE RESTRICT,
  thread_key text NOT NULL,
  subject_normalized text NOT NULL DEFAULT '',
  sender_address text NOT NULL,
  sender_source text NOT NULL DEFAULT 'header',
  status text NOT NULL DEFAULT 'active',
  resolution_status text NOT NULL DEFAULT 'unknown',
  match_method text,
  match_confidence text,
  ambiguity_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  CONSTRAINT email_threads_status_check CHECK (status = ANY (ARRAY['active', 'closed'])),
  CONSTRAINT email_threads_resolution_status_check CHECK (resolution_status = ANY (ARRAY['matched', 'unknown', 'ambiguous'])),
  CONSTRAINT email_threads_sender_source_check CHECK (sender_source = ANY (ARRAY['header', 'parsed_forward'])),
  CONSTRAINT email_threads_match_confidence_check CHECK (match_confidence IS NULL OR match_confidence = ANY (ARRAY['high', 'medium', 'low'])),
  CONSTRAINT email_threads_sender_address_check CHECK (sender_address = lower(sender_address) AND position('@' IN sender_address) > 1)
);

CREATE TABLE IF NOT EXISTS app.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  thread_id uuid REFERENCES app.email_threads(id) ON DELETE RESTRICT,
  direction text NOT NULL DEFAULT 'inbound',
  rfc_message_id text NOT NULL,
  dedupe_key text NOT NULL,
  in_reply_to text,
  reference_ids text[] NOT NULL DEFAULT '{}'::text[],
  from_address text NOT NULL,
  from_name text,
  to_addresses text[] NOT NULL DEFAULT '{}'::text[],
  subject text,
  text_body text,
  snippet text,
  raw_r2_key text,
  html_r2_key text,
  received_at timestamptz NOT NULL,
  auth_spf text,
  auth_dkim text,
  auth_dmarc text,
  message_kind text NOT NULL DEFAULT 'message',
  processing_status text NOT NULL DEFAULT 'processed',
  filter_reason text,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  CONSTRAINT email_messages_direction_check CHECK (direction = ANY (ARRAY['inbound', 'outbound'])),
  CONSTRAINT email_messages_kind_check CHECK (message_kind = ANY (ARRAY['message', 'setup_verification'])),
  CONSTRAINT email_messages_processing_status_check CHECK (processing_status = ANY (ARRAY['processed', 'filtered', 'failed'])),
  CONSTRAINT email_messages_text_body_cap CHECK (text_body IS NULL OR char_length(text_body) <= 20000),
  CONSTRAINT email_messages_filtered_reason_check CHECK (processing_status <> 'filtered' OR filter_reason IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS app.email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE RESTRICT,
  filename text NOT NULL,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  r2_key text,
  -- No scanner in the POC: everything is 'skipped' or 'blocked' and the UI
  -- offers no download until a scanner exists.
  scan_status text NOT NULL DEFAULT 'skipped',
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  CONSTRAINT email_attachments_scan_status_check CHECK (scan_status = ANY (ARRAY['pending', 'clean', 'blocked', 'skipped']))
);

CREATE TABLE IF NOT EXISTS app.email_sender_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  address text NOT NULL,
  rule text NOT NULL,
  buyer_id uuid REFERENCES app.buyers(id) ON DELETE RESTRICT,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  CONSTRAINT email_sender_rules_rule_check CHECK (rule = ANY (ARRAY['buyer_link', 'supplier', 'ignore'])),
  CONSTRAINT email_sender_rules_address_check CHECK (address = lower(address) AND position('@' IN address) > 1),
  CONSTRAINT email_sender_rules_buyer_link_check CHECK ((rule = 'buyer_link') = (buyer_id IS NOT NULL))
);

-- At most one live thread per (tenant, thread_key). Closed threads keep their
-- key so a late reply to an old conversation opens a fresh thread.
CREATE UNIQUE INDEX IF NOT EXISTS email_threads_tenant_active_key_uk
  ON app.email_threads (tenant_id, thread_key)
  WHERE deleted_at IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS email_threads_tenant_sender_subject_idx
  ON app.email_threads (tenant_id, sender_address, subject_normalized, last_inbound_at DESC)
  WHERE deleted_at IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS email_threads_tenant_buyer_idx
  ON app.email_threads (tenant_id, buyer_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS email_messages_tenant_dedupe_uk
  ON app.email_messages (tenant_id, dedupe_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS email_messages_tenant_rfc_idx
  ON app.email_messages (tenant_id, rfc_message_id)
  WHERE deleted_at IS NULL AND thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_messages_thread_received_idx
  ON app.email_messages (thread_id, received_at DESC)
  WHERE deleted_at IS NULL AND thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_messages_tenant_sender_recent_idx
  ON app.email_messages (tenant_id, from_address, received_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS email_attachments_message_idx
  ON app.email_attachments (message_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS email_sender_rules_tenant_address_uk
  ON app.email_sender_rules (tenant_id, address)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS email_threads_updated_at ON app.email_threads;
CREATE TRIGGER email_threads_updated_at
  BEFORE UPDATE ON app.email_threads
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
DROP TRIGGER IF EXISTS email_messages_updated_at ON app.email_messages;
CREATE TRIGGER email_messages_updated_at
  BEFORE UPDATE ON app.email_messages
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
DROP TRIGGER IF EXISTS email_attachments_updated_at ON app.email_attachments;
CREATE TRIGGER email_attachments_updated_at
  BEFORE UPDATE ON app.email_attachments
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
DROP TRIGGER IF EXISTS email_sender_rules_updated_at ON app.email_sender_rules;
CREATE TRIGGER email_sender_rules_updated_at
  BEFORE UPDATE ON app.email_sender_rules
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_sender_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "seller members can read email threads" ON app.email_threads;
CREATE POLICY "seller members can read email threads"
  ON app.email_threads FOR SELECT TO authenticated
  USING (tenant_id = (select app.jwt_tenant_id()) AND (select app.is_seller()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "seller members can read email messages" ON app.email_messages;
CREATE POLICY "seller members can read email messages"
  ON app.email_messages FOR SELECT TO authenticated
  USING (tenant_id = (select app.jwt_tenant_id()) AND (select app.is_seller()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "seller members can read email attachments" ON app.email_attachments;
CREATE POLICY "seller members can read email attachments"
  ON app.email_attachments FOR SELECT TO authenticated
  USING (tenant_id = (select app.jwt_tenant_id()) AND (select app.is_seller()) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "seller members can read email sender rules" ON app.email_sender_rules;
CREATE POLICY "seller members can read email sender rules"
  ON app.email_sender_rules FOR SELECT TO authenticated
  USING (tenant_id = (select app.jwt_tenant_id()) AND (select app.is_seller()) AND deleted_at IS NULL);

REVOKE ALL ON TABLE app.email_threads, app.email_messages, app.email_attachments, app.email_sender_rules FROM anon, authenticated;
GRANT SELECT ON TABLE app.email_threads, app.email_messages, app.email_attachments, app.email_sender_rules TO authenticated;
GRANT ALL ON TABLE app.email_threads, app.email_messages, app.email_attachments, app.email_sender_rules TO service_role;

COMMENT ON TABLE app.email_threads IS 'Inbound email conversations (one active thread = one Today entry). Buyer resolution state + method; created by process_email_inbound_message.';
COMMENT ON TABLE app.email_messages IS 'Individual inbound emails (and filtered mail kept for audit). Body capped at 20k chars; raw .eml and HTML live in R2.';
COMMENT ON TABLE app.email_attachments IS 'Attachment metadata for inbound email; bytes in R2. scan_status is skipped/blocked until a scanner exists, so the UI offers no download.';
COMMENT ON TABLE app.email_sender_rules IS 'Per-tenant sender rules: seller-confirmed buyer link, or mark address as supplier/ignore so it stops creating Today entries.';

-- ---------------------------------------------------------------------------
-- 4. Inbound RPC
-- ---------------------------------------------------------------------------
-- p_payload keys (all produced by the pure normalizer, supabase/functions/
-- _shared/email-inbound-normalize.ts): rfc_message_id, in_reply_to,
-- references[], from_address, from_name, original_from_address, to_addresses[],
-- subject, text_body, received_at, auth{spf,dkim,dmarc}, headers{},
-- filter_reason, message_kind, gstins[], raw_r2_key, html_r2_key,
-- attachments[{filename,mime_type,size_bytes,sha256,r2_key,blocked}].
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
    v_resolution := 'matched'; v_method := 'seller_link'; v_confidence := 'high';
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
      v_confidence := 'high'; v_ambiguity := '{}'::jsonb;
    END IF;
  END IF;

  v_thread_key := COALESCE(v_refs[1], v_in_reply_to, v_rfc_id);

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

COMMENT ON FUNCTION app.process_email_inbound_message(text, jsonb, boolean) IS
  'Service-role only. Idempotent inbound email ingest: tenant from alias-token hash, noise filter, buyer ladder (seller link > exact email > GSTIN > domain suggestion), thread + Today entry (email_buyer_message). No placeholder buyers.';

-- ---------------------------------------------------------------------------
-- 5. Seller actions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.link_email_thread_buyer(
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
  v_thread app.email_threads%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.tenant_users tu
    WHERE tu.tenant_id = p_tenant_id AND tu.user_id = p_actor_user_id
      AND tu.role IN ('seller_admin', 'seller_assistant')
      AND COALESCE(tu.is_active, true) AND tu.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'actor_not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_entry FROM app.entries
  WHERE id = p_entry_id AND tenant_id = p_tenant_id AND entry_type = 'email_buyer_message'
    AND source_entity_type = 'email_thread' AND deleted_at IS NULL
  FOR UPDATE;
  IF v_entry.id IS NULL THEN RAISE EXCEPTION 'entry_not_found' USING ERRCODE = '02000'; END IF;

  SELECT * INTO v_thread FROM app.email_threads
  WHERE id = v_entry.source_entity_id AND tenant_id = p_tenant_id AND deleted_at IS NULL
  FOR UPDATE;
  IF v_thread.id IS NULL THEN RAISE EXCEPTION 'thread_not_found' USING ERRCODE = '02000'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.buyers b
    WHERE b.id = p_buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND b.is_active = true
  ) THEN
    RAISE EXCEPTION 'buyer_not_found' USING ERRCODE = '02000';
  END IF;

  UPDATE app.email_threads
  SET buyer_id = p_buyer_id, resolution_status = 'matched', match_method = 'seller_link',
      match_confidence = 'high', ambiguity_metadata = '{}'::jsonb,
      metadata = metadata || jsonb_build_object('manual_buyer_link', true, 'linked_by', p_actor_user_id, 'linked_at', now()),
      updated_by = p_actor_user_id
  WHERE id = v_thread.id;

  UPDATE app.entries
  SET buyer_id = p_buyer_id,
      metadata = metadata || jsonb_build_object('resolution_status', 'matched', 'match_method', 'seller_link', 'match_confidence', 'high', 'ambiguity', '{}'::jsonb),
      last_actor_id = p_actor_user_id, last_action = 'link_email_buyer', last_action_at = now(),
      version = version + 1, updated_by = p_actor_user_id
  WHERE id = v_entry.id;

  -- Persist for future threads from this address.
  INSERT INTO app.email_sender_rules (tenant_id, address, rule, buyer_id, external_ref, created_by, updated_by)
  VALUES (p_tenant_id, v_thread.sender_address, 'buyer_link', p_buyer_id,
          'email_sender_rule:' || p_tenant_id::text || ':' || v_thread.sender_address, p_actor_user_id, p_actor_user_id)
  ON CONFLICT (tenant_id, address) WHERE deleted_at IS NULL
  DO UPDATE SET rule = 'buyer_link', buyer_id = EXCLUDED.buyer_id, updated_by = p_actor_user_id;

  INSERT INTO app.entry_events (tenant_id, entry_id, actor_user_id, action, from_status, to_status, metadata, created_by, updated_by)
  VALUES (p_tenant_id, v_entry.id, p_actor_user_id, 'link_email_buyer', v_entry.status, v_entry.status,
          jsonb_build_object('thread_id', v_thread.id, 'buyer_id', p_buyer_id, 'previous_buyer_id', v_thread.buyer_id,
                             'sender_address', v_thread.sender_address),
          p_actor_user_id, p_actor_user_id);

  RETURN jsonb_build_object('thread_id', v_thread.id, 'buyer_id', p_buyer_id, 'previous_buyer_id', v_thread.buyer_id);
END;
$$;

-- supplier / ignore: sender stops creating Today entries; the open entry is dismissed.
CREATE OR REPLACE FUNCTION app.set_email_sender_rule(
  p_tenant_id uuid,
  p_entry_id uuid,
  p_actor_user_id uuid,
  p_rule text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_entry app.entries%ROWTYPE;
  v_thread app.email_threads%ROWTYPE;
BEGIN
  IF p_rule NOT IN ('supplier', 'ignore') THEN
    RAISE EXCEPTION 'invalid_rule' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.tenant_users tu
    WHERE tu.tenant_id = p_tenant_id AND tu.user_id = p_actor_user_id
      AND tu.role IN ('seller_admin', 'seller_assistant')
      AND COALESCE(tu.is_active, true) AND tu.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'actor_not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_entry FROM app.entries
  WHERE id = p_entry_id AND tenant_id = p_tenant_id AND entry_type = 'email_buyer_message'
    AND source_entity_type = 'email_thread' AND deleted_at IS NULL
  FOR UPDATE;
  IF v_entry.id IS NULL THEN RAISE EXCEPTION 'entry_not_found' USING ERRCODE = '02000'; END IF;

  SELECT * INTO v_thread FROM app.email_threads
  WHERE id = v_entry.source_entity_id AND tenant_id = p_tenant_id AND deleted_at IS NULL;
  IF v_thread.id IS NULL THEN RAISE EXCEPTION 'thread_not_found' USING ERRCODE = '02000'; END IF;

  INSERT INTO app.email_sender_rules (tenant_id, address, rule, buyer_id, external_ref, created_by, updated_by)
  VALUES (p_tenant_id, v_thread.sender_address, p_rule, NULL,
          'email_sender_rule:' || p_tenant_id::text || ':' || v_thread.sender_address, p_actor_user_id, p_actor_user_id)
  ON CONFLICT (tenant_id, address) WHERE deleted_at IS NULL
  DO UPDATE SET rule = EXCLUDED.rule, buyer_id = NULL, updated_by = p_actor_user_id;

  UPDATE app.entries
  SET status = 'resolved', resolution_reason = 'email_sender_' || p_rule, resolved_at = now(), resolved_by = p_actor_user_id,
      last_actor_id = p_actor_user_id, last_action = 'email_sender_' || p_rule, last_action_at = now(),
      version = version + 1, updated_by = p_actor_user_id
  WHERE id = v_entry.id;

  INSERT INTO app.entry_events (tenant_id, entry_id, actor_user_id, action, from_status, to_status, metadata, created_by, updated_by)
  VALUES (p_tenant_id, v_entry.id, p_actor_user_id, 'email_sender_' || p_rule, v_entry.status, 'resolved',
          jsonb_build_object('thread_id', v_thread.id, 'sender_address', v_thread.sender_address),
          p_actor_user_id, p_actor_user_id);

  RETURN jsonb_build_object('thread_id', v_thread.id, 'sender_address', v_thread.sender_address, 'rule', p_rule);
END;
$$;

COMMENT ON FUNCTION app.link_email_thread_buyer(uuid, uuid, uuid, uuid) IS
  'Seller links an email thread to a buyer; persists a buyer_link sender rule so later threads from the address match automatically.';
COMMENT ON FUNCTION app.set_email_sender_rule(uuid, uuid, uuid, text) IS
  'Seller marks the thread sender as supplier/ignore: stores a tenant sender rule and resolves the entry.';

REVOKE ALL ON FUNCTION app.process_email_inbound_message(text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.process_email_inbound_message(text, jsonb, boolean) TO service_role;
REVOKE ALL ON FUNCTION app.link_email_thread_buyer(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.link_email_thread_buyer(uuid, uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION app.set_email_sender_rule(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.set_email_sender_rule(uuid, uuid, uuid, text) TO service_role;



-- ---------------------------------------------------------------------------
-- 5b. Alias provisioning (hash only; the plaintext token never reaches the DB)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_email_forwarding_alias(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_alias_token_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_integration_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.tenant_users tu
    WHERE tu.tenant_id = p_tenant_id AND tu.user_id = p_actor_user_id
      AND tu.role = 'seller_admin' AND COALESCE(tu.is_active, true) AND tu.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'actor_not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_alias_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_alias_hash' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.tenant_integrations (
    tenant_id, integration_type_id, status, config, connected_at, connected_by, created_by, updated_by
  ) VALUES (
    p_tenant_id, 'email_forwarding', 'connected',
    jsonb_build_object('alias_token_hash', p_alias_token_hash, 'rotated_at', now()),
    now(), p_actor_user_id, p_actor_user_id, p_actor_user_id
  )
  ON CONFLICT (tenant_id, integration_type_id) DO UPDATE SET
    status = 'connected',
    config = jsonb_build_object('alias_token_hash', EXCLUDED.config->>'alias_token_hash', 'rotated_at', now()),
    connected_at = now(),
    connected_by = p_actor_user_id,
    deleted_at = NULL,
    updated_by = p_actor_user_id
  RETURNING id INTO v_integration_id;

  RETURN jsonb_build_object('integration_id', v_integration_id);
END;
$$;

COMMENT ON FUNCTION app.set_email_forwarding_alias(uuid, uuid, text) IS
  'Seller admin creates or rotates the tenant email forwarding alias. Stores only sha256(token); the previous alias stops working immediately.';
REVOKE ALL ON FUNCTION app.set_email_forwarding_alias(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.set_email_forwarding_alias(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Feed functions: email branches (bodies re-declared from 20260928125155)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.entry_allowed_actions(
  p_entry_type text,
  p_status text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = app, public
AS $$
BEGIN
  IF p_status = 'resolved' THEN
    CASE p_entry_type
      WHEN 'new_enquiry' THEN
        RETURN jsonb_build_array('reopen', 'view_enquiry', 'view_buyer');
      WHEN 'new_order_confirmation' THEN
        RETURN jsonb_build_array('reopen', 'view_order', 'view_buyer');
      WHEN 'order_dispatch_needed' THEN
        RETURN jsonb_build_array('reopen', 'view_order', 'view_buyer');
      WHEN 'invoice_due' THEN
        RETURN jsonb_build_array('reopen', 'view_invoice', 'view_buyer');
      WHEN 'invoice_overdue' THEN
        RETURN jsonb_build_array('reopen', 'view_invoice', 'view_buyer');
      WHEN 'whatsapp_buyer_message' THEN
        RETURN jsonb_build_array('reopen', 'view_details', 'view_buyer');
      WHEN 'email_buyer_message' THEN
        RETURN jsonb_build_array('reopen', 'view_details', 'view_buyer');
      ELSE
        RETURN jsonb_build_array('reopen', 'view_details', 'view_buyer');
    END CASE;
  END IF;

  IF p_status = 'waiting' THEN
    CASE p_entry_type
      WHEN 'new_enquiry' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_enquiry', 'view_buyer');
      WHEN 'new_order_confirmation' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_order', 'view_buyer');
      WHEN 'order_dispatch_needed' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_order', 'view_buyer');
      WHEN 'invoice_due' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_invoice', 'view_buyer');
      WHEN 'invoice_overdue' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_invoice', 'view_buyer');
      WHEN 'whatsapp_buyer_message' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_details', 'view_buyer');
      WHEN 'email_buyer_message' THEN
        RETURN jsonb_build_array('reopen', 'add_note', 'view_details', 'view_buyer');
      ELSE
        RETURN jsonb_build_array('reopen', 'add_note', 'view_details', 'view_buyer');
    END CASE;
  END IF;

  CASE p_entry_type
    WHEN 'business_approval' THEN
      RETURN jsonb_build_array('approve', 'request_more_info', 'decline', 'view_details', 'view_buyer', 'add_note');
    WHEN 'new_user_login' THEN
      RETURN jsonb_build_array('approve', 'request_more_info', 'decline', 'view_details', 'view_buyer', 'add_note', 'view_activity', 'ignore');
    WHEN 'new_enquiry' THEN
      RETURN jsonb_build_array('reply_quote', 'send', 'convert', 'contact_buyer', 'view_enquiry', 'view_buyer', 'view_buyer_history', 'mark_converted_manually', 'remind_later', 'add_note');
    WHEN 'new_order_confirmation' THEN
      RETURN jsonb_build_array('accept_order', 'contact_buyer', 'reject', 'view_order', 'view_buyer', 'add_note');
    WHEN 'order_dispatch_needed' THEN
      RETURN jsonb_build_array('mark_dispatched', 'view_order', 'view_buyer', 'remind_later', 'add_note');
    WHEN 'invoice_due' THEN
      RETURN jsonb_build_array('send_reminder', 'view_invoice', 'view_buyer', 'remind_later', 'add_note');
    WHEN 'invoice_overdue' THEN
      RETURN jsonb_build_array('send_reminder', 'log_call', 'view_invoice', 'view_buyer', 'remind_later', 'add_note');
    WHEN 'credit_limit_breach' THEN
      RETURN jsonb_build_array('send_reminder', 'adjust_limit', 'view_account', 'view_details', 'view_buyer', 'remind_later', 'add_note');
    WHEN 'whatsapp_buyer_message' THEN
      RETURN jsonb_build_array('reply_whatsapp', 'view_details', 'view_buyer', 'remind_later', 'add_note', 'dismiss');
    WHEN 'email_buyer_message' THEN
      RETURN jsonb_build_array('view_details', 'view_buyer', 'remind_later', 'add_note', 'dismiss');
    ELSE
      RETURN jsonb_build_array('view_details', 'view_buyer', 'add_note');
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION app.list_entries(
  p_tenant_id uuid,
  p_location_ids uuid[] DEFAULT NULL,
  p_status_scope text DEFAULT 'active',
  p_entry_types text[] DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_cursor_priority_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  entry_number bigint,
  tenant_id uuid,
  buyer_id uuid,
  buyer_name text,
  buyer_phone text,
  location_id uuid,
  entry_type text,
  status text,
  source_channel text,
  source_entity_type text,
  source_entity_id uuid,
  title text,
  summary text,
  amount numeric,
  currency text,
  priority_at timestamptz,
  remind_at timestamptz,
  created_at timestamptz,
  last_actor_id uuid,
  last_action text,
  last_action_at timestamptz,
  external_sync_status text,
  metadata jsonb,
  allowed_actions jsonb,
  time_bucket text,
  customer_entry_count bigint,
  external_sync_error text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, public
AS $$
  WITH actor AS (
    SELECT app.entry_actor_is_seller_admin(p_tenant_id, p_actor_user_id) AS is_admin
  ),
  scoped AS (
    SELECT e.*, b.business_name, b.phone
    FROM app.entries e
    LEFT JOIN app.buyers b ON b.id = e.buyer_id AND b.tenant_id = e.tenant_id
    WHERE e.tenant_id = p_tenant_id
      AND e.deleted_at IS NULL
      AND (
        e.entry_type NOT IN ('business_approval', 'new_user_login')
        OR (SELECT is_admin FROM actor)
      )
      AND (
        CASE
          WHEN p_status_scope = 'resolved' THEN e.status = 'resolved'
          WHEN p_status_scope = 'all' THEN true
          ELSE e.status <> 'resolved'
        END
      )
      AND (p_entry_types IS NULL OR e.entry_type = ANY(p_entry_types))
      AND (p_location_ids IS NULL OR e.location_id IS NULL OR e.location_id = ANY(p_location_ids))
      AND (
        p_search IS NULL
        OR p_search = ''
        OR b.business_name ILIKE '%' || p_search || '%'
        OR b.phone ILIKE '%' || p_search || '%'
        OR e.source_entity_id::text ILIKE '%' || p_search || '%'
        OR e.metadata::text ILIKE '%' || p_search || '%'
      )
      AND (
        p_cursor_priority_at IS NULL
        OR e.priority_at < p_cursor_priority_at
        OR (e.priority_at = p_cursor_priority_at AND e.id < p_cursor_id)
      )
  ),
  counted AS (
    SELECT scoped.*, COUNT(*) OVER (PARTITION BY scoped.buyer_id) AS customer_entry_count
    FROM scoped
  )
  SELECT
    c.id,
    c.entry_number,
    c.tenant_id,
    c.buyer_id,
    COALESCE(c.business_name, 'Unknown customer') AS buyer_name,
    c.phone AS buyer_phone,
    c.location_id,
    c.entry_type,
    c.status,
    c.source_channel,
    c.source_entity_type,
    c.source_entity_id,
    CASE
      WHEN c.entry_type = 'email_buyer_message' AND c.business_name IS NULL
        THEN COALESCE(NULLIF(c.metadata->>'sender_name', ''), c.metadata->>'sender_address', 'Unknown sender')
      ELSE COALESCE(c.business_name, 'Unknown customer')
    END AS title,
    CASE c.entry_type
      WHEN 'business_approval' THEN 'New business account'
      WHEN 'new_user_login' THEN 'New visitor, no business info yet'
      WHEN 'new_enquiry' THEN concat_ws(' · ', 'Open enquiry', c.metadata->>'amount')
      WHEN 'new_order_confirmation' THEN concat_ws(' · ', 'New order', c.metadata->>'amount')
      WHEN 'order_dispatch_needed' THEN 'Confirmed, not dispatched'
      WHEN 'invoice_due' THEN concat_ws(' · ', c.metadata->>'amount', 'due soon')
      WHEN 'invoice_overdue' THEN concat_ws(' · ', c.metadata->>'amount', 'overdue')
      WHEN 'credit_limit_breach' THEN concat_ws(' · ', c.metadata->>'over_limit_amount', 'over credit limit')
      WHEN 'whatsapp_buyer_message' THEN COALESCE(NULLIF(c.metadata->>'last_inbound_text', ''), 'WhatsApp buyer message')
      WHEN 'email_buyer_message' THEN concat_ws(' · ', 'Email', NULLIF(c.metadata->>'subject', ''))
      ELSE c.entry_type
    END AS summary,
    COALESCE(NULLIF(c.metadata->>'amount', '')::numeric, NULLIF(c.metadata->>'over_limit_amount', '')::numeric) AS amount,
    c.metadata->>'currency' AS currency,
    c.priority_at,
    c.remind_at,
    c.created_at,
    c.last_actor_id,
    c.last_action,
    c.last_action_at,
    c.external_sync_status,
    c.metadata,
    app.entry_allowed_actions(c.entry_type, c.status, c.metadata) AS allowed_actions,
    app.entry_time_bucket(c.priority_at) AS time_bucket,
    c.customer_entry_count,
    c.external_sync_error
  FROM counted c
  ORDER BY c.priority_at DESC, c.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$;

REVOKE ALL ON FUNCTION app.list_entries(uuid, uuid[], text, text[], text, integer, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.list_entries(uuid, uuid[], text, text[], text, integer, timestamptz, uuid, uuid) TO service_role;
