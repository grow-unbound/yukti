import { NextRequest, NextResponse } from 'next/server';

import { assembleBuyerCatalogItemsForProductIds } from '@/lib/server/buyer-assemble-catalog-items';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { resolveBuyerAllowedTenantBrandIds } from '@/lib/server/buyer-brand-visibility';
import { BUYER_CACHE_PRICED } from '@/lib/server/buyer-cache-headers';
import { guardPendingBuyerCatalogAccess } from '@/lib/server/buyer-pending-guard';
import { getCachedGuestPricingContext } from '@/lib/server/public-catalog';
import { supabaseAdmin } from '@/lib/supabase';
import type { BuyerCatalogItem } from '@/types/buyer';
import type { CartBundle, CartBundleSlot, CartBundlesResponse } from '@/types/buyer-reco';

export const dynamic = 'force-dynamic';

export type { CartBundle, CartBundleSlot, CartBundlesResponse };

const EMPTY: CartBundlesResponse = { bundles: [] };

export async function GET(request: NextRequest): Promise<NextResponse<CartBundlesResponse | { error: string }>> {
  const profile = await requireBuyerAccessProfile(request, { slim: true });
  if (!profile?.context.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const tenantId = profile.context.tenant_id!;
  const gate = await guardPendingBuyerCatalogAccess(supabaseAdmin as any, profile);
  if (gate.blocked) return gate.blocked as NextResponse<{ error: string }>;
  const buyerId = gate.pending ? null : (profile.buyer?.id ?? null);
  const guestPricing = gate.pending
    ? gate.guestPricing
    : profile.context.mode === 'guest' ? await getCachedGuestPricingContext(tenantId) : null;

  try {
    // Fetch bundle definitions with top_product_ids per slot from the pre-computed RPC
    const { data: rpcData, error: rpcErr } = await supabaseAdmin
      .schema('app')
      .rpc('reco_get_cart_bundles', { p_tenant_id: tenantId });

    if (rpcErr) throw new Error(rpcErr.message);

    const rawBundles = (rpcData as { bundles?: any[] } | null)?.bundles ?? [];
    if (rawBundles.length === 0) return NextResponse.json(EMPTY, { headers: BUYER_CACHE_PRICED });

    // Collect all top_product_ids across all slots for a single enrichment round-trip
    const allProductIds = Array.from(
      new Set(
        rawBundles
          .flatMap((b: any) => b.slots ?? [])
          .flatMap((s: any) => {
            const ids = s.top_product_ids;
            if (Array.isArray(ids)) return ids.filter(Boolean);
            if (s.top_product_id) return [s.top_product_id];
            return [];
          }),
      ),
    );

    const allowedTenantBrandIds = buyerId
      ? await resolveBuyerAllowedTenantBrandIds(supabaseAdmin as any, tenantId, buyerId)
      : [];

    const enriched =
      allProductIds.length > 0
        ? await assembleBuyerCatalogItemsForProductIds(supabaseAdmin as any, {
            tenantId,
            buyerId,
            productIds: allProductIds,
            allowedTenantBrandIds,
            campaignId: null,
            campaignName: null,
            campaignValidUntil: null,
            priceOverrides: new Map(),
            guestPricing,
          })
        : new Map<string, BuyerCatalogItem>();

    const bundles: CartBundle[] = rawBundles.map((b: any) => ({
      id: b.id,
      name: b.name,
      slots: (b.slots ?? []).map((s: any) => ({
        tenant_category_id: s.tenant_category_id,
        slot_label: s.slot_label ?? null,
        is_required: s.is_required ?? true,
        display_order: s.display_order ?? 0,
        top_products: (() => {
          const ids: string[] = Array.isArray(s.top_product_ids)
            ? s.top_product_ids.filter(Boolean)
            : s.top_product_id
              ? [s.top_product_id]
              : [];
          return ids
            .map((id: string) => enriched.get(id))
            .filter((x): x is BuyerCatalogItem => x != null);
        })(),
      })),
    }));

    return NextResponse.json({ bundles }, { headers: BUYER_CACHE_PRICED });
  } catch (error) {
    console.error('[GET /api/buyer/reco/cart-bundles]', error);
    // Non-critical — return empty rather than 500
    return NextResponse.json(EMPTY, { headers: BUYER_CACHE_PRICED });
  }
}
