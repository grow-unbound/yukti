import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import { isCatalogApprovalRequiredForProfile, resolveBuyerProductScopeContext } from '@/lib/server/buyer-product-data';
import { loadBuyerProductFamilyDetail } from '@/lib/server/buyer-product-families';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerProductFamilyDetail } from '@/types/buyer';

const IdSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<BuyerProductFamilyDetail | { error: string }>> {
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
    return NextResponse.json({ error: 'Invalid product family id' }, { status: 400 });
  }

  try {
    const context = await resolveBuyerProductScopeContext(supabaseAdmin as any, request, profile);
    if (isCatalogApprovalRequiredForProfile(profile, context.publicCatalog)) {
      return NextResponse.json({ error: 'Approval required' }, {
        status: 403,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    const detail = await loadBuyerProductFamilyDetail({
      db: supabaseAdmin as any,
      tenantId: context.tenantId,
      buyerId: context.buyerId,
      familyId: parsed.data,
      allowedTenantBrandIds: context.allowedTenantBrandIds,
      inventoryWarehouseId: context.inventoryWarehouseId,
      guestPricing: context.guestPricing,
      publicCatalog: context.publicCatalog,
    });

    if (!detail) {
      return NextResponse.json({ error: 'Product family not found' }, { status: 404 });
    }

    return NextResponse.json(detail, { headers: BUYER_CACHE_PRICED });
  } catch (error) {
    console.error('[GET /api/buyer/product-families/[id]]', error);
    return NextResponse.json({ error: 'Failed to load product family' }, { status: 500 });
  }
}
