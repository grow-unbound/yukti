'use client';

import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AuthHomeLogoLink } from '@/components/auth/AuthHomeLogoLink';
import { PhoneInput } from '@/components/buyer/auth/PhoneInput';
import { OtpForm } from '@/components/buyer/auth/OtpForm';
import { supabaseBrowser } from '@/lib/supabase-browser';

interface ActivateSendResponse {
  success?: boolean;
  ref_id?: string;
  phone?: string;
  full_name?: string | null;
  email?: string | null;
  tenant_name?: string | null;
  error?: string;
}

interface ActivateVerifyResponse {
  success?: boolean;
  redirect?: string;
  session?: {
    access_token: string;
    refresh_token: string;
  };
  context?: {
    full_name?: string | null;
    email?: string | null;
  };
  error?: string;
}

function ActivateForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const existingRefId = searchParams.get('ref_id') ?? '';
  const existingPhone = searchParams.get('phone') ?? '';

  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [error, setError] = useState('');

  const step = useMemo(() => (existingRefId ? 'otp' : 'phone'), [existingRefId]);

  async function handleSendOtp(phone: string) {
    setSendingOtp(true);
    setError('');
    let shouldResetLoading = true;
    try {
      const response = await fetch('/api/auth/activate/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });

      const data = await response.json() as ActivateSendResponse;
      if (!response.ok || !data.success || !data.ref_id) {
        setError(data.error ?? 'Could not send activation OTP. Please try again.');
        return;
      }

      shouldResetLoading = false;
      router.replace(`/activate?ref_id=${encodeURIComponent(data.ref_id)}&phone=${encodeURIComponent(data.phone ?? phone)}`);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      if (shouldResetLoading) setSendingOtp(false);
    }
  }

  async function handleVerifyOtp(otp: string) {
    setVerifyingOtp(true);
    setError('');
    let shouldResetLoading = true;
    try {
      const response = await fetch('/api/auth/activate/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_id: existingRefId, otp }),
      });

      const data = await response.json() as ActivateVerifyResponse;
      if (!response.ok || !data.success || !data.session) {
        setError(data.error ?? 'Could not verify OTP. Please try again.');
        return;
      }

      await supabaseBrowser.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      const params = new URLSearchParams({ activate: '1' });
      if (data.context?.full_name) params.set('full_name', data.context.full_name);
      if (data.context?.email) params.set('email', data.context.email);

      shouldResetLoading = false;
      router.replace(`${data.redirect ?? '/setup-password'}?${params.toString()}`);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      if (shouldResetLoading) setVerifyingOtp(false);
    }
  }

  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-8">
      <div className="mb-7 flex justify-center">
        <AuthHomeLogoLink />
      </div>

      <h1 className="text-h3 font-display text-cream-900 mb-1">Activate your Supplier workspace account</h1>
      <p className="text-body-sm text-cream-600 mb-6">
        {step === 'phone'
          ? 'Enter the WhatsApp number linked to your workspace invite.'
          : 'Enter the 6-digit OTP we sent to your WhatsApp.'}
      </p>

      {step === 'phone' ? (
        <PhoneInput
          onSubmit={handleSendOtp}
          loading={sendingOtp}
          error={error}
        />
      ) : (
        <OtpForm
          phone={existingPhone}
          onSubmit={handleVerifyOtp}
          loading={verifyingOtp}
          error={error}
        />
      )}

      <div className="mt-6 pt-4 border-t border-cream-200 flex items-center justify-between">
        <Link
          href="/login"
          className="text-caption text-ember-400 hover:text-ember-500 font-medium transition-colors"
        >
          ← Back to Login
        </Link>
        {step === 'otp' ? (
          <button
            type="button"
            onClick={() => router.replace('/activate')}
            className="text-caption text-cream-600 hover:text-cream-800 transition-colors"
          >
            Change number
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ActivateFallback() {
  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-8">
      <div className="mb-7 flex justify-center">
        <div className="h-14 w-[76px] rounded-xl bg-cream-200 animate-pulse" />
      </div>
      <div className="space-y-3 mb-6">
        <div className="h-5 w-44 rounded bg-cream-200 animate-pulse" />
        <div className="h-4 w-64 rounded bg-cream-200 animate-pulse" />
      </div>
      <div className="mt-4 h-11 w-full rounded bg-cream-200 animate-pulse" />
      <div className="mt-4 h-11 w-full rounded bg-cream-200 animate-pulse" />
    </div>
  );
}

export function ActivatePageClient() {
  return (
    <Suspense fallback={<ActivateFallback />}>
      <ActivateForm />
    </Suspense>
  );
}
