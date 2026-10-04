'use client';

import { useState, FormEvent, useRef, KeyboardEvent, ClipboardEvent } from 'react';
import { Button } from '@/components/ui/button';

interface OtpFormProps {
  phone: string;
  onSubmit: (otp: string) => void | Promise<void>;
  loading?: boolean;
  error?: string;
}

const OTP_LENGTH = 6;

export function OtpForm({ phone, onSubmit, loading = false, error }: OtpFormProps) {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const otp = digits.join('');
  const isComplete = otp.length === OTP_LENGTH && digits.every((d) => d !== '');

  function handleChange(index: number, val: string) {
    const digit = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    const next = Array(OTP_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    const focusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
    inputRefs.current[focusIndex]?.focus();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isComplete) onSubmit(otp);
  }

  const digitInputCls =
    'w-10 h-12 text-center text-h4 font-display rounded-md border border-cream-300 bg-[var(--bg-surface)] text-cream-900 focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-400/20 transition-colors disabled:opacity-50 caret-transparent';
  const phoneDisplay = phone.trim().startsWith('+') ? phone.trim() : `+91 ${phone}`;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-caption text-cream-600">
        OTP sent to <span className="font-semibold text-cream-800">{phoneDisplay}</span>
      </p>

      <div className="flex items-center justify-between gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]"
            maxLength={1}
            value={d}
            disabled={loading}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            className={digitInputCls}
          />
        ))}
      </div>

      {error && (
        <p className="text-caption text-danger-500 bg-danger-50 px-3 py-2 rounded-md">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={loading || !isComplete} haptic>
        {loading ? 'Verifying…' : 'Verify OTP'}
      </Button>
    </form>
  );
}
