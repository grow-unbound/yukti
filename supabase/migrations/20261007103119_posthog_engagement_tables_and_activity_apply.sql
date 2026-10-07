-- Pulse gap 2: persist buyer-app engagement (from PostHog) in the Yukti DB, daily.
--
-- PostHog stays the event store; only small daily aggregates are copied here so Pulse and reports can read
-- DAU/WAU/MAU, funnel steps and bounce without a live PostHog call:
--   app.engagement_buyer_daily   one row per active buyer per IST day (counts by event class, first/last event)
--   app.engagement_product_daily one row per viewed product per IST day (viewers, views, carters)
--   app.engagement_tenant_daily  one row per tenant per IST day (DAU + trailing WAU/MAU, new/returning, funnel, bounce)
-- The edge function posthog-engagement-sync (cron 22:00 UTC = 03:30 IST, after inbox-entries-daily-refresh and
-- before ops-daily-rollup) fetches the previous closed IST day (and re-fetches the day before to absorb late
-- events), then calls app.engagement_apply_daily, which is idempotent per (tenant, day).
-- apply_daily also raises buyers.last_login_at (OTP logins) and buyers.last_active_at (any activity), only ever
-- upward, and refreshes the tenant active-buyer windows.
--
-- Definitions (documented in .claude/skills/tenant-case-study/references/definitions.md):
--   active buyer (day)  >= 1 non-passive buyer-app event ($web_vitals/$set/$groupidentify/$feature_flag_called excluded)
--   bounce buyer (day)  active but no intent action: no search, product view, cart open/add, submit, or quote
--   new / returning     first-ever active day = day / active and first-ever active day < day
--   WAU / MAU           distinct active buyers over the trailing 7 / 30 IST days including the day

CREATE TABLE IF NOT EXISTS app.engagement_buyer_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES app.buyers(id) ON DELETE RESTRICT,
  day date NOT NULL,
  pageviews integer NOT NULL DEFAULT 0,
  searches integer NOT NULL DEFAULT 0,
  product_views integer NOT NULL DEFAULT 0,
  cart_opens integer NOT NULL DEFAULT 0,
  add_to_cart integer NOT NULL DEFAULT 0,
  submit_clicks integer NOT NULL DEFAULT 0,
  submit_failed integer NOT NULL DEFAULT 0,
  quotes_created integer NOT NULL DEFAULT 0,
  logins integer NOT NULL DEFAULT 0,
  is_bounce boolean NOT NULL DEFAULT false,
  first_event_at timestamptz,
  last_event_at timestamptz,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_engagement_buyer_daily ON app.engagement_buyer_daily (tenant_id, buyer_id, day);
CREATE INDEX IF NOT EXISTS idx_engagement_buyer_daily_day ON app.engagement_buyer_daily (tenant_id, day);
CREATE INDEX IF NOT EXISTS idx_engagement_buyer_daily_buyer ON app.engagement_buyer_daily (buyer_id);

CREATE TABLE IF NOT EXISTS app.engagement_product_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  tenant_product_id uuid NOT NULL REFERENCES app.tenant_products(id) ON DELETE RESTRICT,
  day date NOT NULL,
  viewers integer NOT NULL DEFAULT 0,
  views integer NOT NULL DEFAULT 0,
  carters integer NOT NULL DEFAULT 0,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_engagement_product_daily ON app.engagement_product_daily (tenant_id, tenant_product_id, day);
CREATE INDEX IF NOT EXISTS idx_engagement_product_daily_day ON app.engagement_product_daily (tenant_id, day);
CREATE INDEX IF NOT EXISTS idx_engagement_product_daily_product ON app.engagement_product_daily (tenant_product_id);

CREATE TABLE IF NOT EXISTS app.engagement_tenant_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  day date NOT NULL,
  dau integer NOT NULL DEFAULT 0,
  wau integer NOT NULL DEFAULT 0,
  mau integer NOT NULL DEFAULT 0,
  new_buyers integer NOT NULL DEFAULT 0,
  returning_buyers integer NOT NULL DEFAULT 0,
  login_buyers integer NOT NULL DEFAULT 0,
  sessions integer NOT NULL DEFAULT 0,
  pageviews integer NOT NULL DEFAULT 0,
  search_buyers integer NOT NULL DEFAULT 0,
  product_view_buyers integer NOT NULL DEFAULT 0,
  product_views integer NOT NULL DEFAULT 0,
  cart_open_buyers integer NOT NULL DEFAULT 0,
  add_to_cart_buyers integer NOT NULL DEFAULT 0,
  add_to_cart_events integer NOT NULL DEFAULT 0,
  submit_click_buyers integer NOT NULL DEFAULT 0,
  submit_clicks integer NOT NULL DEFAULT 0,
  quote_buyers integer NOT NULL DEFAULT 0,
  quotes_created integer NOT NULL DEFAULT 0,
  bounce_buyers integer NOT NULL DEFAULT 0,
  source_synced_at timestamptz NOT NULL DEFAULT now(),
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_engagement_tenant_daily ON app.engagement_tenant_daily (tenant_id, day);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['engagement_buyer_daily', 'engagement_product_daily', 'engagement_tenant_daily'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', t || '_tenant_select', t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO authenticated USING (tenant_id = (SELECT app.jwt_tenant_id()))', t || '_tenant_select', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON app.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON app.%I TO service_role', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON app.%I', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t || '_updated_at', t);
  END LOOP;
END
$rls$;

-- Tenants worth syncing: any tenant with a buyer-app-enabled buyer (small list, edge function reads it).
CREATE OR REPLACE FUNCTION app.engagement_sync_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $$
  SELECT DISTINCT b.tenant_id FROM app.buyers b WHERE b.deleted_at IS NULL AND b.buyer_app_enabled;
$$;
REVOKE ALL ON FUNCTION app.engagement_sync_tenants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.engagement_sync_tenants() TO service_role;

-- Idempotent per (tenant, day). p_buyers / p_products are JSON arrays produced by the edge function.
--   buyer row: {buyer_id, pageviews, searches, product_views, cart_opens, add_to_cart, submit_clicks,
--               submit_failed, quotes_created, logins, first_event_at, last_event_at, last_login_at}
--   product row: {tenant_product_id, viewers, views, carters}
--   p_totals: {sessions}
CREATE OR REPLACE FUNCTION app.engagement_apply_daily(
  p_tenant_id uuid,
  p_day date,
  p_buyers jsonb,
  p_products jsonb,
  p_totals jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $$
DECLARE
  v_buyers integer := 0;
  v_products integer := 0;
BEGIN
  IF p_tenant_id IS NULL OR p_day IS NULL THEN
    RAISE EXCEPTION 'engagement_apply_daily: tenant and day are required';
  END IF;
  IF p_day > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'engagement_apply_daily: day % is in the future', p_day;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.eng_buyers (LIKE app.engagement_buyer_daily INCLUDING DEFAULTS) ON COMMIT DROP;
  TRUNCATE pg_temp.eng_buyers;
  INSERT INTO pg_temp.eng_buyers (tenant_id, buyer_id, day, pageviews, searches, product_views, cart_opens, add_to_cart,
      submit_clicks, submit_failed, quotes_created, logins, is_bounce, first_event_at, last_event_at)
  SELECT p_tenant_id, b.id, p_day,
    COALESCE((r->>'pageviews')::int, 0), COALESCE((r->>'searches')::int, 0), COALESCE((r->>'product_views')::int, 0),
    COALESCE((r->>'cart_opens')::int, 0), COALESCE((r->>'add_to_cart')::int, 0), COALESCE((r->>'submit_clicks')::int, 0),
    COALESCE((r->>'submit_failed')::int, 0), COALESCE((r->>'quotes_created')::int, 0), COALESCE((r->>'logins')::int, 0),
    (COALESCE((r->>'searches')::int, 0) + COALESCE((r->>'product_views')::int, 0) + COALESCE((r->>'cart_opens')::int, 0)
      + COALESCE((r->>'add_to_cart')::int, 0) + COALESCE((r->>'submit_clicks')::int, 0) + COALESCE((r->>'quotes_created')::int, 0)) = 0,
    NULLIF(r->>'first_event_at', '')::timestamptz, NULLIF(r->>'last_event_at', '')::timestamptz
  FROM jsonb_array_elements(COALESCE(p_buyers, '[]'::jsonb)) r
  JOIN app.buyers b ON b.id = NULLIF(r->>'buyer_id', '')::uuid AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL;

  INSERT INTO app.engagement_buyer_daily AS d (tenant_id, buyer_id, day, pageviews, searches, product_views, cart_opens, add_to_cart,
      submit_clicks, submit_failed, quotes_created, logins, is_bounce, first_event_at, last_event_at, deleted_at)
  SELECT tenant_id, buyer_id, day, pageviews, searches, product_views, cart_opens, add_to_cart,
      submit_clicks, submit_failed, quotes_created, logins, is_bounce, first_event_at, last_event_at, NULL
  FROM pg_temp.eng_buyers
  ON CONFLICT (tenant_id, buyer_id, day) DO UPDATE SET
    pageviews = EXCLUDED.pageviews, searches = EXCLUDED.searches, product_views = EXCLUDED.product_views,
    cart_opens = EXCLUDED.cart_opens, add_to_cart = EXCLUDED.add_to_cart, submit_clicks = EXCLUDED.submit_clicks,
    submit_failed = EXCLUDED.submit_failed, quotes_created = EXCLUDED.quotes_created, logins = EXCLUDED.logins,
    is_bounce = EXCLUDED.is_bounce, first_event_at = EXCLUDED.first_event_at, last_event_at = EXCLUDED.last_event_at,
    deleted_at = NULL;
  GET DIAGNOSTICS v_buyers = ROW_COUNT;

  -- resync: rows for this day that PostHog no longer reports are removed
  DELETE FROM app.engagement_buyer_daily d
  WHERE d.tenant_id = p_tenant_id AND d.day = p_day
    AND NOT EXISTS (SELECT 1 FROM pg_temp.eng_buyers e WHERE e.buyer_id = d.buyer_id);

  INSERT INTO app.engagement_product_daily AS d (tenant_id, tenant_product_id, day, viewers, views, carters, deleted_at)
  SELECT p_tenant_id, tp.id, p_day,
    COALESCE((r->>'viewers')::int, 0), COALESCE((r->>'views')::int, 0), COALESCE((r->>'carters')::int, 0), NULL
  FROM jsonb_array_elements(COALESCE(p_products, '[]'::jsonb)) r
  JOIN app.tenant_products tp ON tp.id = NULLIF(r->>'tenant_product_id', '')::uuid AND tp.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, tenant_product_id, day) DO UPDATE SET
    viewers = EXCLUDED.viewers, views = EXCLUDED.views, carters = EXCLUDED.carters, deleted_at = NULL;
  GET DIAGNOSTICS v_products = ROW_COUNT;

  DELETE FROM app.engagement_product_daily d
  WHERE d.tenant_id = p_tenant_id AND d.day = p_day
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_products, '[]'::jsonb)) r
      WHERE NULLIF(r->>'tenant_product_id', '')::uuid = d.tenant_product_id
    );

  -- tenant-day roll-up incl. trailing windows and new/returning, all from the persisted buyer rows
  INSERT INTO app.engagement_tenant_daily AS t (
    tenant_id, day, dau, wau, mau, new_buyers, returning_buyers, login_buyers, sessions, pageviews,
    search_buyers, product_view_buyers, product_views, cart_open_buyers, add_to_cart_buyers, add_to_cart_events,
    submit_click_buyers, submit_clicks, quote_buyers, quotes_created, bounce_buyers, source_synced_at, deleted_at)
  SELECT p_tenant_id, p_day,
    COUNT(*),
    (SELECT COUNT(DISTINCT w.buyer_id) FROM app.engagement_buyer_daily w WHERE w.tenant_id = p_tenant_id AND w.day BETWEEN p_day - 6 AND p_day),
    (SELECT COUNT(DISTINCT m.buyer_id) FROM app.engagement_buyer_daily m WHERE m.tenant_id = p_tenant_id AND m.day BETWEEN p_day - 29 AND p_day),
    COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM app.engagement_buyer_daily h WHERE h.tenant_id = p_tenant_id AND h.buyer_id = b.buyer_id AND h.day < p_day)),
    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.engagement_buyer_daily h WHERE h.tenant_id = p_tenant_id AND h.buyer_id = b.buyer_id AND h.day < p_day)),
    COUNT(*) FILTER (WHERE b.logins > 0),
    COALESCE((p_totals->>'sessions')::int, 0),
    COALESCE(SUM(b.pageviews), 0),
    COUNT(*) FILTER (WHERE b.searches > 0),
    COUNT(*) FILTER (WHERE b.product_views > 0), COALESCE(SUM(b.product_views), 0),
    COUNT(*) FILTER (WHERE b.cart_opens > 0),
    COUNT(*) FILTER (WHERE b.add_to_cart > 0), COALESCE(SUM(b.add_to_cart), 0),
    COUNT(*) FILTER (WHERE b.submit_clicks > 0), COALESCE(SUM(b.submit_clicks), 0),
    COUNT(*) FILTER (WHERE b.quotes_created > 0), COALESCE(SUM(b.quotes_created), 0),
    COUNT(*) FILTER (WHERE b.is_bounce),
    now(), NULL
  FROM app.engagement_buyer_daily b
  WHERE b.tenant_id = p_tenant_id AND b.day = p_day
  ON CONFLICT (tenant_id, day) DO UPDATE SET
    dau = EXCLUDED.dau, wau = EXCLUDED.wau, mau = EXCLUDED.mau, new_buyers = EXCLUDED.new_buyers,
    returning_buyers = EXCLUDED.returning_buyers, login_buyers = EXCLUDED.login_buyers, sessions = EXCLUDED.sessions,
    pageviews = EXCLUDED.pageviews, search_buyers = EXCLUDED.search_buyers, product_view_buyers = EXCLUDED.product_view_buyers,
    product_views = EXCLUDED.product_views, cart_open_buyers = EXCLUDED.cart_open_buyers,
    add_to_cart_buyers = EXCLUDED.add_to_cart_buyers, add_to_cart_events = EXCLUDED.add_to_cart_events,
    submit_click_buyers = EXCLUDED.submit_click_buyers, submit_clicks = EXCLUDED.submit_clicks,
    quote_buyers = EXCLUDED.quote_buyers, quotes_created = EXCLUDED.quotes_created, bounce_buyers = EXCLUDED.bounce_buyers,
    source_synced_at = EXCLUDED.source_synced_at, deleted_at = NULL;

  -- no activity that day: keep an explicit zero row so charts have no gaps
  INSERT INTO app.engagement_tenant_daily (tenant_id, day, sessions, source_synced_at)
  SELECT p_tenant_id, p_day, COALESCE((p_totals->>'sessions')::int, 0), now()
  WHERE NOT EXISTS (SELECT 1 FROM app.engagement_buyer_daily b WHERE b.tenant_id = p_tenant_id AND b.day = p_day)
  ON CONFLICT (tenant_id, day) DO UPDATE SET
    dau = 0, wau = (SELECT COUNT(DISTINCT w.buyer_id) FROM app.engagement_buyer_daily w WHERE w.tenant_id = p_tenant_id AND w.day BETWEEN p_day - 6 AND p_day),
    mau = (SELECT COUNT(DISTINCT m.buyer_id) FROM app.engagement_buyer_daily m WHERE m.tenant_id = p_tenant_id AND m.day BETWEEN p_day - 29 AND p_day),
    new_buyers = 0, returning_buyers = 0, login_buyers = 0, pageviews = 0, search_buyers = 0, product_view_buyers = 0,
    product_views = 0, cart_open_buyers = 0, add_to_cart_buyers = 0, add_to_cart_events = 0, submit_click_buyers = 0,
    submit_clicks = 0, quote_buyers = 0, quotes_created = 0, bounce_buyers = 0,
    sessions = EXCLUDED.sessions, source_synced_at = EXCLUDED.source_synced_at, deleted_at = NULL;

  -- buyers: raise last_login_at (OTP) and last_active_at (any activity); never lower.
  UPDATE app.buyers b
  SET last_login_at = GREATEST(b.last_login_at, x.login_at),
      last_active_at = GREATEST(b.last_active_at, x.active_at, x.login_at)
  FROM (
    SELECT NULLIF(r->>'buyer_id', '')::uuid AS buyer_id,
      NULLIF(r->>'last_login_at', '')::timestamptz AS login_at,
      NULLIF(r->>'last_event_at', '')::timestamptz AS active_at
    FROM jsonb_array_elements(COALESCE(p_buyers, '[]'::jsonb)) r
  ) x
  WHERE b.id = x.buyer_id AND b.tenant_id = p_tenant_id
    AND (
      (x.login_at IS NOT NULL AND (b.last_login_at IS NULL OR b.last_login_at < x.login_at))
      OR (x.active_at IS NOT NULL AND (b.last_active_at IS NULL OR b.last_active_at < x.active_at))
    );

  PERFORM app.engagement_refresh_active_windows(p_tenant_id);

  RETURN jsonb_build_object('tenant_id', p_tenant_id, 'day', p_day, 'buyers', v_buyers, 'products', v_products);
END
$$;
REVOKE ALL ON FUNCTION app.engagement_apply_daily(uuid, date, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.engagement_apply_daily(uuid, date, jsonb, jsonb, jsonb) TO service_role;

-- Daily run: 22:00 UTC = 03:30 IST. Runs after inbox-entries-daily-refresh (21:30 UTC) and well before
-- ops-daily-rollup (03:15 UTC / 08:45 IST). The edge function syncs the last two closed IST days.
-- Same cron -> net.http_post -> edge function pattern as ops-daily-digest-send.
DO $cron$
BEGIN
  PERFORM cron.unschedule('posthog-engagement-sync') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'posthog-engagement-sync');
  PERFORM cron.schedule(
    'posthog-engagement-sync',
    '0 22 * * *',
    $job$
    select net.http_post(
      url := app.get_functions_base_url() || '/posthog-engagement-sync',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-push-secret', app.get_integrations_dispatch_secret()
      ),
      body := jsonb_build_object('day', (((now() at time zone 'Asia/Kolkata')::date) - 1)::text, 'days', 2),
      timeout_milliseconds := 20000
    );
    $job$
  );
END
$cron$;
