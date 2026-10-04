export const SUPPORTED_WHATSAPP_COUNTRIES = [
  { iso: 'IN', flag: '🇮🇳', name: 'India', dialCode: '91', nationalLength: 10, placeholder: '9876543210' },
  { iso: 'US', flag: '🇺🇸', name: 'United States', dialCode: '1', nationalLength: 10, placeholder: '4155550123' },
  { iso: 'CA', flag: '🇨🇦', name: 'Canada', dialCode: '1', nationalLength: 10, placeholder: '4165550123' },
  { iso: 'BR', flag: '🇧🇷', name: 'Brazil', dialCode: '55', nationalLength: 11, placeholder: '11987654321' },
  { iso: 'AE', flag: '🇦🇪', name: 'United Arab Emirates', dialCode: '971', nationalLength: 9, placeholder: '501234567' },
  { iso: 'SA', flag: '🇸🇦', name: 'Saudi Arabia', dialCode: '966', nationalLength: 9, placeholder: '512345678' },
  { iso: 'QA', flag: '🇶🇦', name: 'Qatar', dialCode: '974', nationalLength: 8, placeholder: '33123456' },
  { iso: 'KW', flag: '🇰🇼', name: 'Kuwait', dialCode: '965', nationalLength: 8, placeholder: '51234567' },
  { iso: 'BH', flag: '🇧🇭', name: 'Bahrain', dialCode: '973', nationalLength: 8, placeholder: '36001234' },
  { iso: 'OM', flag: '🇴🇲', name: 'Oman', dialCode: '968', nationalLength: 8, placeholder: '91234567' },
  { iso: 'AT', flag: '🇦🇹', name: 'Austria', dialCode: '43', nationalLength: 10, placeholder: '6601234567' },
  { iso: 'BE', flag: '🇧🇪', name: 'Belgium', dialCode: '32', nationalLength: 9, placeholder: '470123456' },
  { iso: 'BG', flag: '🇧🇬', name: 'Bulgaria', dialCode: '359', nationalLength: 9, placeholder: '881234567' },
  { iso: 'HR', flag: '🇭🇷', name: 'Croatia', dialCode: '385', nationalLength: 9, placeholder: '911234567' },
  { iso: 'CY', flag: '🇨🇾', name: 'Cyprus', dialCode: '357', nationalLength: 8, placeholder: '96123456' },
  { iso: 'CZ', flag: '🇨🇿', name: 'Czechia', dialCode: '420', nationalLength: 9, placeholder: '601123456' },
  { iso: 'DK', flag: '🇩🇰', name: 'Denmark', dialCode: '45', nationalLength: 8, placeholder: '20123456' },
  { iso: 'EE', flag: '🇪🇪', name: 'Estonia', dialCode: '372', nationalLength: 8, placeholder: '51234567' },
  { iso: 'FI', flag: '🇫🇮', name: 'Finland', dialCode: '358', nationalLength: 10, placeholder: '401234567' },
  { iso: 'FR', flag: '🇫🇷', name: 'France', dialCode: '33', nationalLength: 9, placeholder: '612345678' },
  { iso: 'DE', flag: '🇩🇪', name: 'Germany', dialCode: '49', nationalLength: 11, placeholder: '15123456789' },
  { iso: 'GR', flag: '🇬🇷', name: 'Greece', dialCode: '30', nationalLength: 10, placeholder: '6912345678' },
  { iso: 'HU', flag: '🇭🇺', name: 'Hungary', dialCode: '36', nationalLength: 9, placeholder: '201234567' },
  { iso: 'IE', flag: '🇮🇪', name: 'Ireland', dialCode: '353', nationalLength: 9, placeholder: '851234567' },
  { iso: 'IT', flag: '🇮🇹', name: 'Italy', dialCode: '39', nationalLength: 10, placeholder: '3123456789' },
  { iso: 'LV', flag: '🇱🇻', name: 'Latvia', dialCode: '371', nationalLength: 8, placeholder: '21234567' },
  { iso: 'LT', flag: '🇱🇹', name: 'Lithuania', dialCode: '370', nationalLength: 8, placeholder: '61234567' },
  { iso: 'LU', flag: '🇱🇺', name: 'Luxembourg', dialCode: '352', nationalLength: 9, placeholder: '621123456' },
  { iso: 'MT', flag: '🇲🇹', name: 'Malta', dialCode: '356', nationalLength: 8, placeholder: '99123456' },
  { iso: 'NL', flag: '🇳🇱', name: 'Netherlands', dialCode: '31', nationalLength: 9, placeholder: '612345678' },
  { iso: 'PL', flag: '🇵🇱', name: 'Poland', dialCode: '48', nationalLength: 9, placeholder: '512345678' },
  { iso: 'PT', flag: '🇵🇹', name: 'Portugal', dialCode: '351', nationalLength: 9, placeholder: '912345678' },
  { iso: 'RO', flag: '🇷🇴', name: 'Romania', dialCode: '40', nationalLength: 9, placeholder: '712345678' },
  { iso: 'SK', flag: '🇸🇰', name: 'Slovakia', dialCode: '421', nationalLength: 9, placeholder: '901234567' },
  { iso: 'SI', flag: '🇸🇮', name: 'Slovenia', dialCode: '386', nationalLength: 8, placeholder: '31123456' },
  { iso: 'ES', flag: '🇪🇸', name: 'Spain', dialCode: '34', nationalLength: 9, placeholder: '612345678' },
  { iso: 'SE', flag: '🇸🇪', name: 'Sweden', dialCode: '46', nationalLength: 9, placeholder: '701234567' },
] as const;

export function normalizeIndianPhone(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.startsWith('91') && digits.length > 10) {
    return digits.slice(-10);
  }

  if (digits.startsWith('0') && digits.length > 10) {
    return digits.slice(-10);
  }

  return digits;
}

export function normalizeSupportedWhatsappPhone(input: string): {
  iso: string;
  e164Digits: string;
  lookupPhone: string;
} | null {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (!raw.startsWith('+')) {
    const indian = normalizeIndianPhone(raw);
    return isValidIndianMobile(indian)
      ? { iso: 'IN', e164Digits: `91${indian}`, lookupPhone: indian }
      : null;
  }

  for (const country of [...SUPPORTED_WHATSAPP_COUNTRIES].sort((a, b) => b.dialCode.length - a.dialCode.length)) {
    if (!digits.startsWith(country.dialCode)) continue;
    const national = digits.slice(country.dialCode.length);
    if (national.length !== country.nationalLength) continue;
    if (country.iso === 'IN' && !/^[6-9][0-9]{9}$/.test(national)) return null;
    return {
      iso: country.iso,
      e164Digits: digits,
      lookupPhone: country.iso === 'IN' ? national : digits,
    };
  }

  return null;
}

export function normalizeSupportedWhatsappLookupPhone(input: string): string | null {
  return normalizeSupportedWhatsappPhone(input)?.lookupPhone ?? null;
}

export function isValidSupportedWhatsappPhone(phone: string): boolean {
  return normalizeSupportedWhatsappPhone(phone) !== null;
}

export function formatWhatsappDestination(phone: string): string {
  return normalizeSupportedWhatsappPhone(phone)?.e164Digits ?? '';
}

export function isValidIndianMobile(phone: string): boolean {
  return /^[6-9][0-9]{9}$/.test(normalizeIndianPhone(phone));
}

export function firstNameFromValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const [first] = trimmed.split(/\s+/);
  return first || null;
}
