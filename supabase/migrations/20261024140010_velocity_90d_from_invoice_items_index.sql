-- app.get_product_velocity_90d reads raw invoice_items through idx_invoice_items_product_created
-- (previous migration) instead of metrics_product_period_summary month buckets, so it no longer
-- depends on the metrics aggregation jobs (Job 111) and stays cheap: per product, a 90-day index range
-- scan plus one backward probe for the last invoice.
--
-- Behaviour changes vs 20261015040205: invoice_units_90d is the exact trailing-90-day sum of
-- invoice_items.qty on in-flow invoices (app.invoice_status_in_flow), not a month-bucket estimate scaled
-- to 90 days; last_invoice_at stays MAX(invoice_items.created_at). Signature, volatility, search_path,
-- tenant ownership filter and the 1000-id cap are unchanged. Apply only after the index exists.
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
  v_since timestamptz := now() - interval '90 days';
BEGIN
  IF p_tenant_id IS NULL OR p_product_ids IS NULL OR cardinality(p_product_ids) = 0 THEN
    RETURN;
  END IF;

  IF cardinality(p_product_ids) > c_max_ids THEN
    RAISE EXCEPTION 'too_many_product_ids' USING ERRCODE = '22023', DETAIL = format('max %s ids per call', c_max_ids);
  END IF;

  -- invoice_items has no tenant_id: restrict the id list to products this tenant owns first.
  SELECT COALESCE(array_agg(DISTINCT tp.id), '{}'::uuid[])
  INTO v_ids
  FROM app.tenant_products tp
  WHERE tp.id = ANY (p_product_ids)
    AND tp.tenant_id = p_tenant_id;

  RETURN QUERY
  SELECT w.id,
         COALESCE(u.units, 0)::numeric,
         l.last_invoice_at
  FROM unnest(v_ids) AS w(id)
  LEFT JOIN LATERAL (
    SELECT SUM(ii.qty) AS units
    FROM app.invoice_items ii
    JOIN app.invoices i ON i.id = ii.invoice_id
    WHERE ii.tenant_product_id = w.id
      AND ii.deleted_at IS NULL
      AND ii.created_at >= v_since
      AND i.deleted_at IS NULL
      AND app.invoice_status_in_flow(i.status)
  ) u ON true
  LEFT JOIN LATERAL (
    SELECT ii.created_at AS last_invoice_at
    FROM app.invoice_items ii
    WHERE ii.tenant_product_id = w.id
      AND ii.deleted_at IS NULL
    ORDER BY ii.created_at DESC
    LIMIT 1
  ) l ON true;
END;
$function$;

COMMENT ON FUNCTION app.get_product_velocity_90d(uuid, uuid[]) IS
  'Trailing-90-day invoiced units and last invoice time per tenant product, from invoice_items via idx_invoice_items_product_created. Used by the enquiry triage alternates endpoint.';
