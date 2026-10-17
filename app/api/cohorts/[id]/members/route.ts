import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { getPostHogClient } from '@/lib/posthog-server';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';
import { z } from 'zod';

const AddMembersSchema = z.object({
  buyer_ids: z.array(z.string().uuid()).min(1, 'At least one buyer is required'),
});

// GET: list current members of a cohort
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_'))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin)
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  // Verify cohort belongs to this tenant
  const { data: cohort } = await db
    .schema('app')
    .from('cohorts')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });

  const { data: members, error } = await db
    .schema('app')
    .from('cohort_members_active')
    .select('buyer_id, buyers!inner(id, business_name, tier, is_active)')
    .eq('cohort_id', id);

  if (error) {
    console.error('[GET /api/cohorts/[id]/members]', error.message);
    return NextResponse.json({ error: 'Failed to fetch members' }, { status: 500 });
  }

  return NextResponse.json({ members: members ?? [] }, { headers: SELLER_CACHE_PERSONAL });
}

// POST: add buyers to a static cohort
async function POSTImpl(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin)
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = AddMembersSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Validation failed' },
      { status: 422 },
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  // Verify cohort belongs to this tenant and is static
  const { data: cohort } = await db
    .schema('app')
    .from('cohorts')
    .select('id, is_static')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });
  if (!cohort.is_static)
    return NextResponse.json(
      { error: 'Can only add members to static cohorts' },
      { status: 400 },
    );

  // SCD2: cohort_members only enforces uniqueness on the active (valid_until IS NULL) row via
  // a partial index, which ON CONFLICT upsert can't target directly. Open a new window only
  // for pairs that aren't already active; already-active pairs are left untouched.
  const { data: existingActive } = await db
    .schema('app')
    .from('cohort_members_active')
    .select('buyer_id')
    .eq('cohort_id', id)
    .in('buyer_id', parsed.data.buyer_ids);
  const alreadyActive = new Set((existingActive ?? []).map((row: { buyer_id: string }) => row.buyer_id));
  const rows = parsed.data.buyer_ids
    .filter((buyer_id) => !alreadyActive.has(buyer_id))
    .map((buyer_id) => ({ cohort_id: id, buyer_id }));

  if (rows.length > 0) {
    const { error: insertError } = await db.schema('app').from('cohort_members').insert(rows);
    if (insertError) {
      console.error('[POST /api/cohorts/[id]/members]', insertError.message);
      return NextResponse.json({ error: 'Failed to add members' }, { status: 500 });
    }
  }

  // Update cached_member_count
  const { count } = await db
    .schema('app')
    .from('cohort_members_active')
    .select('*', { count: 'exact', head: true })
    .eq('cohort_id', id);
  await db
    .schema('app')
    .from('cohorts')
    .update({ cached_member_count: count ?? 0 })
    .eq('id', id);

  getPostHogClient()?.capture({
    distinctId: claims.sub ?? claims.tenant_id,
    event: 'customer_group_members_updated',
    properties: {
      tenant_id: claims.tenant_id,
      seller_id: claims.sub,
      cohort_id: id,
      action: 'add',
      requested_member_count: parsed.data.buyer_ids.length,
      changed_member_count: rows.length,
      cached_member_count: count ?? 0,
      role: claims.role,
    },
  });

  return NextResponse.json({ ok: true, count }, { status: 200 });
}

// DELETE: remove a buyer from a static cohort (buyer_id in query string)
async function DELETEImpl(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (claims.role !== 'seller_admin')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const flagEnabled = await getFlag('df_cohorts', claims.tenant_id);
  if (!flagEnabled) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  if (!supabaseAdmin)
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

  const buyerId = request.nextUrl.searchParams.get('buyer_id');
  if (!buyerId) return NextResponse.json({ error: 'buyer_id required' }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;

  // Verify cohort belongs to this tenant
  const { data: cohort } = await db
    .schema('app')
    .from('cohorts')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });

  // Close the active membership window instead of deleting the row (SCD2: never hard-delete).
  await db
    .schema('app')
    .from('cohort_members')
    .update({ valid_until: new Date().toISOString() })
    .eq('cohort_id', id)
    .eq('buyer_id', buyerId)
    .is('valid_until', null);

  // Update cached_member_count
  const { count } = await db
    .schema('app')
    .from('cohort_members_active')
    .select('*', { count: 'exact', head: true })
    .eq('cohort_id', id);
  await db
    .schema('app')
    .from('cohorts')
    .update({ cached_member_count: count ?? 0 })
    .eq('id', id);

  getPostHogClient()?.capture({
    distinctId: claims.sub ?? claims.tenant_id,
    event: 'customer_group_members_updated',
    properties: {
      tenant_id: claims.tenant_id,
      seller_id: claims.sub,
      cohort_id: id,
      action: 'remove',
      changed_member_count: 1,
      cached_member_count: count ?? 0,
      role: claims.role,
    },
  });

  return NextResponse.json({ ok: true, count });
}

export const POST = withBuyerContextRevalidation(POSTImpl);

export const DELETE = withBuyerContextRevalidation(DELETEImpl);
