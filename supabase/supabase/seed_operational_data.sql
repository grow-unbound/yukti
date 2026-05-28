-- ============================================================
-- DealFlow Operational Seed — Complete App Dataset Coverage
--
-- Append-only and tenant-scoped seed that creates realistic
-- operational data across app.* tables for demo visualization.
--
-- Assumes supabase/supabase/seed.sql has already been applied.
-- ============================================================

DO $$
DECLARE
  v_tenant_slug text := 'techwave';

  v_tenant_id uuid;
  v_seller_user_id uuid;

  v_today date := current_date;
  v_start_date date := current_date - 13;

  v_loc_main_id uuid;
  v_loc_branch_id uuid;
  v_loc_city_id uuid;

  v_cohort_premium_id uuid;
  v_cohort_growth_id uuid;
  v_cohort_value_id uuid;

  v_pl_all_id uuid;
  v_pl_cohort_premium_id uuid;
  v_pl_buyer_special_id uuid;
  v_pl_expired_id uuid;

  v_catalog_published_all_id uuid;
  v_catalog_published_cohort_id uuid;
  v_catalog_draft_buyer_id uuid;

  v_day date;
  v_order_idx integer;
  v_orders_for_day integer;

  v_order_id uuid;
  v_order_number text;
  v_buyer_id uuid;
  v_catalog_id uuid;
  v_source text;
  v_status text;

  v_items_count integer;
  v_item_idx integer;
  v_tp_id uuid;
  v_base_price numeric;
  v_tax_rate numeric;
  v_qty numeric;
  v_unit_price numeric;
  v_line_total numeric;

  v_subtotal numeric;
  v_tax_amount numeric;
  v_total_amount numeric;

  v_order_ts timestamptz;
  v_created_ts timestamptz;
BEGIN
  -- ------------------------------------------------------------
  -- 0) Resolve tenant and actor
  -- ------------------------------------------------------------
  SELECT t.id INTO v_tenant_id
  FROM app.tenants t
  WHERE t.slug = v_tenant_slug
  LIMIT 1;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant with slug % not found. Run seed.sql first or change v_tenant_slug.', v_tenant_slug;
  END IF;

  SELECT tu.user_id INTO v_seller_user_id
  FROM app.tenant_users tu
  WHERE tu.tenant_id = v_tenant_id
    AND tu.role IN ('seller_admin', 'seller_assistant')
    AND tu.is_active = true
  ORDER BY (tu.role = 'seller_admin') DESC, tu.created_at ASC
  LIMIT 1;

  IF v_seller_user_id IS NULL THEN
    RAISE EXCEPTION 'No active seller user found for tenant %.', v_tenant_slug;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app.buyers b WHERE b.tenant_id = v_tenant_id AND b.is_active = true AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'No buyers found for tenant %. Run seed.sql first.', v_tenant_slug;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app.tenant_products tp WHERE tp.tenant_id = v_tenant_id AND tp.is_active = true AND tp.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'No active tenant_products found for tenant %. Run seed.sql first.', v_tenant_slug;
  END IF;

  -- ------------------------------------------------------------
  -- 1) Locations (2-3 deterministic rows)
  -- ------------------------------------------------------------
  INSERT INTO app.locations (
    tenant_id, name, address, is_default,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_tenant_id,
    x.name,
    x.address,
    x.is_default,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    VALUES
      ('Main Warehouse', '{"line1":"42 Industrial Area","city":"Bangalore","state":"KA","pincode":"560058"}'::jsonb, true),
      ('South Branch Hub', '{"line1":"18 Electronics Hub","city":"Hyderabad","state":"TS","pincode":"500016"}'::jsonb, false),
      ('City Dispatch Point', '{"line1":"77 Market Road","city":"Mysore","state":"KA","pincode":"570001"}'::jsonb, false)
  ) AS x(name, address, is_default)
  WHERE NOT EXISTS (
    SELECT 1
    FROM app.locations l
    WHERE l.tenant_id = v_tenant_id
      AND l.name = x.name
      AND l.deleted_at IS NULL
  );

  SELECT id INTO v_loc_main_id
  FROM app.locations
  WHERE tenant_id = v_tenant_id AND name = 'Main Warehouse' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_loc_branch_id
  FROM app.locations
  WHERE tenant_id = v_tenant_id AND name = 'South Branch Hub' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_loc_city_id
  FROM app.locations
  WHERE tenant_id = v_tenant_id AND name = 'City Dispatch Point' AND deleted_at IS NULL
  LIMIT 1;

  -- ------------------------------------------------------------
  -- 2) Cohorts + members (2-3 deterministic rows)
  -- ------------------------------------------------------------
  INSERT INTO app.cohorts (
    tenant_id, name, description, rules, is_static, cached_member_count,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_tenant_id,
    x.name,
    x.description,
    x.rules,
    x.is_static,
    0,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    VALUES
      (
        'Premium Buyers',
        'Top-tier buyers with high monthly volume and better credit terms',
        '{"logic":"AND","conditions":[{"field":"tier","op":"eq","value":"A"}]}'::jsonb,
        false
      ),
      (
        'Growth Accounts',
        'Fast-growing buyers targeted with upsell offers',
        '{"logic":"AND","conditions":[{"field":"tier","op":"eq","value":"B"}]}'::jsonb,
        false
      ),
      (
        'Value Hunters',
        'Price-sensitive buyers for promo and accessory-heavy bundles',
        '{"logic":"AND","conditions":[{"field":"tier","op":"eq","value":"C"}]}'::jsonb,
        false
      )
  ) AS x(name, description, rules, is_static)
  WHERE NOT EXISTS (
    SELECT 1
    FROM app.cohorts c
    WHERE c.tenant_id = v_tenant_id
      AND c.name = x.name
      AND c.deleted_at IS NULL
  );

  SELECT id INTO v_cohort_premium_id
  FROM app.cohorts
  WHERE tenant_id = v_tenant_id AND name = 'Premium Buyers' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_cohort_growth_id
  FROM app.cohorts
  WHERE tenant_id = v_tenant_id AND name = 'Growth Accounts' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_cohort_value_id
  FROM app.cohorts
  WHERE tenant_id = v_tenant_id AND name = 'Value Hunters' AND deleted_at IS NULL
  LIMIT 1;

  INSERT INTO app.cohort_members (cohort_id, buyer_id)
  SELECT v_cohort_premium_id, b.id
  FROM app.buyers b
  WHERE b.tenant_id = v_tenant_id
    AND b.is_active = true
    AND COALESCE(b.tier, 'B') = 'A'
    AND NOT EXISTS (
      SELECT 1 FROM app.cohort_members cm
      WHERE cm.cohort_id = v_cohort_premium_id
        AND cm.buyer_id = b.id
    );

  INSERT INTO app.cohort_members (cohort_id, buyer_id)
  SELECT v_cohort_growth_id, b.id
  FROM app.buyers b
  WHERE b.tenant_id = v_tenant_id
    AND b.is_active = true
    AND COALESCE(b.tier, 'B') = 'B'
    AND NOT EXISTS (
      SELECT 1 FROM app.cohort_members cm
      WHERE cm.cohort_id = v_cohort_growth_id
        AND cm.buyer_id = b.id
    );

  INSERT INTO app.cohort_members (cohort_id, buyer_id)
  SELECT v_cohort_value_id, b.id
  FROM app.buyers b
  WHERE b.tenant_id = v_tenant_id
    AND b.is_active = true
    AND COALESCE(b.tier, 'C') = 'C'
    AND NOT EXISTS (
      SELECT 1 FROM app.cohort_members cm
      WHERE cm.cohort_id = v_cohort_value_id
        AND cm.buyer_id = b.id
    );

  UPDATE app.cohorts c
  SET cached_member_count = (
      SELECT COUNT(*)
      FROM app.cohort_members cm
      WHERE cm.cohort_id = c.id
    ),
    updated_at = now(),
    updated_by = v_seller_user_id
  WHERE c.tenant_id = v_tenant_id
    AND c.deleted_at IS NULL;

  -- ------------------------------------------------------------
  -- 3) Price lists + assignments + items
  -- ------------------------------------------------------------
  INSERT INTO app.price_lists (
    tenant_id, name, currency, valid_from, valid_to, priority, is_active,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_tenant_id,
    x.name,
    'INR',
    x.valid_from,
    x.valid_to,
    x.priority,
    x.is_active,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    VALUES
      ('Operational Base Pricing', now() - interval '30 days', NULL::timestamptz, 10, true),
      ('Premium Cohort Boost',     now() - interval '14 days', NULL::timestamptz, 40, true),
      ('Special Buyer Contract',   now() - interval '7 days',  now() + interval '30 days', 60, true),
      ('Festival Promo (Expired)', now() - interval '45 days', now() - interval '20 days', 20, false)
  ) AS x(name, valid_from, valid_to, priority, is_active)
  WHERE NOT EXISTS (
    SELECT 1
    FROM app.price_lists pl
    WHERE pl.tenant_id = v_tenant_id
      AND pl.name = x.name
      AND pl.deleted_at IS NULL
  );

  SELECT id INTO v_pl_all_id
  FROM app.price_lists
  WHERE tenant_id = v_tenant_id AND name = 'Operational Base Pricing' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_pl_cohort_premium_id
  FROM app.price_lists
  WHERE tenant_id = v_tenant_id AND name = 'Premium Cohort Boost' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_pl_buyer_special_id
  FROM app.price_lists
  WHERE tenant_id = v_tenant_id AND name = 'Special Buyer Contract' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_pl_expired_id
  FROM app.price_lists
  WHERE tenant_id = v_tenant_id AND name = 'Festival Promo (Expired)' AND deleted_at IS NULL
  LIMIT 1;

  INSERT INTO app.price_list_assignments (
    price_list_id, target_type, target_id,
    created_at, updated_at, created_by, updated_by
  )
  SELECT v_pl_all_id, 'all_buyers', NULL, now(), now(), v_seller_user_id, v_seller_user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM app.price_list_assignments pla
    WHERE pla.price_list_id = v_pl_all_id
      AND pla.target_type = 'all_buyers'
      AND pla.target_id IS NULL
  );

  INSERT INTO app.price_list_assignments (
    price_list_id, target_type, target_id,
    created_at, updated_at, created_by, updated_by
  )
  SELECT v_pl_cohort_premium_id, 'cohort', v_cohort_premium_id, now(), now(), v_seller_user_id, v_seller_user_id
  WHERE v_cohort_premium_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.price_list_assignments pla
      WHERE pla.price_list_id = v_pl_cohort_premium_id
        AND pla.target_type = 'cohort'
        AND pla.target_id = v_cohort_premium_id
    );

  INSERT INTO app.price_list_assignments (
    price_list_id, target_type, target_id,
    created_at, updated_at, created_by, updated_by
  )
  SELECT v_pl_buyer_special_id, 'buyer', b.id, now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    SELECT id
    FROM app.buyers
    WHERE tenant_id = v_tenant_id AND is_active = true AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  ) b
  WHERE NOT EXISTS (
    SELECT 1 FROM app.price_list_assignments pla
    WHERE pla.price_list_id = v_pl_buyer_special_id
      AND pla.target_type = 'buyer'
      AND pla.target_id = b.id
  );

  INSERT INTO app.price_list_items (
    price_list_id, tenant_product_id, price, min_qty, max_qty,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_pl_all_id,
    tp.id,
    round(tp.base_selling_price * 0.98, 2),
    1,
    NULL,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM app.tenant_products tp
  WHERE tp.tenant_id = v_tenant_id
    AND tp.is_active = true
    AND tp.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.price_list_items pli
      WHERE pli.price_list_id = v_pl_all_id
        AND pli.tenant_product_id = tp.id
        AND pli.min_qty = 1
    );

  INSERT INTO app.price_list_items (
    price_list_id, tenant_product_id, price, min_qty, max_qty,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_pl_cohort_premium_id,
    tp.id,
    round(tp.base_selling_price * 0.95, 2),
    1,
    NULL,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM app.tenant_products tp
  JOIN catalog.products p ON p.id = tp.master_product_id
  WHERE tp.tenant_id = v_tenant_id
    AND tp.is_active = true
    AND tp.deleted_at IS NULL
    AND p.category_id IN (
      SELECT c.id FROM catalog.categories c WHERE c.slug IN ('smartphones', 'tablets')
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.price_list_items pli
      WHERE pli.price_list_id = v_pl_cohort_premium_id
        AND pli.tenant_product_id = tp.id
        AND pli.min_qty = 1
    );

  INSERT INTO app.price_list_items (
    price_list_id, tenant_product_id, price, min_qty, max_qty,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_pl_buyer_special_id,
    tp.id,
    round(tp.base_selling_price * 0.93, 2),
    5,
    NULL,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM app.tenant_products tp
  JOIN catalog.products p ON p.id = tp.master_product_id
  WHERE tp.tenant_id = v_tenant_id
    AND tp.is_active = true
    AND tp.deleted_at IS NULL
    AND p.category_id IN (
      SELECT c.id FROM catalog.categories c WHERE c.slug IN ('accessories', 'audio')
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.price_list_items pli
      WHERE pli.price_list_id = v_pl_buyer_special_id
        AND pli.tenant_product_id = tp.id
        AND pli.min_qty = 5
    );

  INSERT INTO app.price_list_items (
    price_list_id, tenant_product_id, price, min_qty, max_qty,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_pl_expired_id,
    tp.id,
    round(tp.base_selling_price * 0.90, 2),
    1,
    3,
    now() - interval '25 days', now() - interval '25 days', v_seller_user_id, v_seller_user_id
  FROM app.tenant_products tp
  WHERE tp.tenant_id = v_tenant_id
    AND tp.is_active = true
    AND tp.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.price_list_items pli
      WHERE pli.price_list_id = v_pl_expired_id
        AND pli.tenant_product_id = tp.id
        AND pli.min_qty = 1
    );

  -- ------------------------------------------------------------
  -- 4) Catalogs + catalog items (draft + published)
  -- ------------------------------------------------------------
  INSERT INTO app.published_catalogs (
    tenant_id, name, scope_type, scope_value,
    valid_from, valid_to, status,
    hero_image_url, message, share_token,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    v_tenant_id,
    x.name,
    x.scope_type,
    x.scope_value,
    x.valid_from,
    x.valid_to,
    x.status,
    x.hero_image_url,
    x.message,
    x.share_token,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    VALUES
      (
        'Weekly Bestseller Drop',
        'all',
        '{}'::jsonb,
        now() - interval '7 days',
        now() + interval '21 days',
        'published',
        'https://images.example.com/catalogs/weekly-bestsellers.jpg',
        'Top moving SKUs this week with ready stock.',
        'techwave-weekly-bestsellers'
      ),
      (
        'Premium Corporate Bundle',
        'cohort',
        jsonb_build_object('cohort_id', v_cohort_premium_id),
        now() - interval '5 days',
        now() + interval '25 days',
        'published',
        'https://images.example.com/catalogs/premium-corporate.jpg',
        'Premium device bundles for enterprise buyers.',
        'techwave-premium-corp'
      ),
      (
        'Buyer Spotlight Draft',
        'buyer',
        (
          SELECT jsonb_build_object('buyer_id', b.id)
          FROM app.buyers b
          WHERE b.tenant_id = v_tenant_id
            AND b.is_active = true
            AND b.deleted_at IS NULL
          ORDER BY b.created_at DESC
          LIMIT 1
        ),
        now(),
        now() + interval '15 days',
        'draft',
        'https://images.example.com/catalogs/buyer-spotlight.jpg',
        'Draft curation for a focused buyer account.',
        'techwave-buyer-spotlight-draft'
      )
  ) AS x(name, scope_type, scope_value, valid_from, valid_to, status, hero_image_url, message, share_token)
  WHERE NOT EXISTS (
    SELECT 1
    FROM app.published_catalogs pc
    WHERE pc.tenant_id = v_tenant_id
      AND pc.share_token = x.share_token
      AND pc.deleted_at IS NULL
  );

  SELECT id INTO v_catalog_published_all_id
  FROM app.published_catalogs
  WHERE tenant_id = v_tenant_id AND share_token = 'techwave-weekly-bestsellers' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_catalog_published_cohort_id
  FROM app.published_catalogs
  WHERE tenant_id = v_tenant_id AND share_token = 'techwave-premium-corp' AND deleted_at IS NULL
  LIMIT 1;

  SELECT id INTO v_catalog_draft_buyer_id
  FROM app.published_catalogs
  WHERE tenant_id = v_tenant_id AND share_token = 'techwave-buyer-spotlight-draft' AND deleted_at IS NULL
  LIMIT 1;

  INSERT INTO app.published_catalog_items (
    catalog_id, tenant_product_id, is_featured, display_order, price_override,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    c.catalog_id,
    tp.id,
    (c.row_num % 5 = 0),
    c.row_num,
    CASE WHEN c.row_num % 4 = 0 THEN round(tp.base_selling_price * 0.97, 2) ELSE NULL END,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    SELECT v_catalog_published_all_id AS catalog_id, tp2.id AS tp_id, row_number() OVER (ORDER BY tp2.created_at, tp2.id) AS row_num
    FROM app.tenant_products tp2
    WHERE tp2.tenant_id = v_tenant_id AND tp2.is_active = true AND tp2.deleted_at IS NULL
    LIMIT 12
  ) c
  JOIN app.tenant_products tp ON tp.id = c.tp_id
  WHERE NOT EXISTS (
    SELECT 1 FROM app.published_catalog_items pci
    WHERE pci.catalog_id = c.catalog_id
      AND pci.tenant_product_id = tp.id
  );

  INSERT INTO app.published_catalog_items (
    catalog_id, tenant_product_id, is_featured, display_order, price_override,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    c.catalog_id,
    tp.id,
    (c.row_num % 3 = 0),
    c.row_num,
    CASE WHEN c.row_num % 2 = 0 THEN round(tp.base_selling_price * 0.95, 2) ELSE NULL END,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    SELECT v_catalog_published_cohort_id AS catalog_id, tp2.id AS tp_id, row_number() OVER (ORDER BY tp2.created_at, tp2.id) AS row_num
    FROM app.tenant_products tp2
    JOIN catalog.products p ON p.id = tp2.master_product_id
    JOIN catalog.categories c ON c.id = p.category_id
    WHERE tp2.tenant_id = v_tenant_id
      AND tp2.is_active = true
      AND tp2.deleted_at IS NULL
      AND c.slug IN ('smartphones', 'tablets', 'wearables')
    LIMIT 10
  ) c
  JOIN app.tenant_products tp ON tp.id = c.tp_id
  WHERE NOT EXISTS (
    SELECT 1 FROM app.published_catalog_items pci
    WHERE pci.catalog_id = c.catalog_id
      AND pci.tenant_product_id = tp.id
  );

  INSERT INTO app.published_catalog_items (
    catalog_id, tenant_product_id, is_featured, display_order, price_override,
    created_at, updated_at, created_by, updated_by
  )
  SELECT
    c.catalog_id,
    tp.id,
    false,
    c.row_num,
    NULL,
    now(), now(), v_seller_user_id, v_seller_user_id
  FROM (
    SELECT v_catalog_draft_buyer_id AS catalog_id, tp2.id AS tp_id, row_number() OVER (ORDER BY tp2.created_at DESC, tp2.id DESC) AS row_num
    FROM app.tenant_products tp2
    WHERE tp2.tenant_id = v_tenant_id AND tp2.is_active = true AND tp2.deleted_at IS NULL
    LIMIT 8
  ) c
  JOIN app.tenant_products tp ON tp.id = c.tp_id
  WHERE NOT EXISTS (
    SELECT 1 FROM app.published_catalog_items pci
    WHERE pci.catalog_id = c.catalog_id
      AND pci.tenant_product_id = tp.id
  );

  -- ------------------------------------------------------------
  -- 5) Tenant inventory coverage across all locations
  -- ------------------------------------------------------------
  INSERT INTO app.tenant_inventory (
    tenant_product_id, location_id, qty_available, qty_reserved, reorder_point, updated_at
  )
  SELECT
    tp.id,
    l.id,
    CASE
      WHEN l.id = v_loc_main_id   THEN (30 + (abs(('x' || substr(md5(tp.id::text || l.id::text), 1, 8))::bit(32)::int) % 120))::numeric
      WHEN l.id = v_loc_branch_id THEN (10 + (abs(('x' || substr(md5(tp.id::text || l.id::text), 1, 8))::bit(32)::int) % 60))::numeric
      ELSE (5 + (abs(('x' || substr(md5(tp.id::text || l.id::text), 1, 8))::bit(32)::int) % 35))::numeric
    END,
    (abs(('x' || substr(md5(tp.id::text || l.id::text || 'res'), 1, 8))::bit(32)::int) % 6)::numeric,
    CASE
      WHEN l.id = v_loc_main_id THEN 15
      WHEN l.id = v_loc_branch_id THEN 8
      ELSE 5
    END,
    now()
  FROM app.tenant_products tp
  CROSS JOIN app.locations l
  WHERE tp.tenant_id = v_tenant_id
    AND tp.is_active = true
    AND tp.deleted_at IS NULL
    AND l.tenant_id = v_tenant_id
    AND l.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.tenant_inventory ti
      WHERE ti.tenant_product_id = tp.id
        AND ti.location_id = l.id
    );

  -- ------------------------------------------------------------
  -- 6) Orders + order items for last 14 days
  -- ------------------------------------------------------------
  FOR v_day IN SELECT generate_series(v_start_date, v_today, interval '1 day')::date LOOP
    -- Weekdays busier than weekends
    v_orders_for_day := CASE
      WHEN extract(isodow FROM v_day) IN (6, 7) THEN 2 + (extract(day FROM v_day)::int % 3)
      ELSE 4 + (extract(day FROM v_day)::int % 4)
    END;

    FOR v_order_idx IN 1..v_orders_for_day LOOP
      v_order_number := format('DF-%s-%s', to_char(v_day, 'YYYYMMDD'), lpad(v_order_idx::text, 3, '0'));

      -- Skip if already present (idempotent append behavior)
      IF EXISTS (
        SELECT 1 FROM app.orders o
        WHERE o.tenant_id = v_tenant_id
          AND o.order_number = v_order_number
          AND o.deleted_at IS NULL
      ) THEN
        CONTINUE;
      END IF;

      SELECT b.id INTO v_buyer_id
      FROM app.buyers b
      WHERE b.tenant_id = v_tenant_id
        AND b.is_active = true
        AND b.deleted_at IS NULL
      ORDER BY md5((b.id::text || v_day::text || v_order_idx::text))
      LIMIT 1;

      v_source := CASE (v_order_idx % 3)
        WHEN 0 THEN 'buyer_app'
        WHEN 1 THEN 'cockpit_manual'
        ELSE 'csv_import'
      END;

      v_status := CASE ((extract(day FROM v_day)::int + v_order_idx) % 7)
        WHEN 0 THEN 'received'
        WHEN 1 THEN 'confirmed'
        WHEN 2 THEN 'partially_dispatched'
        WHEN 3 THEN 'dispatched'
        WHEN 4 THEN 'delivered'
        WHEN 5 THEN 'cancelled'
        ELSE 'delivered'
      END;

      IF (v_order_idx % 3) = 0 THEN
        v_catalog_id := v_catalog_published_cohort_id;
      ELSIF (v_order_idx % 2) = 0 THEN
        v_catalog_id := v_catalog_published_all_id;
      ELSE
        v_catalog_id := NULL;
      END IF;

      v_order_ts := (v_day::timestamptz + make_interval(hours => 9 + (v_order_idx % 9), mins => (v_order_idx * 7) % 60));
      v_created_ts := v_order_ts + interval '10 minutes';

      INSERT INTO app.orders (
        tenant_id, buyer_id, placed_by, order_number,
        status, source, catalog_id,
        subtotal, tax_amount, total_amount, currency,
        notes, placed_at,
        created_at, updated_at, created_by, updated_by
      )
      VALUES (
        v_tenant_id, v_buyer_id, v_seller_user_id, v_order_number,
        v_status, v_source, v_catalog_id,
        0, 0, 0, 'INR',
        format('Seeded operational order for %s', to_char(v_day, 'YYYY-MM-DD')),
        v_order_ts,
        v_created_ts, v_created_ts, v_seller_user_id, v_seller_user_id
      )
      RETURNING id INTO v_order_id;

      v_items_count := 1 + ((extract(day FROM v_day)::int + v_order_idx) % 5);
      v_subtotal := 0;
      v_tax_amount := 0;

      FOR v_item_idx IN 1..v_items_count LOOP
        SELECT tp.id, COALESCE(tp.base_selling_price, 1000), COALESCE(p.gst_rate, 18)
        INTO v_tp_id, v_base_price, v_tax_rate
        FROM app.tenant_products tp
        LEFT JOIN catalog.products p ON p.id = tp.master_product_id
        WHERE tp.tenant_id = v_tenant_id
          AND tp.is_active = true
          AND tp.deleted_at IS NULL
        ORDER BY md5(tp.id::text || v_order_number || v_item_idx::text)
        LIMIT 1;

        v_qty := CASE
          WHEN v_base_price <= 2000 THEN (2 + ((v_item_idx + v_order_idx) % 8))
          WHEN v_base_price <= 15000 THEN (1 + ((v_item_idx + v_order_idx) % 4))
          ELSE 1 + ((v_item_idx + v_order_idx) % 2)
        END;

        v_unit_price := round(v_base_price * (0.94 + (((v_item_idx + v_order_idx) % 8) * 0.01)), 2);
        v_line_total := round(v_qty * v_unit_price, 2);

        INSERT INTO app.order_items (
          order_id, tenant_product_id, qty, unit_price, tax_rate, line_total,
          created_at, updated_at, created_by, updated_by
        )
        VALUES (
          v_order_id, v_tp_id, v_qty, v_unit_price, v_tax_rate, v_line_total,
          v_created_ts, v_created_ts, v_seller_user_id, v_seller_user_id
        );

        v_subtotal := v_subtotal + v_line_total;
        v_tax_amount := v_tax_amount + round(v_line_total * (v_tax_rate / 100.0), 2);
      END LOOP;

      v_total_amount := v_subtotal + v_tax_amount;

      UPDATE app.orders o
      SET subtotal = round(v_subtotal, 2),
          tax_amount = round(v_tax_amount, 2),
          total_amount = round(v_total_amount, 2),
          updated_at = now(),
          updated_by = v_seller_user_id
      WHERE o.id = v_order_id;

      INSERT INTO app.audit_log (tenant_id, actor_user_id, entity_type, entity_id, action, diff, ts)
      VALUES (
        v_tenant_id,
        v_seller_user_id,
        'order',
        v_order_id,
        'status_change',
        jsonb_build_object('from', 'draft', 'to', v_status, 'source', v_source, 'order_number', v_order_number),
        v_created_ts + interval '30 minutes'
      );
    END LOOP;
  END LOOP;

  -- ------------------------------------------------------------
  -- 7) Entity-level audit records for seeded setup
  -- ------------------------------------------------------------
  INSERT INTO app.audit_log (tenant_id, actor_user_id, entity_type, entity_id, action, diff, ts)
  SELECT v_tenant_id, v_seller_user_id, 'cohort', c.id, 'create',
         jsonb_build_object('name', c.name, 'cached_member_count', c.cached_member_count),
         now() - interval '12 days'
  FROM app.cohorts c
  WHERE c.tenant_id = v_tenant_id
    AND c.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.audit_log a
      WHERE a.entity_type = 'cohort'
        AND a.entity_id = c.id
        AND a.action = 'create'
    );

  INSERT INTO app.audit_log (tenant_id, actor_user_id, entity_type, entity_id, action, diff, ts)
  SELECT v_tenant_id, v_seller_user_id, 'price_list', pl.id, 'publish',
         jsonb_build_object('name', pl.name, 'priority', pl.priority, 'is_active', pl.is_active),
         now() - interval '10 days'
  FROM app.price_lists pl
  WHERE pl.tenant_id = v_tenant_id
    AND NOT EXISTS (
      SELECT 1 FROM app.audit_log a
      WHERE a.entity_type = 'price_list'
        AND a.entity_id = pl.id
        AND a.action = 'publish'
    );

  INSERT INTO app.audit_log (tenant_id, actor_user_id, entity_type, entity_id, action, diff, ts)
  SELECT v_tenant_id, v_seller_user_id, 'catalog', pc.id, 'publish',
         jsonb_build_object('name', pc.name, 'status', pc.status, 'scope_type', pc.scope_type),
         now() - interval '8 days'
  FROM app.published_catalogs pc
  WHERE pc.tenant_id = v_tenant_id
    AND NOT EXISTS (
      SELECT 1 FROM app.audit_log a
      WHERE a.entity_type = 'catalog'
        AND a.entity_id = pc.id
        AND a.action = 'publish'
    );

  INSERT INTO app.audit_log (tenant_id, actor_user_id, entity_type, entity_id, action, diff, ts)
  SELECT v_tenant_id, v_seller_user_id, 'inventory', tp.id, 'update',
         jsonb_build_object('coverage', 'location_stock_initialized'),
         now() - interval '7 days'
  FROM app.tenant_products tp
  WHERE tp.tenant_id = v_tenant_id
    AND tp.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM app.audit_log a
      WHERE a.entity_type = 'inventory'
        AND a.entity_id = tp.id
        AND a.action = 'update'
    );

END $$;

-- ============================================================
-- Verification block — complete-table confidence checks
-- ============================================================

-- 1) Core row counts
SELECT 'locations' AS metric, COUNT(*)::text AS value
FROM app.locations l
JOIN app.tenants t ON t.id = l.tenant_id
WHERE t.slug = 'techwave'
  AND l.deleted_at IS NULL
UNION ALL
SELECT 'cohorts', COUNT(*)::text
FROM app.cohorts c
JOIN app.tenants t ON t.id = c.tenant_id
WHERE t.slug = 'techwave' AND c.deleted_at IS NULL
UNION ALL
SELECT 'cohort_members', COUNT(*)::text
FROM app.cohort_members cm
JOIN app.cohorts c ON c.id = cm.cohort_id
JOIN app.tenants t ON t.id = c.tenant_id
WHERE t.slug = 'techwave' AND c.deleted_at IS NULL
UNION ALL
SELECT 'price_lists', COUNT(*)::text
FROM app.price_lists pl
JOIN app.tenants t ON t.id = pl.tenant_id
WHERE t.slug = 'techwave'
  AND pl.deleted_at IS NULL
UNION ALL
SELECT 'price_list_assignments', COUNT(*)::text
FROM app.price_list_assignments pla
JOIN app.price_lists pl ON pl.id = pla.price_list_id
JOIN app.tenants t ON t.id = pl.tenant_id
WHERE t.slug = 'techwave'
  AND pc.deleted_at IS NULL
UNION ALL
SELECT 'price_list_items', COUNT(*)::text
FROM app.price_list_items pli
JOIN app.price_lists pl ON pl.id = pli.price_list_id
JOIN app.tenants t ON t.id = pl.tenant_id
WHERE t.slug = 'techwave'
  AND tp.deleted_at IS NULL
UNION ALL
SELECT 'published_catalogs', COUNT(*)::text
FROM app.published_catalogs pc
JOIN app.tenants t ON t.id = pc.tenant_id
WHERE t.slug = 'techwave'
UNION ALL
SELECT 'published_catalog_items', COUNT(*)::text
FROM app.published_catalog_items pci
JOIN app.published_catalogs pc ON pc.id = pci.catalog_id
JOIN app.tenants t ON t.id = pc.tenant_id
WHERE t.slug = 'techwave'
UNION ALL
SELECT 'tenant_inventory_rows', COUNT(*)::text
FROM app.tenant_inventory ti
JOIN app.tenant_products tp ON tp.id = ti.tenant_product_id
JOIN app.tenants t ON t.id = tp.tenant_id
WHERE t.slug = 'techwave'
UNION ALL
SELECT 'orders_14d', COUNT(*)::text
FROM app.orders o
JOIN app.tenants t ON t.id = o.tenant_id
WHERE t.slug = 'techwave'
  AND o.deleted_at IS NULL
  AND o.placed_at::date >= (current_date - 13)
UNION ALL
SELECT 'order_items_14d', COUNT(*)::text
FROM app.order_items oi
JOIN app.orders o ON o.id = oi.order_id
JOIN app.tenants t ON t.id = o.tenant_id
WHERE t.slug = 'techwave'
  AND o.placed_at::date >= (current_date - 13);

-- 2) Orders by status (last 14 days)
SELECT o.status, COUNT(*) AS orders
FROM app.orders o
JOIN app.tenants t ON t.id = o.tenant_id
WHERE t.slug = 'techwave'
  AND o.deleted_at IS NULL
  AND o.placed_at::date >= (current_date - 13)
GROUP BY o.status
ORDER BY orders DESC;

-- 3) Daily GMV trend (last 14 days)
SELECT
  o.placed_at::date AS order_date,
  COUNT(*) AS orders_count,
  round(COALESCE(SUM(o.total_amount), 0), 2) AS gmv
FROM app.orders o
JOIN app.tenants t ON t.id = o.tenant_id
WHERE t.slug = 'techwave'
  AND o.deleted_at IS NULL
  AND o.placed_at::date >= (current_date - 13)
GROUP BY o.placed_at::date
ORDER BY order_date;

-- 4) Top products by quantity and revenue (last 14 days)
SELECT
  COALESCE(tp.name_override, p.name, tp.internal_sku) AS product,
  b.name AS brand,
  round(SUM(oi.qty), 2) AS qty_sold,
  round(SUM(oi.line_total), 2) AS revenue
FROM app.order_items oi
JOIN app.orders o ON o.id = oi.order_id
JOIN app.tenant_products tp ON tp.id = oi.tenant_product_id
LEFT JOIN catalog.products p ON p.id = tp.master_product_id
LEFT JOIN catalog.brands b ON b.id = p.brand_id
JOIN app.tenants t ON t.id = o.tenant_id
WHERE t.slug = 'techwave'
  AND o.deleted_at IS NULL
  AND o.placed_at::date >= (current_date - 13)
GROUP BY COALESCE(tp.name_override, p.name, tp.internal_sku), b.name
ORDER BY revenue DESC
LIMIT 10;

-- 5) Top buyers by order count (last 14 days)
SELECT
  bu.business_name,
  COUNT(*) AS orders_count,
  round(SUM(o.total_amount), 2) AS total_spend
FROM app.orders o
JOIN app.buyers bu ON bu.id = o.buyer_id
JOIN app.tenants t ON t.id = o.tenant_id
WHERE t.slug = 'techwave'
  AND o.deleted_at IS NULL
  AND o.placed_at::date >= (current_date - 13)
GROUP BY bu.business_name
ORDER BY orders_count DESC, total_spend DESC;

-- 6) Coverage checks: buyers not in any cohort
SELECT
  bu.id,
  bu.business_name,
  bu.tier
FROM app.buyers bu
JOIN app.tenants t ON t.id = bu.tenant_id
WHERE t.slug = 'techwave'
  AND bu.is_active = true
  AND NOT EXISTS (
    SELECT 1
    FROM app.cohort_members cm
    JOIN app.cohorts c ON c.id = cm.cohort_id
    WHERE cm.buyer_id = bu.id
      AND c.deleted_at IS NULL
  )
ORDER BY bu.business_name;

-- 7) Coverage checks: active products missing any price-list item
SELECT
  tp.id,
  COALESCE(tp.name_override, p.name, tp.internal_sku) AS product
FROM app.tenant_products tp
LEFT JOIN catalog.products p ON p.id = tp.master_product_id
JOIN app.tenants t ON t.id = tp.tenant_id
WHERE t.slug = 'techwave'
  AND tp.is_active = true
  AND tp.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM app.price_list_items pli
    JOIN app.price_lists pl ON pl.id = pli.price_list_id
    WHERE pli.tenant_product_id = tp.id
      AND pl.tenant_id = tp.tenant_id
  )
ORDER BY product;
