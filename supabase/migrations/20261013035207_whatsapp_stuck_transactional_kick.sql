-- Safety net for transactional WhatsApp sends whose synchronous dispatch never ran.
--
-- Dispatch is driven from app code (triggerWhatsAppDispatch, see
-- 20260713055448_synchronous-whatsapp-dispatch.sql) and the only DB-side backstop
-- is the once-daily whatsapp-queue-sweep cron (03:40 UTC). When the Vercel request
-- is torn down between enqueue and dispatch, a priority-1 row (enquiry/order/OTP/
-- access-request) stays `pending` with attempt_count = 0 until the next morning —
-- observed 2026-10-12: 8 enquiry_received rows queued 09:57-14:22 IST, delivered
-- only by the 09:10 IST sweep the next day.
--
-- This adds a cheap DB-side check every 5 minutes: only when a transactional row
-- has been pending > 2 minutes does it call the (already idempotent) sweep worker.
-- No edge invocation happens when the queue is healthy.

CREATE OR REPLACE FUNCTION app.whatsapp_kick_stuck_transactional()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.whatsapp_send_queue
    WHERE status = 'pending'
      AND priority = 1
      AND deleted_at IS NULL
      AND attempt_count = 0
      AND scheduled_send_at <= now() - interval '2 minutes'
      AND created_at > now() - interval '2 days'
  ) THEN
    RETURN false;
  END IF;

  -- Vault-backed helper (GUC fallback inside); an empty secret would be rejected by the worker
  -- while this cron still "succeeds", so say so loudly.
  v_secret := COALESCE(app.get_integrations_dispatch_secret(), '');
  IF v_secret = '' THEN
    RAISE WARNING 'whatsapp_kick_stuck_transactional: dispatch secret is empty; sweep worker will reject the call';
  END IF;

  PERFORM net.http_post(
    url := app.get_functions_base_url() || '/whatsapp-queue-sweep-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
    ),
    body := jsonb_build_object('trigger', 'stuck_transactional_kick')
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.whatsapp_kick_stuck_transactional() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.whatsapp_kick_stuck_transactional() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.unschedule('whatsapp-stuck-transactional-kick');
  EXCEPTION
    WHEN OTHERS THEN
      NULL;
  END;

  PERFORM cron.schedule(
    'whatsapp-stuck-transactional-kick',
    '1-59/5 * * * *',
    $sql$SELECT app.whatsapp_kick_stuck_transactional()$sql$
  );
END;
$$;
