import { createHash } from 'crypto';
import { after, NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { getInAppCreateFlags } from '@/lib/server/seller-features';
import { sendImmediateTransactionNotifications } from '@/lib/server/buyer-transaction-notify-immediate';
import { tenantDefersTransactionNumber } from '@/lib/server/transaction-outbound-push';
import {
  formatProvisionalEstimateNumber,
  nextProvisionalEstimateSequence,
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
import { syncEstimateEntrySafe } from '@/lib/server/inbox-entries';
import { loadLivePublicCatalog } from '@/lib/server/public-catalog';
import { captureAuthoritativeBuyerDemand } from '@/lib/server/buyer-posthog-events';

// Exported types consumed by checkout/page.tsx and EnquiriesTab
export interface EstimateRequest {
  items: Array<{
    tenant_product_id: string;
    qty: number;
    unit_price?: number | null;
    gst_rate?: number | null;
    product_name?: string;
    buyer_target_unit_price_min?: number | null;
    buyer_target_unit_price_max?: number | null;
    buyer_note?: string | null;
  }>;
  notes?: string;
  campaign_id?: string | null;
  location_id?: string | null;
  place_of_supply?: string | null;
}

export interface EstimateResponse {
  success: boolean;
  estimate_id?: string;
  estimate_number?: string | null;
  document_url?: string | null;
  document_status_note?: string | null;
  whatsapp_sent?: boolean;
  error?: string;
}

interface EstimateRow {
  id: string;
  estimate_number: string | null;
  status: string;
  total_amount: number;
  estimate_type: string | null;
  created_at: string;
  notes: string | null;
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

export async function POST(request: NextRequest): Promise<NextResponse<EstimateResponse>> {
  try {
    const profile = await requireBuyerAccessProfile(request);
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Defense-in-depth: requireBuyerAccessProfile deliberately lets a
    // `buyer_pending` session read its own row (so /api/buyer/me and the
    // intake screen work), but this route uses the service-role client for
    // the actual estimate insert, which bypasses RLS entirely. Matches the
    // pattern in app/api/buyer/orders/route.ts and app/api/buyer/me/route.ts.
    // Seller preview bypasses buyer_app_enabled (see buyer-access.ts) — a
    // preview session must be allowed through even for a pending/disabled buyer.
    if (profile.context.mode !== 'preview' && profile.buyer && profile.buyer.buyer_app_enabled === false) {
      return NextResponse.json(
        { success: false, error: 'Your account is pending approval. You cannot place or view orders yet.' },
        { status: 403 },
      );
    }

    const context = profile.context;

    let body: EstimateRequest;
    try {
      body = (await request.json()) as EstimateRequest;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const { items, notes, campaign_id, location_id } = body;

    const createFlags = await getInAppCreateFlags(context.tenant_id!);
    if (!createFlags.create_enquiries) {
      return NextResponse.json({ success: false, error: 'Estimate creation is not available' }, { status: 403 });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: false, error: 'Cart must have at least one item' }, { status: 400 });
    }
    const db = supabaseAdmin ?? supabase;
    const tenant_id = context.tenant_id;
    const sub = context.sub;
    if (!tenant_id || !sub) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    for (const item of items) {
      if (!item.tenant_product_id) {
        return NextResponse.json({ success: false, error: 'Each item must have a valid tenant_product_id' }, { status: 400 });
      }
      if (typeof item.qty !== 'number' || item.qty <= 0) {
        return NextResponse.json({ success: false, error: 'Each item must have qty > 0' }, { status: 400 });
      }
    }

    if (context.mode === 'preview' && !context.buyer_id) {
      return NextResponse.json({
        success: true,
        estimate_id: `preview-${Date.now()}`,
        estimate_number: 'PREVIEW-INQUIRY',
        document_url: null,
        document_status_note: null,
        whatsapp_sent: false,
      });
    }

    const publicCatalog = await loadLivePublicCatalog(db as any, tenant_id);
    const hiddenPriceEnquiry = publicCatalog?.pricingMode === 'hide_price_collect_enquiry';
    const collectTargetRange = hiddenPriceEnquiry && publicCatalog.collectTargetUnitPriceRange === true;

    for (const item of items) {
      if (!hiddenPriceEnquiry && (typeof item.unit_price !== 'number' || item.unit_price <= 0)) {
        return NextResponse.json({ success: false, error: 'Each item must have unit_price > 0' }, { status: 400 });
      }
      const minTarget = item.buyer_target_unit_price_min;
      const maxTarget = item.buyer_target_unit_price_max;
      const hasMin = minTarget != null;
      const hasMax = maxTarget != null;
      if ((hasMin || hasMax) && !collectTargetRange) {
        return NextResponse.json({ success: false, error: 'Target price range is not enabled for this catalog' }, { status: 400 });
      }
      if (hasMin && (typeof minTarget !== 'number' || !Number.isFinite(minTarget) || minTarget < 0)) {
        return NextResponse.json({ success: false, error: 'Target rate range is invalid' }, { status: 400 });
      }
      if (hasMax && (typeof maxTarget !== 'number' || !Number.isFinite(maxTarget) || maxTarget < 0)) {
        return NextResponse.json({ success: false, error: 'Target rate range is invalid' }, { status: 400 });
      }
      if (hasMin && hasMax && (maxTarget as number) < (minTarget as number)) {
        return NextResponse.json({ success: false, error: 'Target rate range is invalid' }, { status: 400 });
      }
    }

    if (!profile.buyer?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const selectedDelivery = getSelectedBuyerDeliveryFromRequest(request);
    const requestedLocationId = selectedDelivery?.routed_location_id ?? location_id ?? null;

    if (!requestedLocationId) {
      return NextResponse.json(
        { success: false, error: 'Select a delivery location before requesting a quote' },
        { status: 400 },
      );
    }

    const buyer_id = profile.buyer.id;
    const routedLocationId = await resolveTenantScopedLocationId(db, tenant_id, requestedLocationId);
    if (!routedLocationId) {
      return NextResponse.json(
        { success: false, error: 'Your saved delivery location is no longer valid for this store. Please reselect it.' },
        { status: 400 },
      );
    }
    const inventoryWarehouseId = await resolveBuyerInventoryWarehouseId(db as any, request, profile);
    const stockValidation = await validateBuyerCartStock(db as any, {
      tenantId: tenant_id,
      warehouseId: inventoryWarehouseId,
      items: items.map((item) => ({ ...item, unit_price: Number(item.unit_price ?? 0) })),
      enforceStock: false,
    });
    if (!stockValidation.ok) {
      return NextResponse.json(
        { success: false, error: stockValidation.error },
        { status: stockValidation.status },
      );
    }
    const resolvedCampaignId = hiddenPriceEnquiry ? null : await inferCampaignIdForBuyerCart(db, {
      tenantId: tenant_id,
      buyerId: buyer_id,
      clientCampaignId: campaign_id,
      tenantProductIds: stockValidation.items.map((item) => item.tenant_product_id),
    });

    const priceResolution = hiddenPriceEnquiry
      ? { ok: true as const, items: stockValidation.items }
      : await resolveAuthoritativePrices(db as any, {
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
    const subtotal = hiddenPriceEnquiry ? 0 : acceptedItems.reduce((sum, item) => sum + item.qty * item.unit_price, 0);
    const tax_amount = hiddenPriceEnquiry || policy.gst_inclusive
      ? 0
      : acceptedItems.reduce((sum, item) => {
          const rate = Number(item.gst_rate ?? policy.gst_rate);
          return sum + item.qty * item.unit_price * (Number.isFinite(rate) ? rate / 100 : 0);
        }, 0);
    const total_amount = subtotal + tax_amount;

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const sortedItems = [...acceptedItems].sort((a, b) => a.tenant_product_id.localeCompare(b.tenant_product_id));
    const placeOfSupply = selectedDelivery?.place_of_supply
      || (selectedDelivery ? deriveBuyerPlaceOfSupply(selectedDelivery) : '')
      || (typeof body.place_of_supply === 'string' && body.place_of_supply.trim())
      || 'Unknown';
    const cart_hash = createHash('sha256')
      .update(JSON.stringify({
          items: sortedItems.map((i) => ({
            id: i.tenant_product_id,
            qty: i.qty,
            price: hiddenPriceEnquiry ? null : i.unit_price,
            target_min: items.find((item) => item.tenant_product_id === i.tenant_product_id)?.buyer_target_unit_price_min ?? null,
            target_max: items.find((item) => item.tenant_product_id === i.tenant_product_id)?.buyer_target_unit_price_max ?? null,
          })),
        location_id: routedLocationId,
        place_of_supply: placeOfSupply,
        estimate_type: hiddenPriceEnquiry ? 'without_price' : 'with_price',
      }))
      .digest('hex');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existingRows } = await (db as any)
      .schema('app')
      .from('estimates')
      .select('id, estimate_number, campaign_id')
      .eq('buyer_id', buyer_id)
      .eq('cart_hash', cart_hash)
      .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
      .is('deleted_at', null)
      .limit(1);

    const existing = (existingRows as Array<{ id: string; estimate_number: string | null; campaign_id: string | null }> | null)?.[0];
    if (existing) {
      if (!existing.campaign_id && resolvedCampaignId) {
        await (db as any)
          .schema('app')
          .from('estimates')
          .update({ campaign_id: resolvedCampaignId })
          .eq('id', existing.id);
      }
      return NextResponse.json({
        success: true,
        estimate_id: existing.id,
        estimate_number: existing.estimate_number,
        document_status_note: existing.estimate_number ? null : TRANSACTION_PENDING_NOTE,
        whatsapp_sent: false,
      });
    }

    const deferDocumentNumber = await tenantDefersTransactionNumber(tenant_id, 'estimates');

    const estimate_number = deferDocumentNumber
      ? null
      : formatProvisionalEstimateNumber(await nextProvisionalEstimateSequence(db, tenant_id));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newEstimate, error: insertError } = await (db as any)
      .schema('app')
      .from('estimates')
      .insert({
        tenant_id,
        buyer_id,
        estimate_number,
        status: 'draft',
        source: 'buyer_app',
        is_buyer_app_estimate: true,
        estimate_type: hiddenPriceEnquiry ? 'without_price' : 'with_price',
        catalog_id: publicCatalog?.id ?? null,
        price_visibility: hiddenPriceEnquiry ? 'hide_price' : 'show_price',
        expires_at: expiresAt,
        subtotal,
        total_amount,
        item_count: acceptedItems.length,
        cart_hash,
        notes: notes ?? null,
        campaign_id: resolvedCampaignId,
        location_id: routedLocationId,
        place_of_supply: placeOfSupply,
        created_by: sub,
      })
      .select('id, estimate_number')
      .single();

    if (insertError || !newEstimate) {
      console.error('[buyer/estimates] Insert error:', insertError);
      return NextResponse.json({ success: false, error: 'Failed to create estimate' }, { status: 500 });
    }

    const typed = newEstimate as { id: string; estimate_number: string | null };

    const targetByProductId = new Map(items.map((item) => [item.tenant_product_id, item]));
    const estimateItemRows = acceptedItems.map((item) => {
      const target = targetByProductId.get(item.tenant_product_id);
      return ({
      estimate_id: typed.id,
      tenant_product_id: item.tenant_product_id,
      qty: item.qty,
      unit_price: hiddenPriceEnquiry ? null : item.unit_price,
      tax_rate: hiddenPriceEnquiry ? null : (item.gst_rate ?? policy.gst_rate),
      line_total: hiddenPriceEnquiry ? null : item.qty * item.unit_price,
      buyer_target_unit_price_min: collectTargetRange ? target?.buyer_target_unit_price_min ?? null : null,
      buyer_target_unit_price_max: collectTargetRange ? target?.buyer_target_unit_price_max ?? null : null,
      buyer_note: typeof target?.buyer_note === 'string' ? target.buyer_note.trim() || null : null,
    });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: itemsError } = await (db as any).schema('app').from('estimate_items').insert(estimateItemRows);
    if (itemsError) {
      console.error('[buyer/estimates] Items insert error:', itemsError);
    }

    syncEstimateEntrySafe(db as any, typed.id);

    // Fire-and-forget: the estimate row above is already committed (and is what
    // the realtime channel notifies on), so don't hold the HTTP response hostage
    // on PostHog or the outbound WhatsApp API — that made the buyer's own
    // response arrive noticeably after the realtime "new estimate" toast for the
    // same row.
    captureAuthoritativeBuyerDemand({
      request,
      event: 'inquiry_created',
      tenantId: tenant_id,
      buyerId: buyer_id,
      documentId: typed.id,
      documentNumber: typed.estimate_number,
      documentType: 'estimate',
      totalAmount: total_amount,
      itemCount: acceptedItems.length,
      lineProductIds: acceptedItems.map((item) => item.tenant_product_id),
      campaignId: resolvedCampaignId,
      estimateType: hiddenPriceEnquiry ? 'without_price' : 'with_price',
    });

    const whatsappDispatched = !hiddenPriceEnquiry && !deferDocumentNumber && Boolean(typed.estimate_number);
    const notifyDocumentNumber = typed.estimate_number;
    if (!deferDocumentNumber && notifyDocumentNumber && !hiddenPriceEnquiry) {
      // Must run inside after(): a bare `void` promise is frozen/killed once the response is sent, which
      // left the WhatsApp row enqueued but never dispatched (stuck `queued` until the daily sweep).
      after(() => sendImmediateTransactionNotifications({
        kind: 'estimate',
        tenantId: tenant_id,
        buyerId: buyer_id,
        locationId: routedLocationId,
        initiatingBuyerUserId: context.sub,
        documentId: typed.id,
        documentNumber: notifyDocumentNumber,
        totalAmount: total_amount,
        itemCount: acceptedItems.length,
        db,
        table: 'estimates',
      }).catch((err) => {
        console.error('[buyer/estimates] whatsapp notify failed', {
          estimate_id: typed.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }));
    }

    void recordBuyerAppActivitySafe(db as any, {
      tenantId: tenant_id,
      buyerId: buyer_id,
      eventName: 'estimate_created',
      path: request.nextUrl.pathname,
      context: {
        estimate_id: typed.id,
        estimate_number: typed.estimate_number,
        item_count: acceptedItems.length,
        total_amount,
      },
    });

    return NextResponse.json({
      success: true,
      estimate_id: typed.id,
      estimate_number: typed.estimate_number,
      document_url: null,
      document_status_note: typed.estimate_number ? null : TRANSACTION_PENDING_NOTE,
      whatsapp_sent: whatsappDispatched,
    });
  } catch (err) {
    console.error('[buyer/estimates] Unexpected error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const profile = await requireBuyerAccessProfile(request);
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Defense-in-depth: see the matching comment in POST above.
    // Seller preview bypasses buyer_app_enabled (see buyer-access.ts) — a
    // preview session must be allowed through even for a pending/disabled buyer.
    if (profile.context.mode !== 'preview' && profile.buyer && profile.buyer.buyer_app_enabled === false) {
      return NextResponse.json(
        { error: 'Your account is pending approval. You cannot place or view orders yet.' },
        { status: 403 },
      );
    }

    const context = profile.context;

    if (context.mode === 'preview' && !context.buyer_id) {
      return NextResponse.json({ estimates: [] }, { headers: BUYER_CACHE_PERSONAL });
    }

    if (!profile.buyer?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const tenant_id = context.tenant_id;
    const buyer_id = profile.buyer.id;
    const db = supabaseAdmin ?? supabase;
    const { searchParams } = request.nextUrl;
    const reqLimit = Math.min(Number(searchParams.get('limit') ?? PAGE_SIZE.BUYER), PAGE_SIZE.MAX);
    const cursorParam = searchParams.get('cursor');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .schema('app')
      .from('estimates')
      .select('id, estimate_number, status, total_amount, estimate_type, created_at, notes')
      .eq('tenant_id', tenant_id)
      .eq('buyer_id', buyer_id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(reqLimit + 1);

    if (cursorParam) {
      const { created_at, id } = decodeCursor(cursorParam);
      query = query.or(`created_at.lt.${created_at},and(created_at.eq.${created_at},id.lt.${id})`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [{ data, error }, countRes] = await Promise.all([
      query,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .schema('app')
        .from('estimates')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant_id)
        .eq('buyer_id', buyer_id)
        .is('deleted_at', null),
    ]);

    if (error) {
      console.warn('[buyer/estimates] GET error (table may not exist yet):', error.message);
      return NextResponse.json({ estimates: [], nextCursor: null, total: null });
    }

    const rawRows = ((data ?? []) as EstimateRow[]);
    const hasNextPage = rawRows.length > reqLimit;
    const rows = hasNextPage ? rawRows.slice(0, reqLimit) : rawRows;
    const lastRow = rows.at(-1);
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor({ created_at: lastRow.created_at, id: lastRow.id })
      : null;

    const estimates = rows.map((e) => ({
      id: e.id,
      estimate_number: e.estimate_number,
      status: e.status,
      total_amount: Number(e.total_amount ?? 0),
      estimate_type: e.estimate_type ?? 'with_price',
      created_at: e.created_at,
      notes: e.notes ?? null,
    }));

    return NextResponse.json(
      { estimates, nextCursor, total: (countRes as { count: number | null }).count ?? null },
      { headers: BUYER_CACHE_PERSONAL },
    );
  } catch (err) {
    console.error('[buyer/estimates] GET unexpected error:', err);
    return NextResponse.json({ estimates: [], nextCursor: null, total: null });
  }
}
