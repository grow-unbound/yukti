import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { loadBuyerDocumentLineItems } from '@/lib/buyer-documents/load-buyer-transaction-detail';
import { TRANSACTION_PENDING_NOTE } from '@/lib/transaction-notes';

export interface BuyerOrderItem {
  tenant_product_id: string;
  product_name: string;
  internal_sku: string | null;
  unit: string | null;
  image_url: string | null;
  qty: number;
  unit_price: number;
  tax_rate: number | null;
  line_total: number;
}

export interface BuyerOrderDetail {
  id: string;
  order_number: string | null;
  document_status_note: string | null;
  status: string;
  notes: string | null;
  placed_at: string;
  place_of_supply: string | null;
  total_amount: number;
  subtotal: number;
  tax_total: number;
  discount_flat: number;
  freight: number;
  round_off: number;
  document_url: string | null;
  items: BuyerOrderItem[];
}

export interface BuyerOrderDetailResponse {
  order: BuyerOrderDetail;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const profile = await requireBuyerAccessProfile(request);
    if (!profile?.context.tenant_id || !profile.buyer?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Defense-in-depth: see the matching comment in
    // app/api/buyer/orders/route.ts — this route also uses the service-role
    // client for the order-detail read, bypassing RLS entirely.
    // Seller preview bypasses buyer_app_enabled (see buyer-access.ts) — a
    // preview session must be allowed through even for a pending/disabled buyer.
    if (profile.context.mode !== 'preview' && profile.buyer.buyer_app_enabled === false) {
      return NextResponse.json(
        { error: 'Your account is pending approval. You cannot place or view orders yet.' },
        { status: 403 },
      );
    }

    const { tenant_id } = profile.context;
    const buyer_id = profile.buyer.id;
    const db = supabaseAdmin ?? supabase;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: order, error } = await (db as any)
      .schema('app')
      .from('orders')
      .select('id, order_number, status, notes, placed_at, place_of_supply, total_amount, subtotal, tax_amount, discount_flat, freight, round_off, order_url')
      .eq('id', id)
      .eq('tenant_id', tenant_id)
      .eq('buyer_id', buyer_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const rawItems = await loadBuyerDocumentLineItems(db as any, tenant_id, 'orders', id);
    const items: BuyerOrderItem[] = rawItems.map((item) => ({
      ...item,
      unit_price: item.unit_price ?? 0,
      line_total: item.line_total ?? 0,
    }));
    const subtotal = Number(order.subtotal ?? items.reduce((sum, i) => sum + i.line_total, 0));
    const tax_total = Number(order.tax_amount ?? Number(order.total_amount) - subtotal);

    const detail: BuyerOrderDetail = {
      id: order.id,
      order_number: order.order_number ?? null,
      document_status_note: order.order_number ? null : TRANSACTION_PENDING_NOTE,
      status: order.status,
      notes: order.notes ?? null,
      placed_at: order.placed_at,
      place_of_supply: order.place_of_supply ?? null,
      total_amount: Number(order.total_amount),
      subtotal,
      tax_total: Math.max(0, tax_total),
      discount_flat: Number(order.discount_flat ?? 0),
      freight: Number(order.freight ?? 0),
      round_off: Number(order.round_off ?? 0),
      document_url: (order as { order_url?: string | null }).order_url ?? null,
      items,
    };

    return NextResponse.json({ order: detail }, { headers: BUYER_CACHE_PERSONAL });
  } catch (err) {
    console.error('[buyer/orders/[id]] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
