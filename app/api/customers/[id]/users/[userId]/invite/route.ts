import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { sendSetupPasswordInviteEmail } from '@/lib/server/email';

async function ensureBuyerUser(db: any, tenantId: string, buyerId: string, userId: string) {
  const { data: buyer } = await db
    .schema('app')
    .from('buyers')
    .select('id')
    .eq('id', buyerId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!buyer) {
    return null;
  }

  const { data, error } = await db
    .schema('app')
    .from('buyer_users')
    .select('id, buyer_id, email, user_id, deleted_at, first_name, last_name')
    .eq('id', userId)
    .eq('buyer_id', buyerId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const { id, userId } = await params;
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
  const user = await ensureBuyerUser(db, claims.tenant_id, id, userId);
  if (!user) {
    return NextResponse.json({ error: 'Buyer user not found' }, { status: 404 });
  }

  if (!user.email) {
    return NextResponse.json({ error: 'Email is required to send an invite.' }, { status: 400 });
  }

  const { data: tenantRow, error: tenantError } = await db
    .schema('app')
    .from('tenants')
    .select('business_name')
    .eq('id', claims.tenant_id)
    .maybeSingle();

  if (tenantError || !tenantRow?.business_name) {
    return NextResponse.json(
      { error: 'Failed to load tenant details for invite', details: tenantError?.message },
      { status: 500 },
    );
  }

  const setupPasswordUrl = new URL('/setup-password', request.nextUrl.origin).toString();
  const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'invite',
    email: user.email,
    options: {
      redirectTo: setupPasswordUrl,
      data: {
        tenant_id: claims.tenant_id,
        buyer_id: id,
        buyer_user_id: userId,
      },
    },
  });

  if (inviteError || !inviteData?.properties?.action_link) {
    return NextResponse.json(
      { error: 'Failed to prepare invite', details: inviteError?.message ?? 'Invite link was not generated' },
      { status: 500 },
    );
  }

  try {
    await sendSetupPasswordInviteEmail({
      to: user.email,
      inviteUrl: inviteData.properties.action_link,
      tenantName: tenantRow.business_name,
      recipientName: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to send invite email', details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const { error: updateError } = await db
    .schema('app')
    .from('buyer_users')
    .update({
      user_id: inviteData.user?.id ?? null,
      is_active: true,
      updated_at: new Date().toISOString(),
      updated_by: claims.sub,
    })
    .eq('id', userId)
    .eq('buyer_id', id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update buyer user invite state' }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: `Invite sent to ${user.email}` });
}
