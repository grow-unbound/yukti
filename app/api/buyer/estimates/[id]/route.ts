import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { guardPendingBuyerAccount } from '@/lib/server/buyer-pending-guard';
import { loadBuyerDocumentLineItems } from '@/lib/buyer-documents/load-buyer-transaction-detail';
import { TRANSACTION_PENDING_NOTE } from '@/lib/transaction-notes';

export interface BuyerEstimateItem {
  tenant_product_id: string;
  product_name: string;
  internal_sku: string | null;
  unit: string | null;
  image_url: string | null;
  qty: number;
  unit_price: number | null;
  tax_rate: number | null;
  line_total: number | null;
  buyer_target_unit_price_min?: number | null;
  buyer_target_unit_price_max?: number | null;
}

export interface BuyerEstimateDetail {
  id: string;
  estimate_number: string | null;
  document_status_note: string | null;
  status: string;
  estimate_type: string;
  notes: string | null;
  created_at: string;
  valid_until: string | null;
  place_of_supply: string | null;
  total_amount: number;
  subtotal: number;
  tax_total: number;
  document_url: string | null;
  /** Campaign whose prices were applied at submission (lines are at the campaign price). */
  campaign_name: string | null;
  items: BuyerEstimateItem[];
}

export interface BuyerEstimateDetailResponse {
  estimate: BuyerEstimateDetail;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id || !profile.buyer?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const pendingBlock = guardPendingBuyerAccount(profile);
    if (pendingBlock) return pendingBlock;

    const { tenant_id } = profile.context;
    const buyer_id = profile.buyer.id;
    const db = supabaseAdmin ?? supabase;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: estimate, error } = await (db as any)
      .schema('app')
      .from('estimates')
      .select('id, estimate_number, status, estimate_type, notes, created_at, valid_until, place_of_supply, total_amount, subtotal, tax_amount, estimate_url, campaign_id')
      .eq('id', id)
      .eq('tenant_id', tenant_id)
      .eq('buyer_id', buyer_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    let campaignName: string | null = null;
    const campaignId = (estimate as { campaign_id?: string | null }).campaign_id ?? null;
    if (campaignId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: campaign } = await (db as any)
        .schema('app')
        .from('campaigns')
        .select('name')
        .eq('id', campaignId)
        .eq('tenant_id', tenant_id)
        .maybeSingle();
      campaignName = (campaign as { name?: string | null } | null)?.name ?? null;
    }

    const rawItems = await loadBuyerDocumentLineItems(db as any, tenant_id, 'estimates', id);
    const subtotal = Number(estimate.subtotal ?? rawItems.reduce((sum, i) => sum + (i.line_total ?? 0), 0));
    const tax_total = Number(estimate.tax_amount ?? Math.max(0, Number(estimate.total_amount) - subtotal));

    const detail: BuyerEstimateDetail = {
      id: estimate.id,
      estimate_number: estimate.estimate_number ?? null,
      document_status_note: estimate.estimate_number ? null : TRANSACTION_PENDING_NOTE,
      status: estimate.status,
      estimate_type: estimate.estimate_type ?? 'with_price',
      notes: estimate.notes ?? null,
      created_at: estimate.created_at,
      valid_until: estimate.valid_until ?? null,
      place_of_supply: estimate.place_of_supply ?? null,
      total_amount: Number(estimate.total_amount),
      subtotal,
      tax_total,
      document_url: (estimate as { estimate_url?: string | null }).estimate_url ?? null,
      campaign_name: campaignName,
      items: rawItems,
    };

    return NextResponse.json({ estimate: detail }, { headers: BUYER_CACHE_PERSONAL });
  } catch (err) {
    console.error('[buyer/estimates/[id]] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
