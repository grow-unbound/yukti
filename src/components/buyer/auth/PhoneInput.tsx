'use client';

import { useState, FormEvent } from 'react';
import { SUPPORTED_WHATSAPP_COUNTRIES } from '@/lib/phone';

interface PhoneInputProps {
  onSubmit: (phoneNumber: string) => void | Promise<void>;
  loading?: boolean;
  error?: string;
  submitLabel?: string;
  loadingLabel?: string;
}

const inputCls =
  'w-full px-3 py-2.5 rounded-md bg-[var(--bg-surface)] border border-cream-300 text-cream-900 placeholder:text-cream-500 text-body-sm focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-400/20 transition-colors disabled:opacity-50';

const labelCls =
  'block text-cream-700 font-semibold mb-1.5 text-xs uppercase tracking-[0.08em]';

export function PhoneInput({
  onSubmit,
  loading = false,
  error,
  submitLabel = 'Send OTP',
  loadingLabel = 'Sending OTP…',
}: PhoneInputProps) {
  const [value, setValue] = useState('');
  const [countryIso, setCountryIso] = useState<(typeof SUPPORTED_WHATSAPP_COUNTRIES)[number]['iso']>('IN');
  const selectedCountry = SUPPORTED_WHATSAPP_COUNTRIES.find((country) => country.iso === countryIso) ?? SUPPORTED_WHATSAPP_COUNTRIES[0];

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = value.trim().replace(/\s+/g, '');
    if (cleaned) onSubmit(`+${selectedCountry.dialCode}${cleaned}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="phone" className={labelCls}>
          Mobile number
        </label>
        <div className="grid grid-cols-[minmax(7.75rem,9rem),1fr] items-stretch">
          <label className="sr-only" htmlFor="phone-country">Country code</label>
          <select
            id="phone-country"
            value={countryIso}
            onChange={(event) => {
              setCountryIso(event.target.value as typeof countryIso);
              setValue('');
            }}
            disabled={loading}
            className="min-w-0 rounded-l-md border border-r-0 border-cream-300 bg-cream-100 px-2 text-body-sm text-cream-800 outline-none transition-colors focus:border-teal-400 focus:ring-2 focus:ring-teal-400/20 disabled:opacity-50"
          >
            {SUPPORTED_WHATSAPP_COUNTRIES.map((country) => (
              <option key={country.iso} value={country.iso}>
                {country.flag} +{country.dialCode} {country.name}
              </option>
            ))}
          </select>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            pattern={`[0-9]{${selectedCountry.nationalLength}}`}
            maxLength={selectedCountry.nationalLength}
            placeholder={selectedCountry.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
            disabled={loading}
            required
            autoComplete="tel-national"
            className={`${inputCls} rounded-l-none`}
          />
        </div>
      </div>

      {error && (
        <p className="text-caption text-danger-500 bg-danger-50 px-3 py-2 rounded-md">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading || value.length !== selectedCountry.nationalLength}
        className="w-full px-4 py-2.5 rounded-md bg-teal-500 hover:bg-teal-600 text-cream-50 text-body-sm font-semibold transition-colors duration-base disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? loadingLabel : submitLabel}
      </button>
    </form>
  );
}
