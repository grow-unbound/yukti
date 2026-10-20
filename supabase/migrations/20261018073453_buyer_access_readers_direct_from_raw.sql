-- Pulse/access readers stop depending on the metrics_* summary tables (the tick job is being retired):
--  * search_buyer_app_access_v4: last app purchase and month-to-date spend are computed from invoices/orders/estimates
--    for the buyers being enriched (indexed: idx_invoices_is_buyer_app, invoices_metrics_tenant_day_idx, ...).
--  * existing_buyer_context_snapshot: always live (the summary branches are removed); last_buyer_app_activity_at now
--    returns the latest buyer-app invoice/order instead of NULL on the live path.
-- last_buyer_app_activity_at never meant presence: the builder used MAX(buyer-app invoice date, buyer-app order placed_at).

CREATE OR REPLACE FUNCTION app.search_buyer_app_access_v4(p_tenant_id uuid, p_query text DEFAULT NULL::text, p_segment text DEFAULT 'all'::text, p_last_ordered text DEFAULT 'all'::text, p_sort text DEFAULT 'business_name'::text, p_location_ids uuid[] DEFAULT NULL::uuid[], p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_include_summary boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
 SET statement_timeout TO '10s'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_query text := NULLIF(btrim(p_query), '');
  v_ts_query tsquery;
  v_prefix_query_text text;
  v_prefix_ts_query tsquery;
  v_segment text := lower(btrim(COALESCE(p_segment, 'all')));
  v_last_ordered text := lower(btrim(COALESCE(p_last_ordered, 'all')));
  v_sort text := lower(btrim(COALESCE(p_sort, 'business_name')));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 10000);
  v_include_summary boolean := COALESCE(p_include_summary, false);
  v_requires_metric_candidates boolean;
  v_month_start date := date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_30d_ago timestamptz := now() - interval '30 days';
  v_90d_ago timestamptz := now() - interval '90 days';
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required' USING ERRCODE = '22023';
  END IF;

  IF v_segment NOT IN ('all', 'enabled', 'disabled', 'suggested', 'inactive') THEN
    RAISE EXCEPTION 'invalid_segment' USING ERRCODE = '22023';
  END IF;

  IF v_last_ordered NOT IN ('all', '30d', '90d', 'dormant') THEN
    RAISE EXCEPTION 'invalid_last_ordered' USING ERRCODE = '22023';
  END IF;

  IF v_sort NOT IN ('business_name', 'app_gmv', 'offline_spend', 'last_ordered') THEN
    RAISE EXCEPTION 'invalid_sort' USING ERRCODE = '22023';
  END IF;

  v_requires_metric_candidates :=
    v_segment IN ('suggested', 'inactive')
    OR v_last_ordered <> 'all'
    OR v_sort <> 'business_name';

  IF v_query IS NOT NULL THEN
    v_ts_query := websearch_to_tsquery('english', v_query);

    SELECT string_agg(quote_literal(lexeme) || ':*', ' & ' ORDER BY lexeme)
    INTO v_prefix_query_text
    FROM unnest(tsvector_to_array(to_tsvector('english', v_query))) AS terms(lexeme);

    IF v_prefix_query_text IS NOT NULL THEN
      v_prefix_ts_query := to_tsquery('english', v_prefix_query_text);
    END IF;
  END IF;

  WITH scoped_buyers AS MATERIALIZED (
    SELECT
      b.id,
      b.business_name,
      b.contact_name,
      b.phone,
      b.geography,
      b.buyer_app_enabled,
      b.search_vector
    FROM app.buyers b
    WHERE b.tenant_id = p_tenant_id
      AND b.is_active = true
      AND b.deleted_at IS NULL
      AND (
        p_location_ids IS NULL
        OR EXISTS (
          SELECT 1
          FROM app.invoices i
          WHERE i.tenant_id = p_tenant_id
            AND i.buyer_id = b.id
            AND i.location_id = ANY (p_location_ids)
            AND i.deleted_at IS NULL
        )
      )
  ),
  ranked_scoped AS MATERIALIZED (
    SELECT
      sb.*,
      CASE
        WHEN v_query IS NULL THEN 0::real
        WHEN sb.search_vector @@ v_ts_query
          THEN 2.0 + ts_rank_cd(sb.search_vector, v_ts_query)
        ELSE ts_rank_cd(sb.search_vector, v_prefix_ts_query)
      END AS search_rank
    FROM scoped_buyers sb
  ),
  candidate_pool AS MATERIALIZED (
    SELECT rs.*
    FROM ranked_scoped rs
    WHERE (
        v_query IS NULL
        OR rs.search_vector @@ v_ts_query
        OR (v_prefix_ts_query IS NOT NULL AND rs.search_vector @@ v_prefix_ts_query)
      )
      AND CASE v_segment
        WHEN 'enabled' THEN rs.buyer_app_enabled
        WHEN 'disabled' THEN NOT rs.buyer_app_enabled
        WHEN 'suggested' THEN NOT rs.buyer_app_enabled
        WHEN 'inactive' THEN rs.buyer_app_enabled
        ELSE true
      END
  ),
  cheap_page AS MATERIALIZED (
    SELECT cp.*
    FROM candidate_pool cp
    WHERE NOT v_include_summary
      AND NOT v_requires_metric_candidates
    ORDER BY
      CASE WHEN v_query IS NOT NULL THEN cp.search_rank END DESC NULLS LAST,
      cp.business_name ASC,
      cp.id ASC
    LIMIT v_limit
    OFFSET v_offset
  ),
  buyers_to_enrich AS MATERIALIZED (
    SELECT rs.*
    FROM ranked_scoped rs
    WHERE v_include_summary

    UNION ALL

    SELECT cp.*
    FROM candidate_pool cp
    WHERE NOT v_include_summary
      AND v_requires_metric_candidates

    UNION ALL

    SELECT cp.*
    FROM cheap_page cp
    WHERE NOT v_include_summary
      AND NOT v_requires_metric_candidates
  ),
  last_app AS MATERIALIZED (
    -- latest buyer-app purchase (invoice or order) per buyer, straight from the source tables
    SELECT x.buyer_id, MAX(x.at) AS last_at
    FROM (
      SELECT i.buyer_id, i.invoice_date::timestamptz AS at
      FROM app.invoices i
      WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND i.is_buyer_app_invoice
        AND i.buyer_id IN (SELECT id FROM buyers_to_enrich)
      UNION ALL
      SELECT o.buyer_id, o.placed_at
      FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order
        AND o.buyer_id IN (SELECT id FROM buyers_to_enrich)
    ) x
    GROUP BY x.buyer_id
  ),
  mtd AS MATERIALIZED (
    -- month-to-date spend per buyer, same filters the retired summary builder used
    SELECT t.buyer_id,
           COALESCE(SUM(t.inv), 0) AS invoice_value,
           COALESCE(SUM(t.ord), 0) AS app_order_value,
           COALESCE(SUM(t.est), 0) AS app_estimate_value
    FROM (
      SELECT i.buyer_id, i.total_amount AS inv, 0::numeric AS ord, 0::numeric AS est
      FROM app.invoices i
      WHERE i.tenant_id = p_tenant_id AND i.deleted_at IS NULL AND app.invoice_status_gmv_included(i.status)
        AND app.metric_day_ist(i.invoice_date, i.created_at) >= v_month_start
        AND app.metric_day_ist(i.invoice_date, i.created_at) < (v_month_start + interval '1 month')::date
        AND i.buyer_id IN (SELECT id FROM buyers_to_enrich)
      UNION ALL
      SELECT o.buyer_id, 0::numeric, o.total_amount, 0::numeric
      FROM app.orders o
      WHERE o.tenant_id = p_tenant_id AND o.deleted_at IS NULL AND o.is_buyer_app_order AND app.order_status_in_flow(o.status)
        AND app.metric_day_ist(o.order_date, o.created_at) >= v_month_start
        AND app.metric_day_ist(o.order_date, o.created_at) < (v_month_start + interval '1 month')::date
        AND o.buyer_id IN (SELECT id FROM buyers_to_enrich)
      UNION ALL
      SELECT e.buyer_id, 0::numeric, 0::numeric, e.total_amount
      FROM app.estimates e
      WHERE e.tenant_id = p_tenant_id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate AND app.estimate_status_counts_as_demand(e.status)
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_month_start
        AND app.metric_day_ist(e.estimate_date, e.created_at) < (v_month_start + interval '1 month')::date
        AND e.buyer_id IN (SELECT id FROM buyers_to_enrich)
    ) t
    GROUP BY t.buyer_id
  ),
  enriched AS MATERIALIZED (
    SELECT
      bte.id,
      bte.business_name,
      bte.contact_name,
      bte.phone,
      NULLIF(bte.geography ->> 'city', '') AS city,
      NULLIF(bte.geography ->> 'state', '') AS state,
      bte.buyer_app_enabled,
      la.last_at AS last_app_order_at,
      GREATEST(COALESCE(m.invoice_value, 0) - (COALESCE(m.app_order_value, 0) + COALESCE(m.app_estimate_value, 0)), 0)::numeric AS offline_spend_mtd,
      COALESCE(m.invoice_value, 0)::numeric AS total_spend_mtd,
      (COALESCE(m.app_order_value, 0) + COALESCE(m.app_estimate_value, 0))::numeric AS app_gmv_mtd,
      (NOT bte.buyer_app_enabled AND COALESCE(m.invoice_value, 0) - (COALESCE(m.app_order_value, 0) + COALESCE(m.app_estimate_value, 0)) > 0) AS is_suggested,
      (
        bte.buyer_app_enabled
        AND (
          la.last_at IS NULL
          OR la.last_at < v_30d_ago
        )
      ) AS is_inactive,
      bte.search_rank,
      bte.search_vector
    FROM buyers_to_enrich bte
    LEFT JOIN last_app la ON la.buyer_id = bte.id
    LEFT JOIN mtd m ON m.buyer_id = bte.id
  ),
  kpis AS (
    SELECT
      COUNT(*) FILTER (WHERE buyer_app_enabled)::bigint AS enabled_count,
      COUNT(*) FILTER (WHERE NOT buyer_app_enabled)::bigint AS not_enabled_count,
      COUNT(*) FILTER (WHERE is_suggested)::bigint AS suggested_count,
      COUNT(*) FILTER (WHERE is_inactive)::bigint AS inactive_count,
      COUNT(*)::bigint AS total_count
    FROM enriched
  ),
  filtered AS MATERIALIZED (
    SELECT e.*
    FROM enriched e
    WHERE (
        v_query IS NULL
        OR e.search_vector @@ v_ts_query
        OR (v_prefix_ts_query IS NOT NULL AND e.search_vector @@ v_prefix_ts_query)
      )
      AND CASE v_segment
        WHEN 'enabled' THEN e.buyer_app_enabled
        WHEN 'disabled' THEN NOT e.buyer_app_enabled
        WHEN 'suggested' THEN e.is_suggested
        WHEN 'inactive' THEN e.is_inactive
        ELSE true
      END
      AND CASE v_last_ordered
        WHEN '30d' THEN e.last_app_order_at >= v_30d_ago
        WHEN '90d' THEN e.last_app_order_at >= v_90d_ago
        WHEN 'dormant' THEN e.last_app_order_at IS NULL OR e.last_app_order_at < v_90d_ago
        ELSE true
      END
  ),
  filtered_count AS (
    SELECT CASE
      WHEN NOT v_include_summary AND NOT v_requires_metric_candidates
        THEN (SELECT COUNT(*)::bigint FROM candidate_pool)
      ELSE (SELECT COUNT(*)::bigint FROM filtered)
    END AS value
  ),
  page AS MATERIALIZED (
    SELECT f.*
    FROM filtered f
    ORDER BY
      CASE WHEN v_query IS NOT NULL THEN f.search_rank END DESC NULLS LAST,
      CASE WHEN v_sort = 'app_gmv' THEN f.app_gmv_mtd END DESC NULLS LAST,
      CASE WHEN v_sort = 'offline_spend' THEN f.offline_spend_mtd END DESC NULLS LAST,
      CASE WHEN v_sort = 'last_ordered' THEN f.last_app_order_at END DESC NULLS LAST,
      f.business_name ASC,
      f.id ASC
    LIMIT v_limit
    OFFSET CASE
      WHEN NOT v_include_summary AND NOT v_requires_metric_candidates THEN 0
      ELSE v_offset
    END
  )
  SELECT jsonb_build_object(
    'summary_authoritative', v_include_summary,
    'kpis', CASE
      WHEN v_include_summary THEN jsonb_build_object(
        'enabled_count', k.enabled_count,
        'not_enabled_count', k.not_enabled_count,
        'suggested_count', k.suggested_count,
        'inactive_count', k.inactive_count,
        'total_count', k.total_count
      )
      ELSE NULL
    END,
    'buyers', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'business_name', p.business_name,
          'contact_name', p.contact_name,
          'phone', p.phone,
          'city', p.city,
          'state', p.state,
          'buyer_app_enabled', p.buyer_app_enabled,
          'last_app_order_at', p.last_app_order_at,
          'offline_spend_mtd', p.offline_spend_mtd,
          'total_spend_mtd', p.total_spend_mtd,
          'app_gmv_mtd', p.app_gmv_mtd,
          'is_suggested', p.is_suggested,
          'is_inactive', p.is_inactive
        )
        ORDER BY
          CASE WHEN v_query IS NOT NULL THEN p.search_rank END DESC NULLS LAST,
          CASE WHEN v_sort = 'app_gmv' THEN p.app_gmv_mtd END DESC NULLS LAST,
          CASE WHEN v_sort = 'offline_spend' THEN p.offline_spend_mtd END DESC NULLS LAST,
          CASE WHEN v_sort = 'last_ordered' THEN p.last_app_order_at END DESC NULLS LAST,
          p.business_name ASC,
          p.id ASC
      )
      FROM page p
    ), '[]'::jsonb),
    'filtered_count', fc.value,
    'has_more', (v_offset + v_limit) < fc.value,
    'limit', v_limit,
    'offset', v_offset
  )
  INTO v_result
  FROM kpis k
  CROSS JOIN filtered_count fc;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION app.existing_buyer_context_snapshot(p_buyer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
DECLARE
  v_buyer app.buyers%ROWTYPE;
  v_primary text;
  v_cur_start date := date_trunc('quarter', (now() AT TIME ZONE 'Asia/Kolkata'))::date;
  v_prev_start date;
  v_next_start date;
  v_inv_cur_value numeric := 0; v_inv_cur_count bigint := 0;
  v_inv_prev_value numeric := 0; v_inv_prev_count bigint := 0;
  v_dem_cur_value numeric := 0; v_dem_cur_count bigint := 0;
  v_dem_prev_value numeric := 0; v_dem_prev_count bigint := 0;
  v_receivable numeric := 0; v_receivable_count bigint := 0;
  v_overdue numeric := 0; v_overdue_count bigint := 0;
  v_last_invoice_date date;
  v_credit_limit numeric;
  v_credit_available numeric;
  v_app_activity timestamptz;
  v_app_cur_value numeric := 0; v_app_cur_count bigint := 0;
BEGIN
  v_prev_start := (v_cur_start - interval '3 months')::date;
  v_next_start := (v_cur_start + interval '3 months')::date;

  SELECT * INTO v_buyer FROM app.buyers WHERE id = p_buyer_id AND deleted_at IS NULL;
  IF v_buyer.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_primary := app.metrics_v4_primary_demand_kind(v_buyer.tenant_id);

  SELECT
    COALESCE(SUM(x.total_amount) FILTER (WHERE x.d >= v_cur_start), 0),
    COUNT(*) FILTER (WHERE x.d >= v_cur_start),
    COALESCE(SUM(x.total_amount) FILTER (WHERE x.d < v_cur_start), 0),
    COUNT(*) FILTER (WHERE x.d < v_cur_start)
  INTO v_inv_cur_value, v_inv_cur_count, v_inv_prev_value, v_inv_prev_count
  FROM (
    SELECT i.total_amount, app.metric_day_ist(i.invoice_date, i.created_at) AS d
    FROM app.invoices i
    WHERE i.tenant_id = v_buyer.tenant_id AND i.buyer_id = v_buyer.id AND i.deleted_at IS NULL
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= v_prev_start
      AND app.metric_day_ist(i.invoice_date, i.created_at) < v_next_start
      AND app.invoice_status_gmv_included(i.status)
  ) x;

  IF v_primary = 'orders' THEN
    SELECT
      COALESCE(SUM(x.total_amount) FILTER (WHERE x.d >= v_cur_start), 0),
      COUNT(*) FILTER (WHERE x.d >= v_cur_start),
      COALESCE(SUM(x.total_amount) FILTER (WHERE x.d < v_cur_start), 0),
      COUNT(*) FILTER (WHERE x.d < v_cur_start)
    INTO v_dem_cur_value, v_dem_cur_count, v_dem_prev_value, v_dem_prev_count
    FROM (
      SELECT o.total_amount, app.metric_day_ist(o.order_date, o.created_at) AS d
      FROM app.orders o
      WHERE o.tenant_id = v_buyer.tenant_id AND o.buyer_id = v_buyer.id AND o.deleted_at IS NULL
        AND app.metric_day_ist(o.order_date, o.created_at) >= v_prev_start
        AND app.metric_day_ist(o.order_date, o.created_at) < v_next_start
        AND app.order_status_in_flow(o.status)
    ) x;
  ELSIF v_primary = 'estimates' THEN
    SELECT
      COALESCE(SUM(x.total_amount) FILTER (WHERE x.d >= v_cur_start), 0),
      COUNT(*) FILTER (WHERE x.d >= v_cur_start),
      COALESCE(SUM(x.total_amount) FILTER (WHERE x.d < v_cur_start), 0),
      COUNT(*) FILTER (WHERE x.d < v_cur_start)
    INTO v_dem_cur_value, v_dem_cur_count, v_dem_prev_value, v_dem_prev_count
    FROM (
      SELECT e.total_amount, app.metric_day_ist(e.estimate_date, e.created_at) AS d
      FROM app.estimates e
      WHERE e.tenant_id = v_buyer.tenant_id AND e.buyer_id = v_buyer.id AND e.deleted_at IS NULL
        AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_prev_start
        AND app.metric_day_ist(e.estimate_date, e.created_at) < v_next_start
        AND app.estimate_status_counts_as_demand(e.status)
    ) x;
  END IF;

  -- Buyer-app demand this quarter (app estimates that count as demand + app orders in flow).
  SELECT COALESCE(SUM(x.amt), 0), COUNT(*) INTO v_app_cur_value, v_app_cur_count
  FROM (
    SELECT e.total_amount AS amt FROM app.estimates e
    WHERE e.tenant_id = v_buyer.tenant_id AND e.buyer_id = v_buyer.id AND e.deleted_at IS NULL AND e.is_buyer_app_estimate
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= v_cur_start
      AND app.metric_day_ist(e.estimate_date, e.created_at) < v_next_start
    UNION ALL
    SELECT o.total_amount FROM app.orders o
    WHERE o.tenant_id = v_buyer.tenant_id AND o.buyer_id = v_buyer.id AND o.deleted_at IS NULL AND o.is_buyer_app_order
      AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= v_cur_start
      AND app.metric_day_ist(o.order_date, o.created_at) < v_next_start
  ) x;

  -- Only invoices with an outstanding balance, receivable/overdue via the shared status helpers.
  SELECT
    COALESCE(SUM(i.outstanding_balance) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)), 0),
    COUNT(*) FILTER (WHERE app.invoice_status_has_receivable(i.status, i.outstanding_balance)),
    COALESCE(SUM(i.outstanding_balance) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance)), 0),
    COUNT(*) FILTER (WHERE app.invoice_is_overdue(i.status, i.due_date, i.outstanding_balance))
  INTO v_receivable, v_receivable_count, v_overdue, v_overdue_count
  FROM app.invoices i
  WHERE i.tenant_id = v_buyer.tenant_id AND i.buyer_id = v_buyer.id AND i.deleted_at IS NULL
    AND i.outstanding_balance > 0;

  SELECT MAX(app.metric_day_ist(i.invoice_date, i.created_at)) INTO v_last_invoice_date
  FROM app.invoices i
  WHERE i.tenant_id = v_buyer.tenant_id AND i.buyer_id = v_buyer.id AND i.deleted_at IS NULL;

  v_credit_limit := COALESCE(v_buyer.credit_limit, 0);
  v_credit_available := v_credit_limit - v_receivable;
  SELECT GREATEST(
    (SELECT MAX(i3.invoice_date::timestamptz) FROM app.invoices i3
      WHERE i3.tenant_id = v_buyer.tenant_id AND i3.buyer_id = v_buyer.id AND i3.deleted_at IS NULL AND i3.is_buyer_app_invoice),
    (SELECT MAX(o3.placed_at) FROM app.orders o3
      WHERE o3.tenant_id = v_buyer.tenant_id AND o3.buyer_id = v_buyer.id AND o3.deleted_at IS NULL AND o3.is_buyer_app_order)
  ) INTO v_app_activity;

  RETURN jsonb_build_object(
    'current_quarter_start', v_cur_start,
    'previous_quarter_start', v_prev_start,
    'sales', jsonb_build_object(
      'current', jsonb_build_object('invoice_value', v_inv_cur_value, 'invoice_count', v_inv_cur_count),
      'previous', jsonb_build_object('invoice_value', v_inv_prev_value, 'invoice_count', v_inv_prev_count)
    ),
    'demand', jsonb_build_object(
      'kind', v_primary,
      'current', jsonb_build_object('value', v_dem_cur_value, 'count', v_dem_cur_count),
      'previous', jsonb_build_object('value', v_dem_prev_value, 'count', v_dem_prev_count)
    ),
    'dues', jsonb_build_object(
      'receivable_amount', v_receivable,
      'receivable_invoice_count', v_receivable_count,
      'overdue_amount', v_overdue,
      'overdue_invoice_count', v_overdue_count,
      'credit_limit', v_credit_limit,
      'credit_available', v_credit_available,
      'last_invoice_date', v_last_invoice_date,
      'last_buyer_app_activity_at', v_app_activity
    ),
    'app_engagement', jsonb_build_object('value', v_app_cur_value, 'count', v_app_cur_count),
    'sources', jsonb_build_object(
      'period', 'live',
      'dues', 'live'
    ),
    -- Kept for caller compatibility: nothing is read from summaries any more.
    'computed_at', NULL,
    'generated_at', now()
  );
END;
$function$;
