import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { resolveBuyerAllowedTenantBrandIds } from '@/lib/server/buyer-brand-visibility';
import { BUYER_CACHE_CATALOG, BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { guardPendingBuyerCatalogAccess } from '@/lib/server/buyer-pending-guard';

export interface BuyerSearchItem {
  id: string;
  entity_type: string;
  label: string;
  sublabel: string;
  meta?: string;
}

export interface BuyerSearchResponse {
  items: BuyerSearchItem[];
  scope: 'catalog' | 'orders';
}

export async function GET(request: NextRequest): Promise<NextResponse<BuyerSearchResponse | { error: string }>> {
  try {
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { tenant_id } = profile.context;
    const scope = (request.nextUrl.searchParams.get('scope') ?? 'catalog') as 'catalog' | 'orders';
    if (profile.context.mode === 'guest' && scope === 'orders') {
      return NextResponse.json({ items: [], scope }, { headers: BUYER_CACHE_PERSONAL });
    }

    // Pending / access-disabled sessions: 403 unless the tenant's public catalog allows public
    // browsing, and then search runs with NO buyer id (guest scope). Orders search is account
    // data and is always empty for them.
    const gate = supabaseAdmin
      ? await guardPendingBuyerCatalogAccess(supabaseAdmin as any, profile)
      : { pending: false, blocked: null };
    if (gate.blocked) return gate.blocked as NextResponse<{ error: string }>;
    if (gate.pending && scope === 'orders') {
      return NextResponse.json({ items: [], scope }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const buyer_id = gate.pending ? null : profile.context.buyer_id;
    const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
    const cacheHeaders = scope === 'orders' ? BUYER_CACHE_PERSONAL : BUYER_CACHE_CATALOG;

    if (!q) {
      return NextResponse.json({ items: [], scope }, { headers: cacheHeaders });
    }

    const db = supabaseAdmin ?? supabase;
    const items: BuyerSearchItem[] = [];

    if (scope === 'catalog') {
      const allowedTenantBrandIds =
        profile.context.mode === 'buyer' && buyer_id && tenant_id
          ? await resolveBuyerAllowedTenantBrandIds(db as any, tenant_id, buyer_id)
          : null;

      const { data: rows, error } = await (db as any).schema('app').rpc('global_search', {
        p_query: q,
        p_tenant_id: tenant_id,
        p_role: profile.context.role,
        p_items_per_group: 20,
        p_buyer_id: buyer_id,
        p_allowed_brand_ids: allowedTenantBrandIds,
      });

      if (error) {
        console.error('[buyer/search] global_search error:', error);
      }

      for (const row of (rows ?? []) as Array<{ entity_type: string; id: string; label: string; sublabel: string }>) {
        items.push({
          id: row.id,
          entity_type: row.entity_type,
          label: row.label,
          sublabel: row.sublabel,
        });
      }
    }

    if (scope === 'orders' && buyer_id) {
      const [{ data: orders }, { data: estimates }, { data: invoices }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any)
          .schema('app')
          .from('orders')
          .select('id, order_number, status, total_amount')
          .eq('tenant_id', tenant_id)
          .eq('buyer_id', buyer_id)
          .is('deleted_at', null)
          .ilike('order_number', `%${q}%`)
          .limit(10),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any)
          .schema('app')
          .from('estimates')
          .select('id, estimate_number, status, total_amount')
          .eq('tenant_id', tenant_id)
          .eq('buyer_id', buyer_id)
          .is('deleted_at', null)
          .ilike('estimate_number', `%${q}%`)
          .limit(10),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any)
          .schema('app')
          .from('invoices')
          .select('id, invoice_number, status, total_amount')
          .eq('tenant_id', tenant_id)
          .eq('buyer_id', buyer_id)
          .is('deleted_at', null)
          .ilike('invoice_number', `%${q}%`)
          .limit(10),
      ]);

      for (const o of (orders ?? [])) {
        items.push({ id: o.id, entity_type: 'order', label: o.order_number, sublabel: o.status, meta: String(o.total_amount ?? 0) });
      }
      for (const e of (estimates ?? [])) {
        items.push({ id: e.id, entity_type: 'estimate', label: e.estimate_number ?? '', sublabel: e.status, meta: String(e.total_amount ?? 0) });
      }
      for (const inv of (invoices ?? [])) {
        items.push({ id: inv.id, entity_type: 'invoice', label: inv.invoice_number, sublabel: inv.status, meta: String(inv.total_amount ?? 0) });
      }
    }

    return NextResponse.json({ items, scope }, { headers: cacheHeaders });
  } catch (err) {
    console.error('[buyer/search] error:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
