import { loadInventoryAvailabilityMap } from '@/lib/server/warehouse-inventory';
import { firstStoredImageUrl } from '@/lib/r2-url';
import {
  deriveLinePriceState,
  deriveVelocity,
  enquiryStockStatus,
  pickAlternates,
  type AlternateCandidate,
  type EnquiryAlternate,
  type EnquiryLineAlternatesPayload,
  type EnquirySummary,
  type EnquiryTriageLine,
  type EnquiryTriagePayload,
} from '@/lib/inbox/enquiry-triage';

type DbClient = any;

const ALTERNATE_POOL_LIMIT = 40;
const ENQUIRY_ITEM_LIMIT = 500; // per estimate, detail and summary alike

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
 * period summary, month buckets), in chunks. Only the alternates path calls this (pool candidates). Results are cached per tenant+product for
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

type Row = Record<string, unknown>;

/** Product + brand display names, resolved once for a set of tenant_products rows. */
async function loadDisplayNames(d: DbClient, tenantId: string, rows: Row[]) {
  const masterIds = Array.from(new Set(rows.map((p) => asString(p.master_product_id)).filter((v): v is string => !!v)));
  const brandIds = Array.from(new Set(rows.map((p) => asString(p.tenant_brand_id)).filter((v): v is string => !!v)));
  const [masterRes, brandRes] = await Promise.all([
    masterIds.length ? d.schema('catalog').from('products').select('id, name').in('id', masterIds).limit(masterIds.length) : Promise.resolve({ data: [] }),
    brandIds.length ? d.schema('app').from('tenant_brands').select('id, display_name_override, master_brand_id').in('id', brandIds).eq('tenant_id', tenantId).limit(brandIds.length) : Promise.resolve({ data: [] }),
  ]);
  const masterBrandIds = Array.from(new Set(((brandRes.data ?? []) as Row[]).map((b) => asString(b.master_brand_id)).filter((v): v is string => !!v)));
  const masterBrandRes = masterBrandIds.length
    ? await d.schema('catalog').from('brands').select('id, name').in('id', masterBrandIds).limit(masterBrandIds.length)
    : { data: [] };

  const masterName = new Map(((masterRes.data ?? []) as Row[]).map((m) => [m.id as string, m.name as string]));
  const masterBrandName = new Map(((masterBrandRes.data ?? []) as Row[]).map((b) => [b.id as string, b.name as string]));
  const brandName = new Map(((brandRes.data ?? []) as Row[]).map((b) => [
    b.id as string,
    (asString(b.display_name_override)?.trim() || masterBrandName.get(b.master_brand_id as string) || null) as string | null,
  ]));

  return {
    nameOf: (p: Row) =>
      asString(p.name_override)?.trim() || masterName.get(p.master_product_id as string) || asString(p.internal_sku) || 'Product',
    brandOf: (p: Row) => brandName.get(p.tenant_brand_id as string) ?? null,
  };
}

const priceKey = (productId: string, qty: number) => `${productId}:${qty}`;

/** One `resolve_prices_batch` per distinct qty; failures degrade to "no price" (logged). */
async function resolveBuyerPrices(
  d: DbClient,
  buyerId: string,
  idsByQty: Map<number, Set<string>>,
  label: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const responses = await Promise.all(
    Array.from(idsByQty.entries()).map(async ([qty, ids]) => {
      const { data, error } = await d.schema('app').rpc('resolve_prices_batch', {
        p_tenant_product_ids: Array.from(ids),
        p_buyer_id: buyerId,
        p_qty: qty,
      });
      if (error) {
        console.error(`[load-enquiry-triage] resolve_prices_batch (${label})`, error);
        return { qty, rows: [] as Array<{ tenant_product_id: string; unit_price: number }> };
      }
      return { qty, rows: (data ?? []) as Array<{ tenant_product_id: string; unit_price: number }> };
    }),
  );
  for (const { qty, rows } of responses) {
    for (const row of rows) out.set(priceKey(row.tenant_product_id, qty), Number(row.unit_price ?? 0));
  }
  return out;
}

/**
 * Lean triage view of a `new_enquiry` estimate: lines, stock, base rate and the seller's
 * `unit_price`. No velocity and no alternates (see `loadEnquiryAlternates`). Per-buyer price
 * resolution runs only for tenants that hide prices AND collect buyer target prices, where the
 * seller quotes against what the buyer would pay. Caller has already verified tenant + location.
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
      .eq('estimate_id', estimateId).is('deleted_at', null).order('item_order', { ascending: true }).limit(ENQUIRY_ITEM_LIMIT),
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
  const estimate = estimateRes.data as Row | null;
  if (!estimate) return null;
  const catalog = catalogRes.data as Row | null;

  const buyerId = asString(estimate.buyer_id);
  const items = (itemsRes.data ?? []) as Row[];
  const productIds = Array.from(new Set(items.map((i) => asString(i.tenant_product_id)).filter((v): v is string => !!v)));
  const locationId = asString(estimate.location_id);
  const hiddenPricing = estimate.estimate_type === 'without_price' || estimate.price_visibility === 'hide_price';
  const collectTargetUnitPriceRange = catalog?.pricing_mode === 'hide_price_collect_enquiry' && catalog.collect_target_unit_price_range === true;

  const [productsRes, inventory] = await Promise.all([
    productIds.length
      ? d.schema('app').from('tenant_products')
          .select('id, internal_sku, name_override, master_product_id, tenant_brand_id, tenant_category_id, image_urls, base_selling_price')
          .in('id', productIds).eq('tenant_id', tenantId).limit(productIds.length)
      : Promise.resolve({ data: [] }),
    loadInventoryAvailabilityMap(d, productIds, locationId),
  ]);
  const products = (productsRes.data ?? []) as Row[];
  const productMap = new Map(products.map((p) => [p.id as string, p]));
  const { nameOf, brandOf } = await loadDisplayNames(d, tenantId, products);

  // Per-buyer resolved price only where the seller quotes against it (hidden prices + target range).
  let linePriceMap = new Map<string, number>();
  if (buyerId && hiddenPricing && collectTargetUnitPriceRange) {
    const byQty = new Map<number, Set<string>>();
    for (const item of items) {
      const pid = asString(item.tenant_product_id);
      if (!pid) continue;
      const qty = Number(item.qty ?? 0);
      const set = byQty.get(qty) ?? new Set<string>();
      set.add(pid);
      byQty.set(qty, set);
    }
    linePriceMap = await resolveBuyerPrices(d, buyerId, byQty, 'line');
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
    const baseRate = product?.base_selling_price == null ? null : Number(product.base_selling_price);
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
      resolvedPrice: linePriceMap.get(priceKey(pid, qty)) ?? null,
      baseRate: baseRate != null && Number.isFinite(baseRate) ? baseRate : null,
      priceState: deriveLinePriceState({ unitPrice, targetMin, targetMax, stockTone: stock.tone }),
    };
  });

  return {
    estimateId,
    estimateNumber: asString(estimate.estimate_number) ?? '—',
    status: asString(estimate.status) ?? 'unknown',
    hiddenPricing,
    collectTargetUnitPriceRange,
    totalAmount: estimate.total_amount == null ? null : Number(estimate.total_amount),
    taxAmount: Number(estimate.tax_amount ?? 0),
    discountFlat: Number(estimate.discount_flat ?? 0),
    freight: Number(estimate.freight ?? 0),
    roundOff: Number(estimate.round_off ?? 0),
    notes: asString(estimate.notes),
    lines,
  };
}

/**
 * In-stock substitutes for ONE short line: same category first, then same brand, then fastest
 * selling. Velocity is fetched only for the pool candidates that can cover the qty, and each
 * picked alternate gets one per-buyer price. Called when the seller opens a line's alternates.
 */
export async function loadEnquiryAlternates(
  db: DbClient,
  tenantId: string,
  estimateId: string,
  lineId: string,
): Promise<EnquiryLineAlternatesPayload | null> {
  const d = db as any;
  const [estimateRes, itemRes] = await Promise.all([
    d.schema('app').from('estimates')
      .select('id, buyer_id, location_id')
      .eq('id', estimateId).eq('tenant_id', tenantId).is('deleted_at', null).maybeSingle(),
    d.schema('app').from('estimate_items')
      .select('id, tenant_product_id, qty')
      .eq('id', lineId).eq('estimate_id', estimateId).is('deleted_at', null).maybeSingle(),
  ]);
  if (estimateRes.error) throw estimateRes.error;
  if (itemRes.error) throw itemRes.error;
  const estimate = estimateRes.data as Row | null;
  const item = itemRes.data as Row | null;
  if (!estimate || !item) return null;

  const buyerId = asString(estimate.buyer_id);
  const locationId = asString(estimate.location_id);
  const pid = asString(item.tenant_product_id);
  const qty = Number(item.qty ?? 0);
  if (!pid) return { lineId, alternates: [] };

  const lineProductRes = await d.schema('app').from('tenant_products')
    .select('id, tenant_brand_id, tenant_category_id')
    .eq('id', pid).eq('tenant_id', tenantId).maybeSingle();
  const lineProduct = lineProductRes.data as Row | null;
  const categoryId = asString(lineProduct?.tenant_category_id);
  const brandId = asString(lineProduct?.tenant_brand_id);

  const cols = 'id, internal_sku, name_override, master_product_id, tenant_brand_id, tenant_category_id';
  // Same category first; same-brand products from other categories fill the gap.
  const [catRes, brandRes] = await Promise.all([
    categoryId
      ? d.schema('app').from('tenant_products').select(cols)
          .eq('tenant_id', tenantId).eq('tenant_category_id', categoryId).is('deleted_at', null).limit(ALTERNATE_POOL_LIMIT)
      : Promise.resolve({ data: [] }),
    brandId
      ? d.schema('app').from('tenant_products').select(cols)
          .eq('tenant_id', tenantId).eq('tenant_brand_id', brandId).is('deleted_at', null).limit(ALTERNATE_POOL_LIMIT)
      : Promise.resolve({ data: [] }),
  ]);
  const seen = new Set<string>([pid]);
  const pool = [...((catRes.data ?? []) as Row[]), ...((brandRes.data ?? []) as Row[])].filter((r) => {
    const id = r.id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Narrow to candidates that can cover the qty BEFORE spending a velocity query on them.
  const poolInventory = await loadInventoryAvailabilityMap(d, pool.map((r) => r.id as string), locationId);
  const coverable = pool.filter((r) => (poolInventory.get(r.id as string) ?? 0) >= qty);
  if (coverable.length === 0) return { lineId, alternates: [] };

  const coverableIds = coverable.map((r) => r.id as string);
  const [velocityRows, names] = await Promise.all([
    fetchProductVelocityRows(d, tenantId, coverableIds),
    loadDisplayNames(d, tenantId, coverable),
  ]);
  const snapshotMap = withDaysCover(velocityRows, poolInventory);

  const candidates: AlternateCandidate[] = coverable.map((row) => ({
    tenantProductId: row.id as string,
    name: names.nameOf(row),
    sku: asString(row.internal_sku) ?? '—',
    brandId: asString(row.tenant_brand_id),
    brandName: names.brandOf(row),
    categoryId: asString(row.tenant_category_id),
    available: poolInventory.get(row.id as string) ?? 0,
    velocity: deriveVelocity(snapshotMap.get(row.id as string)),
  }));
  const picked = pickAlternates({ tenantProductId: pid, brandId, categoryId, qty }, candidates);

  let prices = new Map<string, number>();
  if (buyerId && picked.length) {
    prices = await resolveBuyerPrices(d, buyerId, new Map([[qty, new Set(picked.map((a) => a.tenantProductId))]]), 'alternates');
  }
  const alternates: EnquiryAlternate[] = picked.map((alt) => ({
    ...alt,
    buyerPrice: prices.get(priceKey(alt.tenantProductId, qty)) ?? null,
  }));
  return { lineId, alternates };
}

/**
 * List-row summaries for many enquiry entries in a fixed number of queries (no velocity, no
 * pricing, no alternates). `entries` are already tenant/location-checked by the caller.
 */
export async function loadEnquirySummaries(
  db: DbClient,
  tenantId: string,
  entries: Array<{ entryId: string; estimateId: string }>,
): Promise<EnquirySummary[]> {
  const d = db as any;
  if (entries.length === 0) return [];
  const estimateIds = entries.map((e) => e.estimateId);

  const [estimatesRes, itemsRes] = await Promise.all([
    d.schema('app').from('estimates')
      .select('id, location_id, estimate_number, total_amount')
      .in('id', estimateIds).eq('tenant_id', tenantId).is('deleted_at', null).limit(estimateIds.length),
    d.schema('app').from('estimate_items')
      .select('estimate_id, tenant_product_id, qty, item_order')
      .in('estimate_id', estimateIds).is('deleted_at', null).order('item_order', { ascending: true }).limit(estimateIds.length * ENQUIRY_ITEM_LIMIT),
  ]);
  if (estimatesRes.error) throw estimatesRes.error;
  if (itemsRes.error) throw itemsRes.error;
  const estimates = new Map(((estimatesRes.data ?? []) as Row[]).map((e) => [e.id as string, e]));
  const itemsByEstimate = new Map<string, Row[]>();
  for (const item of (itemsRes.data ?? []) as Row[]) {
    const key = item.estimate_id as string;
    const list = itemsByEstimate.get(key) ?? [];
    list.push(item);
    itemsByEstimate.set(key, list);
  }

  // Stock is location-scoped; group estimates by location so it is one inventory query each.
  const idsByLocation = new Map<string | null, Set<string>>();
  for (const [estimateId, items] of itemsByEstimate) {
    const loc = asString(estimates.get(estimateId)?.location_id);
    const set = idsByLocation.get(loc) ?? new Set<string>();
    for (const item of items) {
      const pid = asString(item.tenant_product_id);
      if (pid) set.add(pid);
    }
    idsByLocation.set(loc, set);
  }
  const inventoryByLocation = new Map<string | null, Map<string, number>>();
  await Promise.all(Array.from(idsByLocation.entries()).map(async ([loc, ids]) => {
    inventoryByLocation.set(loc, await loadInventoryAvailabilityMap(d, Array.from(ids), loc));
  }));

  const firstProductIds = Array.from(new Set(
    Array.from(itemsByEstimate.values()).map((items) => asString(items[0]?.tenant_product_id)).filter((v): v is string => !!v),
  ));
  const firstProductsRes = firstProductIds.length
    ? await d.schema('app').from('tenant_products')
        .select('id, internal_sku, name_override, master_product_id, tenant_brand_id')
        .in('id', firstProductIds).eq('tenant_id', tenantId).limit(firstProductIds.length)
    : { data: [] };
  const firstProducts = (firstProductsRes.data ?? []) as Row[];
  const productById = new Map(firstProducts.map((p) => [p.id as string, p]));
  const { nameOf } = await loadDisplayNames(d, tenantId, firstProducts);

  const out: EnquirySummary[] = [];
  for (const { entryId, estimateId } of entries) {
    const estimate = estimates.get(estimateId);
    if (!estimate) continue;
    const items = itemsByEstimate.get(estimateId) ?? [];
    const inventory = inventoryByLocation.get(asString(estimate.location_id)) ?? new Map<string, number>();
    const firstProduct = productById.get(asString(items[0]?.tenant_product_id) ?? '');
    out.push({
      entryId,
      estimateId,
      estimateNumber: asString(estimate.estimate_number) ?? '—',
      totalAmount: estimate.total_amount == null ? null : Number(estimate.total_amount),
      lineCount: items.length,
      firstLineName: items.length ? (firstProduct ? nameOf(firstProduct) : 'Product') : null,
      atRisk: items.some((item) => {
        const pid = asString(item.tenant_product_id);
        return !!pid && enquiryStockStatus(Number(item.qty ?? 0), inventory.get(pid) ?? 0).tone !== 'ok';
      }),
    });
  }
  return out;
}
