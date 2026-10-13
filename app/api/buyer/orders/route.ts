import { after, NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import type { BuyerAppMode } from '@/types/buyer';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { getInAppCreateFlags } from '@/lib/server/seller-features';
import { sendImmediateTransactionNotifications } from '@/lib/server/buyer-transaction-notify-immediate';
import { tenantDefersTransactionNumber } from '@/lib/server/transaction-outbound-push';
import {
  formatProvisionalOrderNumber,
  nextProvisionalOrderSequence,
} from '@/lib/server/transaction-numbers';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { recordBuyerAppActivitySafe } from '@/lib/server/buyer-app-activity';
import { inferCampaignIdForBuyerCart } from '@/lib/server/campaign-attribution';
import { PAGE_SIZE, encodeCursor, decodeCursor } from '@/lib/pagination';
import { resolveBuyerInventoryWarehouseId } from '@/lib/server/buyer-product-data';
import { validateBuyerCartStock } from '@/lib/server/buyer-cart-stock';
import { resolveAuthoritativePrices } from '@/lib/server/buyer-price-resolution';
import { getSelectedBuyerDeliveryFromRequest, resolveTenantScopedLocationId } from '@/lib/server/buyer-location-selection';
import { deriveBuyerPlaceOfSupply } from '@/lib/buyer-routing';
import { TRANSACTION_PENDING_NOTE } from '@/lib/transaction-notes';
import { syncOrderEntrySafe } from '@/lib/server/inbox-entries';
import { captureAuthoritativeBuyerDemand } from '@/lib/server/buyer-posthog-events';

export interface BuyerOrderPlaceRequest {
  items: Array<{
    tenant_product_id: string;
    qty: number;
    unit_price: number;
    gst_rate?: number | null;
    product_name?: string;
  }>;
  notes?: string;
  campaign_id?: string | null;
  location_id?: string | null;
  place_of_supply?: string | null;
}

export interface BuyerOrderPlaceResponse {
  success: boolean;
  order_id?: string;
  order_number?: string | null;
  document_url?: string | null;
  document_status_note?: string | null;
  whatsapp_sent?: boolean;
  error?: string;
}

type OrderStatus =
  | 'draft'
  | 'received'
  | 'confirmed'
  | 'partially_dispatched'
  | 'dispatched'
  | 'delivered'
  | 'cancelled';

interface OrderRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  total_amount: number;
  placed_at: string;
  campaign_id: string | null;
}

interface OrderItemCountRow {
  order_id: string;
}

interface CatalogNameRow {
  id: string;
  name: string;
}

async function loadBuyerBusinessPolicy(db: any, tenantId: string) {
  const { data } = await db
    .schema('app')
    .from('tenant_settings')
    .select('settings')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const rawSettings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const rawPolicy = (rawSettings.business_policy ?? {}) as Record<string, unknown>;
  return {
    gst_inclusive: rawPolicy.gst_inclusive === true,
    gst_rate: typeof rawPolicy.gst_rate === 'number' ? rawPolicy.gst_rate : 18,
  };
}

async function loadBuyerStockEnforcement(db: any, tenantId: string): Promise<boolean> {
  const { data } = await db
    .schema('app')
    .from('tenant_settings')
    .select('settings')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const rawSettings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const rawBuyerApp = (rawSettings.buyer_app ?? {}) as Record<string, unknown>;
  return rawBuyerApp.stock_visibility_enabled === true && rawBuyerApp.block_order_on_oos === true;
}

export interface BuyerOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  total_amount: number;
  placed_at: string;
  catalog_name: string | null;
  items_count: number;
}

export interface BuyerOrdersResponse {
  mode: BuyerAppMode;
  orders: BuyerOrder[];
  nextCursor: string | null;
  total: number | null;
  seller_preview?: boolean;
  preview_message?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<BuyerOrderPlaceResponse>> {
  try {
    const profile = await requireBuyerAccessProfile(request);
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Defense-in-depth: requireBuyerAccessProfile deliberately lets a
    // `buyer_pending` session read its own row (so /api/buyer/me and the
    // intake screen work), but this route uses the service-role client for
    // the actual order insert, which bypasses RLS entirely — so RLS's own
    // app.is_buyer() gate (which excludes buyer_pending) is never consulted
    // here. Must reject explicitly before any further processing, matching
    // the pattern in app/api/buyer/me/route.ts and
    // app/api/buyer/onboarding/intake/route.ts.
    // Seller preview bypasses buyer_app_enabled (see buyer-access.ts) — a
    // preview session must be allowed through even for a pending/disabled buyer.
    if (profile.context.mode !== 'preview' && profile.buyer && profile.buyer.buyer_app_enabled === false) {
      return NextResponse.json(
        { success: false, error: 'Your account is pending approval. You cannot place or view orders yet.' },
        { status: 403 },
      );
    }

    const context = profile.context;

    let body: BuyerOrderPlaceRequest;
    try {
      body = (await request.json()) as BuyerOrderPlaceRequest;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const { items, notes, campaign_id, location_id } = body;

    const createFlags = await getInAppCreateFlags(context.tenant_id!);
    if (!createFlags.create_sales_orders) {
      return NextResponse.json({ success: false, error: 'Order placement is not available' }, { status: 403 });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: false, error: 'Cart must have at least one item' }, { status: 400 });
    }
    for (const item of items) {
      if (!item.tenant_product_id) {
        return NextResponse.json({ success: false, error: 'Each item must have a valid tenant_product_id' }, { status: 400 });
      }
      if (typeof item.qty !== 'number' || item.qty <= 0) {
        return NextResponse.json({ success: false, error: 'Each item must have qty > 0' }, { status: 400 });
      }
      if (typeof item.unit_price !== 'number' || item.unit_price <= 0) {
        return NextResponse.json({ success: false, error: 'Each item must have unit_price > 0' }, { status: 400 });
      }
    }

    if (context.mode === 'preview' && !context.buyer_id) {
      return NextResponse.json({
        success: true,
        order_id: `preview-order-${Date.now()}`,
        order_number: 'PREVIEW-ORDER',
        document_url: null,
        document_status_note: null,
      });
    }

    if (!profile.buyer?.id || !context.sub) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const selectedDelivery = getSelectedBuyerDeliveryFromRequest(request);
    const requestedLocationId = selectedDelivery?.routed_location_id ?? location_id ?? null;

    if (!requestedLocationId) {
      return NextResponse.json(
        { success: false, error: 'Select a delivery location before placing an order' },
        { status: 400 },
      );
    }

    const tenant_id = context.tenant_id;
    const placed_by = context.sub;
    if (!tenant_id || !placed_by) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const buyer_id = profile.buyer.id;
    const db = supabaseAdmin ?? supabase;
    const routedLocationId = await resolveTenantScopedLocationId(db, tenant_id, requestedLocationId);
    if (!routedLocationId) {
      return NextResponse.json(
        { success: false, error: 'Your saved delivery location is no longer valid for this store. Please reselect it.' },
        { status: 400 },
      );
    }
    const inventoryWarehouseId = await resolveBuyerInventoryWarehouseId(db as any, request, profile);
    const enforceStock = await loadBuyerStockEnforcement(db as any, tenant_id);
    const stockValidation = await validateBuyerCartStock(db as any, {
      tenantId: tenant_id,
      warehouseId: inventoryWarehouseId,
      items,
      enforceStock,
    });
    if (!stockValidation.ok) {
      return NextResponse.json(
        { success: false, error: stockValidation.error },
        { status: stockValidation.status },
      );
    }
    const resolvedCampaignId = await inferCampaignIdForBuyerCart(db, {
      tenantId: tenant_id,
      buyerId: buyer_id,
      clientCampaignId: campaign_id,
      tenantProductIds: stockValidation.items.map((item) => item.tenant_product_id),
    });

    const priceResolution = await resolveAuthoritativePrices(db as any, {
      tenantId: tenant_id,
      buyerId: buyer_id,
      items: stockValidation.items,
      campaignId: campaign_id ?? null,
    });
    if (!priceResolution.ok) {
      return NextResponse.json(
        { success: false, error: priceResolution.error },
        { status: priceResolution.status },
      );
    }
    const acceptedItems = priceResolution.items;
    const policy = await loadBuyerBusinessPolicy(db as typeof supabaseAdmin, tenant_id);
    const subtotal = acceptedItems.reduce((sum, item) => sum + item.qty * item.unit_price, 0);
    const tax_amount = policy.gst_inclusive
      ? 0
      : acceptedItems.reduce((sum, item) => {
          const rate = Number(item.gst_rate ?? policy.gst_rate);
          return sum + item.qty * item.unit_price * (Number.isFinite(rate) ? rate / 100 : 0);
        }, 0);
    const total_amount = subtotal + tax_amount;

    const placeOfSupply = selectedDelivery?.place_of_supply
      || (selectedDelivery ? deriveBuyerPlaceOfSupply(selectedDelivery) : '')
      || (typeof body.place_of_supply === 'string' && body.place_of_supply.trim())
      || 'Unknown';

    const deferDocumentNumber = await tenantDefersTransactionNumber(tenant_id, 'orders');

    const order_number = deferDocumentNumber
      ? null
      : formatProvisionalOrderNumber(await nextProvisionalOrderSequence(db, tenant_id));
    const placed_at = new Date().toISOString();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newOrder, error: insertError } = await (db as any)
      .schema('app')
      .from('orders')
      .insert({
        tenant_id,
        buyer_id,
        placed_by,
        order_number,
        status: 'received',
        source: 'buyer_app',
        is_buyer_app_order: true,
        campaign_id: resolvedCampaignId,
        location_id: routedLocationId,
        place_of_supply: placeOfSupply,
        subtotal,
        tax_amount,
        total_amount,
        item_count: acceptedItems.length,
        notes: notes ?? null,
        placed_at,
        created_by: placed_by,
      })
      .select('id, order_number')
      .single();

    if (insertError || !newOrder) {
      console.error('[POST /api/buyer/orders] Insert error:', insertError);
      return NextResponse.json({ success: false, error: 'Failed to create order' }, { status: 500 });
    }

    const typed = newOrder as { id: string; order_number: string | null };

    const orderItemRows = acceptedItems.map((item) => ({
      order_id: typed.id,
      tenant_product_id: item.tenant_product_id,
      qty: item.qty,
      unit_price: item.unit_price,
      tax_rate: item.gst_rate ?? policy.gst_rate,
      line_total: item.qty * item.unit_price,
      created_by: placed_by,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: itemsError } = await (db as any).schema('app').from('order_items').insert(orderItemRows);
    if (itemsError) {
      console.error('[POST /api/buyer/orders] Items insert error:', itemsError);
      return NextResponse.json({ success: false, error: 'Failed to create order items' }, { status: 500 });
    }

    syncOrderEntrySafe(db as any, typed.id);

    // Fire-and-forget: the order row above is already committed (and is what the
    // realtime channel notifies on), so don't hold the HTTP response hostage on
    // PostHog or the outbound WhatsApp API — that made the buyer's own response
    // arrive noticeably after the realtime "order created" toast for the same row.
    captureAuthoritativeBuyerDemand({
      request,
      event: 'order_placed',
      tenantId: tenant_id,
      buyerId: buyer_id,
      documentId: typed.id,
      documentNumber: typed.order_number,
      documentType: 'order',
      totalAmount: total_amount,
      itemCount: acceptedItems.length,
      lineProductIds: acceptedItems.map((item) => item.tenant_product_id),
      campaignId: resolvedCampaignId,
    });

    const whatsappDispatched = !deferDocumentNumber && Boolean(typed.order_number);
    const notifyDocumentNumber = typed.order_number;
    if (!deferDocumentNumber && notifyDocumentNumber) {
      // Must run inside after(): a bare `void` promise is frozen/killed once the response is sent, which
      // left the WhatsApp row enqueued but never dispatched (stuck `queued` until the daily sweep).
      after(() => sendImmediateTransactionNotifications({
        kind: 'order',
        tenantId: tenant_id,
        buyerId: buyer_id,
        locationId: routedLocationId,
        initiatingBuyerUserId: context.sub,
        documentId: typed.id,
        documentNumber: notifyDocumentNumber,
        totalAmount: total_amount,
        itemCount: acceptedItems.length,
        db,
        table: 'orders',
      }).catch((err) => {
        console.error('[buyer/orders] whatsapp notify failed', {
          order_id: typed.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }));
    }

    void recordBuyerAppActivitySafe(db as any, {
      tenantId: tenant_id,
      buyerId: buyer_id,
      eventName: 'order_created',
      path: request.nextUrl.pathname,
      context: {
        order_id: typed.id,
        order_number: typed.order_number,
        item_count: acceptedItems.length,
        total_amount: total_amount,
      },
    });

    return NextResponse.json({
      success: true,
      order_id: typed.id,
      order_number: typed.order_number,
      document_url: null,
      document_status_note: typed.order_number ? null : TRANSACTION_PENDING_NOTE,
      whatsapp_sent: whatsappDispatched,
    });
  } catch (error) {
    console.error('[POST /api/buyer/orders] unexpected error:', error);
    Sentry.captureException(error, { tags: { area: 'order_placement' } });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const profile = await requireBuyerAccessProfile(request);
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Defense-in-depth: see the matching comment in POST above — this GET
    // also uses the service-role client (supabaseAdmin) for the actual
    // orders read, bypassing RLS's app.is_buyer() gate entirely.
    // Seller preview bypasses buyer_app_enabled (see buyer-access.ts) — a
    // preview session must be allowed through even for a pending/disabled buyer.
    if (profile.context.mode !== 'preview' && profile.buyer && profile.buyer.buyer_app_enabled === false) {
      return NextResponse.json(
        { error: 'Your account is pending approval. You cannot place or view orders yet.' },
        { status: 403 },
      );
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const context = profile.context;

    // Pure seller preview — no linked buyer account
    if (context.mode === 'preview' && !context.buyer_id) {
      const payload: BuyerOrdersResponse = {
        mode: 'preview',
        orders: [],
        nextCursor: null,
        total: null,
        seller_preview: true,
      };
      return NextResponse.json(payload, { headers: BUYER_CACHE_PERSONAL });
    }

    // Real buyer or seller with linked buyer account — fetch real orders
    const buyerId = profile.buyer?.id ?? context.buyer_id;
    if (!buyerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = supabaseAdmin;
    const tenantId = context.tenant_id;
    const { searchParams } = request.nextUrl;
    const reqLimit = Math.min(Number(searchParams.get('limit') ?? PAGE_SIZE.BUYER), PAGE_SIZE.MAX);
    const cursorParam = searchParams.get('cursor');

    let query = db
      .schema('app')
      .from('orders')
      .select('id, order_number, status, total_amount, placed_at, campaign_id')
      .eq('tenant_id', tenantId)
      .eq('buyer_id', buyerId)
      .is('deleted_at', null)
      .order('placed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(reqLimit + 1);

    if (cursorParam) {
      const { created_at, id } = decodeCursor(cursorParam);
      query = query.or(`placed_at.lt.${created_at},and(placed_at.eq.${created_at},id.lt.${id})`);
    }

    const [ordersRes, countRes] = await Promise.all([
      query,
      db
        .schema('app')
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('buyer_id', buyerId)
        .is('deleted_at', null),
    ]);

    if (ordersRes.error) {
      console.error('[GET /api/buyer/orders] orders query error:', ordersRes.error);
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }

    const rawOrders = (ordersRes.data ?? []) as OrderRow[];
    const hasNextPage = rawOrders.length > reqLimit;
    const orders = hasNextPage ? rawOrders.slice(0, reqLimit) : rawOrders;
    const lastOrder = orders.at(-1);
    const nextCursor = hasNextPage && lastOrder
      ? encodeCursor({ created_at: lastOrder.placed_at, id: lastOrder.id })
      : null;

    const orderIds = orders.map((o) => o.id);
    const catalogIds = Array.from(
      new Set(orders.map((o) => o.campaign_id).filter((id): id is string => id !== null))
    );

    const [itemsRes, catalogsRes] = await Promise.all([
      orderIds.length > 0
        ? db.schema('app').from('order_items').select('order_id').in('order_id', orderIds).is('deleted_at', null)
        : Promise.resolve({ data: [], error: null }),
      catalogIds.length > 0
        ? db.schema('app').from('campaigns').select('id, name').in('id', catalogIds).is('deleted_at', null)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (itemsRes.error) {
      console.error('[GET /api/buyer/orders] items query error:', itemsRes.error);
      return NextResponse.json({ error: 'Failed to fetch order items' }, { status: 500 });
    }

    if (catalogsRes.error) {
      console.error('[GET /api/buyer/orders] catalogs query error:', catalogsRes.error);
      return NextResponse.json({ error: 'Failed to fetch catalog names' }, { status: 500 });
    }

    const itemCounts = (itemsRes.data ?? []) as OrderItemCountRow[];
    const catalogNames = (catalogsRes.data ?? []) as CatalogNameRow[];

    const countByOrder = new Map<string, number>();
    for (const item of itemCounts) {
      countByOrder.set(item.order_id, (countByOrder.get(item.order_id) ?? 0) + 1);
    }

    const catalogNameById = new Map(catalogNames.map((c) => [c.id, c.name]));

    const payload: BuyerOrdersResponse = {
      mode: context.mode,
      seller_preview: false,
      orders: orders.map((order) => ({
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        total_amount: Number(order.total_amount ?? 0),
        placed_at: order.placed_at,
        catalog_name: order.campaign_id ? (catalogNameById.get(order.campaign_id) ?? null) : null,
        items_count: countByOrder.get(order.id) ?? 0,
      })),
      nextCursor,
      total: countRes.count ?? null,
    };

    return NextResponse.json(payload, { headers: BUYER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/buyer/orders] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
