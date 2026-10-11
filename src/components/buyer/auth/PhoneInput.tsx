'use client';

import { useEffect, useState, FormEvent } from 'react';
import { SUPPORTED_WHATSAPP_COUNTRIES } from '@/lib/phone';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';

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

const COUNTRY_STORAGE_KEY = 'yukti.auth.phoneCountryIso';
const COUNTRY_COOKIE_KEY = 'yukti_auth_phone_country_iso';
type SupportedCountryIso = (typeof SUPPORTED_WHATSAPP_COUNTRIES)[number]['iso'];
const SUPPORTED_COUNTRY_ISOS = new Set<string>(SUPPORTED_WHATSAPP_COUNTRIES.map((country) => country.iso));

function readSavedCountryIso(): SupportedCountryIso {
  if (typeof window === 'undefined') return 'IN';
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(COUNTRY_STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (SUPPORTED_COUNTRY_ISOS.has(saved ?? '')) return saved as SupportedCountryIso;
  const cookieValue = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${COUNTRY_COOKIE_KEY}=`))
    ?.split('=')[1];
  return SUPPORTED_COUNTRY_ISOS.has(cookieValue ?? '') ? (cookieValue as SupportedCountryIso) : 'IN';
}

function saveCountryIso(countryIso: SupportedCountryIso) {
  try {
    window.localStorage.setItem(COUNTRY_STORAGE_KEY, countryIso);
  } catch {
    // localStorage may be unavailable in private browsing or locked-down webviews.
  }
  document.cookie = `${COUNTRY_COOKIE_KEY}=${countryIso}; max-age=31536000; path=/; samesite=lax`;
}

export function PhoneInput({
  onSubmit,
  loading = false,
  error,
  submitLabel = 'Send OTP',
  loadingLabel = 'Sending OTP…',
}: PhoneInputProps) {
  const [value, setValue] = useState('');
  const [countryIso, setCountryIso] = useState<SupportedCountryIso>('IN');
  const selectedCountry = SUPPORTED_WHATSAPP_COUNTRIES.find((country) => country.iso === countryIso) ?? SUPPORTED_WHATSAPP_COUNTRIES[0];

  useEffect(() => {
    setCountryIso(readSavedCountryIso());
  }, []);

  function handleCountryChange(nextIso: string) {
    const nextCountryIso: SupportedCountryIso = SUPPORTED_COUNTRY_ISOS.has(nextIso) ? (nextIso as SupportedCountryIso) : 'IN';
    setCountryIso(nextCountryIso);
    setValue('');
    saveCountryIso(nextCountryIso);
  }

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
        <div className="grid grid-cols-[var(--auth-country-select-w),minmax(0,1fr)] items-stretch rounded-md border border-cream-300 bg-[var(--bg-surface)] transition-colors focus-within:border-ember-400 focus-within:ring-2 focus-within:ring-ember-400/20">
          <Select
            value={countryIso}
            onValueChange={handleCountryChange}
            disabled={loading}
          >
            <SelectTrigger
              id="phone-country"
              aria-label={`Country code, ${selectedCountry.name}`}
              className="h-full min-h-[var(--ctl-h-input)] rounded-l-md rounded-r-none border-0 border-r border-cream-300 bg-cream-100 px-2 text-body-sm font-medium shadow-none focus:border-cream-300 focus:ring-0"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden="true">{selectedCountry.flag}</span>
                <span>+{selectedCountry.dialCode}</span>
              </span>
            </SelectTrigger>
            <SelectContent
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className="max-h-[var(--auth-country-menu-max-h)] w-[var(--auth-country-menu-w)] max-w-[calc(100vw-var(--auth-country-menu-gutter))]"
            >
              {SUPPORTED_WHATSAPP_COUNTRIES.map((country) => (
                <SelectItem key={country.iso} value={country.iso} className="py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true">{country.flag}</span>
                    <span className="font-medium">+{country.dialCode}</span>
                    <span className="truncate text-cream-600">{country.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            className={`${inputCls} min-w-0 rounded-l-none border-0 bg-transparent focus:border-transparent focus:ring-0`}
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
