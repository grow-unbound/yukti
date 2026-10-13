-- Transactional WhatsApp messages that failed only because the tenant had run out of credits are
-- never retried: observed 2026-10-08 — 23 access_request_received notifications to the tenant admin
-- failed with "insufficient whatsapp credits" and stayed failed after the 5,000-credit top-up on
-- 2026-10-09 09:36 IST.
--
-- When credits are topped up, put the tenant's recent (24h) credit-failed transactional rows back
-- on the queue. They are then picked up by the stuck-transactional kick cron
-- (20261013035207_whatsapp_stuck_transactional_kick.sql) — attempt_count is reset so they look like
-- any other fresh pending row. Broadcast rows (priority > 1) are left alone: a stale marketing
-- send must not go out unannounced.

CREATE OR REPLACE FUNCTION app.whatsapp_requeue_credit_failures()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app
AS $$
BEGIN
  WITH requeued AS (
    UPDATE app.whatsapp_send_queue q
    SET status = 'pending',
        attempt_count = 0,
        failure_reason = NULL,
        scheduled_send_at = now(),
        updated_at = now()
    WHERE q.tenant_id = NEW.tenant_id
      AND q.status = 'failed'
      AND q.priority = 1
      AND q.deleted_at IS NULL
      AND q.failure_reason LIKE 'credit debit failed: insufficient whatsapp credits%'
      AND q.created_at > now() - interval '24 hours'
    RETURNING q.whatsapp_message_id
  )
  UPDATE app.whatsapp_messages m
  SET status = 'queued',
      failure_reason = NULL,
      updated_at = now()
  FROM requeued r
  WHERE m.id = r.whatsapp_message_id
    AND m.status = 'failed';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.whatsapp_requeue_credit_failures() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_credit_topup_requeue ON app.whatsapp_credit_transactions;
CREATE TRIGGER whatsapp_credit_topup_requeue
AFTER INSERT ON app.whatsapp_credit_transactions
FOR EACH ROW
WHEN (NEW.transaction_type = 'topup' AND NEW.credits > 0)
EXECUTE FUNCTION app.whatsapp_requeue_credit_failures();
