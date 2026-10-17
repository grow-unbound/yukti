import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { FEATURE_FLAGS } from '@/constants';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';

const AddMembersSchema = z.object({
  buyer_ids: z.array(z.string().uuid()).min(1, 'At least one buyer is required'),
});

// Manual campaign-buyer membership CRUD (SCD2-aware). Distinct from
// app/api/tenant/catalogs/[id]/buyers/route.ts, which is a buyer-performance listing
// (opens/GMV via search_catalog_buyers), not membership editing.

// GET: list current manual members of a campaign
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag(FEATURE_FLAGS.CATALOG_PUBLISHING, claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  const { data: campaign } = await db
    .schema('app')
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

  const { data: members, error } = await db
    .schema('app')
    .from('campaign_buyer_members')
    .select('buyer_id, valid_from, buyers!inner(id, business_name, tier, is_active)')
    .eq('campaign_id', id)
    .is('valid_until', null);

  if (error) {
    console.error('[GET /api/tenant/catalogs/[id]/buyer-membership]', error.message);
    return NextResponse.json({ error: 'Failed to fetch members' }, { status: 500 });
  }

  return NextResponse.json({ members: members ?? [] }, { headers: SELLER_CACHE_PERSONAL });
}

// POST: add buyers to a manual campaign
async function POSTImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag(FEATURE_FLAGS.CATALOG_PUBLISHING, claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = AddMembersSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Validation failed' }, { status: 422 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  const { data: campaign } = await db
    .schema('app')
    .from('campaigns')
    .select('id, buyer_target_mode')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  if (campaign.buyer_target_mode !== 'manual') {
    return NextResponse.json({ error: 'Can only add buyers to campaigns with manual buyer targeting' }, { status: 400 });
  }

  // SCD2: insert only for pairs with no existing active row (upsert-on-conflict can't target
  // the partial unique-active index).
  const { data: existingActive } = await db
    .schema('app')
    .from('campaign_buyer_members')
    .select('buyer_id')
    .eq('campaign_id', id)
    .is('valid_until', null)
    .in('buyer_id', parsed.data.buyer_ids);
  const alreadyActive = new Set((existingActive ?? []).map((row: { buyer_id: string }) => row.buyer_id));
  const rows = parsed.data.buyer_ids
    .filter((buyerId) => !alreadyActive.has(buyerId))
    .map((buyerId) => ({ campaign_id: id, buyer_id: buyerId }));

  if (rows.length > 0) {
    const { error: insertError } = await db.schema('app').from('campaign_buyer_members').insert(rows);
    if (insertError) {
      console.error('[POST /api/tenant/catalogs/[id]/buyer-membership]', insertError.message);
      return NextResponse.json({ error: 'Failed to add members' }, { status: 500 });
    }
  }

  const { count } = await db
    .schema('app')
    .from('campaign_buyer_members')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id)
    .is('valid_until', null);

  return NextResponse.json({ ok: true, count }, { status: 200 });
}

// DELETE: remove a buyer from a manual campaign (buyer_id in query string)
async function DELETEImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag(FEATURE_FLAGS.CATALOG_PUBLISHING, claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const buyerId = request.nextUrl.searchParams.get('buyer_id');
  if (!buyerId) return NextResponse.json({ error: 'buyer_id required' }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  const { data: campaign } = await db
    .schema('app')
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

  // Close the active membership window instead of deleting the row (SCD2: never hard-delete).
  await db
    .schema('app')
    .from('campaign_buyer_members')
    .update({ valid_until: new Date().toISOString() })
    .eq('campaign_id', id)
    .eq('buyer_id', buyerId)
    .is('valid_until', null);

  const { count } = await db
    .schema('app')
    .from('campaign_buyer_members')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id)
    .is('valid_until', null);

  return NextResponse.json({ ok: true, count });
}

export const POST = withBuyerContextRevalidation(POSTImpl);

export const DELETE = withBuyerContextRevalidation(DELETEImpl);
