-- Add soft-delete support consistently across catalog.* and app.* tables.
-- This aligns schema with project convention and existing query usage.

-- catalog schema
ALTER TABLE catalog.brands ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE catalog.categories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE catalog.product_aliases ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- app schema
ALTER TABLE app.tenants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.tenant_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.tenant_brands ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.locations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.tenant_products ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.tenant_inventory ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.buyers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.buyer_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.cohorts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.price_lists ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.price_list_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.price_list_assignments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.published_catalogs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.published_catalog_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.order_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.audit_log ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Helpful indexes for common active-row filtering.
CREATE INDEX IF NOT EXISTS idx_catalog_brands_deleted_at ON catalog.brands(deleted_at);
CREATE INDEX IF NOT EXISTS idx_catalog_categories_deleted_at ON catalog.categories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_catalog_products_deleted_at ON catalog.products(deleted_at);
CREATE INDEX IF NOT EXISTS idx_app_buyers_deleted_at ON app.buyers(deleted_at);
CREATE INDEX IF NOT EXISTS idx_app_cohorts_deleted_at ON app.cohorts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_app_tenant_products_deleted_at ON app.tenant_products(deleted_at);
CREATE INDEX IF NOT EXISTS idx_app_price_lists_deleted_at ON app.price_lists(deleted_at);
CREATE INDEX IF NOT EXISTS idx_app_published_catalogs_deleted_at ON app.published_catalogs(deleted_at);
CREATE INDEX IF NOT EXISTS idx_app_orders_deleted_at ON app.orders(deleted_at);
