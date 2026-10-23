-- Reconcile the still-relevant Pulse gaps from the pre-v2 implementation with
-- the current request-time Pulse v2 scorecard.
--
-- 1. Demand captured follows the tenant's primary document kind. Summing both
--    estimates and their converted orders double-counts the same demand.
-- 2. Estimate-led tenants derive the attributed conversion card from converted
--    buyer-app estimates. Historical converted invoices did not always carry
--    is_buyer_app_invoice, so the invoice flag alone understates attribution.

CREATE OR REPLACE FUNCTION app._pulse_window_metrics(
  p_tenant_id uuid,
  p_from date,
  p_to_excl date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app'
AS $function$
  WITH settings AS (
    SELECT app.metrics_v4_primary_demand_kind(p_tenant_id) AS primary_kind
  ), est AS (
    SELECT e.buyer_id, e.status, e.total_amount, e.item_count
    FROM app.estimates e
    WHERE e.tenant_id = p_tenant_id
      AND e.deleted_at IS NULL
      AND e.is_buyer_app_estimate
      AND e.buyer_id IS NOT NULL
      AND app.estimate_status_counts_as_demand(e.status)
      AND app.metric_day_ist(e.estimate_date, e.created_at) >= p_from
      AND app.metric_day_ist(e.estimate_date, e.created_at) < p_to_excl
  ), ord AS (
    SELECT o.buyer_id, o.total_amount
    FROM app.orders o
    WHERE o.tenant_id = p_tenant_id
      AND o.deleted_at IS NULL
      AND o.is_buyer_app_order
      AND o.buyer_id IS NOT NULL
      AND app.order_status_in_flow(o.status)
      AND app.metric_day_ist(o.order_date, o.created_at) >= p_from
      AND app.metric_day_ist(o.order_date, o.created_at) < p_to_excl
  ), inv AS (
    SELECT i.buyer_id, i.total_amount, i.is_buyer_app_invoice AS is_app
    FROM app.invoices i
    WHERE i.tenant_id = p_tenant_id
      AND i.deleted_at IS NULL
      AND app.invoice_status_gmv_included(i.status)
      AND app.metric_day_ist(i.invoice_date, i.created_at) >= p_from
      AND app.metric_day_ist(i.invoice_date, i.created_at) < p_to_excl
  )
  SELECT jsonb_build_object(
    'demand_value', CASE settings.primary_kind
      WHEN 'estimates' THEN COALESCE((SELECT sum(total_amount) FROM est), 0)
      WHEN 'orders' THEN COALESCE((SELECT sum(total_amount) FROM ord), 0)
      ELSE 0
    END,
    'demand_docs', CASE settings.primary_kind
      WHEN 'estimates' THEN (SELECT count(*) FROM est)
      WHEN 'orders' THEN (SELECT count(*) FROM ord)
      ELSE 0
    END,
    'demand_buyers', CASE settings.primary_kind
      WHEN 'estimates' THEN (SELECT count(DISTINCT buyer_id) FROM est)
      WHEN 'orders' THEN (SELECT count(DISTINCT buyer_id) FROM ord)
      ELSE 0
    END,
    'quotes', jsonb_build_object(
      'count', (SELECT count(*) FROM est),
      'converted', (SELECT count(*) FROM est WHERE status IN ('invoiced', 'converted')),
      'lost', (SELECT count(*) FROM est WHERE status IN ('expired', 'declined')),
      'open', (SELECT count(*) FROM est WHERE status IN ('sent', 'accepted'))
    ),
    'median_quote', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_amount) FROM est),
    'avg_lines', (SELECT avg(item_count) FROM est),
    'app_invoiced_value', CASE settings.primary_kind
      WHEN 'estimates' THEN COALESCE((SELECT sum(total_amount) FROM est WHERE status IN ('invoiced', 'converted')), 0)
      ELSE COALESCE((SELECT sum(total_amount) FROM inv WHERE is_app), 0)
    END,
    'app_invoiced_docs', CASE settings.primary_kind
      WHEN 'estimates' THEN (SELECT count(*) FROM est WHERE status IN ('invoiced', 'converted'))
      ELSE (SELECT count(*) FROM inv WHERE is_app)
    END,
    'app_invoiced_buyers', CASE settings.primary_kind
      WHEN 'estimates' THEN (SELECT count(DISTINCT buyer_id) FROM est WHERE status IN ('invoiced', 'converted'))
      ELSE (SELECT count(DISTINCT buyer_id) FROM inv WHERE is_app)
    END,
    'total_invoiced_value', COALESCE((SELECT sum(total_amount) FROM inv), 0),
    'total_invoiced_docs', (SELECT count(*) FROM inv),
    'engaged_buyers', (
      SELECT count(DISTINCT e.buyer_id)
      FROM app.buyer_app_engagement e
      WHERE e.tenant_id = p_tenant_id
        AND e.occurred_day >= p_from
        AND e.occurred_day < p_to_excl
    )
  )
  FROM settings;
$function$;

REVOKE ALL ON FUNCTION app._pulse_window_metrics(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._pulse_window_metrics(uuid, date, date) TO service_role;

-- Repair historical attribution when an invoice is linked to buyer-app demand.
-- This is idempotent and does not fabricate document relationships.
UPDATE app.invoices i
SET is_buyer_app_invoice = true
WHERE i.deleted_at IS NULL
  AND NOT i.is_buyer_app_invoice
  AND (
    EXISTS (
      SELECT 1
      FROM app.estimates e
      WHERE e.id = i.estimate_id
        AND e.is_buyer_app_estimate
    )
    OR EXISTS (
      SELECT 1
      FROM app.estimates e
      WHERE e.converted_to_invoice_id = i.id
        AND e.is_buyer_app_estimate
    )
    OR EXISTS (
      SELECT 1
      FROM app.orders o
      WHERE o.id = i.order_id
        AND o.is_buyer_app_order
    )
  );

COMMENT ON FUNCTION app._pulse_window_metrics(uuid, date, date) IS
  'Pulse v2 headline metrics for one window. Demand follows the tenant primary document kind; estimate-led attribution uses converted buyer-app estimates.';
