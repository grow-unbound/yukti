-- Pricing differential, part 2: edge-case fixtures (yukti-dev only). Everything runs inside a
-- transaction that is ROLLED BACK; nothing persists. Compares resolve_price (what the scoped
-- functions use per row today) against resolve_prices_batch (what the migration switches them to)
-- for situations the dev data may not contain. Expected: every row has diff = false.
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

CREATE TEMP TABLE fx_res (scenario text, qty numeric, product text, a numeric, b numeric, diff boolean) ON COMMIT DROP;

DO $fx$
DECLARE
  v_tenant uuid; v_buyer uuid; v_p1 uuid; v_p2 uuid; v_p3 uuid; v_cohort uuid;
  l_all uuid; l_tier uuid; l_exp uuid; l_off uuid; l_future uuid; l_t1 uuid; l_t2 uuid;
  l_buyer uuid; l_cohort uuid; l_ended uuid; l_del uuid; v_coh_ended uuid;
  q numeric;
BEGIN
  SELECT b.tenant_id, b.id INTO v_tenant, v_buyer
  FROM app.buyers b
  WHERE b.deleted_at IS NULL AND b.is_active
    AND (SELECT count(*) FROM app.tenant_products tp WHERE tp.tenant_id = b.tenant_id AND tp.is_active AND tp.deleted_at IS NULL) >= 3
  ORDER BY b.id LIMIT 1;

  SELECT (array_agg(tp.id ORDER BY tp.id))[1], (array_agg(tp.id ORDER BY tp.id))[2], (array_agg(tp.id ORDER BY tp.id))[3]
    INTO v_p1, v_p2, v_p3
  FROM app.tenant_products tp WHERE tp.tenant_id = v_tenant AND tp.is_active AND tp.deleted_at IS NULL;

  -- neutralise pre-existing lists/assignments for this tenant inside the transaction
  UPDATE app.price_list_assignments pla SET deleted_at = now()
   WHERE pla.price_list_id IN (SELECT id FROM app.price_lists WHERE tenant_id = v_tenant);
  UPDATE app.price_lists SET is_active = false WHERE tenant_id = v_tenant;
  UPDATE app.tenant_products SET base_selling_price = 500 WHERE id IN (v_p1, v_p2);
  UPDATE app.tenant_products SET base_selling_price = NULL WHERE id = v_p3;

  -- helper to create a list
  -- (id, active, priority, valid_from, valid_to)
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx all',    true, 1, now() - interval '1 day', NULL)           RETURNING id INTO l_all;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx tier',   true, 5, now() - interval '1 day', NULL)           RETURNING id INTO l_tier;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx expired',true, 9, now() - interval '9 days', now() - interval '1 day') RETURNING id INTO l_exp;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx off',    false, 9, now() - interval '9 days', NULL)         RETURNING id INTO l_off;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx future', true, 9, now() + interval '5 days', NULL)          RETURNING id INTO l_future;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx tie 1',  true, 7, now() - interval '1 day', NULL)           RETURNING id INTO l_t1;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx tie 2',  true, 7, now() - interval '1 day', NULL)           RETURNING id INTO l_t2;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx buyer',  true, 2, now() - interval '1 day', NULL)           RETURNING id INTO l_buyer;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx cohort', true, 3, now() - interval '1 day', NULL)           RETURNING id INTO l_cohort;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx ended',  true, 8, now() - interval '1 day', NULL)           RETURNING id INTO l_ended;
  INSERT INTO app.price_lists (tenant_id, name, is_active, priority, valid_from, valid_to)
    VALUES (v_tenant, 'fx del',    true, 8, now() - interval '1 day', NULL)           RETURNING id INTO l_del;

  -- cohorts: one the buyer is in, one the buyer left
  INSERT INTO app.cohorts (tenant_id, name) VALUES (v_tenant, 'fx cohort') RETURNING id INTO v_cohort;
  INSERT INTO app.cohorts (tenant_id, name) VALUES (v_tenant, 'fx cohort ended') RETURNING id INTO v_coh_ended;
  INSERT INTO app.cohort_members (cohort_id, buyer_id, valid_from) VALUES (v_cohort, v_buyer, now() - interval '3 days');
  INSERT INTO app.cohort_members (cohort_id, buyer_id, valid_from, valid_until) VALUES (v_coh_ended, v_buyer, now() - interval '9 days', now() - interval '1 day');

  -- assignments
  INSERT INTO app.price_list_assignments (price_list_id, target_type, target_id, source_payload) VALUES
    (l_all,'all_buyers',NULL,'{}'), (l_tier,'all_buyers',NULL,'{}'),
    (l_exp,'buyer',v_buyer,'{}'), (l_off,'buyer',v_buyer,'{}'), (l_future,'buyer',v_buyer,'{}'),
    (l_t1,'buyer',v_buyer,'{}'), (l_t2,'buyer',v_buyer,'{}'),
    (l_buyer,'buyer',v_buyer,'{}'), (l_cohort,'cohort',v_cohort,'{}'),
    (l_ended,'cohort',v_coh_ended,'{}'), (l_del,'buyer',v_buyer,'{}');

  -- items
  INSERT INTO app.price_list_items (price_list_id, tenant_product_id, price, min_qty, max_qty) VALUES
    -- p1: tiers on the all_buyers list
    (l_all, v_p1, 100, 1, 9), (l_all, v_p1, 90, 10, 49), (l_all, v_p1, 80, 50, NULL),
    (l_tier, v_p1, 95, 1, NULL),                       -- higher priority all_buyers list beats l_all
    -- dead lists must be ignored for p1
    (l_exp, v_p1, 1, 1, NULL), (l_off, v_p1, 1, 1, NULL), (l_future, v_p1, 1, 1, NULL),
    (l_ended, v_p1, 2, 1, NULL),
    -- p2: tie between two buyer lists with different prices; cohort + all_buyers also priced
    (l_t1, v_p2, 70, 1, NULL), (l_t2, v_p2, 60, 1, NULL), (l_cohort, v_p2, 50, 1, NULL), (l_all, v_p2, 40, 1, NULL),
    -- p1 buyer price at higher tier/lower tiers
    (l_buyer, v_p1, 85, 1, 4), (l_buyer, v_p1, 75, 5, NULL),
    -- p3 (NULL base): only a soft-deleted item
    (l_del, v_p3, 33, 1, NULL);
  UPDATE app.price_list_items SET deleted_at = now() WHERE price_list_id = l_del;

  FOREACH q IN ARRAY ARRAY[1, 4, 5, 9, 10, 49, 50, 100]::numeric[] LOOP
    INSERT INTO fx_res
    SELECT 'qty', q, p.name,
           COALESCE(app.resolve_price(p.id, v_buyer, q), (SELECT base_selling_price FROM app.tenant_products WHERE id = p.id), 0),
           COALESCE((SELECT unit_price FROM app.resolve_prices_batch(ARRAY[p.id], v_buyer, q)), 0),
           false
    FROM (VALUES (v_p1,'p1 tiers/buyer'), (v_p2,'p2 tie/cohort'), (v_p3,'p3 null base')) p(id, name);
  END LOOP;

  -- same products priced for a buyer with no assignments at all (all_buyers / base only)
  INSERT INTO fx_res
  SELECT 'unassigned buyer', 1, p.name,
         COALESCE(app.resolve_price(p.id, ob.id, 1), (SELECT base_selling_price FROM app.tenant_products WHERE id = p.id), 0),
         COALESCE((SELECT unit_price FROM app.resolve_prices_batch(ARRAY[p.id], ob.id, 1)), 0), false
  FROM (VALUES (v_p1,'p1'), (v_p2,'p2'), (v_p3,'p3')) p(id, name),
       LATERAL (SELECT id FROM app.buyers WHERE tenant_id = v_tenant AND id <> v_buyer AND deleted_at IS NULL AND is_active LIMIT 1) ob;

  -- whole-page call (one batch for all three) must match per-product calls
  INSERT INTO fx_res
  SELECT 'page batch', 1, x.product_id::text, x.a, COALESCE(y.unit_price, 0), false
  FROM (SELECT id AS product_id, COALESCE(app.resolve_price(id, v_buyer, 1), 0) a FROM unnest(ARRAY[v_p1,v_p2,v_p3]) id) x
  JOIN app.resolve_prices_batch(ARRAY[v_p1,v_p2,v_p3], v_buyer, 1) y ON y.tenant_product_id = x.product_id;
END
$fx$;

UPDATE fx_res SET diff = a IS DISTINCT FROM b;
SELECT scenario, count(*) AS cases, count(*) FILTER (WHERE diff) AS diffs,
       string_agg(CASE WHEN diff THEN product || ' q' || qty || ': ' || a || ' vs ' || b END, '; ') AS detail
FROM fx_res GROUP BY ROLLUP (scenario) ORDER BY scenario NULLS LAST;
ROLLBACK;
