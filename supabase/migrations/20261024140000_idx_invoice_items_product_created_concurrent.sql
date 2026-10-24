-- Enquiry triage velocity (alternates path): per-product 90-day units and last invoice as index probes.
-- (tenant_product_id, created_at DESC) INCLUDE (qty) lets one product's 90-day window be a short
-- index-only range scan and its last invoice a single backward probe, instead of aggregating every
-- invoice_items row of the product (prod: ~4.4 k buffers / 114 ms even for 80 products).
-- invoice_items.created_at tracks the invoice date (99.9 % within 7 days). Partial on deleted_at IS NULL
-- like idx_invoice_items_product_invoice. CONCURRENTLY, so one statement per migration file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoice_items_product_created
  ON app.invoice_items (tenant_product_id, created_at DESC)
  INCLUDE (qty)
  WHERE deleted_at IS NULL;
