-- Pricing differential, part 1 (READ-ONLY, run against yukti-dev only).
-- A = what load_products_scoped / search_products_scoped compute per row today:
--       COALESCE(app.resolve_price(tp, buyer, 1), tp.base_selling_price, 0)
-- B = what the app computes after the second round trip:
--       COALESCE(app.resolve_prices_batch(...) price, 0)
-- The migration replaces A's per-row call with B's batch call, so A and B must agree for every
-- (buyer, active product). Expected result: diffs = 0.
-- Run as the service role/postgres: resolve_price skips its JWT checks only for service_role, so the
-- session sets request.jwt.claims accordingly.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

WITH sample AS (
  -- strata: direct buyer assignment, cohort assignment, no assigned list, random
  SELECT DISTINCT b.id, b.tenant_id, s.stratum
  FROM (
    SELECT pla.target_id AS buyer_id, 'direct' AS stratum
      FROM app.price_list_assignments pla WHERE pla.target_type = 'buyer' AND pla.deleted_at IS NULL
    UNION ALL
    SELECT cm.buyer_id, 'cohort'
      FROM app.price_list_assignments pla
      JOIN app.cohort_members_active cm ON cm.cohort_id = pla.target_id
     WHERE pla.target_type = 'cohort' AND pla.deleted_at IS NULL
    UNION ALL
    (SELECT id, 'random' FROM app.buyers WHERE deleted_at IS NULL AND is_active ORDER BY md5(id::text) LIMIT 300)
  ) s
  JOIN app.buyers b ON b.id = s.buyer_id AND b.deleted_at IS NULL AND b.is_active
),
capped AS (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY stratum ORDER BY md5(id::text)) AS rn FROM sample
  ) x WHERE rn <= 300
),
pairs AS (
  SELECT c.id AS buyer_id, c.stratum,
         tp.id AS product_id, tp.base_selling_price
  FROM capped c
  JOIN app.tenant_products tp ON tp.tenant_id = c.tenant_id AND tp.is_active AND tp.deleted_at IS NULL
),
a AS (
  SELECT p.buyer_id, p.stratum, p.product_id,
         COALESCE(app.resolve_price(p.product_id, p.buyer_id, 1), p.base_selling_price, 0) AS price
  FROM pairs p
),
b AS (
  SELECT c.id AS buyer_id, rp.tenant_product_id AS product_id, COALESCE(rp.unit_price, 0) AS price
  FROM capped c
  CROSS JOIN LATERAL app.resolve_prices_batch(
    (SELECT array_agg(tp.id) FROM app.tenant_products tp
      WHERE tp.tenant_id = c.tenant_id AND tp.is_active AND tp.deleted_at IS NULL),
    c.id, 1) rp
)
SELECT a.stratum,
       count(*)                                        AS pairs,
       count(*) FILTER (WHERE b.product_id IS NULL)    AS missing_in_batch,
       count(*) FILTER (WHERE a.price IS DISTINCT FROM b.price) AS diffs
FROM a LEFT JOIN b ON b.buyer_id = a.buyer_id AND b.product_id = a.product_id
GROUP BY ROLLUP (a.stratum)
ORDER BY a.stratum NULLS LAST;
