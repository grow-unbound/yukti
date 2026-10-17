import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { assembleBuyerCatalogItemsForProductIds } from '@/lib/server/buyer-assemble-catalog-items';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import { isCatalogApprovalRequiredForProfile, resolveBuyerProductScopeContext } from '@/lib/server/buyer-product-data';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerCatalogItem } from '@/types/buyer';

const IdSchema = z.string().uuid();

export interface BuyerProductDetailResponse {
  item: BuyerCatalogItem;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<BuyerProductDetailResponse | { error: string }>> {
  const profile = await requireBuyerAccessProfile(request, { slim: true });
  if (!profile?.context.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { id: rawId } = await params;
  const parsed = IdSchema.safeParse(rawId);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid product id' }, { status: 400 });
  }
  const productId = parsed.data;

  try {
    const context = await resolveBuyerProductScopeContext(supabaseAdmin as any, request, profile);
    if (isCatalogApprovalRequiredForProfile(profile, context.publicCatalog)) {
      return NextResponse.json({ error: 'Approval required' }, {
        status: 403,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }

    const enriched = await assembleBuyerCatalogItemsForProductIds(supabaseAdmin as any, {
      tenantId: context.tenantId,
      buyerId: context.buyerId,
      productIds: [productId],
      allowedTenantBrandIds: context.allowedTenantBrandIds,
      inventoryWarehouseId: context.inventoryWarehouseId,
      campaignId: null,
      campaignName: null,
      campaignValidUntil: null,
      priceOverrides: new Map(),
      guestPricing: context.guestPricing,
      publicCatalog: context.publicCatalog,
    });

    const item = enriched.get(productId);
    if (!item) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    return NextResponse.json({ item } satisfies BuyerProductDetailResponse, {
      headers: BUYER_CACHE_PRICED,
    });
  } catch (error) {
    console.error('[GET /api/buyer/products/[id]]', error);
    return NextResponse.json({ error: 'Failed to load product' }, { status: 500 });
  }
}
