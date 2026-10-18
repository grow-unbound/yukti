import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { guardPendingBuyerAccount } from '@/lib/server/buyer-pending-guard';
import { loadBuyerDocumentLineItems } from '@/lib/buyer-documents/load-buyer-transaction-detail';

export interface BuyerInvoiceItem {
  tenant_product_id: string;
  product_name: string;
  internal_sku: string | null;
  unit: string | null;
  image_url: string | null;
  qty: number;
  unit_price: number;
  tax_rate: number | null;
  line_total: number;
  disc_pct: number | null;
}

export interface BuyerInvoiceDetail {
  id: string;
  invoice_number: string;
  status: string;
  invoice_date: string;
  due_date: string | null;
  place_of_supply: string | null;
  total_amount: number;
  outstanding_balance: number | null;
  subtotal: number;
  tax_total: number;
  discount_flat: number;
  freight: number;
  round_off: number;
  items: BuyerInvoiceItem[];
}

export interface BuyerInvoiceDetailResponse {
  invoice: BuyerInvoiceDetail;
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
    const pendingBlock = guardPendingBuyerAccount(profile);
    if (pendingBlock) return pendingBlock;

    const { tenant_id } = profile.context;
    const buyer_id = profile.buyer.id;
    const db = supabaseAdmin ?? supabase;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: invoice, error } = await (db as any)
      .schema('app')
      .from('invoices')
      .select('id, invoice_number, status, invoice_date, due_date, place_of_supply, total_amount, outstanding_balance, subtotal, tax_amount, discount_flat, freight, round_off')
      .eq('id', id)
      .eq('tenant_id', tenant_id)
      .eq('buyer_id', buyer_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    const rawItems = await loadBuyerDocumentLineItems(db as any, tenant_id, 'invoices', id);
    const items: BuyerInvoiceItem[] = rawItems.map((item) => ({
      ...item,
      unit_price: item.unit_price ?? 0,
      line_total: item.line_total ?? 0,
    }));
    const subtotal = Number(invoice.subtotal ?? items.reduce((sum, i) => sum + i.line_total, 0));
    const tax_total = Number(invoice.tax_amount ?? Math.max(0, Number(invoice.total_amount) - subtotal));

    const detail: BuyerInvoiceDetail = {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      status: invoice.status,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date ?? null,
      place_of_supply: invoice.place_of_supply ?? null,
      total_amount: Number(invoice.total_amount),
      outstanding_balance: invoice.outstanding_balance != null ? Number(invoice.outstanding_balance) : null,
      subtotal,
      tax_total,
      discount_flat: Number(invoice.discount_flat ?? 0),
      freight: Number(invoice.freight ?? 0),
      round_off: Number(invoice.round_off ?? 0),
      items,
    };

    return NextResponse.json({ invoice: detail }, { headers: BUYER_CACHE_PERSONAL });
  } catch (err) {
    console.error('[buyer/invoices/[id]] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
