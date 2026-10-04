import { randomInt } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isValidIndianMobile, normalizeIndianPhone } from '@/lib/phone';
import { buyerOtpStore } from '@/lib/server/buyer-otp-store';
import { findSellerPasswordResetCandidatesByPhone } from '@/lib/server/seller-team-activation';
import { sendResetOtpWhatsapp } from '@/lib/server/whatsapp';
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
      candidates = await findSellerPasswordResetCandidatesByPhone(phone);
    } catch (error) {
      console.error('[auth/reset/send] password reset lookup failed:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to look up seller account' },
        { status: 500 },
      );
    }

    if (candidates.length === 0) {
      return NextResponse.json({ error: 'No seller account found for this number' }, { status: 404 });
    }

    if (candidates.length > 1) {
      return NextResponse.json(
        { error: 'Multiple seller accounts found for this number. Contact support to continue.' },
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
      return NextResponse.json({ error: 'Failed to create password reset session' }, { status: 500 });
    }

    try {
      await sendResetOtpWhatsapp(phone, otp);
    } catch (error) {
      console.error('[auth/reset/send] reset OTP send failed:', error);
      Sentry.captureException(error, { tags: { area: 'whatsapp_otp' } });
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to send reset OTP' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      ref_id,
      phone,
      full_name: candidate.full_name,
      email: candidate.email,
    });
  } catch (error) {
    console.error('[auth/reset/send] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
