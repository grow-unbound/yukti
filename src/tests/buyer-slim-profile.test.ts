import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getBuyerAppContextMock = vi.fn();
const buyersReads: string[] = [];
let slimRow: Record<string, unknown> | null = null;

vi.mock('@/lib/auth', () => ({ getBuyerAppContext: (...a: unknown[]) => getBuyerAppContextMock(...a) }));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock('@/lib/supabase', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.is = () => c;
    c.or = () => c;
    c.maybeSingle = async () => {
      buyersReads.push(table);
      return { data: slimRow, error: null };
    };
    return c;
  };
  return { supabaseAdmin: { schema: () => ({ from: chain }) } };
});

const baseContext = { tenant_id: 't1', buyer_id: 'b1', role: 'buyer_admin', mode: 'buyer' };

describe('requireBuyerAccessProfile({ slim: true })', () => {
  beforeEach(() => {
    buyersReads.length = 0;
    slimRow = {
      id: 'b1', tenant_id: 't1', business_name: 'Acme', contact_name: 'Asha Rao', phone: '+91999',
      credit_limit: 10, buyer_app_enabled: true, geography: null,
    };
    getBuyerAppContextMock.mockReset().mockResolvedValue({ ...baseContext });
  });

  it('returns the slim row without reading tenants or tenant_settings', async () => {
    const { requireBuyerAccessProfile } = await import('@/lib/server/buyer-access');
    const profile = await requireBuyerAccessProfile({} as NextRequest, { slim: true });
    expect(profile?.buyer?.id).toBe('b1');
    expect(profile?.tenant).toBeNull();
    expect(profile?.greeting_name).toBe('Asha');
    expect(buyersReads).toEqual(['buyers']);
  });

  it('denies a buyer whose app access is disabled', async () => {
    slimRow = { ...slimRow, buyer_app_enabled: false };
    const { requireBuyerAccessProfile } = await import('@/lib/server/buyer-access');
    expect(await requireBuyerAccessProfile({} as NextRequest, { slim: true })).toBeNull();
  });

  it('still serves a disabled buyer to seller preview and a pending session', async () => {
    slimRow = { ...slimRow, buyer_app_enabled: false };
    const { requireBuyerAccessProfile } = await import('@/lib/server/buyer-access');
    getBuyerAppContextMock.mockResolvedValue({ ...baseContext, mode: 'preview' });
    expect((await requireBuyerAccessProfile({} as NextRequest, { slim: true }))?.buyer?.id).toBe('b1');
    getBuyerAppContextMock.mockResolvedValue({ ...baseContext, role: 'buyer_pending' });
    expect((await requireBuyerAccessProfile({} as NextRequest, { slim: true }))?.buyer?.id).toBe('b1');
  });

  it('returns null when the buyer row is missing or inactive', async () => {
    slimRow = null;
    const { requireBuyerAccessProfile } = await import('@/lib/server/buyer-access');
    expect(await requireBuyerAccessProfile({} as NextRequest, { slim: true })).toBeNull();
  });
});
