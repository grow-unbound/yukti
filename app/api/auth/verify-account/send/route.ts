import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import {
  sendAccountVerificationOtpEmail,
  sendAccountVerificationOtpWhatsapp,
} from '@/lib/server/account-verification';
import { isSigninLocked, recordFailedSignin } from '@/lib/server/auth-signin-lockout';
import { requireSupplierWorkspaceSurface } from '@/lib/server/auth-surface-server';

const SendBodySchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid().optional().nullable(),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  channel: z.enum(['email', 'whatsapp']).default('whatsapp'),
});

async function resolveTenantIdForUser(userId: string, explicitTenantId?: string | null) {
  if (explicitTenantId) return explicitTenantId;
  const { data } = await supabaseAdmin!
    .schema('app')
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const surfaceError = requireSupplierWorkspaceSurface(request);
  if (surfaceError) return surfaceError;

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = SendBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  const { user_id, tenant_id: rawTenantId, email, phone, channel } = parsed.data;
  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
  const throttleKey = `verify-account-send:${channel}:${clientIp}:${user_id}`;
  if (await isSigninLocked(throttleKey)) {
    return NextResponse.json(
      { error: 'Too many OTP requests. Please wait before trying again.' },
      { status: 429 },
    );
  }

  const tenant_id = await resolveTenantIdForUser(user_id, rawTenantId);
  if (!tenant_id) {
    return NextResponse.json({ error: 'No workspace found for this account' }, { status: 404 });
  }

  // Rate-limit: max 5 OTP sends per user+channel in the last hour
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user_id)
    .eq('channel', channel)
    .gte('created_at', hourAgo);

  if ((count ?? 0) >= 5) {
    return NextResponse.json(
      { error: 'Too many OTP requests. Please wait before trying again.' },
      { status: 429 }
    );
  }
  void recordFailedSignin(throttleKey);

  if (channel === 'email') {
    const result = await sendAccountVerificationOtpEmail({ user_id, tenant_id, email });
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true });
  }

  if (!phone) {
    return NextResponse.json({ error: 'Phone number is required for WhatsApp OTP' }, { status: 400 });
  }

  const result = await sendAccountVerificationOtpWhatsapp({ user_id, tenant_id, email, phone });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true });
}
