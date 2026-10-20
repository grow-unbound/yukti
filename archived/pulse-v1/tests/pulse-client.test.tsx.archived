import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PulseDashboardClient } from '@/components/seller/pulse/PulseDashboardClient';
import type { PulseContributionResponse, PulseDemandSignalsResponse, PulseOpportunitiesResponse } from '@/types/pulse';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function renderPulse() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PulseDashboardClient />
    </QueryClientProvider>,
  );
}

const contribution: PulseContributionResponse = {
  source: 'app.get_landing_metrics_v4',
  computed_at: '2026-09-22T04:00:00.000Z',
  source_watermark: '2026-09-22T03:45:00.000Z',
  freshness_label: new Date().toISOString(),
  primary_demand_kind: 'orders',
  cards: [
    {
      id: 'yukti_access_enabled',
      label: 'Customers with Yukti access',
      value: 27,
      value_kind: 'count',
      buyer_count: 27,
      time_basis: 'NOW',
      evidence: 'Customers who can submit demand through Yukti',
    },
    {
      id: 'demand_captured',
      label: 'Demand captured through Yukti',
      value: 840000,
      value_kind: 'currency',
      document_count: 9,
      buyer_count: 6,
      time_basis: 'QTD',
      evidence: '9 submitted demand documents from 6 buyers',
    },
  ],
};

const opportunities: PulseOpportunitiesResponse = {
  source: 'app.metrics_buyer_period_summary',
  computed_at: '2026-09-22T04:00:00.000Z',
  source_watermark: '2026-09-22T03:45:00.000Z',
  freshness_label: new Date().toISOString(),
  groups: [
    {
      id: 'valuable_assisted_customers_without_access',
      title: 'Activate valuable customers',
      description: 'High-value customers still order manually and do not have Yukti access enabled.',
      count: 12,
      time_basis: 'NOW + QTD',
      evidence: '₹4,10,000 qualifying assisted business · NOW + QTD',
      action_label: 'Open access management',
      action_href: '/buyer-app/access',
      previews: [
        {
          buyer_id: 'buyer-1',
          name: 'Alpha Retail',
          initials: 'AR',
          invoice_value_qtd: 410000,
          invoice_count_qtd: 8,
          supporting_text: '₹4,10,000 · 8 invoices',
          href: '/customers/buyer-1',
        },
      ],
    },
    {
      id: 'dormant_customers_90d',
      title: 'Dormant customers to win back',
      description: 'Customers with meaningful past business who have not purchased in 90+ days.',
      count: 294,
      time_basis: 'Rolling 90 days',
      evidence: '₹1,75,00,000 last-12-month value · no purchase in 90+ days',
      action_label: 'Review customers',
      action_href: '/customers',
      previews: [
        {
          buyer_id: 'buyer-3',
          name: 'Quiet Retail',
          initials: 'QR',
          last_invoice_date: '2026-06-12',
          days_since_last_invoice: 106,
          value_12m: 1107286,
          supporting_text: 'Last purchase 106 days ago · ₹11,07,286 last 12m',
          href: '/customers/buyer-3',
        },
      ],
    },
  ],
};

const demandSignals: PulseDemandSignalsResponse = {
  page_key: 'pulse_demand_signals',
  computed_at: new Date().toISOString(),
  source_watermark: new Date().toISOString(),
  stale: false,
  query_window: {
    started_at: '2026-09-17T03:10:06.189Z',
    ended_at: '2026-09-24T03:10:06.189Z',
  },
  funnel_counts: {
    searches: 0,
    zero_result_searches: 0,
    product_views: 81,
    cart_adds: 0,
  },
  signal_counts: {
    missing_assortment: 0,
    conversion_gaps: 6,
    stock_mismatch: 0,
  },
  missing_assortment: [],
  conversion_gaps: [
    {
      id: 'product-1',
      tenant_product_id: 'product-1',
      label: '8-Ch NVR CP Plus',
      product_name: '8-Ch NVR CP Plus',
      count: 11,
      unique_count: 10,
      last_seen_at: new Date().toISOString(),
      source_channel: 'storefront',
    },
    {
      id: 'product-2',
      tenant_product_id: 'product-2',
      label: 'Second Product',
      product_name: 'Second Product',
      count: 6,
      unique_count: 3,
      last_seen_at: new Date().toISOString(),
      source_channel: 'storefront',
    },
    {
      id: 'product-3',
      tenant_product_id: 'product-3',
      label: 'Third Product',
      product_name: 'Third Product',
      count: 5,
      unique_count: 3,
      last_seen_at: new Date().toISOString(),
      source_channel: 'storefront',
    },
    {
      id: 'product-4',
      tenant_product_id: 'product-4',
      label: 'Fourth Product',
      product_name: 'Fourth Product',
      count: 4,
      unique_count: 2,
      last_seen_at: new Date().toISOString(),
      source_channel: 'storefront',
    },
    {
      id: 'product-5',
      tenant_product_id: 'product-5',
      label: 'Fifth Product',
      product_name: 'Fifth Product',
      count: 3,
      unique_count: 2,
      last_seen_at: new Date().toISOString(),
      source_channel: 'storefront',
    },
    {
      id: 'product-6',
      tenant_product_id: 'product-6',
      label: 'Hidden Product',
      product_name: 'Hidden Product',
      count: 2,
      unique_count: 2,
      last_seen_at: new Date().toISOString(),
      source_channel: 'storefront',
    },
  ],
  stock_mismatch: [],
};

function pulseResponse(url: string, overrides?: { contribution?: unknown; opportunities?: unknown; demandSignals?: unknown }) {
  if (url.includes('demand-signals')) return overrides?.demandSignals ?? demandSignals;
  if (url.includes('opportunities')) return overrides?.opportunities ?? opportunities;
  return overrides?.contribution ?? contribution;
}

describe('PulseDashboardClient', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders the P01 Pulse core without retired ERP dashboard widgets', async () => {
    apiFetchMock.mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => pulseResponse(url),
    }));

    renderPulse();

    expect(screen.getByRole('heading', { name: 'Pulse' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Business captured through Yukti',
      'Opportunities',
      'Demand signals',
    ]);
    expect(await screen.findByText('Demand signals')).toBeInTheDocument();
    expect(await screen.findByText('8-Ch NVR CP Plus')).toBeInTheDocument();
    expect(await screen.findByText(/10 customers/)).toBeInTheDocument();
    expect((await screen.findAllByText(/Last seen/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('views')).length).toBe(5);
    expect((await screen.findAllByText('Show all')).length).toBeGreaterThan(0);
    expect(await screen.findByText('No privacy-safe missing assortment yet')).toBeInTheDocument();
    expect(await screen.findByText('No stock mismatch detected')).toBeInTheDocument();
    expect(await screen.findByText('Customers with Yukti access · NOW')).toBeInTheDocument();
    expect(await screen.findByText(/Demand captured through Yukti/)).toBeInTheDocument();
    expect(await screen.findByText('Activate valuable customers')).toBeInTheDocument();
    expect(await screen.findByText('₹4,10,000 qualifying assisted business · NOW + QTD')).toBeInTheDocument();
    expect(await screen.findByText('Open access management')).toBeInTheDocument();
    expect(await screen.findByText('Dormant customers to win back')).toBeInTheDocument();
    expect(await screen.findByText('Last purchase 106 days ago · ₹11,07,286 last 12m')).toBeInTheDocument();
    expect(await screen.findByText('₹1,75,00,000 last-12-month value · no purchase in 90+ days')).toBeInTheDocument();
    expect(await screen.findByText('294')).toBeInTheDocument();
    expect(screen.queryByText(/going quiet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Convert interested customers')).not.toBeInTheDocument();
    expect(screen.queryByText(/Open access management/i)).toBeInTheDocument();

    expect(screen.queryByText('Business flow')).not.toBeInTheDocument();
    expect(screen.queryByText('Customer activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Sales mix')).not.toBeInTheDocument();
    expect(screen.queryByText('Location performance')).not.toBeInTheDocument();
    expect(screen.queryByText(/Buyer channels/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-live-share-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Storefront')).not.toBeInTheDocument();
    expect(screen.queryByText(/intent events/)).not.toBeInTheDocument();
    expect(screen.queryByText(/visitors/)).not.toBeInTheDocument();
  });

  it('opens a Demand Signals slide-over from Show all', async () => {
    apiFetchMock.mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => pulseResponse(url),
    }));

    renderPulse();

    expect(await screen.findByText('Fifth Product')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Product')).not.toBeInTheDocument();
    const showAllButtons = await screen.findAllByText('Show all');
    fireEvent.click(showAllButtons[showAllButtons.length - 1]);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findAllByText('Conversion gaps')).toHaveLength(2);
    expect(await screen.findByText('6 signals')).toBeInTheDocument();
    expect(await screen.findByText('Hidden Product')).toBeInTheDocument();
  });

  it('keeps opportunities visible when contribution fails', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('contribution')) {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'fail' }) });
      }
      return Promise.resolve({ ok: true, json: async () => pulseResponse(url) });
    });

    renderPulse();

    expect(await screen.findByText('Contribution could not load')).toBeInTheDocument();
    expect(await screen.findByText('Activate valuable customers')).toBeInTheDocument();
    expect(await screen.findByText('8-Ch NVR CP Plus')).toBeInTheDocument();
  });

  it('keeps the P01 core visible when demand signals fail', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('demand-signals')) {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'fail' }) });
      }
      return Promise.resolve({ ok: true, json: async () => pulseResponse(url) });
    });

    renderPulse();

    await waitFor(() => {
      expect(screen.getAllByText('Signal could not load')).toHaveLength(3);
    });
    expect(await screen.findByText(/Demand captured through Yukti/)).toBeInTheDocument();
    expect(await screen.findByText('Activate valuable customers')).toBeInTheDocument();
  });

  it('uses independent navigation-tier query keys and preserves successful content through sibling failure', async () => {
    apiFetchMock.mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => pulseResponse(url, { contribution: { ...contribution, cards: [] } }),
    }));

    renderPulse();

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/tenant/pulse/contribution');
      expect(apiFetchMock).toHaveBeenCalledWith('/api/tenant/pulse/opportunities');
      expect(apiFetchMock).toHaveBeenCalledWith('/api/tenant/pulse/demand-signals');
    });
    expect(await screen.findByText('Pulse will focus once Yukti captures demand')).toBeInTheDocument();
    expect(await screen.findByText('Activate valuable customers')).toBeInTheDocument();
  });

  it('shows stale demand-signal copy for an old successful snapshot', async () => {
    apiFetchMock.mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => pulseResponse(url, {
        demandSignals: {
          ...demandSignals,
          stale: true,
          conversion_gaps: [],
        },
      }),
    }));

    renderPulse();

    await waitFor(() => {
      expect(screen.getAllByText('Last successful extraction is stale.')).toHaveLength(3);
    });
    expect(await screen.findByText('No meaningful conversion gaps detected')).toBeInTheDocument();
  });
});
