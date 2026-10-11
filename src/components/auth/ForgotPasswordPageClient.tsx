'use client';

import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AuthHomeLogoLink } from '@/components/auth/AuthHomeLogoLink';
import { PhoneInput } from '@/components/buyer/auth/PhoneInput';
import { OtpForm } from '@/components/buyer/auth/OtpForm';
import { supabaseBrowser } from '@/lib/supabase-browser';

interface ResetSendResponse {
  success?: boolean;
  ref_id?: string;
  phone?: string;
  full_name?: string | null;
  email?: string | null;
  error?: string;
}

interface ResetVerifyResponse {
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

interface EmailResetResponse {
  success?: boolean;
  error?: string;
}

type ResetMode = 'whatsapp' | 'email';

function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const existingRefId = searchParams.get('ref_id') ?? '';
  const existingPhone = searchParams.get('phone') ?? '';

  const [mode, setMode] = useState<ResetMode>('whatsapp');
  const [email, setEmail] = useState('');
  const [sendingOtp, setSendingOtp] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [error, setError] = useState('');
  const [emailSent, setEmailSent] = useState(false);

  const step = useMemo(() => (existingRefId ? 'otp' : 'phone'), [existingRefId]);
  const activeMode: ResetMode = step === 'otp' ? 'whatsapp' : mode;

  async function handleSendOtp(phone: string) {
    setSendingOtp(true);
    setError('');
    let shouldResetLoading = true;
    try {
      const response = await fetch('/api/auth/reset/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });

      const data = await response.json() as ResetSendResponse;
      if (!response.ok || !data.success || !data.ref_id) {
        setError(data.error ?? 'Could not send password reset OTP. Please try again.');
        return;
      }

      shouldResetLoading = false;
      router.replace(`/forgot-password?ref_id=${encodeURIComponent(data.ref_id)}&phone=${encodeURIComponent(data.phone ?? phone)}`);
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
      const response = await fetch('/api/auth/reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_id: existingRefId, otp }),
      });

      const data = await response.json() as ResetVerifyResponse;
      if (!response.ok || !data.success || !data.session) {
        setError(data.error ?? 'Could not verify OTP. Please try again.');
        return;
      }

      await supabaseBrowser.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      const params = new URLSearchParams();
      if (data.context?.full_name) params.set('full_name', data.context.full_name);
      if (data.context?.email) params.set('email', data.context.email);

      shouldResetLoading = false;
      router.replace(`${data.redirect ?? '/reset-password'}${params.toString() ? `?${params.toString()}` : ''}`);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      if (shouldResetLoading) setVerifyingOtp(false);
    }
  }

  async function handleSendEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSendingEmail(true);
    setEmailSent(false);
    setError('');
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json() as EmailResetResponse;
      if (!response.ok || !data.success) {
        setError(data.error ?? 'Could not send reset email. Please try again.');
        return;
      }

      setEmailSent(true);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSendingEmail(false);
    }
  }

  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-5 sm:p-8">
      <div className="mb-7 flex justify-center">
        <AuthHomeLogoLink />
      </div>

      <h1 className="text-h3 font-display text-cream-900 mb-1">Reset Supplier workspace password</h1>
      <p className="text-body-sm text-cream-600 mb-6">
        {activeMode === 'email'
          ? 'Enter the email linked to your Supplier workspace. We will send a secure reset link.'
          : step === 'phone'
          ? 'Enter the WhatsApp number linked to your Supplier workspace.'
          : 'Enter the 6-digit OTP we sent to your WhatsApp.'}
      </p>

      {step === 'phone' ? (
        <div className="mb-6 grid grid-cols-2 rounded-lg border border-cream-200 bg-cream-100 p-1">
          <button
            type="button"
            onClick={() => {
              setMode('whatsapp');
              setError('');
              setEmailSent(false);
            }}
            className={[
              'min-h-10 rounded-md px-3 text-body-sm font-semibold transition-colors',
              activeMode === 'whatsapp' ? 'bg-white text-cream-950 shadow-sm' : 'text-cream-600 hover:text-cream-900',
            ].join(' ')}
          >
            WhatsApp OTP
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('email');
              setError('');
              setEmailSent(false);
            }}
            className={[
              'min-h-10 rounded-md px-3 text-body-sm font-semibold transition-colors',
              activeMode === 'email' ? 'bg-white text-cream-950 shadow-sm' : 'text-cream-600 hover:text-cream-900',
            ].join(' ')}
          >
            Email link
          </button>
        </div>
      ) : null}

      {activeMode === 'whatsapp' && step === 'phone' ? (
        <PhoneInput
          onSubmit={handleSendOtp}
          loading={sendingOtp}
          error={error}
        />
      ) : activeMode === 'whatsapp' ? (
        <OtpForm
          phone={existingPhone}
          onSubmit={handleVerifyOtp}
          loading={verifyingOtp}
          error={error}
        />
      ) : (
        <form onSubmit={handleSendEmail} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-cream-700">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError('');
                setEmailSent(false);
              }}
              disabled={sendingEmail}
              required
              autoComplete="email"
              placeholder="you@company.com"
              className="w-full rounded-md border border-cream-300 bg-cream-50 px-3 py-2.5 text-body-sm text-cream-900 placeholder:text-cream-500 transition-colors focus:border-ember-400 focus:outline-none focus:ring-2 focus:ring-ember-400/20 disabled:opacity-50"
            />
          </div>

          {error ? (
            <p className="rounded-md bg-danger-50 px-3 py-2 text-caption text-danger-500">
              {error}
            </p>
          ) : null}

          {emailSent ? (
            <p className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-body-sm font-medium text-teal-800">
              If this email belongs to a Supplier workspace, a reset link has been sent.
            </p>
          ) : null}

          <button
            type="submit"
            disabled={sendingEmail}
            className="w-full rounded-md bg-teal-500 px-4 py-2.5 text-body-sm font-semibold text-cream-50 transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sendingEmail ? 'Sending link…' : 'Send reset link'}
          </button>
        </form>
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
            onClick={() => router.replace('/forgot-password')}
            className="text-caption text-cream-600 hover:text-cream-800 transition-colors"
          >
            Change number
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ForgotPasswordFallback() {
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

export function ForgotPasswordPageClient() {
  return (
    <Suspense fallback={<ForgotPasswordFallback />}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
