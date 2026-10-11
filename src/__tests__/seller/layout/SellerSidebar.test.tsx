import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';

const mockPathname = vi.fn(() => '/pulse');

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn().mockResolvedValue({}),
    },
  },
}));

const mockUseAuth = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ currentTenant: { business_name: 'Acme Dist' } }),
}));

const prefetchSpy = vi.fn();
vi.mock('@/hooks/useIdleRoutePrefetch', () => ({
  useIdleRoutePrefetch: (paths: string[]) => prefetchSpy(paths),
}));

const mockUseInboxActiveCount = vi.fn(() => ({ data: undefined }));
vi.mock('@/hooks/useInboxEntries', () => ({
  useInboxActiveCount: () => mockUseInboxActiveCount(),
}));

function makeAuth(role: string) {
  return {
    session: null,
    user: { id: 'u1', email: 'seller@example.com' },
    tenantProfile: { id: 'tp-1', tenant_id: 't1', user_id: 'u1', role, is_active: true },
    buyerProfiles: [],
    currentTenantId: 't1',
    currentBuyerId: null,
    isLoading: false,
    isError: false,
    error: null,
    signOut: vi.fn(),
    switchTenant: vi.fn(),
    switchBuyer: vi.fn(),
  };
}

import { SellerSidebar, collectPrefetchHrefs, navGroups } from '@/components/layout/SellerSidebar';
import { resolveSellerSidebarLayout } from '@/components/layout/seller-sidebar-layout';
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

describe('SellerSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.mockReturnValue('/pulse');
    mockUseAuth.mockReturnValue(makeAuth('seller_admin'));
    try {
      localStorage.removeItem('df_sidebar_settings_expanded');
    } catch {
      // non-browser test env
    }
  });

  it('renders three section headers in expanded mode', async () => {
    await act(async () => {
      render(<SellerSidebar isCollapsed={false} featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    expect(screen.getByText('OPERATIONS')).toBeInTheDocument();
    expect(screen.getByText('MARKET')).toBeInTheDocument();
    expect(screen.getByText('SETUP')).toBeInTheDocument();
  });

  it('hides section headers when collapsed', async () => {
    await act(async () => {
      render(<SellerSidebar isCollapsed featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    expect(screen.queryByText('OPERATIONS')).not.toBeInTheDocument();
    expect(screen.queryByText('MARKET')).not.toBeInTheDocument();
    expect(screen.queryByText('SETUP')).not.toBeInTheDocument();
  });

  it('keeps Sales visible when one transaction flag is off', async () => {
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures({ estimates: false }))} />);
    });
    expect(screen.queryByText('Estimates')).not.toBeInTheDocument();
    expect(screen.getByText('OPERATIONS')).toBeInTheDocument();
    expect(screen.getByText('Pulse')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('does not render the account footer in the sidebar', async () => {
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
    expect(screen.queryByText('seller@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Dist')).not.toBeInTheDocument();
  });

  it('derives idle prefetch hrefs from navGroups for admin with flags on', async () => {
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    expect(prefetchSpy).toHaveBeenCalled();
    const paths = prefetchSpy.mock.calls[0][0] as string[];
    expect(paths).toContain('/inbox');
    expect(paths).toContain('/pulse');
    expect(paths).toContain('/sales/invoices');
    expect(paths).toContain('/settings');
    expect(paths).not.toContain('/settings/modules');
    expect(paths).toContain('/business/branches');
    expect(paths).toContain('/catalog');
    expect(paths).toContain('/pricing');
    expect(paths).toContain('/recommendations');
  });

  it('hides Integrations when df_integrations is off', async () => {
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures({ integrations: false }))} />);
    });
    expect(screen.queryByRole('link', { name: 'Integrations' })).not.toBeInTheDocument();
  });

  it('keeps the Catalog nav item visible when catalog publishing is off', async () => {
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures({ catalogPublishing: false }))} />);
    });
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Campaigns' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Announcements' })).not.toBeInTheDocument();
  });

  it('keeps Settings active without rendering settings child nav items', async () => {
    mockPathname.mockReturnValue('/settings/team');
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Billing & Plan' })).not.toBeInTheDocument();
  });

  it('excludes admin-only and flag-off routes from prefetch for assistant', async () => {
    mockUseAuth.mockReturnValue(makeAuth('seller_assistant'));
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures({ estimates: false }))} />);
    });
    const paths = prefetchSpy.mock.calls[0][0] as string[];
    expect(paths).not.toContain('/cohorts');
    expect(paths).not.toContain('/exports');
    expect(paths).not.toContain('/settings');
    expect(paths).not.toContain('/settings/modules');
    expect(paths).not.toContain('/settings/integrations');
    expect(paths).not.toContain('/settings/billing');
    expect(paths).not.toContain('/estimates');
    expect(paths).not.toContain('/pulse');
    expect(paths).toContain('/sales/invoices');
  });

  it('renders assistant nav as a flat ordered list with no section headings', async () => {
    mockUseAuth.mockReturnValue(makeAuth('seller_assistant'));
    await act(async () => {
      render(<SellerSidebar featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });

    expect(screen.queryByText('OPERATIONS')).not.toBeInTheDocument();
    expect(screen.queryByText('MARKET')).not.toBeInTheDocument();
    expect(screen.queryByText('SETUP')).not.toBeInTheDocument();
    const orderedItems = ['Inbox', 'Sales', 'Customers', 'Products'];
    orderedItems.forEach((label) => {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Pulse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Brands' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Catalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('renders collapse toggle in footer when canCollapse is true', async () => {
    await act(async () => {
      render(<SellerSidebar isCollapsed={false} canCollapse featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toBeInTheDocument();
    expect(toggle.closest('footer')).not.toBeNull();
  });

  it('hides collapse toggle when canCollapse is false', async () => {
    await act(async () => {
      render(<SellerSidebar isCollapsed={false} canCollapse={false} featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    expect(screen.queryByRole('button', { name: /sidebar/i })).not.toBeInTheDocument();
  });

  it('renders copper mark logo in collapsed mode (not charcoal app-icon)', async () => {
    await act(async () => {
      render(<SellerSidebar isCollapsed featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    const logo = screen.getByRole('img', { name: 'Yukti' });
    expect(logo).toHaveAttribute('src', expect.stringContaining('mark-copper.svg'));
  });

  it('centers collapsed nav links in the narrower rail', async () => {
    await act(async () => {
      render(<SellerSidebar isCollapsed featureAvailabilityPromise={Promise.resolve(makeFeatures())} />);
    });
    const dashboardLink = screen.getByRole('link', { name: 'Pulse' });
    expect(dashboardLink.className).toContain('justify-center');
    expect(dashboardLink.className).toContain('px-0');
  });

  it('reveals expanded content when the collapsed sidebar is hovered', async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellerSidebar isCollapsed featureAvailabilityPromise={Promise.resolve(makeFeatures())} />
      ));
    });

    const aside = container!.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(screen.queryByText('OPERATIONS')).not.toBeInTheDocument();

    fireEvent.mouseEnter(aside!);

    expect(screen.getByText('OPERATIONS')).toBeInTheDocument();
    expect(screen.getByText('Pulse')).toBeInTheDocument();
  });
});

describe('resolveSellerSidebarLayout', () => {
  it('keeps the sidebar expanded and non-collapsible on large screens', () => {
    expect(
      resolveSellerSidebarLayout({
        isUserCollapsed: true,
        isLargeScreen: true,
        isForcedCollapsed: false,
      })
    ).toEqual({
      isCollapsed: false,
      canCollapse: false,
      sidebarWidth: '216px',
    });
  });

  it('forces the sidebar collapsed below the responsive breakpoint', () => {
    expect(
      resolveSellerSidebarLayout({
        isUserCollapsed: false,
        isLargeScreen: false,
        isForcedCollapsed: true,
      })
    ).toEqual({
      isCollapsed: true,
      canCollapse: false,
      sidebarWidth: '72px',
    });
  });

  it('uses the user preference in the middle breakpoint range', () => {
    expect(
      resolveSellerSidebarLayout({
        isUserCollapsed: true,
        isLargeScreen: false,
        isForcedCollapsed: false,
      })
    ).toEqual({
      isCollapsed: true,
      canCollapse: true,
      sidebarWidth: '72px',
    });
  });
});

describe('collectPrefetchHrefs', () => {
  it('matches navGroups flattening with flag and admin gates', () => {
    const hrefs = collectPrefetchHrefs(navGroups, {
      role: 'seller_admin',
      getFlag: () => true,
    });
    expect(hrefs).toContain('/sales/invoices');
    expect(hrefs).toContain('/settings');
    expect(hrefs).toContain('/business/branches');
    expect(hrefs).toContain('/pricing');
  });

  it('keeps Sales prefetch when one transaction flag is false', () => {
    const hrefs = collectPrefetchHrefs(navGroups, {
      role: 'seller_admin',
      getFlag: (k) => k !== 'df_estimates',
    });
    expect(hrefs).not.toContain('/estimates');
    expect(hrefs).toContain('/sales/invoices');
  });

  it('excludes integrations path when integrations flag is off', () => {
    const hrefs = collectPrefetchHrefs(navGroups, {
      role: 'seller_admin',
      getFlag: (k) => k !== 'df_integrations',
    });
    expect(hrefs).not.toContain('/settings/integrations');
    expect(hrefs).toContain('/settings');
  });

  it('includes price lists but excludes admin-only routes for assistants', () => {
    const hrefs = collectPrefetchHrefs(navGroups, {
      role: 'seller_assistant',
      getFlag: () => true,
    });
    expect(hrefs).not.toContain('/brands');
    expect(hrefs).not.toContain('/catalog');
    expect(hrefs).not.toContain('/settings');
    expect(hrefs).not.toContain('/pricing');
  });
});
