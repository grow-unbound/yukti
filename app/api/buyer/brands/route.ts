import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_CATALOG, BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import {
  fetchBuyerBrands,
  fetchCachedBuyerBrands,
  fetchCachedGuestBrands,
  isCatalogApprovalRequiredForProfile,
  resolveBuyerProductScopeContext,
} from '@/lib/server/buyer-product-data';
import type { BuyerBrandsResponse } from '@/types/buyer';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const profile = await requireBuyerAccessProfile(req, { slim: true });
    if (!profile?.context.tenant_id || !supabaseAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const context = await resolveBuyerProductScopeContext(supabaseAdmin as any, req, profile);
    if (isCatalogApprovalRequiredForProfile(profile, context.publicCatalog)) {
      return NextResponse.json({ error: 'Approval required' }, {
        status: 403,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    const requestedCampaignId = req.nextUrl.searchParams.get('campaign_id')?.trim() ?? '';
    const shareToken = req.nextUrl.searchParams.get('share_token')?.trim() ?? '';
    const isDefaultBrowse = !requestedCampaignId && !shareToken;
    const brands = !isDefaultBrowse
      ? await fetchBuyerBrands({
          db: supabaseAdmin as any,
          tenantId: context.tenantId,
          allowedTenantBrandIds: context.allowedTenantBrandIds,
          requestedCampaignId,
          shareToken,
        })
      : context.guestPricing
        ? await fetchCachedGuestBrands(context.tenantId)
        : await fetchCachedBuyerBrands(context.tenantId, context.allowedTenantBrandIds);

    const cacheHeaders = context.guestPricing ? BUYER_CACHE_CATALOG : BUYER_CACHE_PRICED;
    return NextResponse.json({ brands } satisfies BuyerBrandsResponse, { headers: cacheHeaders });
  } catch (err) {
    console.error('[GET /api/buyer/brands]', err);
    return NextResponse.json({ error: 'Failed to fetch brands' }, { status: 500 });
  }
}
