-- Price a product page once.
--
-- app.load_products_scoped and app.search_products_scoped priced every output row with
-- app.resolve_price (plpgsql, up to 4 queries per row, 40-100 rows per page), and then the app
-- called app.resolve_prices_batch for the same page and qty=1 again. This resolves the page's
-- prices with ONE app.resolve_prices_batch call inside the functions; the app can then use the
-- returned unit_price (follow-up commit).
--
-- Output-preserving: same signatures, volatility, SECURITY DEFINER, search_path and timeouts; only the
-- unit_price subexpression changed. resolve_price and resolve_prices_batch implement the same
-- precedence (buyer > cohort > all_buyers; priority desc, min_qty desc, price asc; base price fallback);
-- proven by scripts/sql/pricing-diff (equivalence: 123k buyer x product pairs, edge fixtures, golden
-- before/after of both RPCs). Safe to drop resolve_price's JWT checks here: both functions are
-- service_role-only, the buyer id is validated against the tenant in the 'normalized' CTE, and the
-- ids come from the tenant-scoped 'paged' CTE.
--
-- Rollback: re-apply the previous definitions (20260922061932_add_family_image_fallback_to_scoped_rpcs.sql).

CREATE OR REPLACE FUNCTION app.load_products_scoped(p_tenant_id uuid, p_buyer_id uuid DEFAULT NULL::uuid, p_price_list_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_ids uuid[] DEFAULT NULL::uuid[], p_brand_ids uuid[] DEFAULT NULL::uuid[], p_category_ids uuid[] DEFAULT NULL::uuid[], p_allowed_brand_ids uuid[] DEFAULT NULL::uuid[], p_warehouse_ids uuid[] DEFAULT NULL::uuid[], p_availability text DEFAULT 'show_all'::text, p_sort text DEFAULT 'created_desc'::text, p_include_inventory boolean DEFAULT true, p_campaign_id uuid DEFAULT NULL::uuid, p_category_scope_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tenant_product_id uuid, product_name text, sku text, brand_id uuid, brand_name text, category_id uuid, category_name text, hsn_code text, tax_pct numeric, on_hand numeric, reorder_point numeric, unit_price numeric, mrp numeric, base_selling_price numeric, cost_price numeric, default_uom text, pack_size numeric, created_at timestamp with time zone, total_count bigint, image_urls text[], r2_small_key text, r2_medium_key text, r2_large_key text, brand_logo_url text, category_image_thumb_key text, category_image_medium_key text, family_image_urls text[], family_r2_small_key text, family_r2_medium_key text, family_r2_large_key text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'public'
 SET statement_timeout TO '10s'
 SET lock_timeout TO '2s'
AS $function$
  WITH normalized AS (
    SELECT
      CASE
        WHEN p_buyer_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM app.buyers b
          WHERE b.id = p_buyer_id AND b.tenant_id = p_tenant_id AND b.deleted_at IS NULL
        ) THEN p_buyer_id
      END AS buyer_id,
      CASE
        WHEN p_price_list_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM app.price_lists pl
          WHERE pl.id = p_price_list_id AND pl.tenant_id = p_tenant_id AND pl.deleted_at IS NULL
        ) THEN p_price_list_id
      END AS price_list_id,
      LEAST(GREATEST(p_limit, 1), 100) AS page_size,
      GREATEST(p_offset, 0) AS page_offset
  ),
  matched_tp AS (
    SELECT tp.id
    FROM app.tenant_products tp
    WHERE tp.tenant_id = p_tenant_id
      AND EXISTS (SELECT 1 FROM app.tenants tenant WHERE tenant.id = p_tenant_id)
      AND tp.is_active = true
      AND tp.deleted_at IS NULL
      AND (p_ids IS NULL OR tp.id = ANY (p_ids))
      AND (p_brand_ids IS NULL OR tp.tenant_brand_id = ANY (p_brand_ids))
      AND (p_category_ids IS NULL OR tp.tenant_category_id = ANY (p_category_ids))
      AND (p_allowed_brand_ids IS NULL OR tp.tenant_brand_id = ANY (p_allowed_brand_ids))
      AND (
        p_category_scope_id IS NULL
        OR tp.tenant_category_id = p_category_scope_id
        OR EXISTS (
          SELECT 1 FROM app.tenant_categories tc
          WHERE tc.id = tp.tenant_category_id AND tc.master_category_id = p_category_scope_id
        )
      )
      AND (
        p_campaign_id IS NULL
        OR EXISTS (
          SELECT 1 FROM app.campaign_items ci
          JOIN app.campaigns campaign ON campaign.id = ci.campaign_id
          WHERE ci.campaign_id = p_campaign_id
            AND ci.tenant_product_id = tp.id
            AND ci.deleted_at IS NULL
            AND campaign.tenant_id = p_tenant_id
            AND campaign.deleted_at IS NULL
        )
      )
  ),
  inventory AS (
    SELECT
      ti.tenant_product_id,
      SUM(COALESCE(ti.qty_available, 0))::numeric AS on_hand,
      MAX(COALESCE(ti.reorder_point, 0))::numeric AS reorder_point,
      MAX(ti.updated_at) AS inventory_updated_at
    FROM app.tenant_inventory ti
    JOIN matched_tp mtp ON mtp.id = ti.tenant_product_id
    WHERE ti.deleted_at IS NULL
      AND p_include_inventory
      AND p_availability NOT IN ('show_all', 'show_everything')
      AND (p_warehouse_ids IS NULL OR ti.warehouse_id = ANY (p_warehouse_ids))
    GROUP BY ti.tenant_product_id
  ),
  scoped_products AS (
    SELECT
      tp.id AS tenant_product_id,
      COALESCE(tp.name_override, tp.internal_sku) AS product_name,
      tp.internal_sku AS sku,
      tp.tenant_brand_id AS brand_id,
      COALESCE(tb.display_name_override, 'Brand') AS brand_name,
      tp.tenant_category_id AS category_id,
      COALESCE(tc.name, '') AS category_name,
      tp.hsn_code AS hsn_code,
      tp.gst_rate AS tax_pct,
      COALESCE(inv.on_hand, 0) AS on_hand,
      COALESCE(inv.reorder_point, 0) AS reorder_point,
      inv.inventory_updated_at,
      tp.base_selling_price AS unit_price,
      COALESCE(tp.mrp, 0) AS mrp,
      tp.base_selling_price,
      tp.cost_price,
      tp.default_uom,
      tp.pack_size,
      tp.created_at,
      tp.image_urls,
      tp.r2_small_key,
      tp.r2_medium_key,
      tp.r2_large_key,
      tb.logo_url AS brand_logo_url,
      tc.r2_image_thumb_key AS category_image_thumb_key,
      tc.r2_image_medium_key AS category_image_medium_key,
      pf.image_urls AS family_image_urls,
      pf.r2_small_key AS family_r2_small_key,
      pf.r2_medium_key AS family_r2_medium_key,
      pf.r2_large_key AS family_r2_large_key,
      campaign_scope.display_order AS campaign_display_order
    FROM matched_tp mtp
    JOIN app.tenant_products tp ON tp.id = mtp.id
    LEFT JOIN app.tenant_brands tb ON tb.id = tp.tenant_brand_id
    LEFT JOIN app.tenant_categories tc
      ON tc.id = tp.tenant_category_id
      AND tc.tenant_id = p_tenant_id
      AND tc.deleted_at IS NULL
    LEFT JOIN app.tenant_product_families pf
      ON pf.id = tp.product_family_id
      AND pf.deleted_at IS NULL
    LEFT JOIN inventory inv ON inv.tenant_product_id = tp.id
    LEFT JOIN LATERAL (
      SELECT ci.display_order
      FROM app.campaign_items ci
      WHERE p_campaign_id IS NOT NULL
        AND ci.campaign_id = p_campaign_id
        AND ci.tenant_product_id = tp.id
        AND ci.deleted_at IS NULL
      ORDER BY ci.display_order NULLS LAST, ci.id
      LIMIT 1
    ) campaign_scope ON true
  ),
  filtered AS (
    SELECT sp.*
    FROM scoped_products sp
    WHERE (
      p_availability = 'show_all'
      OR p_availability = 'show_everything'
      OR (p_availability = 'in_stock' AND COALESCE(sp.on_hand, 0) > 0)
      OR (p_availability = 'in_stock_only' AND COALESCE(sp.on_hand, 0) > 0)
      OR (p_availability = 'low_stock' AND COALESCE(sp.on_hand, 0) > 0 AND COALESCE(sp.reorder_point, 0) > 0 AND COALESCE(sp.on_hand, 0) <= COALESCE(sp.reorder_point, 0))
      OR (p_availability = 'low_stock_only' AND COALESCE(sp.on_hand, 0) > 0 AND COALESCE(sp.reorder_point, 0) > 0 AND COALESCE(sp.on_hand, 0) <= COALESCE(sp.reorder_point, 0))
      OR (p_availability = 'out_of_stock' AND COALESCE(sp.on_hand, 0) <= 0)
      OR (
        p_availability = 'new_in_stock_today'
        AND COALESCE(sp.on_hand, 0) > 0
        AND sp.inventory_updated_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
      )
      OR (
        p_availability = 'old_stock'
        AND sp.created_at < now() - interval '7 days'
        AND NOT (
          COALESCE(sp.on_hand, 0) > 0
          AND sp.inventory_updated_at >= now() - interval '3 days'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app.order_items oi
          JOIN app.orders recent_order ON recent_order.id = oi.order_id
          WHERE oi.tenant_product_id = sp.tenant_product_id
            AND oi.deleted_at IS NULL
            AND recent_order.tenant_id = p_tenant_id
            AND recent_order.deleted_at IS NULL
            AND recent_order.status <> 'cancelled'
            AND COALESCE(
              (recent_order.order_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
              recent_order.created_at
            ) >= now() - interval '30 days'
        )
      )
    )
  ),
  paged AS MATERIALIZED (
    SELECT
      filtered.*,
      COUNT(*) OVER() AS total_count,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE
            WHEN p_campaign_id IS NOT NULL THEN 0
            WHEN p_sort = 'created_desc' THEN 0
            WHEN p_sort = 'name_asc' THEN 1
            ELSE 0
          END ASC,
          CASE WHEN p_campaign_id IS NOT NULL THEN filtered.campaign_display_order END ASC NULLS LAST,
          CASE WHEN p_sort = 'name_asc' THEN filtered.product_name END ASC,
          CASE WHEN p_sort = 'name_asc' THEN filtered.sku END ASC,
          CASE WHEN p_sort <> 'name_asc' OR p_campaign_id IS NOT NULL THEN filtered.created_at END DESC,
          filtered.product_name ASC,
          filtered.sku ASC,
          filtered.tenant_product_id ASC
      ) AS page_order
    FROM filtered
    ORDER BY page_order
    OFFSET (SELECT page_offset FROM normalized)
    LIMIT (SELECT page_size FROM normalized)
  ),
  page_inventory AS (
    SELECT
      ti.tenant_product_id,
      SUM(COALESCE(ti.qty_available, 0))::numeric AS on_hand,
      MAX(COALESCE(ti.reorder_point, 0))::numeric AS reorder_point
    FROM app.tenant_inventory ti
    JOIN paged page ON page.tenant_product_id = ti.tenant_product_id
    WHERE p_include_inventory
      AND ti.deleted_at IS NULL
      AND (p_warehouse_ids IS NULL OR ti.warehouse_id = ANY (p_warehouse_ids))
    GROUP BY ti.tenant_product_id
  ),
  page_prices AS (
    -- one batched price resolution for the whole page (qty 1), instead of app.resolve_price per row
    SELECT rp.tenant_product_id, rp.unit_price
    FROM normalized n
    CROSS JOIN LATERAL app.resolve_prices_batch(
      (SELECT array_agg(pg.tenant_product_id) FROM paged pg), n.buyer_id, 1
    ) rp
    WHERE n.buyer_id IS NOT NULL
  )
  SELECT
    page.tenant_product_id,
    page.product_name,
    page.sku,
    page.brand_id,
    page.brand_name,
    page.category_id,
    page.category_name,
    page.hsn_code,
    page.tax_pct,
    COALESCE(page_inv.on_hand, page.on_hand, 0) AS on_hand,
    COALESCE(page_inv.reorder_point, page.reorder_point, 0) AS reorder_point,
    COALESCE(pl_override.price, page_price.unit_price, page.base_selling_price, 0) AS unit_price,
    page.mrp,
    page.base_selling_price,
    page.cost_price,
    page.default_uom,
    page.pack_size,
    page.created_at,
    page.total_count,
    page.image_urls,
    page.r2_small_key,
    page.r2_medium_key,
    page.r2_large_key,
    page.brand_logo_url,
    page.category_image_thumb_key,
    page.category_image_medium_key,
    page.family_image_urls,
    page.family_r2_small_key,
    page.family_r2_medium_key,
    page.family_r2_large_key
  FROM paged page
  CROSS JOIN normalized n
  LEFT JOIN page_inventory page_inv ON page_inv.tenant_product_id = page.tenant_product_id
  LEFT JOIN page_prices page_price ON page_price.tenant_product_id = page.tenant_product_id
  LEFT JOIN LATERAL (
    SELECT pli.price
    FROM app.price_list_items pli
    WHERE n.price_list_id IS NOT NULL
      AND pli.price_list_id = n.price_list_id
      AND pli.tenant_product_id = page.tenant_product_id
      AND pli.deleted_at IS NULL
      AND COALESCE(pli.min_qty, 1) <= 1
    ORDER BY COALESCE(pli.min_qty, 1) DESC, pli.created_at DESC
    LIMIT 1
  ) pl_override ON true
  ORDER BY page.page_order;
$function$;

CREATE OR REPLACE FUNCTION app.search_products_scoped(p_tenant_id uuid, p_query text DEFAULT NULL::text, p_buyer_id uuid DEFAULT NULL::uuid, p_price_list_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_ids uuid[] DEFAULT NULL::uuid[], p_brand_ids uuid[] DEFAULT NULL::uuid[], p_category_ids uuid[] DEFAULT NULL::uuid[], p_allowed_brand_ids uuid[] DEFAULT NULL::uuid[], p_warehouse_ids uuid[] DEFAULT NULL::uuid[], p_availability text DEFAULT 'show_all'::text, p_sort text DEFAULT 'relevance'::text, p_include_inventory boolean DEFAULT true, p_campaign_id uuid DEFAULT NULL::uuid, p_category_scope_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tenant_product_id uuid, product_name text, sku text, brand_id uuid, brand_name text, category_id uuid, category_name text, hsn_code text, tax_pct numeric, on_hand numeric, reorder_point numeric, unit_price numeric, mrp numeric, base_selling_price numeric, cost_price numeric, default_uom text, pack_size numeric, created_at timestamp with time zone, search_rank double precision, total_count bigint, image_urls text[], r2_small_key text, r2_medium_key text, r2_large_key text, brand_logo_url text, category_image_thumb_key text, category_image_medium_key text, family_image_urls text[], family_r2_small_key text, family_r2_medium_key text, family_r2_large_key text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'catalog', 'public', 'extensions'
 SET statement_timeout TO '10s'
 SET lock_timeout TO '2s'
AS $function$
  WITH normalized AS (
    SELECT
      NULLIF(btrim(p_query), '') AS query,
      CASE
        WHEN NULLIF(btrim(p_query), '') IS NULL THEN NULL
        ELSE websearch_to_tsquery('english', NULLIF(btrim(p_query), ''))
      END AS ts_query,
      CASE
        WHEN NULLIF(btrim(p_query), '') IS NULL THEN NULL
        ELSE (
          SELECT to_tsquery(
            'english',
            string_agg(quote_literal(lexeme) || ':*', ' & ' ORDER BY lexeme)
          )
          FROM unnest(tsvector_to_array(to_tsvector('english', NULLIF(btrim(p_query), '')))) AS terms(lexeme)
        )
      END AS prefix_ts_query,
      lower(NULLIF(btrim(p_query), '')) AS like_q,
      CASE
        WHEN p_buyer_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM app.buyers b
          WHERE b.id = p_buyer_id
            AND b.tenant_id = p_tenant_id
            AND b.deleted_at IS NULL
        ) THEN p_buyer_id
      END AS buyer_id,
      CASE
        WHEN p_price_list_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM app.price_lists pl
          WHERE pl.id = p_price_list_id
            AND pl.tenant_id = p_tenant_id
            AND pl.deleted_at IS NULL
        ) THEN p_price_list_id
      END AS price_list_id,
      LEAST(GREATEST(p_limit, 1), 100) AS page_size,
      GREATEST(p_offset, 0) AS page_offset
  ),
  matched_tp AS (
    SELECT tp.id
    FROM app.tenant_products tp
    CROSS JOIN normalized n
    WHERE tp.tenant_id = p_tenant_id
      AND EXISTS (SELECT 1 FROM app.tenants tenant WHERE tenant.id = p_tenant_id)
      AND tp.is_active = true
      AND tp.deleted_at IS NULL
      AND (p_ids IS NULL OR tp.id = ANY (p_ids))
      AND (p_brand_ids IS NULL OR tp.tenant_brand_id = ANY (p_brand_ids))
      AND (p_category_ids IS NULL OR tp.tenant_category_id = ANY (p_category_ids))
      AND (p_allowed_brand_ids IS NULL OR tp.tenant_brand_id = ANY (p_allowed_brand_ids))
      AND (
        p_category_scope_id IS NULL
        OR tp.tenant_category_id = p_category_scope_id
        OR EXISTS (
          SELECT 1 FROM app.tenant_categories tc
          WHERE tc.id = tp.tenant_category_id AND tc.master_category_id = p_category_scope_id
        )
      )
      AND (
        p_campaign_id IS NULL
        OR EXISTS (
          SELECT 1 FROM app.campaign_items ci
          JOIN app.campaigns campaign ON campaign.id = ci.campaign_id
          WHERE ci.campaign_id = p_campaign_id
            AND ci.tenant_product_id = tp.id
            AND ci.deleted_at IS NULL
            AND campaign.tenant_id = p_tenant_id
            AND campaign.deleted_at IS NULL
        )
      )
      AND (
        n.query IS NULL
        OR (n.ts_query IS NOT NULL AND tp.search_vector @@ n.ts_query)
        OR (n.prefix_ts_query IS NOT NULL AND tp.search_vector @@ n.prefix_ts_query)
        OR lower(tp.name_override) LIKE '%' || n.like_q || '%'
        OR lower(tp.internal_sku) LIKE '%' || n.like_q || '%'
      )
  ),
  inventory AS (
    SELECT
      ti.tenant_product_id,
      SUM(COALESCE(ti.qty_available, 0))::numeric AS on_hand,
      MAX(COALESCE(ti.reorder_point, 0))::numeric AS reorder_point,
      MAX(ti.updated_at) AS inventory_updated_at
    FROM app.tenant_inventory ti
    JOIN matched_tp mtp ON mtp.id = ti.tenant_product_id
    WHERE ti.deleted_at IS NULL
      AND p_include_inventory
      AND p_availability NOT IN ('show_all', 'show_everything')
      AND (p_warehouse_ids IS NULL OR ti.warehouse_id = ANY (p_warehouse_ids))
    GROUP BY ti.tenant_product_id
  ),
  scoped_products AS (
    SELECT
      tp.id AS tenant_product_id,
      COALESCE(tp.name_override, tp.internal_sku) AS product_name,
      tp.internal_sku AS sku,
      tp.name_override,
      tp.tenant_brand_id AS brand_id,
      COALESCE(tb.display_name_override, 'Brand') AS brand_name,
      tp.tenant_category_id AS category_id,
      COALESCE(tc.name, '') AS category_name,
      tp.hsn_code AS hsn_code,
      tp.gst_rate AS tax_pct,
      COALESCE(inv.on_hand, 0) AS on_hand,
      COALESCE(inv.reorder_point, 0) AS reorder_point,
      inv.inventory_updated_at,
      tp.base_selling_price AS unit_price,
      COALESCE(tp.mrp, 0) AS mrp,
      tp.base_selling_price,
      tp.cost_price,
      tp.default_uom,
      tp.pack_size,
      tp.created_at,
      tp.search_vector,
      tp.image_urls,
      tp.r2_small_key,
      tp.r2_medium_key,
      tp.r2_large_key,
      tb.logo_url AS brand_logo_url,
      tc.r2_image_thumb_key AS category_image_thumb_key,
      tc.r2_image_medium_key AS category_image_medium_key,
      pf.image_urls AS family_image_urls,
      pf.r2_small_key AS family_r2_small_key,
      pf.r2_medium_key AS family_r2_medium_key,
      pf.r2_large_key AS family_r2_large_key,
      CASE
        WHEN NULLIF(btrim(p_query), '') IS NULL THEN NULL
        ELSE lower(
          concat_ws(
            ' ',
            COALESCE(tp.name_override, ''),
            COALESCE(tp.internal_sku, ''),
            COALESCE(tb.display_name_override, ''),
            COALESCE(tc.name, ''),
            COALESCE(tp.hsn_code, ''),
            COALESCE(tp.attributes_override::text, '')
          )
        )
      END AS search_text,
      campaign_scope.display_order AS campaign_display_order
    FROM matched_tp mtp
    JOIN app.tenant_products tp ON tp.id = mtp.id
    LEFT JOIN app.tenant_brands tb ON tb.id = tp.tenant_brand_id
    LEFT JOIN app.tenant_categories tc
      ON tc.id = tp.tenant_category_id
      AND tc.tenant_id = p_tenant_id
      AND tc.deleted_at IS NULL
    LEFT JOIN app.tenant_product_families pf
      ON pf.id = tp.product_family_id
      AND pf.deleted_at IS NULL
    LEFT JOIN inventory inv ON inv.tenant_product_id = tp.id
    LEFT JOIN LATERAL (
      SELECT ci.display_order
      FROM app.campaign_items ci
      WHERE p_campaign_id IS NOT NULL
        AND ci.campaign_id = p_campaign_id
        AND ci.tenant_product_id = tp.id
        AND ci.deleted_at IS NULL
      ORDER BY ci.display_order NULLS LAST, ci.id
      LIMIT 1
    ) campaign_scope ON true
  ),
  ranked AS (
    SELECT
      sp.*,
      COALESCE(
        CASE
          WHEN n.ts_query IS NOT NULL AND sp.search_vector @@ n.ts_query
            THEN ts_rank(sp.search_vector, n.ts_query)
          WHEN n.prefix_ts_query IS NOT NULL AND sp.search_vector @@ n.prefix_ts_query
            THEN 0.75 * ts_rank(sp.search_vector, n.prefix_ts_query)
          ELSE 0
        END,
        0
      )
      + CASE
          WHEN n.like_q IS NOT NULL AND n.like_q <> ''
            THEN 0.25 * extensions.similarity(sp.search_text, n.like_q)
          ELSE 0
        END AS search_rank
    FROM scoped_products sp
    CROSS JOIN normalized n
    WHERE (
      p_availability = 'show_all'
      OR p_availability = 'show_everything'
      OR (p_availability = 'in_stock' AND COALESCE(sp.on_hand, 0) > 0)
      OR (p_availability = 'in_stock_only' AND COALESCE(sp.on_hand, 0) > 0)
      OR (p_availability = 'low_stock' AND COALESCE(sp.on_hand, 0) > 0 AND COALESCE(sp.reorder_point, 0) > 0 AND COALESCE(sp.on_hand, 0) <= COALESCE(sp.reorder_point, 0))
      OR (p_availability = 'low_stock_only' AND COALESCE(sp.on_hand, 0) > 0 AND COALESCE(sp.reorder_point, 0) > 0 AND COALESCE(sp.on_hand, 0) <= COALESCE(sp.reorder_point, 0))
      OR (p_availability = 'out_of_stock' AND COALESCE(sp.on_hand, 0) <= 0)
      OR (
        p_availability = 'new_in_stock_today'
        AND COALESCE(sp.on_hand, 0) > 0
        AND sp.inventory_updated_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
      )
      OR (
        p_availability = 'old_stock'
        AND sp.created_at < now() - interval '7 days'
        AND NOT (
          COALESCE(sp.on_hand, 0) > 0
          AND sp.inventory_updated_at >= now() - interval '3 days'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app.order_items oi
          JOIN app.orders recent_order ON recent_order.id = oi.order_id
          WHERE oi.tenant_product_id = sp.tenant_product_id
            AND oi.deleted_at IS NULL
            AND recent_order.tenant_id = p_tenant_id
            AND recent_order.deleted_at IS NULL
            AND recent_order.status <> 'cancelled'
            AND COALESCE(
              (recent_order.order_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
              recent_order.created_at
            ) >= now() - interval '30 days'
        )
      )
    )
  ),
  paged AS MATERIALIZED (
    SELECT
      ranked.*,
      COUNT(*) OVER() AS total_count,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE
            WHEN n.query IS NULL AND p_campaign_id IS NOT NULL THEN 0
            WHEN n.query IS NULL AND p_sort = 'created_desc' THEN 0
            WHEN n.query IS NULL AND p_sort = 'name_asc' THEN 1
            ELSE 2
          END ASC,
          CASE WHEN n.query IS NULL AND p_campaign_id IS NOT NULL THEN ranked.campaign_display_order END ASC NULLS LAST,
          CASE WHEN n.query IS NULL AND p_sort = 'created_desc' THEN ranked.created_at END DESC,
          CASE WHEN n.query IS NULL AND p_sort = 'name_asc' THEN ranked.product_name END ASC,
          CASE WHEN n.query IS NULL AND p_sort = 'name_asc' THEN ranked.sku END ASC,
          ranked.search_rank DESC,
          ranked.product_name ASC,
          ranked.sku ASC,
          ranked.tenant_product_id ASC
      ) AS page_order
    FROM ranked
    CROSS JOIN normalized n
    ORDER BY page_order
    OFFSET (SELECT page_offset FROM normalized)
    LIMIT (SELECT page_size FROM normalized)
  ),
  page_inventory AS (
    SELECT
      ti.tenant_product_id,
      SUM(COALESCE(ti.qty_available, 0))::numeric AS on_hand,
      MAX(COALESCE(ti.reorder_point, 0))::numeric AS reorder_point
    FROM app.tenant_inventory ti
    JOIN paged page ON page.tenant_product_id = ti.tenant_product_id
    WHERE p_include_inventory
      AND ti.deleted_at IS NULL
      AND (p_warehouse_ids IS NULL OR ti.warehouse_id = ANY (p_warehouse_ids))
    GROUP BY ti.tenant_product_id
  ),
  page_prices AS (
    -- one batched price resolution for the whole page (qty 1), instead of app.resolve_price per row
    SELECT rp.tenant_product_id, rp.unit_price
    FROM normalized n
    CROSS JOIN LATERAL app.resolve_prices_batch(
      (SELECT array_agg(pg.tenant_product_id) FROM paged pg), n.buyer_id, 1
    ) rp
    WHERE n.buyer_id IS NOT NULL
  )
  SELECT
    page.tenant_product_id,
    page.product_name,
    page.sku,
    page.brand_id,
    page.brand_name,
    page.category_id,
    page.category_name,
    page.hsn_code,
    page.tax_pct,
    COALESCE(page_inv.on_hand, page.on_hand, 0) AS on_hand,
    COALESCE(page_inv.reorder_point, page.reorder_point, 0) AS reorder_point,
    COALESCE(pl_override.price, page_price.unit_price, page.base_selling_price, 0) AS unit_price,
    page.mrp,
    page.base_selling_price,
    page.cost_price,
    page.default_uom,
    page.pack_size,
    page.created_at,
    page.search_rank,
    page.total_count,
    page.image_urls,
    page.r2_small_key,
    page.r2_medium_key,
    page.r2_large_key,
    page.brand_logo_url,
    page.category_image_thumb_key,
    page.category_image_medium_key,
    page.family_image_urls,
    page.family_r2_small_key,
    page.family_r2_medium_key,
    page.family_r2_large_key
  FROM paged page
  CROSS JOIN normalized n
  LEFT JOIN page_inventory page_inv ON page_inv.tenant_product_id = page.tenant_product_id
  LEFT JOIN page_prices page_price ON page_price.tenant_product_id = page.tenant_product_id
  LEFT JOIN LATERAL (
    SELECT pli.price
    FROM app.price_list_items pli
    WHERE n.price_list_id IS NOT NULL
      AND pli.price_list_id = n.price_list_id
      AND pli.tenant_product_id = page.tenant_product_id
      AND pli.deleted_at IS NULL
      AND COALESCE(pli.min_qty, 1) <= 1
    ORDER BY COALESCE(pli.min_qty, 1) DESC, pli.created_at DESC
    LIMIT 1
  ) pl_override ON true
  ORDER BY page.page_order;
$function$;
