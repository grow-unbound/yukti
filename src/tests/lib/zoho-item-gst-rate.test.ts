import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../supabase/functions/_shared/r2.ts', () => ({
  putObjectJson: vi.fn().mockResolvedValue(undefined),
}));

import { resolveZohoItemGstRate } from '../../../supabase/functions/_shared/integrations-persist';

const pref = (tax_specification: string, tax_percentage: number) => ({ tax_specification, tax_percentage });

describe('resolveZohoItemGstRate', () => {
  it('reads intra-state rate from item_tax_preferences when top-level tax_percentage is 0', () => {
    expect(
      resolveZohoItemGstRate({
        tax_percentage: 0,
        item_tax_preferences: [pref('inter', 18), pref('intra', 18)],
      }),
    ).toBe(18);
  });

  it('prefers intra over inter when they differ', () => {
    expect(
      resolveZohoItemGstRate({ item_tax_preferences: [pref('inter', 12), pref('intra', 5)] }),
    ).toBe(5);
  });

  it('falls back to inter when intra is missing', () => {
    expect(resolveZohoItemGstRate({ item_tax_preferences: [pref('inter', 28)] })).toBe(28);
  });

  it('keeps a genuine 0% preference', () => {
    expect(
      resolveZohoItemGstRate({ tax_percentage: 18, item_tax_preferences: [pref('intra', 0)] }),
    ).toBe(0);
  });

  it('ignores malformed preference entries', () => {
    expect(
      resolveZohoItemGstRate({
        tax_percentage: 12,
        item_tax_preferences: [null, 'x', pref('intra', 'abc' as never)],
      }),
    ).toBe(12);
  });

  it('falls back to top-level fields for non-GST payloads', () => {
    expect(resolveZohoItemGstRate({ tax_percentage: 12 })).toBe(12);
    expect(resolveZohoItemGstRate({ gst_rate: '5' })).toBe(5);
    expect(resolveZohoItemGstRate({ item_tax_preferences: [] })).toBeNull();
  });
});
