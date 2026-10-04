import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { hashOtp } from '@/lib/server/buyer-otp-store';
import { requireSupplierWorkspaceSurface } from '@/lib/server/auth-surface-server';

const VerifyBodySchema = z.object({
  email: z.string().email(),
  token: z.string().min(6).max(6),
  channel: z.enum(['email', 'whatsapp']),
  user_id: z.string().uuid().optional(), // required for whatsapp channel
});

async function markTenantVerified(userId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;

  const { data: tuRow } = await supabaseAdmin
    .schema('app')
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .single();

  if (!tuRow?.tenant_id) return false;

  const { error } = await supabaseAdmin
    .schema('app')
    .from('tenants')
    .update({ email_verified_at: new Date().toISOString() })
    .eq('id', tuRow.tenant_id);

  return !error;
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

  const parsed = VerifyBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  const { email, token, channel, user_id } = parsed.data;

  // --- EMAIL CHANNEL: validate Resend-delivered OTPs from our DB store.
  // Fall back to Supabase Auth OTP for any in-flight legacy emails.
  if (channel === 'email') {
    const baseQuery = supabaseAdmin
      .schema('app')
      .from('email_verification_otps')
      .select('id, otp, expires_at, attempts, tenant_id, user_id')
      .eq('email', email)
      .eq('channel', 'email')
      .is('verified_at', null)
      .order('created_at', { ascending: false })
      .limit(1);

    const { data: otpRecord } = await (user_id ? baseQuery.eq('user_id', user_id) : baseQuery).single();

    if (otpRecord) {
      if (new Date() > new Date(otpRecord.expires_at)) {
        return NextResponse.json({ error: 'OTP has expired. Please request a new one.' }, { status: 400 });
      }

      if (otpRecord.attempts >= 5) {
        return NextResponse.json({ error: 'Too many attempts. Please request a new OTP.' }, { status: 400 });
      }

      if (otpRecord.otp !== hashOtp(token) && otpRecord.otp !== token) {
        await supabaseAdmin
          .schema('app')
          .from('email_verification_otps')
          .update({ attempts: otpRecord.attempts + 1, updated_at: new Date().toISOString() })
          .eq('id', otpRecord.id);

        const remaining = 4 - otpRecord.attempts;
        return NextResponse.json(
          { error: 'Incorrect OTP.', remaining_attempts: remaining },
          { status: 400 },
        );
      }

      await supabaseAdmin
        .schema('app')
        .from('email_verification_otps')
        .update({ verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', otpRecord.id);

      await supabaseAdmin
        .schema('app')
        .from('tenants')
        .update({ email_verified_at: new Date().toISOString() })
        .eq('id', otpRecord.tenant_id);

      return NextResponse.json({ success: true });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data, error } = await anonClient.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (error || !data.user) {
      return NextResponse.json(
        { error: error?.message ?? 'Invalid or expired OTP. Please request a new one.' },
        { status: 400 }
      );
    }

    await markTenantVerified(data.user.id);
    return NextResponse.json({ success: true });
  }

  // --- WHATSAPP CHANNEL: validate against our DB OTP store ---
  if (!user_id) {
    return NextResponse.json({ error: 'user_id required for WhatsApp verification' }, { status: 400 });
  }

  const { data: otpRecord } = await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .select('id, otp, expires_at, attempts, tenant_id')
    .eq('user_id', user_id)
    .eq('channel', 'whatsapp')
    .is('verified_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!otpRecord) {
    return NextResponse.json({ error: 'No pending OTP found. Request a new one.' }, { status: 400 });
  }

  if (new Date() > new Date(otpRecord.expires_at)) {
    return NextResponse.json({ error: 'OTP has expired. Please request a new one.' }, { status: 400 });
  }

  if (otpRecord.attempts >= 5) {
    return NextResponse.json({ error: 'Too many attempts. Please request a new OTP.' }, { status: 400 });
  }

  if (otpRecord.otp !== hashOtp(token) && otpRecord.otp !== token) {
    await supabaseAdmin
      .schema('app')
      .from('email_verification_otps')
      .update({ attempts: otpRecord.attempts + 1, updated_at: new Date().toISOString() })
      .eq('id', otpRecord.id);

    const remaining = 4 - otpRecord.attempts;
    return NextResponse.json(
      { error: 'Incorrect OTP.', remaining_attempts: remaining },
      { status: 400 }
    );
  }

  // Valid — mark OTP used and tenant verified
  await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .update({ verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', otpRecord.id);

  await supabaseAdmin
    .schema('app')
    .from('tenants')
    .update({ email_verified_at: new Date().toISOString() })
    .eq('id', otpRecord.tenant_id);

  return NextResponse.json({ success: true });
}
