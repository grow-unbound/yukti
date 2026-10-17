-- Pricing differential, part 3: golden dump of the REAL scoped RPCs (yukti-dev only, read-only).
-- Run BEFORE and AFTER the migration, save both outputs, compare with diff-golden.mjs.
-- Covers load_products_scoped and search_products_scoped for ~24 deterministic buyers (direct,
-- cohort and random strata), 3 pages of 100, plus a price-list (guest) call and a campaign scope.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

WITH picked AS (
  SELECT b.id, b.tenant_id, s.stratum FROM (
    (SELECT pla.target_id AS id, 'direct' AS stratum FROM app.price_list_assignments pla
       WHERE pla.target_type = 'buyer' AND pla.deleted_at IS NULL ORDER BY md5(pla.target_id::text) LIMIT 8)
    UNION ALL
    (SELECT cm.buyer_id, 'cohort' FROM app.price_list_assignments pla
       JOIN app.cohort_members_active cm ON cm.cohort_id = pla.target_id
       WHERE pla.target_type = 'cohort' AND pla.deleted_at IS NULL ORDER BY md5(cm.buyer_id::text) LIMIT 6)
    UNION ALL
    (SELECT id, 'random' FROM app.buyers WHERE deleted_at IS NULL AND is_active ORDER BY md5(id::text) LIMIT 10)
  ) s JOIN app.buyers b ON b.id = s.id AND b.deleted_at IS NULL AND b.is_active
),
pages(off) AS (VALUES (0), (100), (200)),
load_rows AS (
  SELECT 'load' AS fn, p.id AS buyer_id, r.tenant_product_id, r.unit_price
  FROM picked p CROSS JOIN pages
  CROSS JOIN LATERAL app.load_products_scoped(p_tenant_id => p.tenant_id, p_buyer_id => p.id, p_limit => 100, p_offset => pages.off) r
),
search_rows AS (
  SELECT 'search' AS fn, p.id AS buyer_id, r.tenant_product_id, r.unit_price
  FROM picked p
  CROSS JOIN LATERAL app.search_products_scoped(p_tenant_id => p.tenant_id, p_query => 'a', p_buyer_id => p.id, p_limit => 100, p_offset => 0) r
),
guest_list AS (
  SELECT pl.id, pl.tenant_id FROM app.price_lists pl
  WHERE pl.deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.price_list_items i WHERE i.price_list_id = pl.id AND i.deleted_at IS NULL)
  ORDER BY md5(pl.id::text) LIMIT 3
),
guest_rows AS (
  SELECT 'load_pricelist' AS fn, NULL::uuid AS buyer_id, r.tenant_product_id, r.unit_price
  FROM guest_list g
  CROSS JOIN LATERAL app.load_products_scoped(p_tenant_id => g.tenant_id, p_price_list_id => g.id, p_limit => 100, p_offset => 0) r
),
campaign_pick AS (
  SELECT c.id, c.tenant_id,
         (SELECT b.id FROM picked b WHERE b.tenant_id = c.tenant_id LIMIT 1) AS buyer_id
  FROM app.campaigns c
  WHERE c.deleted_at IS NULL AND c.status = 'published'
    AND EXISTS (SELECT 1 FROM app.campaign_items ci WHERE ci.campaign_id = c.id AND ci.deleted_at IS NULL)
  ORDER BY md5(c.id::text) LIMIT 3
),
campaign_rows AS (
  SELECT 'load_campaign' AS fn, cp.buyer_id, r.tenant_product_id, r.unit_price
  FROM campaign_pick cp
  CROSS JOIN LATERAL app.load_products_scoped(p_tenant_id => cp.tenant_id, p_buyer_id => cp.buyer_id, p_campaign_id => cp.id, p_limit => 100, p_offset => 0) r
  WHERE cp.buyer_id IS NOT NULL
)
SELECT fn, buyer_id, tenant_product_id, unit_price FROM (
  SELECT * FROM load_rows UNION ALL SELECT * FROM search_rows
  UNION ALL SELECT * FROM guest_rows UNION ALL SELECT * FROM campaign_rows
) x ORDER BY fn, buyer_id NULLS FIRST, tenant_product_id;
