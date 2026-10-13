-- Campaign items sourced from a price list must not fall back to the product's base_selling_price.
--
-- app.refresh_campaign_products_by_id wrote COALESCE(pli.price, tp.base_selling_price) into
-- campaign_items.price_override. A product missing from the campaign's price list therefore got
-- the base selling price as its "campaign price" — which is neither the price list price nor the
-- buyer's own resolved (General) price, and rendered as a bogus discount / a different price on
-- cards than on the estimate. With a NULL override the buyer's resolved price applies
-- (campaignOverridePrice() treats NULL as "no campaign price").
--
-- Patched in place from the live definition so any drift in the rest of the function is kept.
DO $$
DECLARE
  v_def text;
  v_needle constant text := 'COALESCE(pli.price, tp.base_selling_price)';
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app'
    AND p.proname = 'refresh_campaign_products_by_id'
    AND pg_get_function_identity_arguments(p.oid) = 'p_campaign_id uuid';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'app.refresh_campaign_products_by_id(uuid) not found';
  END IF;

  IF position(v_needle IN v_def) = 0 THEN
    RAISE NOTICE 'base_selling_price fallback already removed; nothing to patch';
  ELSE
    EXECUTE replace(v_def, v_needle, 'pli.price');

    IF position(v_needle IN pg_get_functiondef('app.refresh_campaign_products_by_id(uuid)'::regprocedure)) > 0 THEN
      RAISE EXCEPTION 'refresh_campaign_products_by_id still contains the base_selling_price fallback after patching';
    END IF;
  END IF;
END;
$$;

-- Re-derive overrides for published price-list campaigns so stale base-price overrides clear now
-- rather than at the next nightly boundary refresh.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.id
    FROM app.campaigns c
    WHERE c.pricing_source = 'pricelist'
      AND c.status = 'published'
      AND c.deleted_at IS NULL
  LOOP
    PERFORM app.refresh_campaign_products_by_id(r.id);
  END LOOP;
END;
$$;
