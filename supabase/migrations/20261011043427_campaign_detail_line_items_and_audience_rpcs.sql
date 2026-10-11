-- Campaign detail (GET /api/tenant/catalogs/[id]) without id lists in the request URL.
--
-- Problem: the route sent every campaign product uuid (459 for "Super September Sale") and every
-- eligible estimate uuid (562) as GET `.in()` filters on /rest/v1/estimate_items, and the audience
-- buyer ids (519) on /rest/v1/buyers. PostgREST/Supabase rejects the oversized URL with HTTP 400,
-- so the detail page failed with "Failed to load line items". The cohort-members read was also
-- exposed to PostgREST's 1000-row response cap.
--
-- Both functions return ONE jsonb scalar (a function returning SETOF rows would hit the same
-- 1000-row cap). Each has an explicit internal cap and reports `truncated`; the route fails loudly
-- instead of silently under-counting.
--
-- service_role only: the route authenticates the seller, then calls with its tenant. Both functions
-- re-check that the campaign belongs to p_tenant_id.

-- ---------------------------------------------------------------------------------------------
-- 1. line items of the campaign's orders / estimates, restricted to products that are (or were)
--    campaign members. Eligibility filtering and membership-window attribution stay in the route.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.get_campaign_attributed_line_items(p_tenant_id uuid, p_campaign_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
DECLARE
  c_cap constant integer := 20000;
  v_orders jsonb;
  v_estimates jsonb;
  v_orders_n integer;
  v_estimates_n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.campaigns c
    WHERE c.id = p_campaign_id AND c.tenant_id = p_tenant_id AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'parent_id', t.parent_id,
            'tenant_product_id', t.tenant_product_id,
            'qty', t.qty,
            'line_total', t.line_total,
            'unit_price', t.unit_price
          )) FILTER (WHERE t.rn <= c_cap), '[]'::jsonb),
         COALESCE(max(t.rn), 0)
    INTO v_orders, v_orders_n
  FROM (
    SELECT q.*, row_number() OVER (ORDER BY q.parent_id, q.tenant_product_id) AS rn
    FROM (
      SELECT oi.order_id AS parent_id, oi.tenant_product_id, oi.qty, oi.line_total, oi.unit_price
      FROM app.orders o
      JOIN app.order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
      WHERE o.tenant_id = p_tenant_id
        AND o.campaign_id = p_campaign_id
        AND o.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM app.campaign_items ci
          WHERE ci.campaign_id = p_campaign_id AND ci.tenant_product_id = oi.tenant_product_id
        )
      LIMIT c_cap + 1
    ) q
  ) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'parent_id', t.parent_id,
            'tenant_product_id', t.tenant_product_id,
            'qty', t.qty,
            'line_total', t.line_total,
            'unit_price', t.unit_price
          )) FILTER (WHERE t.rn <= c_cap), '[]'::jsonb),
         COALESCE(max(t.rn), 0)
    INTO v_estimates, v_estimates_n
  FROM (
    SELECT q.*, row_number() OVER (ORDER BY q.parent_id, q.tenant_product_id) AS rn
    FROM (
      SELECT ei.estimate_id AS parent_id, ei.tenant_product_id, ei.qty, ei.line_total, ei.unit_price
      FROM app.estimates e
      JOIN app.estimate_items ei ON ei.estimate_id = e.id AND ei.deleted_at IS NULL
      WHERE e.tenant_id = p_tenant_id
        AND e.campaign_id = p_campaign_id
        AND e.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM app.campaign_items ci
          WHERE ci.campaign_id = p_campaign_id AND ci.tenant_product_id = ei.tenant_product_id
        )
      LIMIT c_cap + 1
    ) q
  ) t;

  RETURN jsonb_build_object(
    'orders', v_orders,
    'estimates', v_estimates,
    'truncated', (v_orders_n > c_cap OR v_estimates_n > c_cap)
  );
END;
$function$;

REVOKE ALL ON FUNCTION app.get_campaign_attributed_line_items(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_campaign_attributed_line_items(uuid, uuid) TO service_role;

COMMENT ON FUNCTION app.get_campaign_attributed_line_items(uuid, uuid) IS
  'Order/estimate line items (parent_id, tenant_product_id, qty, line_total, unit_price) of a campaign''s orders/estimates for products that are or were campaign members. jsonb scalar; truncated=true when a side exceeds 20000 rows. service_role only.';

-- ---------------------------------------------------------------------------------------------
-- 2. the campaign's audience: member count + buyer rows, scope resolved exactly as the route did
--      cohort scope (cohort_id)        -> open cohort_members, label = cohort name
--      buyer scope, buyer_id           -> that buyer, label = buyer business_name
--      buyer scope, buyer_ids          -> those buyers, label 'Selected buyers'
--      otherwise, automatic targeting  -> open campaign_buyer_members, label 'Targeted buyers'
--      otherwise                       -> all active tenant buyers, 'All buyers' (scope 'all') or
--                                         'Targeted buyers'
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.get_campaign_audience_buyers(p_tenant_id uuid, p_campaign_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
DECLARE
  c_cap constant integer := 5000;
  v_campaign record;
  v_cohort_id uuid;
  v_buyer_id uuid;
  v_buyer_ids uuid[];
  v_ids uuid[] := ARRAY[]::uuid[];
  v_label text := 'All buyers';
  v_selected_cohort_id uuid := NULL;
  v_member_count integer := 0;
  v_use_ids boolean := false;
  v_buyers jsonb := '[]'::jsonb;
  v_returned integer := 0;
  v_name text;
BEGIN
  SELECT c.scope_type, c.scope_value, c.buyer_target_mode
    INTO v_campaign
  FROM app.campaigns c
  WHERE c.id = p_campaign_id AND c.tenant_id = p_tenant_id AND c.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_cohort_id := NULLIF(v_campaign.scope_value ->> 'cohort_id', '')::uuid;
  v_buyer_id := NULLIF(v_campaign.scope_value ->> 'buyer_id', '')::uuid;
  IF jsonb_typeof(v_campaign.scope_value -> 'buyer_ids') = 'array' THEN
    SELECT COALESCE(array_agg(DISTINCT x::uuid), ARRAY[]::uuid[])
      INTO v_buyer_ids
    FROM jsonb_array_elements_text(v_campaign.scope_value -> 'buyer_ids') AS x;
  ELSE
    v_buyer_ids := ARRAY[]::uuid[];
  END IF;

  IF v_campaign.scope_type = 'cohort' AND v_cohort_id IS NOT NULL THEN
    v_selected_cohort_id := v_cohort_id;
    v_use_ids := true;
    SELECT COALESCE(array_agg(DISTINCT m.buyer_id), ARRAY[]::uuid[])
      INTO v_ids
    FROM app.cohort_members m
    WHERE m.cohort_id = v_cohort_id AND m.valid_until IS NULL;
    SELECT co.name INTO v_name
    FROM app.cohorts co
    WHERE co.id = v_cohort_id AND co.tenant_id = p_tenant_id;
    IF v_name IS NOT NULL AND v_name <> '' THEN
      v_label := v_name;
    END IF;
  ELSIF v_campaign.scope_type = 'buyer' AND v_buyer_id IS NOT NULL THEN
    v_use_ids := true;
    v_ids := ARRAY[v_buyer_id];
    SELECT b.business_name INTO v_name
    FROM app.buyers b
    WHERE b.id = v_buyer_id AND b.tenant_id = p_tenant_id;
    IF v_name IS NOT NULL AND v_name <> '' THEN
      v_label := v_name;
    END IF;
  ELSIF v_campaign.scope_type = 'buyer' AND COALESCE(array_length(v_buyer_ids, 1), 0) > 0 THEN
    v_use_ids := true;
    v_ids := v_buyer_ids;
    v_label := 'Selected buyers';
  END IF;

  IF v_use_ids THEN
    v_member_count := COALESCE(array_length(v_ids, 1), 0);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'id', t.id, 'business_name', t.business_name, 'geography', t.geography, 'tier', t.tier
           ) ORDER BY t.business_name, t.id), '[]'::jsonb),
           count(*)
      INTO v_buyers, v_returned
    FROM (
      SELECT b.id, b.business_name, b.geography, b.tier
      FROM app.buyers b
      WHERE b.tenant_id = p_tenant_id
        AND b.id = ANY (v_ids)
        AND b.deleted_at IS NULL
      ORDER BY b.business_name, b.id
      LIMIT c_cap
    ) t;

  ELSIF v_campaign.buyer_target_mode = 'automatic' THEN
    v_label := 'Targeted buyers';

    SELECT count(*) INTO v_member_count
    FROM app.campaign_buyer_members cbm
    WHERE cbm.campaign_id = p_campaign_id AND cbm.valid_until IS NULL;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'id', t.id, 'business_name', t.business_name, 'geography', t.geography, 'tier', t.tier
           ) ORDER BY t.business_name, t.id), '[]'::jsonb),
           count(*)
      INTO v_buyers, v_returned
    FROM (
      SELECT b.id, b.business_name, b.geography, b.tier
      FROM app.campaign_buyer_members cbm
      JOIN app.buyers b ON b.id = cbm.buyer_id AND b.tenant_id = p_tenant_id
      WHERE cbm.campaign_id = p_campaign_id AND cbm.valid_until IS NULL
      ORDER BY b.business_name, b.id
      LIMIT c_cap
    ) t;

  ELSE
    v_label := CASE WHEN v_campaign.scope_type = 'all' THEN 'All buyers' ELSE 'Targeted buyers' END;

    SELECT count(*) INTO v_member_count
    FROM app.buyers b
    WHERE b.tenant_id = p_tenant_id AND b.is_active = true AND b.deleted_at IS NULL;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'id', t.id, 'business_name', t.business_name, 'geography', t.geography, 'tier', t.tier
           ) ORDER BY t.business_name, t.id), '[]'::jsonb),
           count(*)
      INTO v_buyers, v_returned
    FROM (
      SELECT b.id, b.business_name, b.geography, b.tier
      FROM app.buyers b
      WHERE b.tenant_id = p_tenant_id AND b.is_active = true AND b.deleted_at IS NULL
      ORDER BY b.business_name, b.id
      LIMIT c_cap
    ) t;
  END IF;

  RETURN jsonb_build_object(
    'member_count', v_member_count,
    'selected_cohort_id', v_selected_cohort_id,
    'selected_cohort_name', v_label,
    'buyers', v_buyers,
    'truncated', (v_member_count > c_cap AND v_returned >= c_cap)
  );
END;
$function$;

REVOKE ALL ON FUNCTION app.get_campaign_audience_buyers(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_campaign_audience_buyers(uuid, uuid) TO service_role;

COMMENT ON FUNCTION app.get_campaign_audience_buyers(uuid, uuid) IS
  'Campaign audience for the seller campaign detail page: exact member_count plus up to 5000 buyer rows (id, business_name, geography, tier), selected cohort id/name label. jsonb scalar. service_role only.';
