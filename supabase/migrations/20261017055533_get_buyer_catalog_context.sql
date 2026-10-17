-- One round trip for the tenant/buyer context every buyer catalog request needs.
--
-- Today each /api/buyer/* request and each SSR page re-derives this with 8-10 separate PostgREST
-- calls (campaigns x2-3, buyers, cohort_members_active, cohorts, catalogs, campaign_items). The
-- Next.js layer now reads it through this function and caches the result per (tenant, buyer).
--
-- Returns ONE jsonb scalar (no 1000-row PostgREST cap). Visibility rules (who sees which campaign,
-- IST valid_to day, brand allow-list union) deliberately stay in TypeScript
-- (src/lib/server/buyer-catalog-context.ts + buyerMatchesCatalog) as the single source of truth;
-- this function only gathers the raw rows with the same filters the old queries used.
--
-- service_role only: the caller authenticates the buyer session first, then passes its own tenant.
-- Rollback: additive; dropping it is harmless once the app stops calling it.

CREATE OR REPLACE FUNCTION app.get_buyer_catalog_context(p_tenant_id uuid, p_buyer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
DECLARE
  c_campaign_cap constant integer := 200;
  v_buyer jsonb;
  v_explicit uuid[];
  v_default uuid;
  v_campaigns jsonb;
  v_cohorts jsonb;
  v_catalog jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_buyer_id IS NULL THEN
    RAISE EXCEPTION 'tenant_and_buyer_required' USING ERRCODE = '22004';
  END IF;

  -- buyer scoped to the tenant (null when the buyer is not in this tenant)
  SELECT b.default_cohort_id,
         jsonb_build_object('default_cohort_id', b.default_cohort_id, 'geography', b.geography)
    INTO v_default, v_buyer
  FROM app.buyers b
  WHERE b.id = p_buyer_id AND b.tenant_id = p_tenant_id;

  IF v_buyer IS NOT NULL THEN
    SELECT COALESCE(array_agg(m.cohort_id), ARRAY[]::uuid[])
      INTO v_explicit
    FROM app.cohort_members_active m
    WHERE m.buyer_id = p_buyer_id;

    v_buyer := v_buyer || jsonb_build_object('explicit_cohort_ids', to_jsonb(v_explicit));
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb)
    INTO v_campaigns
  FROM (
    SELECT cp.id, cp.tenant_id, cp.name, cp.share_token, cp.valid_to, cp.message, cp.created_at,
           cp.scope_type, cp.scope_value, cp.hero_image_url,
           (SELECT count(*) FROM app.campaign_items ci
             WHERE ci.campaign_id = cp.id AND ci.deleted_at IS NULL) AS item_count
    FROM app.campaigns cp
    WHERE cp.tenant_id = p_tenant_id
      AND cp.status = 'published'
      AND cp.deleted_at IS NULL
    ORDER BY cp.created_at DESC
    LIMIT c_campaign_cap
  ) c;

  -- the buyer's default + explicit cohorts (tenant-scoped, not deleted) with their brand allow-lists
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', co.id, 'allowed_tenant_brand_ids', co.allowed_tenant_brand_ids)), '[]'::jsonb)
    INTO v_cohorts
  FROM app.cohorts co
  WHERE co.tenant_id = p_tenant_id
    AND co.deleted_at IS NULL
    AND co.id = ANY (COALESCE(v_explicit, ARRAY[]::uuid[]) || CASE WHEN v_default IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_default] END);

  SELECT jsonb_build_object(
           'id', ca.id, 'tenant_id', ca.tenant_id, 'include_all', ca.include_all,
           'pricing_mode', ca.pricing_mode, 'price_list_id', ca.price_list_id,
           'access_mode', ca.access_mode,
           'collect_target_unit_price_range', ca.collect_target_unit_price_range,
           'product_display_mode', ca.product_display_mode, 'live_at', ca.live_at)
    INTO v_catalog
  FROM app.catalogs ca
  WHERE ca.tenant_id = p_tenant_id
    AND ca.kind = 'public'
    AND ca.deleted_at IS NULL
    AND ca.live_at IS NOT NULL
  LIMIT 1;

  RETURN jsonb_build_object(
    'buyer', v_buyer,
    'campaigns', v_campaigns,
    'cohorts', v_cohorts,
    'public_catalog', v_catalog
  );
END;
$function$;

REVOKE ALL ON FUNCTION app.get_buyer_catalog_context(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_buyer_catalog_context(uuid, uuid) TO service_role;

COMMENT ON FUNCTION app.get_buyer_catalog_context(uuid, uuid) IS
  'Raw tenant/buyer catalog context (buyer cohorts, published campaigns + item counts, cohort brand allow-lists, live public catalog) as one jsonb. Visibility rules live in TS. service_role only.';
