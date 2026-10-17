import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { PriceListSimplePricingStrategySchema } from '@/lib/zod';
import { revalidatePublicCatalogCache } from '@/lib/server/public-catalog-cache';
import { z } from 'zod';

const PricingUpdateSchema = z.object({
  pricing_strategy: PriceListSimplePricingStrategySchema,
  strategy_value: z.coerce.number().nonnegative().nullable().optional(),
}).refine((data) => data.pricing_strategy === 'edit_each' || data.strategy_value != null, {
  message: 'Enter a value for the selected pricing mode',
  path: ['strategy_value'],
});

async function PATCHImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = PricingUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Validation failed' }, { status: 422 });
  }
  const { pricing_strategy, strategy_value } = parsed.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  const { data: campaign, error: campaignError } = await db
    .schema('app')
    .from('campaigns')
    .select('id, pricing_source')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }
  if (campaign.pricing_source !== 'individual_prices') {
    return NextResponse.json({ error: 'This campaign is priced via a pricelist — change pricing source first.' }, { status: 422 });
  }

  const { error: updateError } = await db
    .schema('app')
    .from('campaigns')
    .update({
      pricing_strategy,
      strategy_value: pricing_strategy === 'edit_each' ? null : (strategy_value ?? null),
      updated_by: claims.sub,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update pricing mode', detail: updateError.message }, { status: 500 });
  }

  let updatedCount = 0;
  if (pricing_strategy !== 'edit_each') {
    const { data: applyResult, error: applyError } = await db.schema('app').rpc('apply_campaign_pricing_strategy', { p_campaign_id: id });
    if (applyError) {
      return NextResponse.json({ error: 'Pricing mode saved but products could not be repriced', detail: applyError.message }, { status: 500 });
    }
    updatedCount = Number(applyResult ?? 0);
  }

  revalidatePublicCatalogCache(claims.tenant_id);
  return NextResponse.json({ ok: true, updated_count: updatedCount });
}

export const PATCH = withBuyerContextRevalidation(PATCHImpl);
