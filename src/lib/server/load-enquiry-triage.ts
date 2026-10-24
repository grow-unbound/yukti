import { loadInventoryAvailabilityMap } from '@/lib/server/warehouse-inventory';
import { firstStoredImageUrl } from '@/lib/r2-url';
import {
  deriveLinePriceState,
  deriveVelocity,
  enquiryStockStatus,
  pickAlternates,
  type AlternateCandidate,
  type EnquiryTriageLine,
  type EnquiryTriagePayload,
} from '@/lib/inbox/enquiry-triage';

type DbClient = any;

const ALTERNATE_POOL_LIMIT = 40;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

type VelocitySnapshot = {
  invoice_units_90d: number;
  days_cover: number | null;
  last_invoice_at: string | null;
};

type VelocityRow = { invoice_units_90d: number; last_invoice_at: string | null };

const VELOCITY_RPC_CHUNK = 500; // get_product_velocity_90d rejects > 1000 ids per call
const VELOCITY_CACHE_TTL_MS = 10 * 60 * 1000;
const VELOCITY_CACHE_MAX_ENTRIES = 5000;

// Per-instance, tenant-scoped cache. Keys include tenantId so one tenant never reads another's rows.
// `null` marks a product the RPC did not return, so it is not re-queried inside the TTL.
const velocityCache = new Map<string, { row: VelocityRow | null; expiresAt: number }>();

function rememberVelocity(tenantId: string, productId: string, row: VelocityRow | null) {
  if (velocityCache.size >= VELOCITY_CACHE_MAX_ENTRIES) velocityCache.clear();
  velocityCache.set(`${tenantId}:${productId}`, { row, expiresAt: Date.now() + VELOCITY_CACHE_TTL_MS });
}

/** Test hook: drop cached velocity so each test controls its own RPC calls. */
export function resetVelocityCacheForTests() {
  velocityCache.clear();
}

/**
 * ~90-day invoiced units + last invoice per product via `app.get_product_velocity_90d` (product
 * period summary, month buckets), in chunks. Results are cached per tenant+product for
 * VELOCITY_CACHE_TTL_MS, so repeat triage views don't re-run the RPC (2.1 s mean, 59 s max on prod).
 * A failure degrades to "no velocity" for the enquiry panel rather than failing the triage payload.
 */
async function fetchProductVelocityRows(
  d: DbClient,
  tenantId: string,
  productIds: string[],
): Promise<Map<string, VelocityRow>> {
  const out = new Map<string, VelocityRow>();
  if (productIds.length === 0) return out;

  const now = Date.now();
  const misses: string[] = [];
  for (const id of productIds) {
    const hit = velocityCache.get(`${tenantId}:${id}`);
    if (hit && hit.expiresAt > now) {
      if (hit.row) out.set(id, hit.row);
    } else {
      misses.push(id);
    }
  }
  if (misses.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < misses.length; i += VELOCITY_RPC_CHUNK) {
    chunks.push(misses.slice(i, i + VELOCITY_RPC_CHUNK));
  }

  const results = await Promise.all(chunks.map((chunk) =>
    d.schema('app').rpc('get_product_velocity_90d', { p_tenant_id: tenantId, p_product_ids: chunk }),
  ));

  results.forEach(({ data, error }, index) => {
    if (error) {
      console.error('[load-enquiry-triage] get_product_velocity_90d', error);
      return;
    }
    const returned = new Set<string>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = asString(row.tenant_product_id);
      if (!id) continue;
      const units = Number(row.invoice_units_90d ?? 0);
      const value = {
        invoice_units_90d: Number.isFinite(units) ? units : 0,
        last_invoice_at: asString(row.last_invoice_at),
      };
      returned.add(id);
      out.set(id, value);
      rememberVelocity(tenantId, id, value);
    }
    for (const id of chunks[index]) {
      if (!returned.has(id)) rememberVelocity(tenantId, id, null);
    }
  });
  return out;
}

/** Days of cover = available / units-per-day, from the location availability the caller loaded. */
function withDaysCover(
  rows: Map<string, VelocityRow>,
  availableByProduct: Map<string, number>,
): Map<string, VelocitySnapshot> {
  const out = new Map<string, VelocitySnapshot>();
  for (const [id, row] of rows) {
    const unitsPerDay = row.invoice_units_90d > 0 ? row.invoice_units_90d / 90 : 0;
    const available = availableByProduct.get(id);
    out.set(id, {
      invoice_units_90d: row.invoice_units_90d,
      days_cover: unitsPerDay > 0 && available !== undefined && Number.isFinite(available)
        ? Math.round(Math.max(0, available) / unitsPerDay)
        : null,
      last_invoice_at: row.last_invoice_at,
    });
  }
  return out;
}

/**
 * Read-only triage view of a `new_enquiry` estimate: lines with stock, precomputed
 * ~90-day velocity (`app.get_product_velocity_90d`) and same-category alternates for
 * lines that can't be covered. Caller has already verified tenant + location access.
 */
export async function loadEnquiryTriage(
  db: DbClient,
  tenantId: string,
  estimateId: string,
): Promise<EnquiryTriagePayload | null> {
  const d = db as any;

  const [estimateRes, itemsRes, catalogRes] = await Promise.all([
    d.schema('app').from('estimates')
      .select('id, tenant_id, buyer_id, location_id, estimate_number, status, total_amount, tax_amount, discount_flat, freight, round_off, notes, estimate_type, price_visibility')
      .eq('id', estimateId).eq('tenant_id', tenantId).is('deleted_at', null).maybeSingle(),
    d.schema('app').from('estimate_items')
      .select('id, tenant_product_id, qty, unit_price, disc_pct, item_order, buyer_target_unit_price_min, buyer_target_unit_price_max, buyer_note')
      .eq('estimate_id', estimateId).is('deleted_at', null).order('item_order', { ascending: true }),
    d.schema('app').from('catalogs')
      .select('pricing_mode, collect_target_unit_price_range')
      .eq('tenant_id', tenantId)
      .eq('kind', 'public')
      .is('deleted_at', null)
      .maybeSingle(),
  ]);
  if (estimateRes.error) throw estimateRes.error;
  if (itemsRes.error) throw itemsRes.error;
  if (catalogRes.error) throw catalogRes.error;
  const estimate = estimateRes.data as Record<string, unknown> | null;
  if (!estimate) return null;
  const catalog = catalogRes.data as Record<string, unknown> | null;

  const buyerId = asString(estimate.buyer_id);
  const items = (itemsRes.data ?? []) as Array<Record<string, unknown>>;
  const productIds = Array.from(new Set(items.map((i) => asString(i.tenant_product_id)).filter((v): v is string => !!v)));
  const locationId = asString(estimate.location_id);

  const [productsRes, inventory, velocityRows] = await Promise.all([
    productIds.length
      ? d.schema('app').from('tenant_products')
          .select('id, internal_sku, name_override, master_product_id, tenant_brand_id, tenant_category_id, image_urls')
          .in('id', productIds).eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    loadInventoryAvailabilityMap(d, productIds, locationId),
    fetchProductVelocityRows(d, tenantId, productIds),
  ]);
  const snapshotMap = withDaysCover(velocityRows, inventory);

  const products = (productsRes.data ?? []) as Array<Record<string, unknown>>;
  const productMap = new Map(products.map((p) => [p.id as string, p]));

  // Alternates only for lines that need them.
  const needsAlt = items.filter((i) => {
    const pid = asString(i.tenant_product_id);
    return pid && enquiryStockStatus(Number(i.qty ?? 0), inventory.get(pid) ?? 0).tone !== 'ok';
  });
  const categoryIds = Array.from(new Set(
    needsAlt.map((i) => asString(productMap.get(i.tenant_product_id as string)?.tenant_category_id)).filter((v): v is string => !!v),
  ));
  const shortBrandIds = Array.from(new Set(
    needsAlt.map((i) => asString(productMap.get(i.tenant_product_id as string)?.tenant_brand_id)).filter((v): v is string => !!v),
  ));

  const poolCandidates: AlternateCandidate[] = [];
  const nameSources: Array<Record<string, unknown>> = [...products];
  let poolRows: Array<Record<string, unknown>> = [];
  if (needsAlt.length) {
    const cols = 'id, internal_sku, name_override, master_product_id, tenant_brand_id, tenant_category_id';
    // Same category first; same-brand products from other categories fill the gap.
    const [catRes, brandRes] = await Promise.all([
      categoryIds.length
        ? d.schema('app').from('tenant_products').select(cols)
            .eq('tenant_id', tenantId).in('tenant_category_id', categoryIds).is('deleted_at', null).limit(ALTERNATE_POOL_LIMIT * categoryIds.length)
        : Promise.resolve({ data: [] }),
      shortBrandIds.length
        ? d.schema('app').from('tenant_products').select(cols)
            .eq('tenant_id', tenantId).in('tenant_brand_id', shortBrandIds).is('deleted_at', null).limit(ALTERNATE_POOL_LIMIT * shortBrandIds.length)
        : Promise.resolve({ data: [] }),
    ]);
    const seen = new Set<string>();
    poolRows = [...((catRes.data ?? []) as Array<Record<string, unknown>>), ...((brandRes.data ?? []) as Array<Record<string, unknown>>)]
      .filter((r) => {
        const id = r.id as string;
        if (productMap.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    nameSources.push(...poolRows);
  }

  const poolIds = poolRows.map((r) => r.id as string);
  const [poolInventory, poolVelocityRows] = await Promise.all([
    loadInventoryAvailabilityMap(d, poolIds, locationId),
    fetchProductVelocityRows(d, tenantId, poolIds),
  ]);
  const poolSnapshotMap = withDaysCover(poolVelocityRows, poolInventory);

  const masterIds = Array.from(new Set(nameSources.map((p) => asString(p.master_product_id)).filter((v): v is string => !!v)));
  const brandIds = Array.from(new Set(nameSources.map((p) => asString(p.tenant_brand_id)).filter((v): v is string => !!v)));
  const [masterRes, brandRes] = await Promise.all([
    masterIds.length ? d.schema('catalog').from('products').select('id, name').in('id', masterIds) : Promise.resolve({ data: [] }),
    brandIds.length ? d.schema('app').from('tenant_brands').select('id, display_name_override, master_brand_id').in('id', brandIds).eq('tenant_id', tenantId) : Promise.resolve({ data: [] }),
  ]);
  const masterBrandIds = Array.from(new Set(((brandRes.data ?? []) as Array<Record<string, unknown>>).map((b) => asString(b.master_brand_id)).filter((v): v is string => !!v)));
  const masterBrandRes = masterBrandIds.length ? await d.schema('catalog').from('brands').select('id, name').in('id', masterBrandIds) : { data: [] };

  const masterName = new Map(((masterRes.data ?? []) as Array<Record<string, unknown>>).map((m) => [m.id as string, m.name as string]));
  const masterBrandName = new Map(((masterBrandRes.data ?? []) as Array<Record<string, unknown>>).map((b) => [b.id as string, b.name as string]));
  const brandName = new Map(((brandRes.data ?? []) as Array<Record<string, unknown>>).map((b) => [
    b.id as string,
    (asString(b.display_name_override)?.trim() || masterBrandName.get(b.master_brand_id as string) || null) as string | null,
  ]));

  const nameOf = (p: Record<string, unknown>) =>
    asString(p.name_override)?.trim() || masterName.get(p.master_product_id as string) || asString(p.internal_sku) || 'Product';
  const brandOf = (p: Record<string, unknown>) => brandName.get(p.tenant_brand_id as string) ?? null;

  for (const row of poolRows) {
    poolCandidates.push({
      tenantProductId: row.id as string,
      name: nameOf(row),
      sku: asString(row.internal_sku) ?? '—',
      brandId: asString(row.tenant_brand_id),
      brandName: brandOf(row),
      categoryId: asString(row.tenant_category_id),
      available: poolInventory.get(row.id as string) ?? 0,
      velocity: deriveVelocity(poolSnapshotMap.get(row.id as string)),
    });
  }

  // Resolve what this buyer would actually pay for each suggested alternate (app.resolve_price,
  // same precedence catalog display uses) -- without it the seller can't judge the swap's impact.
  const altPriceKey = (productId: string, qty: number) => `${productId}:${qty}`;
  const altPriceMap = new Map<string, number>();
  if (buyerId) {
    const altsByQty = new Map<number, Set<string>>();
    for (const item of items) {
      const pid = asString(item.tenant_product_id);
      const qty = Number(item.qty ?? 0);
      if (!pid || enquiryStockStatus(qty, inventory.get(pid) ?? 0).tone === 'ok') continue;
      const catId = asString(productMap.get(pid)?.tenant_category_id);
      const brandId = asString(productMap.get(pid)?.tenant_brand_id);
      const alts = pickAlternates({ tenantProductId: pid, brandId, categoryId: catId, qty }, poolCandidates);
      const set = altsByQty.get(qty) ?? new Set<string>();
      for (const alt of alts) set.add(alt.tenantProductId);
      altsByQty.set(qty, set);
    }
    const responses = await Promise.all(
      Array.from(altsByQty.entries()).map(async ([qty, ids]) => {
        const { data, error } = await d.schema('app').rpc('resolve_prices_batch', {
          p_tenant_product_ids: Array.from(ids),
          p_buyer_id: buyerId,
          p_qty: qty,
        });
        if (error) { console.error('[load-enquiry-triage] resolve_prices_batch', error); return { qty, rows: [] as Array<{ tenant_product_id: string; unit_price: number }> }; }
        return { qty, rows: (data ?? []) as Array<{ tenant_product_id: string; unit_price: number }> };
      }),
    );
    for (const { qty, rows } of responses) {
      for (const row of rows) altPriceMap.set(altPriceKey(row.tenant_product_id, qty), Number(row.unit_price ?? 0));
    }
  }

  // Resolve what this buyer would actually pay for each line's OWN product at its
  // requested qty (app.resolve_price precedence) -- a reference price the seller
  // can quote against, distinct from `unitPrice` (whatever the seller has or
  // hasn't already set on the enquiry line itself). Every line, not just short
  // ones -- unlike the alternates resolution above, which only needs a price for
  // lines that can't be covered as-is.
  const linePriceMap = new Map<string, number>();
  if (buyerId) {
    const byQty = new Map<number, Set<string>>();
    for (const item of items) {
      const pid = asString(item.tenant_product_id);
      if (!pid) continue;
      const qty = Number(item.qty ?? 0);
      const set = byQty.get(qty) ?? new Set<string>();
      set.add(pid);
      byQty.set(qty, set);
    }
    const responses = await Promise.all(
      Array.from(byQty.entries()).map(async ([qty, ids]) => {
        const { data, error } = await d.schema('app').rpc('resolve_prices_batch', {
          p_tenant_product_ids: Array.from(ids),
          p_buyer_id: buyerId,
          p_qty: qty,
        });
        if (error) { console.error('[load-enquiry-triage] resolve_prices_batch (line)', error); return { qty, rows: [] as Array<{ tenant_product_id: string; unit_price: number }> }; }
        return { qty, rows: (data ?? []) as Array<{ tenant_product_id: string; unit_price: number }> };
      }),
    );
    for (const { qty, rows } of responses) {
      for (const row of rows) linePriceMap.set(altPriceKey(row.tenant_product_id, qty), Number(row.unit_price ?? 0));
    }
  }

  const lines: EnquiryTriageLine[] = items.map((item) => {
    const pid = item.tenant_product_id as string;
    const product = productMap.get(pid);
    const qty = Number(item.qty ?? 0);
    const onHand = inventory.get(pid) ?? 0;
    const stock = enquiryStockStatus(qty, onHand);
    const unitPrice = item.unit_price == null ? null : Number(item.unit_price);
    const targetMin = item.buyer_target_unit_price_min == null ? null : Number(item.buyer_target_unit_price_min);
    const targetMax = item.buyer_target_unit_price_max == null ? null : Number(item.buyer_target_unit_price_max);
    return {
      id: item.id as string,
      tenantProductId: pid,
      name: product ? nameOf(product) : 'Product',
      sku: asString(product?.internal_sku) ?? '—',
      brandName: product ? brandOf(product) : null,
      imageUrl: firstStoredImageUrl(product?.image_urls),
      qty,
      unitPrice,
      discPct: Number.isFinite(Number(item.disc_pct)) ? Number(item.disc_pct) : 0,
      targetMin,
      targetMax,
      buyerNote: asString(item.buyer_note),
      onHand,
      stock,
      resolvedPrice: linePriceMap.get(altPriceKey(pid, qty)) ?? null,
      priceState: deriveLinePriceState({ unitPrice, targetMin, targetMax, stockTone: stock.tone }),
      velocity: deriveVelocity(snapshotMap.get(pid)),
      alternates: stock.tone !== 'ok'
        ? pickAlternates({
            tenantProductId: pid,
            brandId: asString(product?.tenant_brand_id),
            categoryId: asString(product?.tenant_category_id),
            qty,
          }, poolCandidates).map((alt) => ({
            ...alt,
            buyerPrice: altPriceMap.get(altPriceKey(alt.tenantProductId, qty)) ?? null,
          }))
        : [],
    };
  });

  return {
    estimateId,
    estimateNumber: asString(estimate.estimate_number) ?? '—',
    status: asString(estimate.status) ?? 'unknown',
    hiddenPricing: estimate.estimate_type === 'without_price' || estimate.price_visibility === 'hide_price',
    collectTargetUnitPriceRange: catalog?.pricing_mode === 'hide_price_collect_enquiry' && catalog.collect_target_unit_price_range === true,
    totalAmount: estimate.total_amount == null ? null : Number(estimate.total_amount),
    taxAmount: Number(estimate.tax_amount ?? 0),
    discountFlat: Number(estimate.discount_flat ?? 0),
    freight: Number(estimate.freight ?? 0),
    roundOff: Number(estimate.round_off ?? 0),
    notes: asString(estimate.notes),
    lines,
  };
}
