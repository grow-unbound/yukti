-- P8 of specs/2026-10-14-prod-resource-diet-nano.md: make app.get_product_velocity_90d cheap.
--
-- Units already come from the month buckets in metrics_product_period_summary. The cost was
-- last_invoice_at: it joined every invoice_items line of each product (all-time) to invoices by
-- primary key. On prod, 459 products: 150,669 buffers / 84 k nested-loop probes. The replacement
-- reads invoice_items only: 3,954 buffers (~38x fewer), no join to invoices.
--
-- last_invoice_at becomes MAX(invoice_items.created_at). invoice_items rows are inserted with their
-- invoice, so this tracks the invoice date; on prod 99.9 % of 84.9 k lines are inserted within 7 days
-- of invoice_date (74 lines > 7 d, 2 > 30 d). The value is advisory ("last invoiced ~N days ago" in
-- the seller enquiry triage panel), so day-level drift is acceptable.
--
-- Tenant isolation: invoice_items has no tenant_id, so the id list is first restricted to products
-- owned by p_tenant_id (the function is SECURITY DEFINER; units were already tenant-filtered).
-- Signature, volatility, search_path and the 1000-id cap are unchanged.
CREATE OR REPLACE FUNCTION app.get_product_velocity_90d(p_tenant_id uuid, p_product_ids uuid[])
RETURNS TABLE(tenant_product_id uuid, invoice_units_90d numeric, last_invoice_at timestamp with time zone)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  c_max_ids constant integer := 1000;
  v_ids uuid[];
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_window_start date := date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata') - interval '2 months')::date;
  v_window_days numeric;
BEGIN
  IF p_tenant_id IS NULL OR p_product_ids IS NULL OR cardinality(p_product_ids) = 0 THEN
    RETURN;
  END IF;

  IF cardinality(p_product_ids) > c_max_ids THEN
    RAISE EXCEPTION 'too_many_product_ids' USING ERRCODE = '22023', DETAIL = format('max %s ids per call', c_max_ids);
  END IF;

  SELECT COALESCE(array_agg(tp.id), '{}'::uuid[])
  INTO v_ids
  FROM app.tenant_products tp
  WHERE tp.id = ANY (p_product_ids)
    AND tp.tenant_id = p_tenant_id;

  v_window_days := GREATEST(1, (v_today - v_window_start) + 1);

  RETURN QUERY
  WITH wanted AS (
    SELECT DISTINCT unnest(v_ids) AS tenant_product_id
  ),
  units AS (
    SELECT s.tenant_product_id, SUM(s.invoice_units) AS units
    FROM app.metrics_product_period_summary s
    WHERE s.tenant_id = p_tenant_id
      AND s.grain = 'month'
      AND s.deleted_at IS NULL
      AND s.period_start >= v_window_start
      AND s.tenant_product_id = ANY (v_ids)
    GROUP BY s.tenant_product_id
  ),
  last_inv AS (
    SELECT ii.tenant_product_id, MAX(ii.created_at) AS last_invoice_at
    FROM app.invoice_items ii
    WHERE ii.tenant_product_id = ANY (v_ids)
      AND ii.deleted_at IS NULL
    GROUP BY ii.tenant_product_id
  )
  SELECT w.tenant_product_id,
         COALESCE(u.units, 0) * 90 / v_window_days AS invoice_units_90d,
         l.last_invoice_at
  FROM wanted w
  LEFT JOIN units u ON u.tenant_product_id = w.tenant_product_id
  LEFT JOIN last_inv l ON l.tenant_product_id = w.tenant_product_id;
END;
$function$;
