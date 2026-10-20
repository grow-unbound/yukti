-- Pulse v2 P3 bands, computed at request time from raw tables for a caller-chosen IST window [p_from, p_to_excl):
--   get_pulse_sellthrough  quoted vs invoiced by category / brand / product (app documents only)
--   get_pulse_customers    top customers by app-invoiced and quoted value, concentration, ticket size
--   get_pulse_patterns     weekday rhythm of quotes and quote conversion by quote size
-- Same contract as 20261018080410_pulse_v2_window_rpcs.sql: SECURITY DEFINER, tenant from the verified route claim,
-- service_role only, bounded statement_timeout, window cap via app._pulse_check_window.
-- Line level reads filter documents by tenant + day first, then join items by document id (items have no tenant_id).

CREATE OR REPLACE FUNCTION app.get_pulse_sellthrough(
  p_tenant_id uuid,
  p_from date,
  p_to_excl date,
  p_dimension text DEFAULT 'category',
  p_limit integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 8), 1), 50);
  v_rows jsonb;
  v_totals jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_dimension IS NULL OR p_dimension NOT IN ('category', 'brand', 'product') THEN
    RAISE EXCEPTION 'invalid_dimension' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 92);

  WITH est AS (
    SELECT e.id FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
  ), inv AS (
    SELECT i.id FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.is_buyer_app_invoice
      AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p_to_excl
  ), lines AS (
    SELECT ei.tenant_product_id, ei.estimate_id AS doc_id, ei.qty,
           COALESCE(ei.line_total, ei.qty * COALESCE(ei.unit_price, 0)) AS amt, true AS is_quote
    FROM est JOIN app.estimate_items ei ON ei.estimate_id = est.id AND ei.deleted_at IS NULL
    UNION ALL
    SELECT ii.tenant_product_id, ii.invoice_id, ii.qty,
           COALESCE(ii.line_total, ii.qty * ii.unit_price), false
    FROM inv JOIN app.invoice_items ii ON ii.invoice_id = inv.id AND ii.deleted_at IS NULL
  ), keyed AS (
    SELECT
      CASE p_dimension
        WHEN 'product' THEN tp.id
        WHEN 'brand' THEN tp.tenant_brand_id
        ELSE tp.tenant_category_id
      END AS k,
      CASE p_dimension
        WHEN 'product' THEN COALESCE(tp.name_override, cp.name, tp.internal_sku)
        WHEN 'brand' THEN COALESCE(tb.display_name_override, cb.name, 'Other')
        ELSE COALESCE(tc.name, 'Uncategorised')
      END AS label,
      l.doc_id, l.qty, l.amt, l.is_quote
    FROM lines l
    JOIN app.tenant_products tp ON tp.id = l.tenant_product_id AND tp.tenant_id = p_tenant_id
    LEFT JOIN catalog.products cp ON p_dimension = 'product' AND cp.id = tp.master_product_id
    LEFT JOIN app.tenant_brands tb ON p_dimension = 'brand' AND tb.id = tp.tenant_brand_id
    LEFT JOIN catalog.brands cb ON p_dimension = 'brand' AND cb.id = tb.master_brand_id
    LEFT JOIN app.tenant_categories tc ON p_dimension = 'category' AND tc.id = tp.tenant_category_id
  ), agg AS (
    SELECT k, max(label) AS label,
           COALESCE(sum(amt) FILTER (WHERE is_quote), 0) AS quoted_value,
           COALESCE(sum(qty) FILTER (WHERE is_quote), 0) AS quoted_qty,
           count(DISTINCT doc_id) FILTER (WHERE is_quote) AS quoted_docs,
           COALESCE(sum(amt) FILTER (WHERE NOT is_quote), 0) AS invoiced_value,
           COALESCE(sum(qty) FILTER (WHERE NOT is_quote), 0) AS invoiced_qty,
           count(DISTINCT doc_id) FILTER (WHERE NOT is_quote) AS invoiced_docs
    FROM keyed GROUP BY k
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'id', t.k, 'name', t.label,
                'quoted_value', t.quoted_value, 'quoted_qty', t.quoted_qty, 'quoted_docs', t.quoted_docs,
                'invoiced_value', t.invoiced_value, 'invoiced_qty', t.invoiced_qty, 'invoiced_docs', t.invoiced_docs)
              ORDER BY t.invoiced_value DESC, t.quoted_value DESC, t.label)
              FROM (SELECT * FROM agg ORDER BY invoiced_value DESC, quoted_value DESC, label LIMIT v_limit) t), '[]'::jsonb),
    jsonb_build_object(
      'quoted_value', COALESCE((SELECT sum(quoted_value) FROM agg), 0),
      'invoiced_value', COALESCE((SELECT sum(invoiced_value) FROM agg), 0),
      'items', (SELECT count(*) FROM agg))
  INTO v_rows, v_totals;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to_excl', p_to_excl),
    'dimension', p_dimension,
    'rows', v_rows,
    'totals', v_totals,
    'generated_at', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.get_pulse_customers(
  p_tenant_id uuid,
  p_from date,
  p_to_excl date,
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_top jsonb;
  v_summary jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 366);

  WITH inv AS (
    SELECT i.buyer_id, i.total_amount, app.metric_day_ist(i.invoice_date, i.created_at) AS d
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.is_buyer_app_invoice AND i.buyer_id IS NOT NULL
      AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p_to_excl
  ), dem AS (
    SELECT e.buyer_id, e.total_amount, app.metric_day_ist(e.estimate_date, e.created_at) AS d
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
    UNION ALL
    SELECT o.buyer_id, o.total_amount, app.metric_day_ist(o.order_date, o.created_at)
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND o.buyer_id IS NOT NULL
      AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= p_from
      AND app.metric_day_ist(o.order_date, o.created_at) < p_to_excl
  ), per_buyer AS (
    SELECT COALESCE(a.buyer_id, q.buyer_id) AS buyer_id,
           COALESCE(a.v, 0) AS invoiced_value, COALESCE(a.n, 0) AS invoiced_docs,
           COALESCE(q.v, 0) AS quoted_value, COALESCE(q.n, 0) AS quoted_docs,
           GREATEST(a.last_d, q.last_d) AS last_day
    FROM (SELECT buyer_id, sum(total_amount) AS v, count(*) AS n, max(d) AS last_d FROM inv GROUP BY buyer_id) a
    FULL JOIN (SELECT buyer_id, sum(total_amount) AS v, count(*) AS n, max(d) AS last_d FROM dem GROUP BY buyer_id) q
      ON q.buyer_id = a.buyer_id
  ), ranked AS (
    SELECT pb.*, COALESCE(b.business_name, 'Customer') AS name,
           row_number() OVER (ORDER BY pb.invoiced_value DESC, pb.quoted_value DESC, pb.buyer_id) AS rn
    FROM per_buyer pb
    LEFT JOIN app.buyers b ON b.id = pb.buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'buyer_id', r.buyer_id, 'name', r.name,
                'invoiced_value', r.invoiced_value, 'invoiced_docs', r.invoiced_docs,
                'quoted_value', r.quoted_value, 'quoted_docs', r.quoted_docs, 'last_day', r.last_day) ORDER BY r.rn)
              FROM ranked r WHERE r.rn <= v_limit), '[]'::jsonb),
    jsonb_build_object(
      'buyers', (SELECT count(*) FROM per_buyer),
      'invoicing_buyers', (SELECT count(*) FROM per_buyer WHERE invoiced_docs > 0),
      'repeat_buyers', (SELECT count(*) FROM per_buyer WHERE invoiced_docs >= 2),
      'invoiced_value', COALESCE((SELECT sum(invoiced_value) FROM per_buyer), 0),
      'top3_invoiced_value', COALESCE((SELECT sum(invoiced_value) FROM ranked WHERE rn <= 3), 0),
      'avg_invoice', (SELECT avg(total_amount) FROM inv),
      'median_invoice', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_amount) FROM inv))
  INTO v_top, v_summary;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to_excl', p_to_excl),
    'top', v_top,
    'summary', v_summary,
    'generated_at', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.get_pulse_patterns(
  p_tenant_id uuid,
  p_from date,
  p_to_excl date,
  p_large_quote_min numeric DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_weekdays jsonb;
  v_sizes jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app._pulse_check_window(p_from, p_to_excl, 366);

  WITH est AS (
    SELECT e.status, e.total_amount, app.metric_day_ist(e.estimate_date, e.created_at) AS d
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND e.buyer_id IS NOT NULL
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
  ), wd AS (
    SELECT extract(isodow FROM d)::int AS dow, count(*) AS quotes, COALESCE(sum(total_amount), 0) AS value
    FROM est GROUP BY 1
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('dow', g.dow, 'quotes', COALESCE(wd.quotes, 0), 'value', COALESCE(wd.value, 0)) ORDER BY g.dow)
              FROM generate_series(1, 7) AS g(dow) LEFT JOIN wd ON wd.dow = g.dow), '[]'::jsonb),
    jsonb_build_object(
      'threshold', p_large_quote_min,
      'large', jsonb_build_object(
        'count', count(*) FILTER (WHERE total_amount >= p_large_quote_min),
        'converted', count(*) FILTER (WHERE total_amount >= p_large_quote_min AND status IN ('invoiced', 'converted')),
        'lost', count(*) FILTER (WHERE total_amount >= p_large_quote_min AND status IN ('expired', 'declined')),
        'open', count(*) FILTER (WHERE total_amount >= p_large_quote_min AND status IN ('sent', 'accepted'))),
      'small', jsonb_build_object(
        'count', count(*) FILTER (WHERE total_amount < p_large_quote_min),
        'converted', count(*) FILTER (WHERE total_amount < p_large_quote_min AND status IN ('invoiced', 'converted')),
        'lost', count(*) FILTER (WHERE total_amount < p_large_quote_min AND status IN ('expired', 'declined')),
        'open', count(*) FILTER (WHERE total_amount < p_large_quote_min AND status IN ('sent', 'accepted'))))
  INTO v_weekdays, v_sizes
  FROM est;

  RETURN jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to_excl', p_to_excl),
    'weekdays', v_weekdays,
    'quote_sizes', v_sizes,
    'generated_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION app.get_pulse_sellthrough(uuid, date, date, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_pulse_customers(uuid, date, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.get_pulse_patterns(uuid, date, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_pulse_sellthrough(uuid, date, date, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app.get_pulse_customers(uuid, date, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app.get_pulse_patterns(uuid, date, date, numeric) TO service_role;

COMMENT ON FUNCTION app.get_pulse_sellthrough(uuid, date, date, text, integer) IS 'Pulse v2 sell-through: app-quoted vs app-invoiced value and quantity by category, brand or product for a window of at most 92 days. service_role only.';
COMMENT ON FUNCTION app.get_pulse_customers(uuid, date, date, integer) IS 'Pulse v2 customers: top buyers by app-invoiced and quoted value, repeat buyers, concentration and ticket size for a window. service_role only.';
COMMENT ON FUNCTION app.get_pulse_patterns(uuid, date, date, numeric) IS 'Pulse v2 patterns: quotes by IST weekday and quote outcomes split at a large-quote threshold for a window. service_role only.';
