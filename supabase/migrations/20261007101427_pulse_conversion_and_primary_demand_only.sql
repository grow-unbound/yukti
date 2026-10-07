-- Pulse gaps 1 + 4.
--
-- G1 (understated conversion): the Pulse "invoiced from captured demand" card counted invoices flagged
-- is_buyer_app_invoice. That flag is only reliable once an invoice carries estimate_id/order_id, which
-- Zoho-converted invoices did not before ~27 Sep 2026. For estimate-led tenants the card now counts
-- converted buyer-app *estimates* (status invoiced/converted, same estimate-date cohort as demand), so
-- history is complete without guessing estimate->invoice links. Order-led tenants keep the invoice flag.
-- The flag itself is also re-derived once from the FK links (idempotent; estimate_id is NOT written).
--
-- G4 (double counting): app-sourced demand summed app_estimate_* + app_order_* (and buyer counts). It now
-- follows app.metrics_v4_primary_demand_kind(): orders if sales_orders is enabled, else estimates.
--
-- The two large refresh functions are patched in place from their live definition with asserted anchors
-- (fails loudly if the definition drifted) instead of re-pasting ~110 KB of function bodies.

ALTER TABLE app.metrics_tenant_period_summary
  ADD COLUMN IF NOT EXISTS app_estimate_converted_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS app_estimate_converted_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS app_estimate_converted_buyer_count bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN app.metrics_tenant_period_summary.app_estimate_converted_count IS
  'Buyer-app estimates (is_buyer_app_estimate) dated in the period whose status is invoiced/converted.';

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
  v_q text := $q$(SELECT %s FROM app.metrics_tenant_period_summary WHERE tenant_id = p_tenant_id AND grain = 'quarter' AND period_start = v_quarter.period_start AND deleted_at IS NULL)$q$;
BEGIN
  -- ---- _metrics_v4_refresh_claimed_periods: converted columns (G1) + buyer app_demand by primary (G4)
  v_def := pg_get_functiondef('app._metrics_v4_refresh_claimed_periods(uuid,bigint,uuid,text)'::regprocedure);

  v_def := pg_temp.patch_fn(v_def,
$a$    app_order_count, app_order_value, app_order_buyer_count,
    primary_demand_kind, primary_demand_count, primary_demand_value, primary_demand_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at$a$,
$b$    app_order_count, app_order_value, app_order_buyer_count,
    primary_demand_kind, primary_demand_count, primary_demand_value, primary_demand_buyer_count,
    app_estimate_converted_count, app_estimate_converted_value, app_estimate_converted_buyer_count,
    source_watermark, computed_at, updated_at, deleted_at$b$, 1, 'tenant insert cols');

  v_def := pg_temp.patch_fn(v_def,
$a$    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_buyer_count,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_buyer_count,0) ELSE 0 END,
    GREATEST(inv.watermark, est.watermark, ord.watermark), v_now, v_now, NULL
  FROM pg_temp.metrics_v4_period_keys p$a$,
$b$    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.estimate_buyer_count,0) WHEN v_primary = 'orders' THEN COALESCE(ord.order_buyer_count,0) ELSE 0 END,
    COALESCE(est.app_estimate_converted_count,0), COALESCE(est.app_estimate_converted_value,0), COALESCE(est.app_estimate_converted_buyer_count,0),
    GREATEST(inv.watermark, est.watermark, ord.watermark), v_now, v_now, NULL
  FROM pg_temp.metrics_v4_period_keys p$b$, 1, 'tenant select');

  v_def := pg_temp.patch_fn(v_def,
$a$        COUNT(DISTINCT e.buyer_id) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status)))::bigint AS app_estimate_buyer_count,
        MAX(e.updated_at) AS watermark_h$a$,
$b$        COUNT(DISTINCT e.buyer_id) FILTER (WHERE e.is_buyer_app_estimate AND (app.estimate_status_counts_as_demand(e.status)))::bigint AS app_estimate_buyer_count,
        COUNT(DISTINCT e.id) FILTER (WHERE e.is_buyer_app_estimate AND e.status IN ('invoiced','converted'))::bigint AS app_estimate_converted_count,
        COALESCE(SUM(e.total_amount) FILTER (WHERE e.is_buyer_app_estimate AND e.status IN ('invoiced','converted')),0)::numeric AS app_estimate_converted_value,
        COUNT(DISTINCT e.buyer_id) FILTER (WHERE e.is_buyer_app_estimate AND e.status IN ('invoiced','converted'))::bigint AS app_estimate_converted_buyer_count,
        MAX(e.updated_at) AS watermark_h$b$, 1, 'est hdr');

  v_def := pg_temp.patch_fn(v_def,
$a$      hdr.app_estimate_count, hdr.app_estimate_value, hdr.app_estimate_buyer_count,
      GREATEST(hdr.watermark_h, items.watermark_i) AS watermark
    FROM hdr, items
  ) est ON true$a$,
$b$      hdr.app_estimate_count, hdr.app_estimate_value, hdr.app_estimate_buyer_count,
      hdr.app_estimate_converted_count, hdr.app_estimate_converted_value, hdr.app_estimate_converted_buyer_count,
      GREATEST(hdr.watermark_h, items.watermark_i) AS watermark
    FROM hdr, items
  ) est ON true$b$, 1, 'est select');

  v_def := pg_temp.patch_fn(v_def,
$a$    primary_demand_kind = EXCLUDED.primary_demand_kind, primary_demand_count = EXCLUDED.primary_demand_count, primary_demand_value = EXCLUDED.primary_demand_value, primary_demand_buyer_count = EXCLUDED.primary_demand_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_buyer_period_summary ($a$,
$b$    primary_demand_kind = EXCLUDED.primary_demand_kind, primary_demand_count = EXCLUDED.primary_demand_count, primary_demand_value = EXCLUDED.primary_demand_value, primary_demand_buyer_count = EXCLUDED.primary_demand_buyer_count,
    app_estimate_converted_count = EXCLUDED.app_estimate_converted_count, app_estimate_converted_value = EXCLUDED.app_estimate_converted_value, app_estimate_converted_buyer_count = EXCLUDED.app_estimate_converted_buyer_count,
    source_watermark = EXCLUDED.source_watermark, computed_at = EXCLUDED.computed_at, generation_id = gen_random_uuid(), updated_at = EXCLUDED.updated_at, deleted_at = NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_rows := v_rows + v_count;
  PERFORM app._metrics_check_deadline();

  INSERT INTO app.metrics_buyer_period_summary ($b$, 1, 'tenant conflict');

  v_def := pg_temp.patch_fn(v_def,
$a$    COALESCE(est.app_estimate_count,0) + COALESCE(ord.app_order_count,0),
    COALESCE(est.app_estimate_value,0) + COALESCE(ord.app_order_value,0),$a$,
$b$    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.app_estimate_count,0) WHEN v_primary = 'orders' THEN COALESCE(ord.app_order_count,0) ELSE 0 END,
    CASE WHEN v_primary = 'estimates' THEN COALESCE(est.app_estimate_value,0) WHEN v_primary = 'orders' THEN COALESCE(ord.app_order_value,0) ELSE 0 END,$b$, 1, 'buyer app_demand');

  EXECUTE v_def;

  -- ---- _metrics_v4_refresh_landing_kpis: demand card follows primary kind (G4); converted card (G1)
  v_def := pg_get_functiondef(to_regprocedure('app._metrics_v4_refresh_landing_kpis(uuid,timestamptz,text,date[])'));
  IF v_def IS NULL THEN
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = '_metrics_v4_refresh_landing_kpis';
  END IF;

  v_def := pg_temp.patch_fn(v_def, 'SELECT app_estimate_value + app_order_value FROM',
    $r$SELECT CASE v_primary WHEN 'orders' THEN app_order_value WHEN 'estimates' THEN app_estimate_value ELSE 0 END FROM$r$, 2, 'demand value');
  v_def := pg_temp.patch_fn(v_def, 'SELECT app_estimate_buyer_count + app_order_buyer_count FROM',
    $r$SELECT CASE v_primary WHEN 'orders' THEN app_order_buyer_count WHEN 'estimates' THEN app_estimate_buyer_count ELSE 0 END FROM$r$, 2, 'demand buyers');
  v_def := pg_temp.patch_fn(v_def, 'SELECT app_estimate_count + app_order_count FROM',
    $r$SELECT CASE v_primary WHEN 'orders' THEN app_order_count WHEN 'estimates' THEN app_estimate_count ELSE 0 END FROM$r$, 2, 'demand docs');
  v_def := pg_temp.patch_fn(v_def, 'SELECT estimate_value + order_value FROM',
    'SELECT primary_demand_value FROM', 2, 'demand secondary');

  -- converted card: estimate-led tenants read converted app estimates; others keep the invoice flag
  v_def := regexp_replace(v_def,
    $re$(app\.metrics_v4_kpi\('app_sourced_invoiced_sales_qtd',.*?'is_buyer_app_invoice',true\)\))$re$,
    'CASE WHEN v_primary = ''estimates'' THEN app.metrics_v4_kpi(''app_sourced_invoiced_sales_qtd'', '
      || 'COALESCE(' || format(v_q, 'app_estimate_converted_value') || ',0), '
      || 'COALESCE(' || format(v_q, 'app_estimate_converted_buyer_count') || ',0), '
      || 'COALESCE(' || format(v_q, 'app_estimate_converted_count') || ',0), '
      || 'COALESCE(' || format(v_q, 'app_estimate_value') || ',0), '
      || '''quarter'', jsonb_build_object(''source'',''buyer_app'',''period'',''this_quarter'',''basis'',''estimates_converted'')) '
      || 'ELSE \1 END',
    'g');
  IF v_def NOT LIKE '%estimates_converted%' THEN
    RAISE EXCEPTION 'pulse patch converted card: anchor not found';
  END IF;

  EXECUTE v_def;
END
$patch$;

-- One-time flag backfill: invoices linked (FK) to a buyer-app estimate or order. Idempotent; no estimate_id writes.
UPDATE app.invoices i
SET is_buyer_app_invoice = true
WHERE i.deleted_at IS NULL AND NOT i.is_buyer_app_invoice
  AND (
    EXISTS (SELECT 1 FROM app.estimates e WHERE e.id = i.estimate_id AND e.is_buyer_app_estimate)
    OR EXISTS (SELECT 1 FROM app.estimates e WHERE e.converted_to_invoice_id = i.id AND e.is_buyer_app_estimate)
    OR EXISTS (SELECT 1 FROM app.orders o WHERE o.id = i.order_id AND o.is_buyer_app_order)
  );

-- Populate converted columns on existing tenant summaries (the tick only recomputes dirty periods).
UPDATE app.metrics_tenant_period_summary s
SET app_estimate_converted_count = c.n,
    app_estimate_converted_value = c.v,
    app_estimate_converted_buyer_count = c.b
FROM (
  SELECT s2.id,
    COUNT(DISTINCT e.id) AS n,
    COALESCE(SUM(e.total_amount), 0) AS v,
    COUNT(DISTINCT e.buyer_id) AS b
  FROM app.metrics_tenant_period_summary s2
  LEFT JOIN app.estimates e
    ON e.tenant_id = s2.tenant_id AND e.deleted_at IS NULL
   AND e.is_buyer_app_estimate AND e.status IN ('invoiced','converted')
   AND app.metric_day_ist(e.estimate_date, e.created_at) >= s2.period_start
   AND app.metric_day_ist(e.estimate_date, e.created_at) < s2.period_end_exclusive
  WHERE s2.deleted_at IS NULL
  GROUP BY s2.id
) c
WHERE s.id = c.id AND (s.app_estimate_converted_count, s.app_estimate_converted_value) IS DISTINCT FROM (c.n, c.v);
