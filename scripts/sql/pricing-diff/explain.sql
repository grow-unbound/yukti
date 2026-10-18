-- Pricing differential, part 4: timing of a 40-row page for 3 buyer types (yukti-dev only).
-- Each page is run 5 times (first run warms caches); reports min/median ms of the last 4 plus rows.
-- Everything lives in a rolled-back transaction (a pg_temp helper function).
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

CREATE FUNCTION pg_temp.time_page(p_fn text, p_tenant uuid, p_buyer uuid)
RETURNS TABLE(ms numeric, n bigint) LANGUAGE plpgsql AS $f$
DECLARE t0 timestamptz; i int;
BEGIN
  FOR i IN 1..5 LOOP
    t0 := clock_timestamp();
    IF p_fn = 'load' THEN
      SELECT count(*) INTO n FROM app.load_products_scoped(p_tenant_id => p_tenant, p_buyer_id => p_buyer, p_limit => 40, p_offset => 0);
    ELSE
      SELECT count(*) INTO n FROM app.search_products_scoped(p_tenant_id => p_tenant, p_query => 'a', p_buyer_id => p_buyer, p_limit => 40, p_offset => 0);
    END IF;
    ms := round((extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric, 1);
    IF i > 1 THEN RETURN NEXT; END IF;
  END LOOP;
END $f$;

WITH picked AS (
  (SELECT 'direct' AS kind, b.id, b.tenant_id FROM app.price_list_assignments pla
     JOIN app.buyers b ON b.id = pla.target_id AND b.deleted_at IS NULL AND b.is_active
     WHERE pla.target_type = 'buyer' AND pla.deleted_at IS NULL ORDER BY md5(b.id::text) LIMIT 1)
  UNION ALL
  (SELECT 'cohort', b.id, b.tenant_id FROM app.price_list_assignments pla
     JOIN app.cohort_members_active cm ON cm.cohort_id = pla.target_id
     JOIN app.buyers b ON b.id = cm.buyer_id AND b.deleted_at IS NULL AND b.is_active
     WHERE pla.target_type = 'cohort' AND pla.deleted_at IS NULL ORDER BY md5(b.id::text) LIMIT 1)
  UNION ALL
  (SELECT 'random', id, tenant_id FROM app.buyers WHERE deleted_at IS NULL AND is_active ORDER BY md5(id::text) LIMIT 1)
)
SELECT p.kind, f.fn, min(t.ms) AS min_ms, (percentile_cont(0.5) WITHIN GROUP (ORDER BY t.ms))::numeric(10,1) AS median_ms, max(t.n) AS rows
FROM picked p CROSS JOIN (VALUES ('load'), ('search')) f(fn)
CROSS JOIN LATERAL pg_temp.time_page(f.fn, p.tenant_id, p.id) t
GROUP BY p.kind, f.fn ORDER BY p.kind, f.fn;
ROLLBACK;
