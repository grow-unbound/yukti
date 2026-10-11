import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getBuyerAppContextMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getBuyerAppContext: (...args: unknown[]) => getBuyerAppContextMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn((schemaName: string) => {
      if (schemaName !== 'app') {
        throw new Error(`Unexpected schema: ${schemaName}`);
      }

      return {
        from: vi.fn((tableName: string) => {
          if (tableName === 'buyers') {
            const buyerRow = {
              id: 'buyer-1',
              tenant_id: 'tenant-1',
              business_name: 'Rajan Wine Merchants',
              contact_name: 'Rajan Mehta',
              credit_limit: 250000,
              phone: '9876543210',
              gstin: '07AABCR1234M1Z5',
              buyer_app_enabled: true,
            };
            const buyerChain: Record<string, unknown> = {};
            const terminal = {
              maybeSingle: vi.fn(async () => ({ data: buyerRow, error: null })),
            };
            buyerChain.eq = vi.fn(() => buyerChain);
            buyerChain.is = vi.fn(() => buyerChain);
            buyerChain.or = vi.fn(() => terminal);
            Object.assign(buyerChain, terminal);

            return {
              select: vi.fn(() => buyerChain),
            };
          }

          if (tableName === 'tenants') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: 'tenant-1',
                      business_name: 'Tenant One',
                      slug: 'tenant-one',
                      settings: { buyer_app: { enabled: true } },
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }

          if (tableName === 'tenant_settings') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      tenant_id: 'tenant-1',
                      settings: { buyer_app: { enabled: true } },
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }

          throw new Error(`Unexpected table: ${tableName}`);
        }),
      };
    }),
  },
}));

describe('requireBuyerAccessProfile', () => {
  beforeEach(() => {
    getBuyerAppContextMock.mockReset();
  });

  it('uses buyer contact details for the greeting name', async () => {
    getBuyerAppContextMock.mockResolvedValue({
      sub: 'seller-user-1',
      tenant_id: 'tenant-1',
      role: 'buyer_admin',
      buyer_id: 'buyer-1',
      location_ids: null,
      mode: 'buyer',
      share_token: null,
      preview: null,
    });

    const { requireBuyerAccessProfile } = await import('@/lib/server/buyer-access');
    const profile = await requireBuyerAccessProfile(new NextRequest('http://localhost/buy/home'));

    expect(profile?.greeting_name).toBe('Rajan');
    expect(profile?.buyer?.business_name).toBe('Rajan Wine Merchants');
  });

  it('loads disabled buyers in seller preview mode', async () => {
    getBuyerAppContextMock.mockResolvedValue({
      sub: 'seller-user-1',
      tenant_id: 'tenant-1',
      role: 'buyer_admin',
      buyer_id: 'buyer-disabled',
      location_ids: null,
      mode: 'preview',
      share_token: null,
      preview: {
        typ: 'buyer_preview_v1',
        tenant_id: 'tenant-1',
        role: 'buyer_admin',
        share_token: null,
        buyer_id: 'buyer-disabled',
        iat: 1,
        exp: 9999999999,
      },
    });

    const buyersMaybeSingle = vi.fn(async () => ({
      data: {
        id: 'buyer-disabled',
        tenant_id: 'tenant-1',
        business_name: 'Disabled Buyer',
        contact_name: 'Disabled Buyer',
        credit_limit: 0,
        phone: '9876543210',
        gstin: null,
        buyer_app_enabled: false,
      },
      error: null,
    }));
    const buyerChain: Record<string, unknown> = {};
    buyerChain.eq = vi.fn(() => buyerChain);
    buyerChain.is = vi.fn(() => buyerChain);
    buyerChain.or = vi.fn(() => ({ maybeSingle: buyersMaybeSingle }));
    Object.assign(buyerChain, { maybeSingle: buyersMaybeSingle });

    const { supabaseAdmin } = await import('@/lib/supabase');
    vi.mocked(supabaseAdmin!.schema).mockImplementation((schemaName: string) => {
      if (schemaName !== 'app') throw new Error(`Unexpected schema: ${schemaName}`);
      return {
        from: vi.fn((tableName: string) => {
          if (tableName === 'buyers') {
            return {
              select: vi.fn(() => buyerChain),
            };
          }
          if (tableName === 'tenants') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: 'tenant-1',
                      business_name: 'Tenant One',
                      slug: 'tenant-one',
                      settings: { buyer_app: { enabled: true } },
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }
          if (tableName === 'tenant_settings') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      tenant_id: 'tenant-1',
                      settings: { buyer_app: { enabled: true } },
                    },
                    error: null,
                  })),
                })),
              })),
            };
          }
          throw new Error(`Unexpected table: ${tableName}`);
        }),
      } as never;
    });

    const { requireBuyerAccessProfile } = await import('@/lib/server/buyer-access');
    const profile = await requireBuyerAccessProfile(new NextRequest('http://localhost/buy/home'));

    expect(profile?.buyer?.id).toBe('buyer-disabled');
    expect(profile?.buyer?.buyer_app_enabled).toBe(false);
    expect(buyersMaybeSingle).toHaveBeenCalled();
  });
});

describe('getVisibleBuyerCatalogs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps catalogs visible through the current IST calendar day', async () => {
    vi.setSystemTime(new Date('2026-07-09T18:00:00+05:30'));

    const { supabaseAdmin } = await import('@/lib/supabase');
    vi.mocked(supabaseAdmin!.schema).mockImplementation((schemaName: string) => {
      if (schemaName !== 'app') throw new Error(`Unexpected schema: ${schemaName}`);
      return {
        from: vi.fn((tableName: string) => {
          if (tableName === 'campaigns') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    is: vi.fn(() => ({
                      order: vi.fn(async () => ({
                        data: [
                          {
                            id: 'promo-live',
                            tenant_id: 'tenant-1',
                            name: 'Still live today',
                            share_token: 'tok-live',
                            valid_to: '2026-07-09T00:00:00.000Z',
                            message: null,
                            created_at: '2026-07-01T00:00:00.000Z',
                            scope_type: 'all',
                            scope_value: null,
                            hero_image_url: null,
                          },
                          {
                            id: 'promo-ended',
                            tenant_id: 'tenant-1',
                            name: 'Already ended',
                            share_token: 'tok-ended',
                            valid_to: '2026-07-08T00:00:00.000Z',
                            message: null,
                            created_at: '2026-06-30T00:00:00.000Z',
                            scope_type: 'all',
                            scope_value: null,
                            hero_image_url: null,
                          },
                        ],
                        error: null,
                      })),
                    })),
                  })),
                })),
              })),
            };
          }

          if (tableName === 'buyers') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: { id: 'buyer-1', default_cohort_id: null, geography: null },
                      error: null,
                    })),
                  })),
                })),
              })),
            };
          }

          if (tableName === 'cohort_members_active') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(async () => ({
                  data: [],
                  error: null,
                })),
              })),
            };
          }

          throw new Error(`Unexpected table: ${tableName}`);
        }),
      } as never;
    });

    const { getVisibleBuyerCatalogs } = await import('@/lib/server/buyer-access');
    const catalogs = await getVisibleBuyerCatalogs('tenant-1', 'buyer-1');

    expect(catalogs.map((catalog) => catalog.id)).toEqual(['promo-live']);
  });
});
