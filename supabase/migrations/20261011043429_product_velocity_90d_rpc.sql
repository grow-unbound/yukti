-- Enquiry-triage product velocity without app.metrics_product_snapshot.
--
-- app.metrics_product_snapshot was dropped (20260830051940_drop_orphaned_v2_snapshot_tables) but
-- src/lib/server/load-enquiry-triage.ts kept reading it, so every inbox enquiry panel produced a
-- 404 from /rest/v1/metrics_product_snapshot and silently showed no velocity.
--
-- There is no product *now* summary table; the product read model is
-- app.metrics_product_period_summary (grains: month, quarter). This function derives a ~90 day
-- unit rate from the current + 2 previous IST month buckets and normalises it to 90 days by the
-- actual number of days covered, so callers can keep dividing by (90 / 7) weeks. last_invoice_at
-- keeps the original canonical-date definition (invoice_date at IST, falling back to created_at),
-- served by idx_invoice_items_product_invoice (tenant_product_id, invoice_id).
--
-- days_cover is NOT returned here: it needs the caller's per-location available stock, which the
-- route already loads (loadInventoryAvailabilityMap); it derives cover = available / (units/90).
--
-- Product ids come in the POST body (no URL length limit), capped at 1000.

CREATE OR REPLACE FUNCTION app.get_product_velocity_90d(p_tenant_id uuid, p_product_ids uuid[])
RETURNS TABLE (
  tenant_product_id uuid,
  invoice_units_90d numeric,
  last_invoice_at timestamptz
)
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

  v_ids := p_product_ids[1:c_max_ids];
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
    SELECT ii.tenant_product_id,
           MAX(COALESCE((i.invoice_date::timestamp AT TIME ZONE 'Asia/Kolkata'), i.created_at)) AS last_invoice_at
    FROM app.invoice_items ii
    JOIN app.invoices i ON i.id = ii.invoice_id
    WHERE ii.tenant_product_id = ANY (v_ids)
      AND ii.deleted_at IS NULL
      AND i.tenant_id = p_tenant_id
      AND i.deleted_at IS NULL
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

REVOKE ALL ON FUNCTION app.get_product_velocity_90d(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_product_velocity_90d(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION app.get_product_velocity_90d(uuid, uuid[]) IS
  'Per-product ~90 day invoiced units (from metrics_product_period_summary month buckets, normalised to 90 days) and last invoice timestamp, for enquiry triage. At most 1000 ids. service_role only.';
