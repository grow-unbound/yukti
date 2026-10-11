import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getSellerServerClaimsMock = vi.fn();
const rpcMock = vi.fn();
const fromMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });
});

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));
vi.mock('next/navigation', () => ({
  redirect: (...args: [string]) => redirectMock(...args),
}));
vi.mock('@/lib/server/seller-server-claims', () => ({
  getSellerServerClaims: (...args: unknown[]) => getSellerServerClaimsMock(...args),
  requireSellerServerTenantId: vi.fn(async () => 'tenant-1'),
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
      from: (...args: unknown[]) => fromMock(...args),
    })),
  },
}));
vi.mock('@/components/seller/pulse/PulseDashboardClient', () => ({
  PulseDashboardClient: () => null,
}));

import { GET as getContribution } from '../../app/api/tenant/pulse/contribution/route';
import { GET as getDemandSignals } from '../../app/api/tenant/pulse/demand-signals/route';
import { GET as getOpportunities } from '../../app/api/tenant/pulse/opportunities/route';
import { GET as getOpportunityBuyers } from '../../app/api/tenant/pulse/opportunities/[id]/buyers/route';
import PulseLayout from '../../app/(seller)/pulse/layout';
import PulsePage from '../../app/(seller)/pulse/page';
import DashboardRedirectPage from '../../app/(seller)/dashboard/page';
import { canAccessPulse, sellerHomeRoute } from '@/lib/server/pulse-access';

const assistant = { tenant_id: 'tenant-1', role: 'seller_assistant', location_ids: ['loc-1'] };
const unassignedAssistant = { tenant_id: 'tenant-1', role: 'seller_assistant', location_ids: [] };
const buyer = { tenant_id: 'tenant-1', role: 'buyer_admin', location_ids: null };
const admin = { tenant_id: 'tenant-1', role: 'seller_admin', location_ids: null };

const apiCalls: Array<[string, () => Promise<Response>]> = [
  ['contribution', () => getContribution(new NextRequest('http://localhost/api/tenant/pulse/contribution'))],
  ['demand-signals', () => getDemandSignals(new NextRequest('http://localhost/api/tenant/pulse/demand-signals'))],
  ['opportunities', () => getOpportunities(new NextRequest('http://localhost/api/tenant/pulse/opportunities'))],
  [
    'opportunity buyers',
    () => getOpportunityBuyers(
      new NextRequest('http://localhost/api/tenant/pulse/opportunities/dormant_customers_90d/buyers'),
      { params: Promise.resolve({ id: 'dormant_customers_90d' }) },
    ),
  ],
];

describe('Pulse is seller_admin only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the role helpers', () => {
    expect(canAccessPulse('seller_admin')).toBe(true);
    expect(canAccessPulse('seller_assistant')).toBe(false);
    expect(canAccessPulse('buyer_admin')).toBe(false);
    expect(canAccessPulse(null)).toBe(false);
    expect(sellerHomeRoute('seller_admin')).toBe('/pulse');
    expect(sellerHomeRoute('seller_assistant')).toBe('/inbox');
  });

  describe.each(apiCalls)('%s API', (_name, call) => {
    it.each([
      ['assistant', assistant],
      ['unassigned assistant', unassignedAssistant],
      ['buyer', buyer],
    ])('returns 403 no-store for %s before any data access', async (_label, claims) => {
      getVerifiedClaimsMock.mockResolvedValue(claims);
      const response = await call();
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(rpcMock).not.toHaveBeenCalled();
      expect(fromMock).not.toHaveBeenCalled();
    });

    it('still returns 401 without a tenant', async () => {
      getVerifiedClaimsMock.mockResolvedValue({ tenant_id: null, role: 'seller_admin' });
      expect((await call()).status).toBe(401);
    });
  });

  it('redirects assistants away from the Pulse layout and page without rendering children', async () => {
    getSellerServerClaimsMock.mockResolvedValue(assistant);
    await expect(PulseLayout({ children: 'child' })).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenLastCalledWith('/inbox');
    await expect(PulsePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenLastCalledWith('/inbox');
  });

  it('renders the Pulse layout and page for admins', async () => {
    getSellerServerClaimsMock.mockResolvedValue(admin);
    await expect(PulseLayout({ children: 'child' })).resolves.toBe('child');
    await expect(PulsePage()).resolves.toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('lands assistants on Inbox and admins on Pulse from /dashboard', async () => {
    getSellerServerClaimsMock.mockResolvedValue(assistant);
    await expect(DashboardRedirectPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenLastCalledWith('/inbox');
    getSellerServerClaimsMock.mockResolvedValue(admin);
    await expect(DashboardRedirectPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenLastCalledWith('/pulse');
  });
});
