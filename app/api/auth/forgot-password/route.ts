import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendPasswordRecoveryEmail } from '@/lib/server/email';
import { requireSupplierWorkspaceSurface } from '@/lib/server/auth-surface-server';

export async function POST(request: NextRequest) {
  const surfaceError = requireSupplierWorkspaceSurface(request);
  if (surfaceError) return surfaceError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { email } = body as { email?: string };
  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  // Derive the app origin from the incoming request so this works in all envs
  const origin = request.nextUrl.origin;
  const normalizedEmail = email.trim().toLowerCase();

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: normalizedEmail,
    options: {
      redirectTo: `${origin}/reset-password`,
    },
  });

  if (!error && data.properties?.action_link) {
    await sendPasswordRecoveryEmail({
      to: normalizedEmail,
      resetUrl: data.properties.action_link,
    });
  }

  return NextResponse.json({ success: true });
}
