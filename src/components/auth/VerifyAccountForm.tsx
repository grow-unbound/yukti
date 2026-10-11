'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { OtpForm } from '@/components/buyer/auth/OtpForm';

interface VerifyAccountFormProps {
  email: string;
  phone: string | null;
  userId: string;
  tenantId: string | null;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.length > 2 ? local.slice(0, 2) : local[0];
  return `${visible}***@${domain}`;
}

function formatPhoneDisplay(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return trimmed;
  // Existing tenant data stores Indian phones as 10 raw digits.
  return `+91 ${trimmed.slice(0, 5)} ${trimmed.slice(5)}`;
}

export function VerifyAccountForm({ email, phone, userId, tenantId }: VerifyAccountFormProps) {
  const router = useRouter();
  const [channel, setChannel] = useState<'email' | 'whatsapp'>(phone ? 'whatsapp' : 'email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendingEmail, setResendingEmail] = useState(false);
  const [resendingWhatsapp, setResendingWhatsapp] = useState(false);
  // signup already sent the WhatsApp OTP if phone is present
  const [whatsappSent, setWhatsappSent] = useState(!!phone);
  const [resendMessage, setResendMessage] = useState('');

  async function handleSubmit(otp: string) {
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/verify-account/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token: otp, channel, user_id: userId }),
      });

      const data = (await res.json()) as { success?: boolean; error?: string; remaining_attempts?: number };

      if (!res.ok || !data.success) {
        const msg = data.remaining_attempts !== undefined
          ? `${data.error ?? 'Incorrect OTP'} (${data.remaining_attempts} attempts left)`
          : (data.error ?? 'Verification failed. Please try again.');
        setError(msg);
        return;
      }

      // Success — go to login with verified flag
      const params = new URLSearchParams({ verified: '1', email });
      router.replace(`/login?${params.toString()}`);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendEmail() {
    setResendingEmail(true);
    setResendMessage('');
    setError('');
    try {
      const res = await fetch('/api/auth/verify-account/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, tenant_id: tenantId, email, channel: 'email' }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Failed to send');
      setChannel('email');
      setResendMessage('A new code has been sent to your email.');
    } catch {
      setError('Failed to resend email. Please try again.');
    } finally {
      setResendingEmail(false);
    }
  }

  async function handleSendWhatsapp() {
    if (!phone || !tenantId) {
      setError('Phone number not available. Please resend to email instead.');
      return;
    }
    setResendingWhatsapp(true);
    setResendMessage('');
    setError('');
    try {
      const res = await fetch('/api/auth/verify-account/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, tenant_id: tenantId, email, phone }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Failed to send');
      setChannel('whatsapp');
      setWhatsappSent(true);
      setResendMessage('OTP sent to your WhatsApp number.');
    } catch {
      setError('Failed to send WhatsApp OTP. Please try again.');
    } finally {
      setResendingWhatsapp(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="text-center space-y-1">
        <p className="text-body-sm text-cream-700">
          {channel === 'email'
            ? <>We sent a 6-digit code to <span className="font-semibold text-cream-900">{maskEmail(email)}</span></>
            : <>We sent a 6-digit code to your WhatsApp{phone && <> — <span className="font-semibold text-cream-900">{formatPhoneDisplay(phone)}</span></>}</>
          }
        </p>
        {channel === 'email'
          ? <p className="text-caption text-cream-500">Check your inbox (and spam folder).</p>
          : <p className="text-caption text-cream-500">Check your WhatsApp messages.</p>
        }
      </div>

      {resendMessage && (
        <p className="text-caption text-teal-600 bg-teal-50 border border-teal-200 px-3 py-2 rounded-md">
          {resendMessage}
        </p>
      )}

      <OtpForm
        phone=""
        onSubmit={handleSubmit}
        loading={loading}
        error={error}
      />

      <div className="pt-2 border-t border-cream-200 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {phone && (
            <button
              type="button"
              onClick={handleSendWhatsapp}
              disabled={resendingWhatsapp}
              className="text-caption text-teal-500 hover:text-teal-600 font-medium transition-colors disabled:opacity-50"
            >
              {resendingWhatsapp ? 'Sending…' : whatsappSent ? 'Resend to WhatsApp' : 'Send to WhatsApp'}
            </button>
          )}
          <button
            type="button"
            onClick={handleResendEmail}
            disabled={resendingEmail}
            className="text-caption text-ember-400 hover:text-ember-500 font-medium transition-colors disabled:opacity-50"
          >
            {resendingEmail ? 'Sending…' : 'Resend to email'}
          </button>
        </div>
        {channel === 'whatsapp' && (
          <button
            type="button"
            onClick={() => { setChannel('email'); setResendMessage(''); }}
            className="text-caption text-cream-500 hover:text-cream-700 transition-colors"
          >
            Switch to email instead
          </button>
        )}
      </div>
    </div>
  );
}
