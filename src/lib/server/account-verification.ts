import { randomInt } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { sendLoginOtpWhatsapp } from '@/lib/server/whatsapp';
import { sendAccountVerificationEmail } from '@/lib/server/email';
import { hashOtp } from '@/lib/server/buyer-otp-store';

interface SendOtpParams {
  user_id: string;
  tenant_id: string;
  email: string;
  phone: string;
}

type SendOtpResult = { success: true } | { error: string; status: number };

export async function sendAccountVerificationOtpWhatsapp(
  params: SendOtpParams
): Promise<SendOtpResult> {
  if (!supabaseAdmin) {
    return { error: 'Server misconfiguration', status: 500 };
  }

  const { user_id, tenant_id, email, phone } = params;

  // Invalidate any existing unverified OTPs for this user
  await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .delete()
    .eq('user_id', user_id)
    .eq('channel', 'whatsapp')
    .is('verified_at', null);

  const otp = String(randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error: insertError } = await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .insert({ user_id, tenant_id, email, phone, otp: hashOtp(otp), expires_at: expiresAt, channel: 'whatsapp' });

  if (insertError) {
    return { error: 'Failed to create OTP', status: 500 };
  }

  try {
    await sendLoginOtpWhatsapp(phone, otp);
  } catch {
    return { error: 'Failed to send WhatsApp OTP', status: 500 };
  }

  return { success: true };
}

export async function sendAccountVerificationOtpEmail(
  params: Omit<SendOtpParams, 'phone'>,
): Promise<SendOtpResult> {
  if (!supabaseAdmin) {
    return { error: 'Server misconfiguration', status: 500 };
  }

  const { user_id, tenant_id, email } = params;

  await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .delete()
    .eq('user_id', user_id)
    .eq('channel', 'email')
    .is('verified_at', null);

  const otp = String(randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data: tenantRow } = await supabaseAdmin
    .schema('app')
    .from('tenants')
    .select('business_name')
    .eq('id', tenant_id)
    .maybeSingle();

  const { error: insertError } = await supabaseAdmin
    .schema('app')
    .from('email_verification_otps')
    .insert({
      user_id,
      tenant_id,
      email,
      phone: null,
      otp: hashOtp(otp),
      expires_at: expiresAt,
      channel: 'email',
    });

  if (insertError) {
    return { error: 'Failed to create OTP', status: 500 };
  }

  try {
    await sendAccountVerificationEmail({
      to: email,
      otp,
      tenantName: tenantRow?.business_name ?? 'Yukti',
    });
  } catch {
    return { error: 'Failed to send email OTP', status: 500 };
  }

  return { success: true };
}
