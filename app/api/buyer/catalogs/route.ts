import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVisibleBuyerCatalogs, requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_CATALOG } from '@/lib/server/buyer-cache-headers';
import { isPendingBuyerCatalogSession } from '@/lib/server/buyer-pending-guard';

interface CatalogItem {
  id: string;
  name: string;
  product_count: number;
  share_token: string;
  valid_until: string | null;
  hero_image_url?: string | null;
}

interface BuyerCatalogsResponse {
  catalogs: CatalogItem[];
}

interface CatalogItemCountRow {
  campaign_id: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Buyer-scoped catalog names + share tokens are never exposed to a pending /
    // access-disabled session. Empty list (not 403) so the catalog rail simply renders nothing.
    if (isPendingBuyerCatalogSession(profile)) {
      return NextResponse.json({ catalogs: [] } satisfies BuyerCatalogsResponse, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }

    const context = profile.context;
    const buyer = profile.buyer;
    let catalogs = !buyer
      ? []
      : await getVisibleBuyerCatalogs(context.tenant_id!, buyer.id!);

    if (!buyer) {
      const previewRes = await supabaseAdmin
        .schema('app')
        .from('campaigns')
        .select('id, name, share_token, valid_to, created_at, hero_image_url')
        .eq('tenant_id', context.tenant_id)
        .eq('status', 'published')
        .is('deleted_at', null)
        .or(`valid_to.is.null,valid_to.gt.${new Date().toISOString()}`)
        .order('created_at', { ascending: false });

      if (previewRes.error) {
        console.error('[GET /api/buyer/catalogs] preview catalogs query error:', previewRes.error);
        return NextResponse.json({ error: 'Failed to fetch catalogs' }, { status: 500 });
      }

      catalogs = (previewRes.data ?? []) as typeof catalogs;
    }

    const catalogIds = catalogs.map((catalog) => catalog.id);
    let itemCounts: CatalogItemCountRow[] = [];

    if (catalogIds.length > 0) {
      const itemsRes = await supabaseAdmin
        .schema('app')
        .from('campaign_items')
        .select('campaign_id')
        .in('campaign_id', catalogIds)
        .is('deleted_at', null);

      if (itemsRes.error) {
        console.error('[GET /api/buyer/catalogs] items query error:', itemsRes.error);
        return NextResponse.json({ error: 'Failed to fetch catalog items' }, { status: 500 });
      }

      itemCounts = (itemsRes.data ?? []) as CatalogItemCountRow[];
    }

    const countByCatalog = new Map<string, number>();
    for (const item of itemCounts) {
      countByCatalog.set(item.campaign_id, (countByCatalog.get(item.campaign_id) ?? 0) + 1);
    }

    const payload: BuyerCatalogsResponse = {
      catalogs: catalogs.map((catalog) => ({
        id: catalog.id,
        name: catalog.name,
        product_count: countByCatalog.get(catalog.id) ?? 0,
        share_token: catalog.share_token,
        valid_until: catalog.valid_to,
        hero_image_url: (catalog as { hero_image_url?: string | null }).hero_image_url ?? null,
      })),
    };

    return NextResponse.json(payload, { headers: BUYER_CACHE_CATALOG });
  } catch (error) {
    console.error('[GET /api/buyer/catalogs] unexpected error:', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
