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
vi.mock('@/components/seller/pulse/v2/PulseV2Client', () => ({
  PulseV2Client: () => null,
}));

import { GET as getDemandSignals } from '../../app/api/tenant/pulse/demand-signals/route';
import { GET as getScorecard } from '../../app/api/tenant/pulse/scorecard/route';
import { GET as getActNow } from '../../app/api/tenant/pulse/act-now/route';
import { GET as getActBuyers } from '../../app/api/tenant/pulse/act-now/[group]/route';
import { GET as getFunnel } from '../../app/api/tenant/pulse/funnel/route';
import { GET as getSellThrough } from '../../app/api/tenant/pulse/sellthrough/route';
import { GET as getCustomers } from '../../app/api/tenant/pulse/customers/route';
import { GET as getPatterns } from '../../app/api/tenant/pulse/patterns/route';
import { GET as getReview } from '../../app/api/tenant/pulse/review/route';
import PulseLayout from '../../app/(seller)/pulse/layout';
import PulsePage from '../../app/(seller)/pulse/page';
import DashboardRedirectPage from '../../app/(seller)/dashboard/page';
import { canAccessPulse, sellerHomeRoute } from '@/lib/server/pulse-access';

const assistant = { tenant_id: 'tenant-1', role: 'seller_assistant', location_ids: ['loc-1'] };
const unassignedAssistant = { tenant_id: 'tenant-1', role: 'seller_assistant', location_ids: [] };
const buyer = { tenant_id: 'tenant-1', role: 'buyer_admin', location_ids: null };
const admin = { tenant_id: 'tenant-1', role: 'seller_admin', location_ids: null };

const get = (path: string) => new NextRequest(`http://localhost${path}`);
const apiCalls: Array<[string, () => Promise<Response>]> = [
  ['demand-signals', () => getDemandSignals(get('/api/tenant/pulse/demand-signals'))],
  ['scorecard', () => getScorecard(get('/api/tenant/pulse/scorecard'))],
  ['act-now', () => getActNow(get('/api/tenant/pulse/act-now'))],
  ['act-now group', () => getActBuyers(get('/api/tenant/pulse/act-now/went_quiet'), { params: Promise.resolve({ group: 'went_quiet' }) })],
  ['funnel', () => getFunnel(get('/api/tenant/pulse/funnel'))],
  ['sellthrough', () => getSellThrough(get('/api/tenant/pulse/sellthrough'))],
  ['customers', () => getCustomers(get('/api/tenant/pulse/customers'))],
  ['patterns', () => getPatterns(get('/api/tenant/pulse/patterns'))],
  ['review', () => getReview(get('/api/tenant/pulse/review'))],
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
