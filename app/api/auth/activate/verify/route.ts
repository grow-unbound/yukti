import { NextRequest, NextResponse } from 'next/server';
import { buyerOtpStore, hashOtp } from '@/lib/server/buyer-otp-store';
import { findPendingSellerActivationsByPhone, mintSellerActivationSession } from '@/lib/server/seller-team-activation';
import { requireSupplierWorkspaceSurface } from '@/lib/server/auth-surface-server';

const MAX_ATTEMPTS = 5;

export async function POST(request: NextRequest) {
  try {
    const surfaceError = requireSupplierWorkspaceSurface(request);
    if (surfaceError) return surfaceError;

    const body = await request.json() as { ref_id?: string; otp?: string };
    const ref_id = (body.ref_id ?? '').trim();
    const otp = (body.otp ?? '').trim();

    if (!ref_id || !otp) {
      return NextResponse.json({ error: 'ref_id and otp are required' }, { status: 400 });
    }

    const record = await buyerOtpStore.get(ref_id);
    if (!record || record.kind !== 'pending') {
      return NextResponse.json({ error: 'Invalid or expired activation session' }, { status: 400 });
    }

    if (Date.now() > record.expiresAt) {
      await buyerOtpStore.delete(ref_id);
      return NextResponse.json({ error: 'OTP has expired. Request a new one.' }, { status: 400 });
    }

    record.attempts += 1;
    if (record.attempts > MAX_ATTEMPTS) {
      await buyerOtpStore.delete(ref_id);
      return NextResponse.json({ error: 'Too many incorrect attempts. Request a new OTP.' }, { status: 429 });
    }

    if (record.otp !== hashOtp(otp) && record.otp !== otp) {
      await buyerOtpStore.set(ref_id, record);
      return NextResponse.json(
        { error: `Incorrect OTP. ${MAX_ATTEMPTS - record.attempts} attempt(s) remaining.` },
        { status: 400 },
      );
    }

    await buyerOtpStore.delete(ref_id);

    const pendingCandidates = await findPendingSellerActivationsByPhone(record.phone);
    if (pendingCandidates.length !== 1) {
      return NextResponse.json(
        { error: 'This invite is no longer available. Ask your admin to resend it.' },
        { status: 409 },
      );
    }

    const candidate = pendingCandidates[0];
    const { session } = await mintSellerActivationSession(candidate);

    return NextResponse.json({
      success: true,
      redirect: '/setup-password',
      session,
      context: {
        tenant_id: candidate.tenant_id,
        tenant_slug: candidate.tenant_slug,
        tenant_name: candidate.tenant_name,
        role: candidate.role,
        full_name: candidate.full_name,
        email: candidate.email,
      },
    });
  } catch (error) {
    console.error('[auth/activate/verify] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
