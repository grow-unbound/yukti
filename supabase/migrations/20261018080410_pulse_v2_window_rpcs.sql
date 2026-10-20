-- Pulse v2 band RPCs, computed at request time from raw tables for a caller-chosen window (no metrics_* tables).
-- Windows are IST metric days, half-open [p_from, p_to_excl). Compare window is passed explicitly by the caller
-- (the app derives it from the period preset). Called only by the Pulse routes (service_role) after the route has
-- verified the seller_admin claim; tenant id always comes from the verified claim, never from the client.
-- Definitions: app.metric_day_ist, estimate_status_counts_as_demand, order_status_in_flow, invoice_status_gmv_included.

CREATE OR REPLACE FUNCTION app._pulse_check_window(p_from date, p_to_excl date, p_max_days integer)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_from IS NULL OR p_to_excl IS NULL OR p_to_excl <= p_from THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023';
  END IF;
  IF p_to_excl - p_from > p_max_days THEN
    RAISE EXCEPTION 'window_too_long' USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- Per-window headline numbers (one pass over the window's app estimates/orders and gmv-included invoices).
CREATE OR REPLACE FUNCTION app._pulse_window_metrics(p_tenant_id uuid, p_from date, p_to_excl date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH est AS (
    SELECT e.buyer_id, e.status, e.total_amount, e.item_count
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
  ), ord AS (
    SELECT o.buyer_id, o.total_amount
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
      AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= p_from
      AND app.metric_day_ist(o.order_date, o.created_at) < p_to_excl
  ), inv AS (
    SELECT i.buyer_id, i.total_amount, i.is_buyer_app_invoice AS is_app
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p_to_excl
  )
  SELECT jsonb_build_object(
    'demand_value', COALESCE((SELECT sum(total_amount) FROM est), 0) + COALESCE((SELECT sum(total_amount) FROM ord), 0),
    'demand_docs', (SELECT count(*) FROM est) + (SELECT count(*) FROM ord),
    'demand_buyers', (SELECT count(DISTINCT buyer_id) FROM (SELECT buyer_id FROM est UNION ALL SELECT buyer_id FROM ord) q),
    'quotes', jsonb_build_object(
      'count', (SELECT count(*) FROM est),
      'converted', (SELECT count(*) FROM est WHERE status IN ('invoiced', 'converted')),
      'lost', (SELECT count(*) FROM est WHERE status IN ('expired', 'declined')),
      'open', (SELECT count(*) FROM est WHERE status IN ('sent', 'accepted'))
    ),
    'median_quote', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_amount) FROM est),
    'avg_lines', (SELECT avg(item_count) FROM est),
    'app_invoiced_value', COALESCE((SELECT sum(total_amount) FROM inv WHERE is_app), 0),
    'app_invoiced_docs', (SELECT count(*) FROM inv WHERE is_app),
    'app_invoiced_buyers', (SELECT count(DISTINCT buyer_id) FROM inv WHERE is_app),
    'total_invoiced_value', COALESCE((SELECT sum(total_amount) FROM inv), 0),
    'total_invoiced_docs', (SELECT count(*) FROM inv),
    'engaged_buyers', (SELECT count(DISTINCT e.buyer_id) FROM app.buyer_app_engagement e
                       WHERE e.tenant_id = p_tenant_id AND e.occurred_day >= p_from AND e.occurred_day < p_to_excl)
  );
$function$;

CREATE OR REPLACE FUNCTION app.get_pulse_scorecard(
  p_tenant_id uuid,
  p_from date,
  p_to_excl date,
  p_cmp_from date DEFAULT NULL,
  p_cmp_to_excl date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_current jsonb;
  v_previous jsonb;
  v_open jsonb;
  v_buyers jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 366);
  IF p_cmp_from IS NOT NULL THEN
    PERFORM app._pulse_check_window(p_cmp_from, p_cmp_to_excl, 366);
  END IF;

  v_current := app._pulse_window_metrics(p_tenant_id, p_from, p_to_excl);
  v_previous := CASE WHEN p_cmp_from IS NULL THEN NULL
                     ELSE app._pulse_window_metrics(p_tenant_id, p_cmp_from, p_cmp_to_excl) END;

  -- Quotes waiting on the seller right now (state, not windowed).
  SELECT jsonb_build_object(
    'count', count(*),
    'value', COALESCE(sum(e.total_amount), 0),
    'oldest_at', min(e.created_at),
    'older_than_48h_count', count(*) FILTER (WHERE e.created_at < now() - interval '48 hours'),
    'older_than_48h_value', COALESCE(sum(e.total_amount) FILTER (WHERE e.created_at < now() - interval '48 hours'), 0)
  ) INTO v_open
  FROM app.estimates e
  WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate
    AND e.status IN ('sent', 'accepted');

  -- New / returning / reactivated among buyers who quoted in the window.
  WITH quoted AS (
    SELECT DISTINCT q.buyer_id FROM (
      SELECT e.buyer_id FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
        AND app.estimate_status_counts_as_demand(e.status)
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from
        AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
      UNION ALL
      SELECT o.buyer_id FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
        AND app.order_status_in_flow(o.status)
        AND app.metric_day_ist(o.order_date, o.created_at) >= p_from
        AND app.metric_day_ist(o.order_date, o.created_at) < p_to_excl
    ) q
  ), first_day AS (
    SELECT qd.buyer_id, min(qd.d) AS fd FROM (
      SELECT e.buyer_id, app.metric_day_ist(e.estimate_date, e.created_at) AS d FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate
        AND e.buyer_id IN (SELECT buyer_id FROM quoted) AND app.estimate_status_counts_as_demand(e.status)
      UNION ALL
      SELECT o.buyer_id, app.metric_day_ist(o.order_date, o.created_at) FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order
        AND o.buyer_id IN (SELECT buyer_id FROM quoted) AND app.order_status_in_flow(o.status)
    ) qd GROUP BY qd.buyer_id
  ), classed AS (
    SELECT fd.buyer_id,
      CASE
        WHEN fd.fd >= p_from THEN 'new'
        WHEN EXISTS (SELECT 1 FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.buyer_id = fd.buyer_id AND i.deleted_at IS NULL
                       AND app.invoice_status_gmv_included(i.status)
                       AND app.metric_day_ist(i.invoice_date, i.created_at) < p_from)
             AND NOT EXISTS (SELECT 1 FROM app.invoices i WHERE i.tenant_id = p_tenant_id AND i.buyer_id = fd.buyer_id AND i.deleted_at IS NULL
                       AND app.invoice_status_gmv_included(i.status)
                       AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from - 90
                       AND app.metric_day_ist(i.invoice_date, i.created_at) < p_from)
          THEN 'reactivated'
        ELSE 'returning'
      END AS kind
    FROM first_day fd
  )
  SELECT jsonb_build_object(
    'new', count(*) FILTER (WHERE kind = 'new'),
    'returning', count(*) FILTER (WHERE kind = 'returning'),
    'reactivated', count(*) FILTER (WHERE kind = 'reactivated')
  ) INTO v_buyers FROM classed;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to_excl', p_to_excl),
    'compare_window', CASE WHEN p_cmp_from IS NULL THEN NULL
                           ELSE jsonb_build_object('from', p_cmp_from, 'to_excl', p_cmp_to_excl) END,
    'current', v_current,
    'previous', v_previous,
    'open_quotes', v_open,
    'quoting_buyers', v_buyers,
    'generated_at', now()
  );
END;
$function$;

-- One definition for the four "act now" groups; used by the summary and the paged list.
-- score orders rows inside a group (highest first); value is the rupee evidence for the group.
CREATE OR REPLACE FUNCTION app._pulse_group_rows(p_tenant_id uuid, p_group text, p_from date, p_to_excl date)
RETURNS TABLE (buyer_id uuid, name text, value numeric, n integer, last_day date, score numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_as_of date := LEAST((now() AT TIME ZONE 'Asia/Kolkata')::date, p_to_excl - 1);
BEGIN
  IF p_group = 'quotes_waiting' THEN
    RETURN QUERY
    SELECT e.buyer_id, COALESCE(b.business_name, 'Customer'), COALESCE(sum(e.total_amount), 0)::numeric, count(*)::int,
           min(app.metric_day_ist(e.estimate_date, e.created_at)), COALESCE(sum(e.total_amount), 0)::numeric
    FROM app.estimates e
    JOIN app.buyers b ON b.id = e.buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate
      AND e.status IN ('sent', 'accepted') AND e.created_at < now() - interval '48 hours'
    GROUP BY e.buyer_id, b.business_name;

  ELSIF p_group = 'browse_no_quote' THEN
    RETURN QUERY
    WITH br AS (
      SELECT a.buyer_id, count(DISTINCT a.occurred_day)::int AS days, max(a.occurred_day) AS last_day
      FROM app.buyer_app_activity a
      WHERE a.tenant_id = p_tenant_id AND a.deleted_at IS NULL AND a.qualifies_for_engagement
        AND a.event_name = 'catalog_viewed' AND a.occurred_day >= p_from AND a.occurred_day < p_to_excl
      GROUP BY a.buyer_id
    ), quoters AS (
      SELECT e.buyer_id FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
        AND app.estimate_status_counts_as_demand(e.status)
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
      UNION
      SELECT o.buyer_id FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
        AND app.order_status_in_flow(o.status)
        AND app.metric_day_ist(o.order_date, o.created_at) >= p_from AND app.metric_day_ist(o.order_date, o.created_at) < p_to_excl
    )
    SELECT br.buyer_id, COALESCE(b.business_name, 'Customer'), 0::numeric, br.days, br.last_day, br.days::numeric
    FROM br
    JOIN app.buyers b ON b.id = br.buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND b.is_active
    WHERE NOT EXISTS (SELECT 1 FROM quoters q WHERE q.buyer_id = br.buyer_id);

  ELSIF p_group = 'went_quiet' THEN
    RETURN QUERY
    WITH qb AS (
      SELECT x.buyer_id, sum(x.amt) AS v, count(*)::int AS n, max(x.d) AS last_quote_day FROM (
        SELECT e.buyer_id, e.total_amount AS amt, app.metric_day_ist(e.estimate_date, e.created_at) AS d
        FROM app.estimates e
        WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
          AND app.estimate_status_counts_as_demand(e.status)
        UNION ALL
        SELECT o.buyer_id, o.total_amount, app.metric_day_ist(o.order_date, o.created_at)
        FROM app.orders o
        WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
          AND app.order_status_in_flow(o.status)
      ) x GROUP BY x.buyer_id
    )
    SELECT qb.buyer_id, COALESCE(b.business_name, 'Customer'), COALESCE(qb.v, 0)::numeric, qb.n,
           GREATEST(qb.last_quote_day, led.last_day), COALESCE(qb.v, 0)::numeric
    FROM qb
    JOIN app.buyers b ON b.id = qb.buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND b.is_active
    LEFT JOIN LATERAL (
      SELECT max(a.occurred_day) AS last_day FROM app.buyer_app_activity a
      WHERE a.tenant_id = p_tenant_id AND a.buyer_id = qb.buyer_id AND a.deleted_at IS NULL AND a.qualifies_for_engagement
    ) led ON true
    WHERE GREATEST(qb.last_quote_day, led.last_day) < v_as_of - 30;

  ELSIF p_group = 'valuable_without_access' THEN
    RETURN QUERY
    SELECT i.buyer_id, COALESCE(b.business_name, 'Customer'), COALESCE(sum(i.total_amount), 0)::numeric, count(*)::int,
           max(app.metric_day_ist(i.invoice_date, i.created_at)), COALESCE(sum(i.total_amount), 0)::numeric
    FROM app.invoices i
    JOIN app.buyers b ON b.id = i.buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL AND b.is_active
                     AND NOT b.buyer_app_enabled
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p_to_excl
    GROUP BY i.buyer_id, b.business_name
    HAVING sum(i.total_amount) >= 10000;

  ELSE
    RAISE EXCEPTION 'invalid_group' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION app.get_pulse_act_now(
  p_tenant_id uuid,
  p_from date,
  p_to_excl date,
  p_preview_limit integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_preview_limit, 5), 1), 20);
  v_groups jsonb := '[]'::jsonb;
  v_group text;
  v_item jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 366);

  FOREACH v_group IN ARRAY ARRAY['quotes_waiting', 'browse_no_quote', 'went_quiet', 'valuable_without_access'] LOOP
    SELECT jsonb_build_object(
      'id', v_group,
      'count', count(*),
      'value', COALESCE(sum(r.value), 0),
      'previews', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'buyer_id', t.buyer_id, 'name', t.name, 'value', t.value, 'n', t.n, 'last_day', t.last_day)
               ORDER BY t.score DESC, t.buyer_id)
        FROM (SELECT * FROM app._pulse_group_rows(p_tenant_id, v_group, p_from, p_to_excl) x
              ORDER BY x.score DESC, x.buyer_id LIMIT v_limit) t
      ), '[]'::jsonb)
    ) INTO v_item
    FROM app._pulse_group_rows(p_tenant_id, v_group, p_from, p_to_excl) r;
    IF (v_item ->> 'count')::int > 0 THEN
      v_groups := v_groups || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to_excl', p_to_excl),
    'groups', v_groups,
    'generated_at', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.get_pulse_opportunity_buyers(
  p_tenant_id uuid,
  p_group text,
  p_from date,
  p_to_excl date,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 10000);
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 366);

  SELECT jsonb_build_object(
    'id', p_group,
    'total', (SELECT count(*) FROM app._pulse_group_rows(p_tenant_id, p_group, p_from, p_to_excl)),
    'value', (SELECT COALESCE(sum(value), 0) FROM app._pulse_group_rows(p_tenant_id, p_group, p_from, p_to_excl)),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'buyer_id', t.buyer_id, 'name', t.name, 'value', t.value, 'n', t.n, 'last_day', t.last_day)
             ORDER BY t.score DESC, t.buyer_id)
      FROM (SELECT * FROM app._pulse_group_rows(p_tenant_id, p_group, p_from, p_to_excl) x
            ORDER BY x.score DESC, x.buyer_id LIMIT v_limit OFFSET v_offset) t
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION app.get_pulse_funnel(p_tenant_id uuid, p_from date, p_to_excl date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_funnel jsonb;
  v_days jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 92);

  WITH eng AS (
    SELECT e.buyer_id, e.occurred_day FROM app.buyer_app_engagement e
    WHERE e.tenant_id = p_tenant_id AND e.occurred_day >= p_from AND e.occurred_day < p_to_excl
  ), browse AS (
    SELECT DISTINCT a.buyer_id FROM app.buyer_app_activity a
    WHERE a.tenant_id = p_tenant_id AND a.deleted_at IS NULL AND a.qualifies_for_engagement
      AND a.event_name = 'catalog_viewed' AND a.occurred_day >= p_from AND a.occurred_day < p_to_excl
  ), est AS (
    SELECT e.buyer_id, e.total_amount, app.metric_day_ist(e.estimate_date, e.created_at) AS d
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
  ), ord AS (
    SELECT o.buyer_id, o.total_amount, app.metric_day_ist(o.order_date, o.created_at) AS d
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
      AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= p_from AND app.metric_day_ist(o.order_date, o.created_at) < p_to_excl
  ), quoted AS (
    SELECT buyer_id FROM est UNION SELECT buyer_id FROM ord
  ), invoiced AS (
    SELECT DISTINCT i.buyer_id FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.is_buyer_app_invoice AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from AND app.metric_day_ist(i.invoice_date, i.created_at) < p_to_excl
  )
  SELECT jsonb_build_object(
    'users', (SELECT count(DISTINCT buyer_id) FROM eng),
    'browsed', (SELECT count(*) FROM browse),
    'quoted', (SELECT count(*) FROM quoted),
    'invoiced', (SELECT count(*) FROM invoiced)
  ) INTO v_funnel;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', g.d, 'active_buyers', COALESCE(a.n, 0),
                                               'quotes', COALESCE(q.n, 0), 'quote_value', COALESCE(q.v, 0)) ORDER BY g.d), '[]'::jsonb)
  INTO v_days
  FROM generate_series(p_from, p_to_excl - 1, interval '1 day') AS gs(d0)
  CROSS JOIN LATERAL (SELECT gs.d0::date AS d) g
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT e.buyer_id) AS n FROM app.buyer_app_engagement e
    WHERE e.tenant_id = p_tenant_id AND e.occurred_day = g.d
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(x.total_amount) AS v FROM (
      SELECT e.total_amount FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
        AND app.estimate_status_counts_as_demand(e.status) AND app.metric_day_ist(e.estimate_date, e.created_at) = g.d
      UNION ALL
      SELECT o.total_amount FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
        AND app.order_status_in_flow(o.status) AND app.metric_day_ist(o.order_date, o.created_at) = g.d
    ) x
  ) q ON true;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to_excl', p_to_excl),
    'funnel', v_funnel,
    'days', v_days,
    'generated_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION app._pulse_check_window(date, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._pulse_window_metrics(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._pulse_group_rows(uuid, text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_pulse_scorecard(uuid, date, date, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_pulse_act_now(uuid, date, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_pulse_opportunity_buyers(uuid, text, date, date, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_pulse_funnel(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_pulse_scorecard(uuid, date, date, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION app.get_pulse_act_now(uuid, date, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app.get_pulse_opportunity_buyers(uuid, text, date, date, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app.get_pulse_funnel(uuid, date, date) TO service_role;

COMMENT ON FUNCTION app._pulse_check_window(date, date, integer) IS 'Pulse v2: validates a half-open IST date window and caps its length.';
COMMENT ON FUNCTION app._pulse_window_metrics(uuid, date, date) IS 'Pulse v2: headline demand/invoice/engagement numbers for one window, from estimates, orders, invoices and buyer_app_engagement.';
COMMENT ON FUNCTION app._pulse_group_rows(uuid, text, date, date) IS 'Pulse v2: buyers in one act-now group (quotes_waiting, browse_no_quote, went_quiet, valuable_without_access); single definition shared by summary and paged list.';
COMMENT ON FUNCTION app.get_pulse_scorecard(uuid, date, date, date, date) IS 'Pulse v2 scorecard for a window and optional compare window, computed at request time from raw tables. service_role only.';
COMMENT ON FUNCTION app.get_pulse_act_now(uuid, date, date, integer) IS 'Pulse v2 act-now groups (count, rupee value, top previews) for a window. service_role only.';
COMMENT ON FUNCTION app.get_pulse_opportunity_buyers(uuid, text, date, date, integer, integer) IS 'Pulse v2 paged buyer list for one act-now group. service_role only.';
COMMENT ON FUNCTION app.get_pulse_funnel(uuid, date, date) IS 'Pulse v2 funnel (users, browsed, quoted, invoiced) and per-day activity strip for a window of at most 92 days. service_role only.';
