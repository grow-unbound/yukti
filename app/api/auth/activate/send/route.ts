import { randomInt } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isValidIndianMobile, normalizeIndianPhone } from '@/lib/phone';
import { buyerOtpStore } from '@/lib/server/buyer-otp-store';
import { findPendingSellerActivationsByPhone } from '@/lib/server/seller-team-activation';
import { sendActivationOtpWhatsapp } from '@/lib/server/whatsapp';
import { requireSupplierWorkspaceSurface } from '@/lib/server/auth-surface-server';

const OTP_TTL_MS = 10 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const surfaceError = requireSupplierWorkspaceSurface(request);
    if (surfaceError) return surfaceError;

    const payload = await request.json() as { phoneNumber?: string };
    const rawPhone = (payload.phoneNumber ?? '').trim();

    if (!rawPhone || !isValidIndianMobile(rawPhone)) {
      return NextResponse.json({ error: 'Valid WhatsApp phone number is required' }, { status: 400 });
    }

    const phone = normalizeIndianPhone(rawPhone);
    let candidates;
    try {
      candidates = await findPendingSellerActivationsByPhone(phone);
    } catch (error) {
      console.error('[auth/activate/send] pending invite lookup failed:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to look up pending seller invite' },
        { status: 500 },
      );
    }

    if (candidates.length === 0) {
      return NextResponse.json({ error: 'No pending seller invite found for this number' }, { status: 404 });
    }

    if (candidates.length > 1) {
      return NextResponse.json(
        { error: 'Multiple pending invites found for this number. Contact support to continue.' },
        { status: 409 },
      );
    }

    const candidate = candidates[0];
    const otp = String(randomInt(100000, 999999));
    const ref_id = await buyerOtpStore.insert({
      kind: 'pending',
      otp,
      phone,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      candidates: [{
        kind: 'seller',
        tenant_id: candidate.tenant_id,
        tenant_name: candidate.tenant_name,
        tenant_slug: candidate.tenant_slug,
        tenant_whatsapp_number: null,
        tenant_whatsapp_display_name: null,
        tenant_logo_url: null,
        role: candidate.role,
        buyer_id: null,
        principal_type: 'seller',
        user_id: candidate.user_id,
        buyer_user_id: null,
        phone: candidate.phone,
        business_name: candidate.tenant_name,
        contact_name: candidate.full_name,
        email: candidate.email,
        full_name: candidate.full_name,
        membership_id: candidate.id,
      }],
    });

    if (!ref_id) {
      return NextResponse.json(
        { error: 'Failed to create activation OTP session' },
        { status: 500 },
      );
    }

    try {
      await sendActivationOtpWhatsapp(phone, otp);
    } catch (error) {
      console.error('[auth/activate/send] activation OTP send failed:', error);
      Sentry.captureException(error, { tags: { area: 'whatsapp_otp' } });
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to send activation OTP' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      ref_id,
      phone,
      full_name: candidate.full_name,
      email: candidate.email,
      tenant_name: candidate.tenant_name,
    });
  } catch (error) {
    console.error('[auth/activate/send] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
