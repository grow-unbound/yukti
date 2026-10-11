import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerCatalogItem } from '@/types/buyer';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { recordCampaignView } from '@/lib/server/campaign-engagement';
import { enrichBuyerProducts } from '@/lib/server/buyer-product-data';
import { campaignOverridePrice } from '@/lib/server/buyer-campaign-pricing';
import { guardPendingBuyerCatalogAccess } from '@/lib/server/buyer-pending-guard';
import { getSelectedBuyerDeliveryFromRequest } from '@/lib/server/buyer-location-selection';
import { resolveNearestBuyerLocation } from '@/lib/server/buyer-routing';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ share_token: string }> }
) {
  const { share_token } = await params;

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const db = supabaseAdmin;
  const profile = await requireBuyerAccessProfile(request).catch(() => null);

  // Pending / access-disabled buyers never get buyer-specific prices, stock or campaign
  // pricing: 403 unless the tenant's public catalog allows public browsing, then GUEST data only.
  const gate = profile
    ? await guardPendingBuyerCatalogAccess(db as any, profile)
    : { pending: false, blocked: null, publicCatalog: null, guestPricing: null };
  if (gate.blocked) return gate.blocked;

  // Resolve catalog by share_token — must be published and not deleted
  const { data: catalog, error: catalogError } = await db
    .schema('app')
    .from('campaigns')
    .select('id, name, message, tenant_id, status, valid_to, hero_image_url')
    .eq('share_token', share_token)
    .eq('status', 'published')
    .is('deleted_at', null)
    .maybeSingle();

  if (catalogError) {
    console.error('[GET /api/buyer/catalog/:share_token] catalog lookup error:', catalogError);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 });
  }

  if (!catalog) {
    return NextResponse.json({ error: 'Catalog not found or not active' }, { status: 404 });
  }

  // Check if catalog is still valid (not expired)
  if (catalog.valid_to && new Date(catalog.valid_to).getTime() < Date.now()) {
    return NextResponse.json({ error: 'Catalog has expired' }, { status: 404 });
  }

  // Fetch catalog items
  const { data: catalogItems, error: itemsError } = await db
    .schema('app')
    .from('campaign_items')
    .select('tenant_product_id, price_override, display_order, is_featured')
    .eq('campaign_id', catalog.id)
    .is('deleted_at', null)
    .order('display_order', { ascending: true });

  if (itemsError) {
    console.error('[GET /api/buyer/catalog/:share_token] items error:', itemsError);
    return NextResponse.json({ error: 'Failed to load catalog items' }, { status: 500 });
  }

  const items = (catalogItems ?? []) as Array<{
    tenant_product_id: string;
    price_override: number | null;
    display_order: number | null;
    is_featured: boolean | null;
  }>;
  // A signed-in session (approved or pending) may only open catalogs of its OWN tenant: never resolve
  // another tenant's campaign pricing/stock against a buyer of a different distributor.
  if (profile?.context.tenant_id && profile.context.tenant_id !== catalog.tenant_id) {
    return NextResponse.json({ error: 'Catalog not found or not active' }, { status: 404 });
  }
  const excludedForGuest = new Set(gate.guestPricing?.excludedProductIds ?? []);
  const tenantProductIds = items
    .map((item) => item.tenant_product_id)
    .filter((id) => !excludedForGuest.has(id));

  if (tenantProductIds.length === 0) {
    return NextResponse.json({
      campaign_id: catalog.id,
      name: catalog.name,
      message: catalog.message,
      image_url: catalog.hero_image_url,
      products_count: 0,
      items: [],
    }, { headers: BUYER_CACHE_PRICED });
  }

  const selectedDelivery = getSelectedBuyerDeliveryFromRequest(request);
  const inventoryWarehouseId = selectedDelivery?.nearest_warehouse_id
    ?? (await resolveNearestBuyerLocation(db as any, catalog.tenant_id, selectedDelivery))?.warehouseId
    ?? null;
  const itemMap = await enrichBuyerProducts(db as any, {
    tenantId: catalog.tenant_id,
    buyerId: gate.pending ? null : (profile?.buyer?.id ?? null),
    guestPricing: gate.guestPricing,
    publicCatalog: gate.publicCatalog,
    tenantProductIds,
    inventoryWarehouseId,
    campaignByProductId: new Map(
      items.map((item) => [item.tenant_product_id, {
        campaign_id: catalog.id,
        campaign_name: catalog.name,
        campaign_valid_until: catalog.valid_to,
        campaign_price: campaignOverridePrice(item.price_override),
        is_featured: Boolean(item.is_featured),
      }]),
    ),
  });

  const guestItems = tenantProductIds
    .map((id) => itemMap.get(id))
    .filter((item): item is BuyerCatalogItem => Boolean(item));

  if (profile?.buyer?.id && !gate.pending) {
    await recordCampaignView(db, {
      tenantId: catalog.tenant_id,
      buyerId: profile.buyer.id,
      campaignId: catalog.id,
      source: 'guest_link',
    });
  }

  return NextResponse.json({
    campaign_id: catalog.id,
    name: catalog.name,
    message: catalog.message,
    image_url: catalog.hero_image_url,
    valid_until: catalog.valid_to,
    products_count: guestItems.length,
    items: guestItems,
  }, { headers: BUYER_CACHE_PRICED });
}
