import { describe, expect, it } from 'vitest';
import { campaignOverridePrice } from '@/lib/server/buyer-campaign-pricing';

describe('campaignOverridePrice', () => {
  it('returns finite positive prices, accepting numeric strings from Postgres numeric', () => {
    expect(campaignOverridePrice(650)).toBe(650);
    expect(campaignOverridePrice('650')).toBe(650);
    expect(campaignOverridePrice('1240.50')).toBe(1240.5);
  });

  it('treats missing, zero, negative and non-numeric overrides as "no campaign price"', () => {
    expect(campaignOverridePrice(null)).toBeNull();
    expect(campaignOverridePrice(undefined)).toBeNull();
    expect(campaignOverridePrice('')).toBeNull();
    expect(campaignOverridePrice(0)).toBeNull();
    expect(campaignOverridePrice('0')).toBeNull();
    expect(campaignOverridePrice(-5)).toBeNull();
    expect(campaignOverridePrice('abc')).toBeNull();
    expect(campaignOverridePrice(Number.NaN)).toBeNull();
  });
});
