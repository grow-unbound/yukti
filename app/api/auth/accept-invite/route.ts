import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getRequestSupabaseClient } from '@/lib/server/request-supabase';
import { requireSupplierWorkspaceSurface } from '@/lib/server/auth-surface-server';

export async function POST(request: NextRequest) {
  const surfaceError = requireSupplierWorkspaceSurface(request);
  if (surfaceError) return surfaceError;

  const supabase = await getRequestSupabaseClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data: pendingRow, error: fetchError } = await db
    .schema('app')
    .from('tenant_users')
    .select('id, tenant_id, role')
    .eq('user_id', user.id)
    .eq('is_active', false)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: 'Failed to look up invite' }, { status: 500 });
  }

  if (!pendingRow) {
    return NextResponse.json({ success: true }, { status: 200 });
  }

  const { error: updateError } = await db
    .schema('app')
    .from('tenant_users')
    .update({
      is_active: true,
      joined_at: new Date().toISOString(),
      updated_by: user.id,
    })
    .eq('id', pendingRow.id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to activate membership' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    tenant_id: pendingRow.tenant_id,
    role: pendingRow.role,
  });
}
