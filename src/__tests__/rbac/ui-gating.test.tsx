/**
 * EP-11-003 — Role-Based UI Gating in Seller Cockpit
 *
 * Tests:
 *   1. SellerSidebar with seller_assistant — admin-only nav items absent
 *   2. SellerSidebar with seller_admin    — all nav items present
 *   3. RoleGuard hides children + shows PermissionDenied for unauthorized role
 *   4. RoleGuard renders children for authorized role
 *   5. useRole() returns correct flags for each role
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

// ─── mock Next.js navigation ─────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn() }),
}));

// ─── mock Supabase client (avoids env-var errors in test) ────────────────────

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn().mockResolvedValue({}),
    },
  },
}));

// ─── AuthContext mock factory ─────────────────────────────────────────────────

const mockUseAuth = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ currentTenant: { business_name: 'Test Tenant' } }),
}));

vi.mock('@/hooks/useInboxEntries', () => ({
  useInboxActiveCount: () => ({ data: { count: 0 } }),
}));

function makeAuthValue(role: string) {
  return {
    session: null,
    user: { id: 'user-1', email: 'test@example.com' },
    tenantProfile: { id: 'tp-1', tenant_id: 'tenant-1', user_id: 'user-1', role, is_active: true },
    buyerProfiles: [],
    currentTenantId: 'tenant-1',
    currentBuyerId: null,
    isLoading: false,
    isError: false,
    error: null,
    signOut: vi.fn(),
    switchTenant: vi.fn(),
    switchBuyer: vi.fn(),
  };
}

// ─── imports after mocks ──────────────────────────────────────────────────────

import { SellerSidebar } from '@/components/layout/SellerSidebar';
import { RoleGuard } from '@/components/auth/RoleGuard';
import { useRole } from '@/hooks/useRole';
import { renderHook } from '@testing-library/react';
import type { SellerShellFeatureAvailability } from '@/lib/server/seller-features';

function makeFeatures(overrides: Partial<SellerShellFeatureAvailability> = {}): SellerShellFeatureAvailability {
  return {
    brandProductMaster: true,
    customerMaster: true,
    cohorts: true,
    pricingEngine: true,
    catalogPublishing: true,
    buyerApp: true,
    estimates: true,
    salesOrders: true,
    invoices: true,
    tallyExport: true,
    integrations: true,
    ...overrides,
  };
}

// ─── SellerSidebar nav gating ─────────────────────────────────────────────────

describe('SellerSidebar nav gating', () => {
  describe('seller_assistant', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue(makeAuthValue('seller_assistant'));
    });

    it('renders non-admin nav items', async () => {
      await act(async () => {
        render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
      });
      expect(screen.getByText('Inbox')).toBeInTheDocument();
      expect(screen.queryByText('Pulse')).not.toBeInTheDocument();
      expect(screen.getByText('Sales')).toBeInTheDocument();
      expect(screen.getByText('Customers')).toBeInTheDocument();
      expect(screen.getByText('Products')).toBeInTheDocument();
      expect(screen.queryByText('Pricing')).not.toBeInTheDocument();
      expect(screen.queryByText('Exports')).not.toBeInTheDocument();
    });

    it('hides Customer Groups nav item', async () => {
      await act(async () => {
        render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
      });
      expect(screen.queryByText('Customer Groups')).not.toBeInTheDocument();
    });

    it('hides Price Lists nav item', async () => {
      await act(async () => {
        render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
      });
      expect(screen.queryByText('Pricing')).not.toBeInTheDocument();
    });

    it('hides strategy modules and section headers', async () => {
      await act(async () => {
        render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
      });
      expect(screen.queryByText('Brands')).not.toBeInTheDocument();
      expect(screen.queryByText('Catalogs')).not.toBeInTheDocument();
      expect(screen.queryByText('OPERATIONS')).not.toBeInTheDocument();
      expect(screen.queryByText('CUSTOMERS')).not.toBeInTheDocument();
      expect(screen.queryByText('CATALOG')).not.toBeInTheDocument();
      expect(screen.queryByText('ADMIN')).not.toBeInTheDocument();
      expect(screen.queryByText('MARKET')).not.toBeInTheDocument();
    });

    it('hides Settings nav item', async () => {
      await act(async () => {
        render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
      });
      expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    });

  });

  describe('seller_admin', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue(makeAuthValue('seller_admin'));
    });

    it('renders all nav items including admin-only ones', async () => {
      await act(async () => {
        render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
      });
      expect(screen.getByText('Customer Groups')).toBeInTheDocument();
      expect(screen.getByText('Pricing')).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

  });
});

// ─── RoleGuard ────────────────────────────────────────────────────────────────

describe('RoleGuard', () => {
  it('hides children and shows PermissionDenied when role is not authorized', () => {
    mockUseAuth.mockReturnValue(makeAuthValue('seller_assistant'));

    render(
      <RoleGuard roles={['seller_admin']}>
        <span>secret content</span>
      </RoleGuard>
    );

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });

  it('renders children when role is authorized', () => {
    mockUseAuth.mockReturnValue(makeAuthValue('seller_admin'));

    render(
      <RoleGuard roles={['seller_admin']}>
        <span>secret content</span>
      </RoleGuard>
    );

    expect(screen.getByText('secret content')).toBeInTheDocument();
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('renders custom fallback when provided', () => {
    mockUseAuth.mockReturnValue(makeAuthValue('seller_assistant'));

    render(
      <RoleGuard roles={['seller_admin']} fallback={<span>custom fallback</span>}>
        <span>secret content</span>
      </RoleGuard>
    );

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.getByText('custom fallback')).toBeInTheDocument();
  });

  it('renders loading placeholder when tenantProfile is null (role not resolved)', () => {
    mockUseAuth.mockReturnValue({
      ...makeAuthValue('seller_admin'),
      tenantProfile: null,
    });

    render(
      <RoleGuard roles={['seller_admin']}>
        <span>secret content</span>
      </RoleGuard>
    );

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.getByText(/loading access/i)).toBeInTheDocument();
  });
});

// ─── useRole hook ─────────────────────────────────────────────────────────────

describe('useRole', () => {
  it('returns isSellerAdmin=true for seller_admin', () => {
    mockUseAuth.mockReturnValue(makeAuthValue('seller_admin'));
    const { result } = renderHook(() => useRole());
    expect(result.current.isSellerAdmin).toBe(true);
    expect(result.current.isSellerAssistant).toBe(false);
    expect(result.current.isSeller).toBe(true);
    expect(result.current.isBuyer).toBe(false);
  });

  it('returns isSellerAssistant=true for seller_assistant', () => {
    mockUseAuth.mockReturnValue(makeAuthValue('seller_assistant'));
    const { result } = renderHook(() => useRole());
    expect(result.current.isSellerAdmin).toBe(false);
    expect(result.current.isSellerAssistant).toBe(true);
    expect(result.current.isSeller).toBe(true);
  });

  it('can() returns true when current role is in the list', () => {
    mockUseAuth.mockReturnValue(makeAuthValue('seller_assistant'));
    const { result } = renderHook(() => useRole());
    expect(result.current.can(['seller_admin', 'seller_assistant'])).toBe(true);
    expect(result.current.can(['seller_admin'])).toBe(false);
  });
});
