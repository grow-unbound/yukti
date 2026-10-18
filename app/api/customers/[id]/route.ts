import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims, decodeJWTPayload } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { BuyerUpdateSchema } from '@/lib/zod';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';

async function syncDefaultPriceListAssignment(
  db: any,
  tenantId: string,
  buyerId: string,
  defaultPriceListId: string | null | undefined,
  actorUserId: string | null,
) {
  const { error: deleteError } = await db
    .schema('app')
    .from('price_list_assignments')
    .update({ deleted_at: new Date().toISOString(), updated_by: actorUserId })
    .eq('target_type', 'buyer')
    .eq('target_id', buyerId)
    .is('deleted_at', null);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (!defaultPriceListId) {
    return null;
  }

  const { data: priceList, error: priceListError } = await db
    .schema('app')
    .from('price_lists')
    .select('id')
    .eq('id', defaultPriceListId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle();

  if (priceListError) {
    throw new Error(priceListError.message);
  }
  if (!priceList) {
    throw new Error('Selected pricelist is invalid for this tenant.');
  }

  const { data: assignment, error: insertError } = await db
    .schema('app')
    .from('price_list_assignments')
    .insert({
      price_list_id: defaultPriceListId,
      target_type: 'buyer',
      target_id: buyerId,
      created_by: actorUserId,
      updated_by: actorUserId,
    })
    .select()
    .single();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return assignment;
}

// ─── GET /api/customers/[id] ────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!claims.role?.startsWith('seller_')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const flagEnabled = await getFlag('df_customer_master', claims.tenant_id);
  if (!flagEnabled) {
    return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const db = supabaseAdmin as any;
  const { data: buyer, error } = await db
    .schema('app')
    .from('buyers')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('is_active', true)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch customer' }, { status: 500 });
  }

  if (!buyer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  return NextResponse.json({ buyer }, { headers: SELLER_CACHE_PERSONAL });
}

// ─── PUT /api/customers/[id] ─────────────────────────────────────────────────

async function PUTImpl(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!claims.role?.startsWith('seller_')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const flagEnabled = await getFlag('df_customer_master', claims.tenant_id);
  if (!flagEnabled) {
    return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = BuyerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Validation failed' },
      { status: 422 },
    );
  }

  // Cast to any for schema() chaining — mirrors pattern in app/api/customers/route.ts
  const db = supabaseAdmin as any;

  // Fetch existing buyer (tenant-scoped)
  const { data: existing, error: fetchError } = await db
    .schema('app')
    .from('buyers')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('is_active', true)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: 'Failed to fetch customer' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Build the update payload
  const updateData: Record<string, any> = { ...parsed.data };

  // seller_assistant cannot update financial or access fields — strip them silently
  if (claims.role === 'seller_assistant') {
    delete updateData.credit_limit;
    delete updateData.default_cohort_id;
    delete updateData.buyer_app_enabled;
  }

  // Phone uniqueness check (if phone is being changed)
  if (updateData.phone && updateData.phone !== existing.phone) {
    const { data: phoneMatch } = await db
      .schema('app')
      .from('buyers')
      .select('id')
      .eq('tenant_id', claims.tenant_id)
      .eq('phone', updateData.phone)
      .is('is_active', true)
      .neq('id', id)
      .maybeSingle();

    if (phoneMatch) {
      return NextResponse.json(
        { error: 'A buyer with this phone number already exists.' },
        { status: 409 },
      );
    }
  }

  if (updateData.default_cohort_id) {
    const { data: cohort } = await db
      .schema('app')
      .from('cohorts')
      .select('id')
      .eq('id', updateData.default_cohort_id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (!cohort) {
      return NextResponse.json(
        { error: 'Selected cohort is invalid for this tenant.' },
        { status: 400 },
      );
    }
  }

  if ('default_price_list_id' in updateData) {
    const nextPriceListId = updateData.default_price_list_id ?? null;
    if (nextPriceListId) {
      const { data: priceList } = await db
        .schema('app')
        .from('price_lists')
        .select('id')
        .eq('id', nextPriceListId)
        .eq('tenant_id', claims.tenant_id)
        .is('deleted_at', null)
        .maybeSingle();

      if (!priceList) {
        return NextResponse.json(
          { error: 'Selected pricelist is invalid for this tenant.' },
          { status: 400 },
        );
      }
    }
  }

  const nextDefaultPriceListId =
    'default_price_list_id' in updateData ? updateData.default_price_list_id ?? null : undefined;
  delete updateData.default_price_list_id;

  // Compute diff for audit log (field name → new value for changed fields only)
  const diff: Record<string, any> = {};
  for (const key of Object.keys(updateData)) {
    const newVal = updateData[key];
    const oldVal = existing[key];
    // Simple deep compare for geography (object); string comparison otherwise
    if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      diff[key] = newVal;
    }
  }

  // Perform the update
  const { data: updatedBuyer, error: updateError } = await db
    .schema('app')
    .from('buyers')
    .update({
      ...updateData,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
  }

  if ('default_cohort_id' in updateData) {
    const nextCohortId = updateData.default_cohort_id || null;

    if (nextCohortId) {
      // SCD2: insert only if no active row already exists for this pair (upsert-on-conflict
      // can't target the partial unique-active index).
      const { data: existingActive } = await db
        .schema('app')
        .from('cohort_members_active')
        .select('id')
        .eq('cohort_id', nextCohortId)
        .eq('buyer_id', id)
        .maybeSingle();
      if (!existingActive) {
        await db.schema('app').from('cohort_members').insert({ cohort_id: nextCohortId, buyer_id: id });
      }
    }

    if (existing.default_cohort_id && existing.default_cohort_id !== nextCohortId) {
      // Close the active window instead of deleting the row (SCD2: never hard-delete).
      await db
        .schema('app')
        .from('cohort_members')
        .update({ valid_until: new Date().toISOString() })
        .eq('cohort_id', existing.default_cohort_id)
        .eq('buyer_id', id)
        .is('valid_until', null);
    }
  }

  if (nextDefaultPriceListId !== undefined) {
    try {
      await syncDefaultPriceListAssignment(
        db,
        claims.tenant_id,
        id,
        nextDefaultPriceListId,
        claims.sub ?? null,
      );
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to assign pricelist' },
        { status: 400 },
      );
    }
  }

  // Extract actor_user_id from Bearer token
  let actorUserId: string | null = null;
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      const payload = decodeJWTPayload(token);
      actorUserId = (payload.sub as string) ?? null;
    } catch {
      // ignore — audit log will have null actor
    }
  }

  // Insert audit log (fire-and-forget; don't block response on failure)
  if (Object.keys(diff).length > 0) {
    void db
      .schema('app')
      .from('audit_log')
      .insert({
        tenant_id: claims.tenant_id,
        actor_user_id: actorUserId,
        entity_type: 'buyer',
        entity_id: id,
        action: 'update',
        diff,
      });
  }

  return NextResponse.json({ buyer: updatedBuyer });
}

// ─── PATCH /api/customers/[id] — EP-03-004: deactivate / reactivate ──────────

async function PATCHImpl(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only seller_admin can deactivate/reactivate
  if (claims.role !== 'seller_admin') {
    return NextResponse.json({ error: 'Forbidden: seller_admin role required' }, { status: 403 });
  }

  const flagEnabled = await getFlag('df_customer_master', claims.tenant_id);
  if (!flagEnabled) {
    return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action } = body as { action?: string };
  if (action !== 'deactivate' && action !== 'reactivate') {
    return NextResponse.json(
      { error: 'Invalid action. Must be "deactivate" or "reactivate".' },
      { status: 422 },
    );
  }

  const isActive = action === 'reactivate';
  const db = supabaseAdmin as any;

  // Verify buyer exists and belongs to tenant
  const { data: existing, error: fetchError } = await db
    .schema('app')
    .from('buyers')
    .select('id, business_name, is_active')
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .is('is_active', true)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: 'Failed to fetch customer' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Perform the status update
  const { data: updatedBuyer, error: updateError } = await db
    .schema('app')
    .from('buyers')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', claims.tenant_id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update customer status' }, { status: 500 });
  }

  // Extract actor_user_id from Bearer token
  let actorUserId: string | null = null;
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      const payload = decodeJWTPayload(token);
      actorUserId = (payload.sub as string) ?? null;
    } catch {
      // ignore
    }
  }

  // Audit log (fire-and-forget)
  try {
    void db
      .schema('app')
      .from('audit_log')
      .insert({
        tenant_id: claims.tenant_id,
        actor_user_id: actorUserId,
        entity_type: 'buyer',
        entity_id: id,
        action,
        diff: { is_active: isActive },
      });
  } catch {
    // don't block response on audit failure
  }

  return NextResponse.json({ buyer: updatedBuyer });
}

export const PUT = withBuyerContextRevalidation(PUTImpl);

export const PATCH = withBuyerContextRevalidation(PATCHImpl);
