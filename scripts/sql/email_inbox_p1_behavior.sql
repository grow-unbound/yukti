-- Behavior tests for 20261023112240_email_inbox_p1.sql. DEV ONLY, synthetic data.
-- Run (rolls everything back, including the migration itself):
--   scripts/sql/run-email-inbox-p1-tests.sh
-- Each check RAISEs EXCEPTION on failure; the last SELECT prints a pass marker.

CREATE FUNCTION pg_temp.payload(p_from text, p_msgid text, p_subject text, p_body text, p_recv timestamptz, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'rfc_message_id', p_msgid, 'from_address', p_from, 'from_name', 'Test Sender',
    'to_addresses', jsonb_build_array('tok@mail.example.test'), 'subject', p_subject,
    'text_body', p_body, 'received_at', p_recv, 'auth', jsonb_build_object('dkim', 'pass'),
    'references', '[]'::jsonb, 'gstins', '[]'::jsonb, 'attachments', '[]'::jsonb
  ) || p_extra;
$$;

DO $$
DECLARE
  v_t1 uuid; v_t2 uuid; v_actor uuid;
  v_b1 uuid; v_b2 uuid; v_b3 uuid; v_b4 uuid;
  v_h1 text := repeat('1', 64); v_h1_real text := repeat('1', 64); v_h2 text := 'hash-tenant-two';
  v_base timestamptz := '2026-10-23 10:00:00+00';
  r jsonb; r2 jsonb; n int; s text; v_buyers_before int; v_thread uuid; v_entry uuid;
BEGIN
  SELECT tu.tenant_id, tu.user_id INTO v_t1, v_actor
  FROM app.tenant_users tu JOIN app.tenants t ON t.id = tu.tenant_id AND t.deleted_at IS NULL
  WHERE tu.role = 'seller_admin' AND tu.deleted_at IS NULL AND COALESCE(tu.is_active, true)
  ORDER BY tu.created_at LIMIT 1;
  SELECT id INTO v_t2 FROM app.tenants WHERE deleted_at IS NULL AND id <> v_t1 ORDER BY created_at LIMIT 1;
  IF v_t1 IS NULL OR v_t2 IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'fixture: need two tenants and a seller_admin'; END IF;

  INSERT INTO app.tenant_integrations (tenant_id, integration_type_id, status, config, connected_at)
  VALUES (v_t2, 'email_forwarding', 'connected', jsonb_build_object('alias_token_hash', v_h2), now());

  INSERT INTO app.buyers (tenant_id, business_name, email, gstin, is_active, buyer_app_enabled, external_ref)
  VALUES (v_t1, 'ZZ Test Alpha', 'alpha@alpha-traders.test', '27AAAAA0000A1Z5', true, false, 'zz-test-alpha') RETURNING id INTO v_b1;
  INSERT INTO app.buyers (tenant_id, business_name, email, is_active, buyer_app_enabled, external_ref)
  VALUES (v_t1, 'ZZ Test Twin A', 'shared@twin.test', true, false, 'zz-test-twin-a') RETURNING id INTO v_b2;
  INSERT INTO app.buyers (tenant_id, business_name, email, is_active, buyer_app_enabled, external_ref)
  VALUES (v_t1, 'ZZ Test Twin B', 'shared@twin.test', true, false, 'zz-test-twin-b') RETURNING id INTO v_b3;
  INSERT INTO app.buyers (tenant_id, business_name, email, is_active, buyer_app_enabled, external_ref)
  VALUES (v_t1, 'ZZ Test Gamma', 'owner@gamma-corp.test', true, false, 'zz-test-gamma') RETURNING id INTO v_b4;
  SELECT count(*) INTO v_buyers_before FROM app.buyers WHERE tenant_id = v_t1;

  -- 0. alias provisioning: rotation invalidates the old hash; non-admin rejected
  PERFORM app.set_email_forwarding_alias(v_t1, v_actor, repeat('a', 64));
  IF NOT EXISTS (SELECT 1 FROM app.tenant_integrations WHERE tenant_id = v_t1 AND integration_type_id = 'email_forwarding' AND config->>'alias_token_hash' = repeat('a', 64)) THEN RAISE EXCEPTION 'T0a'; END IF;
  PERFORM app.set_email_forwarding_alias(v_t1, v_actor, v_h1_real);
  r := app.process_email_inbound_message(repeat('a', 64), pg_temp.payload('x@y.test','<rot1@t>','s','b',v_base), true);
  IF r->>'skipped' <> 'tenant_not_resolved' THEN RAISE EXCEPTION 'T0b old alias still works %', r; END IF;
  BEGIN
    PERFORM app.set_email_forwarding_alias(v_t1, gen_random_uuid(), repeat('b', 64));
    RAISE EXCEPTION 'T0c non-admin allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 1. feature off / unknown token
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('x@y.test','<f1@t>','s','b',v_base), false);
  IF r->>'skipped' <> 'feature_disabled' THEN RAISE EXCEPTION 'T1a %', r; END IF;
  r := app.process_email_inbound_message('nope', pg_temp.payload('x@y.test','<f2@t>','s','b',v_base), true);
  IF r->>'skipped' <> 'tenant_not_resolved' THEN RAISE EXCEPTION 'T1b %', r; END IF;

  -- 2. unknown sender: entry created, NO placeholder buyer, free-mail never domain-matched
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('stranger@gmail.com','<u1@t>','Need rates','hello',v_base), true);
  IF r->>'resolution_status' <> 'unknown' OR r->>'entry_id' IS NULL THEN RAISE EXCEPTION 'T2a %', r; END IF;
  SELECT count(*) INTO n FROM app.buyers WHERE tenant_id = v_t1;
  IF n <> v_buyers_before THEN RAISE EXCEPTION 'T2b placeholder buyer created'; END IF;
  SELECT buyer_id::text INTO s FROM app.entries WHERE id = (r->>'entry_id')::uuid;
  IF s IS NOT NULL THEN RAISE EXCEPTION 'T2c entry has buyer'; END IF;

  -- 3. duplicate delivery
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('stranger@gmail.com','<u1@t>','Need rates','hello',v_base), true);
  IF (r2->>'duplicate')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'T3a %', r2; END IF;
  SELECT count(*) INTO n FROM app.email_messages WHERE tenant_id = v_t1 AND rfc_message_id = '<u1@t>';
  IF n <> 1 THEN RAISE EXCEPTION 'T3b dup rows %', n; END IF;

  -- 4. exact email, dkim pass => high; no auth => low
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('Alpha@alpha-traders.test','<a1@t>','Order 1','body',v_base + interval '1 min'), true);
  IF r->>'resolution_status' <> 'matched' OR r->>'match_method' <> 'exact_email' THEN RAISE EXCEPTION 'T4a %', r; END IF;
  SELECT match_confidence INTO s FROM app.email_threads WHERE id = (r->>'thread_id')::uuid;
  IF s <> 'high' THEN RAISE EXCEPTION 'T4b % ', s; END IF;
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('alpha@alpha-traders.test','<a2@t>','Different topic','body',v_base + interval '2 min', jsonb_build_object('auth','{}'::jsonb)), true);
  SELECT match_confidence INTO s FROM app.email_threads WHERE id = (r->>'thread_id')::uuid;
  IF s <> 'low' THEN RAISE EXCEPTION 'T4c unauthenticated should be low, got %', s; END IF;

  -- 5. ambiguous exact email
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('shared@twin.test','<t1@t>','Twin q','body',v_base + interval '3 min'), true);
  IF r->>'resolution_status' <> 'ambiguous' THEN RAISE EXCEPTION 'T5a %', r; END IF;
  SELECT buyer_id::text INTO s FROM app.email_threads WHERE id = (r->>'thread_id')::uuid;
  IF s IS NOT NULL THEN RAISE EXCEPTION 'T5b ambiguous thread has buyer'; END IF;

  -- 6. GSTIN match from body
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('newcontact@unrelated.test','<g1@t>','Hello','gst inside',v_base + interval '4 min', jsonb_build_object('gstins', jsonb_build_array('27AAAAA0000A1Z5'))), true);
  IF r->>'match_method' <> 'gstin' OR r->>'resolution_status' <> 'matched' THEN RAISE EXCEPTION 'T6 %', r; END IF;

  -- 7. domain only suggests (ambiguous), never matches
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('purchasing@gamma-corp.test','<d1@t>','Quote','body',v_base + interval '5 min'), true);
  IF r->>'resolution_status' <> 'ambiguous' OR r->>'match_method' <> 'domain' THEN RAISE EXCEPTION 'T7 %', r; END IF;

  -- 8. threading by In-Reply-To, entry count stays 1; subject fallback joins too
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('thr@thread.test','<th1@t>','Need 10 pcs','first',v_base + interval '10 min'), true);
  v_thread := (r->>'thread_id')::uuid; v_entry := (r->>'entry_id')::uuid;
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('thr@thread.test','<th2@t>','Re: Need 10 pcs','second',v_base + interval '11 min', jsonb_build_object('in_reply_to','<th1@t>','references',jsonb_build_array('<th1@t>'))), true);
  IF (r2->>'thread_id')::uuid <> v_thread OR (r2->>'entry_id')::uuid <> v_entry THEN RAISE EXCEPTION 'T8a reply split thread %', r2; END IF;
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('thr@thread.test','<th3@t>','RE: Need 10 pcs','no headers',v_base + interval '12 min'), true);
  IF (r2->>'thread_id')::uuid <> v_thread THEN RAISE EXCEPTION 'T8b subject fallback split thread'; END IF;
  SELECT count(*) INTO n FROM app.email_messages WHERE thread_id = v_thread;
  IF n <> 3 THEN RAISE EXCEPTION 'T8c messages %', n; END IF;
  SELECT count(*) INTO n FROM app.entries WHERE tenant_id = v_t1 AND source_entity_id = v_thread AND deleted_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'T8d entries %', n; END IF;

  -- 9. out-of-order older message must not move last_inbound_at backwards
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('thr@thread.test','<th0@t>','Need 10 pcs','older',v_base + interval '1 min', jsonb_build_object('in_reply_to','<th1@t>')), true);
  IF (SELECT last_inbound_at FROM app.email_threads WHERE id = v_thread) < v_base + interval '12 min' THEN RAISE EXCEPTION 'T9 last_inbound moved back'; END IF;

  -- 10. resolve then new inbound: inside 24h reopens same entry; after 24h opens new thread
  UPDATE app.entries SET status = 'resolved', resolved_at = v_base + interval '13 min' WHERE id = v_entry;
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('thr@thread.test','<th4@t>','Re: Need 10 pcs','soon after',v_base + interval '2 hours', jsonb_build_object('in_reply_to','<th3@t>')), true);
  IF (r2->>'entry_id')::uuid <> v_entry THEN RAISE EXCEPTION 'T10a should reopen same entry'; END IF;
  SELECT status INTO s FROM app.entries WHERE id = v_entry;
  IF s <> 'new' THEN RAISE EXCEPTION 'T10b status %', s; END IF;
  UPDATE app.entries SET status = 'resolved', resolved_at = v_base + interval '2 hours' WHERE id = v_entry;
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('thr@thread.test','<th5@t>','Re: Need 10 pcs','much later',v_base + interval '30 hours', jsonb_build_object('in_reply_to','<th4@t>')), true);
  IF (r2->>'thread_id')::uuid = v_thread THEN RAISE EXCEPTION 'T10c should open new thread after quiet threshold'; END IF;
  IF (SELECT status FROM app.email_threads WHERE id = v_thread) <> 'closed' THEN RAISE EXCEPTION 'T10d old thread not closed'; END IF;

  -- 11. seller link persists to later threads from the same address
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('unknown.person@vendor-x.test','<l1@t>','Who am I','body',v_base + interval '40 min'), true);
  v_entry := (r->>'entry_id')::uuid; v_thread := (r->>'thread_id')::uuid;
  PERFORM app.link_email_thread_buyer(v_t1, v_entry, v_actor, v_b1);
  IF (SELECT resolution_status FROM app.email_threads WHERE id = v_thread) <> 'matched' THEN RAISE EXCEPTION 'T11a'; END IF;
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('unknown.person@vendor-x.test','<l2@t>','A brand new topic','body',v_base + interval '41 min'), true);
  IF r2->>'match_method' <> 'seller_link' OR (SELECT buyer_id FROM app.email_threads WHERE id = (r2->>'thread_id')::uuid) <> v_b1 THEN RAISE EXCEPTION 'T11b %', r2; END IF;
  -- a later automatic result cannot override the manual link on the same thread
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('unknown.person@vendor-x.test','<l3@t>','Re: Who am I','more',v_base + interval '42 min', jsonb_build_object('in_reply_to','<l1@t>','gstins',jsonb_build_array('27AAAAA0000A1Z5'))), true);
  IF (SELECT buyer_id FROM app.email_threads WHERE id = v_thread) <> v_b1 THEN RAISE EXCEPTION 'T11c'; END IF;

  -- 12. supplier rule: stored as filtered, no thread / entry
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('sales@supplier.test','<s1@t>','Price list','body',v_base + interval '50 min'), true);
  PERFORM app.set_email_sender_rule(v_t1, (r->>'entry_id')::uuid, v_actor, 'supplier');
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('sales@supplier.test','<s2@t>','New price list','body',v_base + interval '51 min'), true);
  IF (r2->>'filtered')::boolean IS NOT TRUE OR r2->>'filter_reason' <> 'sender_rule_supplier' OR r2->>'entry_id' IS NOT NULL THEN RAISE EXCEPTION 'T12 %', r2; END IF;

  -- 13. noise filter + setup verification
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('mailer-daemon@mx.test','<n1@t>','Undelivered','bounce',v_base + interval '52 min', jsonb_build_object('filter_reason','bounce')), true);
  IF (r->>'filtered')::boolean IS NOT TRUE OR r->>'thread_id' IS NOT NULL THEN RAISE EXCEPTION 'T13a %', r; END IF;
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('forwarding-noreply@google.com','<v1@t>','Gmail Forwarding Confirmation','code 123456',v_base + interval '53 min', jsonb_build_object('message_kind','setup_verification')), true);
  IF r->>'message_kind' <> 'setup_verification' OR r->>'entry_id' IS NOT NULL THEN RAISE EXCEPTION 'T13b %', r; END IF;

  -- 14. tenant isolation: same sender via tenant two token never touches tenant one
  SELECT count(*) INTO n FROM app.email_threads WHERE tenant_id = v_t1;
  r := app.process_email_inbound_message(v_h2, pg_temp.payload('alpha@alpha-traders.test','<iso1@t>','Order 1','body',v_base + interval '60 min'), true);
  IF (r->>'tenant_id')::uuid <> v_t2 THEN RAISE EXCEPTION 'T14a %', r; END IF;
  IF r->>'resolution_status' <> 'unknown' THEN RAISE EXCEPTION 'T14b buyer leaked across tenants %', r; END IF;
  IF (SELECT count(*) FROM app.email_threads WHERE tenant_id = v_t1) <> n THEN RAISE EXCEPTION 'T14c tenant one changed'; END IF;

  -- 15. feed: unknown sender title falls back to sender; allowed actions present
  SELECT title INTO s FROM app.list_entries(v_t1, NULL, 'all', ARRAY['email_buyer_message'], 'stranger', 10, NULL, NULL, v_actor) LIMIT 1;
  IF s IS DISTINCT FROM 'Test Sender' THEN RAISE EXCEPTION 'T15a title %', s; END IF;
  IF NOT (app.entry_allowed_actions('email_buyer_message','new','{}'::jsonb) ? 'dismiss') THEN RAISE EXCEPTION 'T15b'; END IF;

  -- 15b. parsed-forward sender: never high confidence, never verified, seller link not applied
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('staff@distributor.test','<pf1@t>','Fwd: order','x',v_base + interval '65 min',
    jsonb_build_object('original_from_address','alpha@alpha-traders.test')), true);
  IF r->>'match_method' <> 'exact_email' THEN RAISE EXCEPTION 'T15b %', r; END IF;
  IF (SELECT match_confidence FROM app.email_threads WHERE id = (r->>'thread_id')::uuid) <> 'low' THEN RAISE EXCEPTION 'T15b confidence'; END IF;
  IF ((SELECT metadata->>'auth_verified' FROM app.entries WHERE id = (r->>'entry_id')::uuid))::boolean IS NOT FALSE THEN RAISE EXCEPTION 'T15b verified'; END IF;

  -- 15c. reply-header injection: another sender citing a known Message-ID must not join the thread
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('victim@victim-co.test','<inj0@t>','Invoice question','private',v_base + interval '66 min'), true);
  r2 := app.process_email_inbound_message(v_h1, pg_temp.payload('attacker@evil.test','<inj1@t>','Re: Invoice question','fake',v_base + interval '67 min', jsonb_build_object('in_reply_to','<inj0@t>','references',jsonb_build_array('<inj0@t>'))), true);
  IF (r2->>'thread_id')::uuid = (r->>'thread_id')::uuid THEN RAISE EXCEPTION 'T15c attacker joined victim thread'; END IF;

  -- 15d. seller link on an unauthenticated From is capped at medium
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('unknown.person@vendor-x.test','<sp1@t>','Spoof attempt','x',v_base + interval '68 min', jsonb_build_object('auth','{}'::jsonb)), true);
  IF (SELECT match_confidence FROM app.email_threads WHERE id = (r->>'thread_id')::uuid) <> 'medium' THEN RAISE EXCEPTION 'T15d spoofed linked sender should be medium'; END IF;

  -- 16. attachments: blocked flag respected, bounded rows
  r := app.process_email_inbound_message(v_h1, pg_temp.payload('att@attach.test','<at1@t>','With files','see attached',v_base + interval '70 min',
    jsonb_build_object('attachments', jsonb_build_array(
      jsonb_build_object('filename','po.pdf','mime_type','application/pdf','size_bytes',100,'blocked',false),
      jsonb_build_object('filename','x.exe','mime_type','application/octet-stream','size_bytes',5,'blocked',true)))), true);
  SELECT count(*) INTO n FROM app.email_attachments WHERE message_id = (r->>'message_id')::uuid;
  IF n <> 2 THEN RAISE EXCEPTION 'T16a %', n; END IF;
  IF (SELECT scan_status FROM app.email_attachments WHERE message_id = (r->>'message_id')::uuid AND filename = 'x.exe') <> 'blocked' THEN RAISE EXCEPTION 'T16b'; END IF;
END $$;

SELECT 'EMAIL_INBOX_P1_ALL_PASSED' AS result;
