-- Pulse gap 3: the "active_buyer_count" naming trap.
--
-- app.metrics_tenant_now_summary.active_buyer_count was COUNT(*) of every non-deleted buyer (12,914 on the
-- largest tenant), and every reader used it as "total customers" (denominators, "inactive = total - purchasing").
-- It is renamed in meaning, not in rows:
--   * total_buyer_count      all non-deleted buyers (what readers actually wanted); readers repointed here.
--   * active_buyer_7d/30d/90d_count   buyers with last_active_at inside the trailing IST-day window.
--   * active_buyer_count     now equals the 30-day active count (MAU-style), the conventional "active".
--
-- Definition. A buyer is ACTIVE in a window if it had any buyer-app activity (login, browse, search, cart,
-- quote/order) inside it. app.buyers.last_login_at (successful OTP login) is a strict subset signal and is
-- kept separately. last_active_at is a high-water mark (only ever raised) fed by (1) live login stamping,
-- (2) the daily PostHog engagement sync, (3) first-party buyer-app orders/estimates/activity rows (seeded
-- once below). Windowed distinct-user counts over a last-seen timestamp is what large products do too;
-- at billions of users they use sketches/streaming rollups, which is unnecessary at our scale.

ALTER TABLE app.buyers ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_buyers_tenant_last_active
  ON app.buyers (tenant_id, last_active_at)
  WHERE deleted_at IS NULL AND last_active_at IS NOT NULL;

ALTER TABLE app.metrics_tenant_now_summary
  ADD COLUMN IF NOT EXISTS total_buyer_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_buyer_7d_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_buyer_30d_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_buyer_90d_count bigint NOT NULL DEFAULT 0;

-- Preserve current readers: total_buyer_count takes the old active_buyer_count value before readers move.
UPDATE app.metrics_tenant_now_summary
SET total_buyer_count = active_buyer_count
WHERE total_buyer_count = 0 AND active_buyer_count > 0;

-- One-time seed of last_active_at from first-party signals (monotonic: never lowers an existing value).
UPDATE app.buyers b
SET last_active_at = s.t
FROM (
  SELECT buyer_id, MAX(t) AS t
  FROM (
    SELECT a.buyer_id, MAX(a.occurred_at) AS t
      FROM app.buyer_app_activity a
      WHERE a.deleted_at IS NULL AND a.qualifies_for_engagement GROUP BY a.buyer_id
    UNION ALL
    SELECT id, last_login_at FROM app.buyers WHERE last_login_at IS NOT NULL
    UNION ALL
    SELECT e.buyer_id, MAX(e.created_at) FROM app.estimates e
      WHERE e.deleted_at IS NULL AND e.is_buyer_app_estimate GROUP BY e.buyer_id
    UNION ALL
    SELECT o.buyer_id, MAX(COALESCE(o.placed_at, o.created_at)) FROM app.orders o
      WHERE o.deleted_at IS NULL AND o.is_buyer_app_order GROUP BY o.buyer_id
  ) x
  WHERE buyer_id IS NOT NULL AND t IS NOT NULL
  GROUP BY buyer_id
) s
WHERE b.id = s.buyer_id AND (b.last_active_at IS NULL OR b.last_active_at < s.t);

-- Cheap, tenant-scoped recompute used by the daily sync (windows move with time, not with dirty rows).
CREATE OR REPLACE FUNCTION app.engagement_refresh_active_windows(p_tenant_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $$
  UPDATE app.metrics_tenant_now_summary s
  SET active_buyer_7d_count = x.c7,
      active_buyer_30d_count = x.c30,
      active_buyer_90d_count = x.c90,
      active_buyer_count = x.c30,
      total_buyer_count = x.total
  FROM (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE (b.last_active_at AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 6) AS c7,
      COUNT(*) FILTER (WHERE (b.last_active_at AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 29) AS c30,
      COUNT(*) FILTER (WHERE (b.last_active_at AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 89) AS c90
    FROM app.buyers b
    WHERE b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
  ) x
  WHERE s.tenant_id = p_tenant_id AND s.deleted_at IS NULL;
$$;
REVOKE ALL ON FUNCTION app.engagement_refresh_active_windows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.engagement_refresh_active_windows(uuid) TO service_role;

CREATE OR REPLACE FUNCTION pg_temp.patch_fn(p_def text, p_old text, p_new text, p_expect integer, p_label text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_hits integer;
BEGIN
  v_hits := (length(p_def) - length(replace(p_def, p_old, ''))) / greatest(length(p_old), 1);
  IF v_hits <> p_expect THEN
    RAISE EXCEPTION 'pulse patch % expected % anchor hit(s), found %', p_label, p_expect, v_hits;
  END IF;
  RETURN replace(p_def, p_old, p_new);
END $$;

DO $patch$
DECLARE
  v_def text;
  v_win text := $w$COALESCE((SELECT COUNT(*) FROM app.buyers WHERE tenant_id = p_tenant_id AND deleted_at IS NULL AND (last_active_at AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - %s),0)$w$;
BEGIN
  -- setup-now refresh writes the new columns (total + trailing windows)
  v_def := pg_get_functiondef('app._metrics_v4_refresh_setup_now(uuid,timestamptz)'::regprocedure);
  v_def := pg_temp.patch_fn(v_def,
    '    active_buyer_count, active_brand_count, active_product_count, active_category_count, active_location_count,',
    '    active_buyer_count, total_buyer_count, active_buyer_7d_count, active_buyer_30d_count, active_buyer_90d_count, active_brand_count, active_product_count, active_category_count, active_location_count,',
    1, 'setup_now cols');
  v_def := pg_temp.patch_fn(v_def,
$a$    COALESCE((SELECT COUNT(*) FROM app.buyers WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),
    COALESCE((SELECT COUNT(*) FROM app.tenant_brands WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),$a$,
    '    ' || format(v_win, '29') || E',\n'
      || '    COALESCE((SELECT COUNT(*) FROM app.buyers WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),' || E'\n'
      || '    ' || format(v_win, '6') || E',\n'
      || '    ' || format(v_win, '29') || E',\n'
      || '    ' || format(v_win, '89') || E',\n'
      || '    COALESCE((SELECT COUNT(*) FROM app.tenant_brands WHERE tenant_id = p_tenant_id AND deleted_at IS NULL),0),',
    1, 'setup_now values');
  v_def := pg_temp.patch_fn(v_def,
    '    active_buyer_count = EXCLUDED.active_buyer_count,',
    E'    active_buyer_count = EXCLUDED.active_buyer_count,\n    total_buyer_count = EXCLUDED.total_buyer_count,\n    active_buyer_7d_count = EXCLUDED.active_buyer_7d_count,\n    active_buyer_30d_count = EXCLUDED.active_buyer_30d_count,\n    active_buyer_90d_count = EXCLUDED.active_buyer_90d_count,',
    1, 'setup_now conflict');
  EXECUTE v_def;

  -- readers that mean "all customers" move to total_buyer_count
  v_def := pg_get_functiondef('app._metrics_v4_refresh_landing_kpis(uuid,timestamptz,text,date[])'::regprocedure);
  v_def := pg_temp.patch_fn(v_def, 'v_now_summary.active_buyer_count', 'v_now_summary.total_buyer_count', 5, 'landing_kpis total');
  EXECUTE v_def;

  v_def := pg_get_functiondef('app.get_buyer_app_dashboard_v4(uuid,text,uuid[],timestamptz)'::regprocedure);
  v_def := pg_temp.patch_fn(v_def, 'v_now_summary.active_buyer_count', 'v_now_summary.total_buyer_count', 1, 'dashboard_v4 total');
  EXECUTE v_def;

  v_def := pg_get_functiondef('app.get_seller_dashboard_customer_activity_v4(uuid)'::regprocedure);
  v_def := pg_temp.patch_fn(v_def, 'active_buyer_count', 'total_buyer_count', 2, 'customer_activity total');
  EXECUTE v_def;
END
$patch$;

-- Windows for every tenant now (the seed above ran after the last refresh).
DO $win$
DECLARE r record;
BEGIN
  FOR r IN SELECT tenant_id FROM app.metrics_tenant_now_summary WHERE deleted_at IS NULL LOOP
    PERFORM app.engagement_refresh_active_windows(r.tenant_id);
  END LOOP;
END
$win$;
