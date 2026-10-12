import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
const useBuyerMeMock = vi.fn();
const useCartMock = vi.fn();
const useRouterMock = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useBuyerMe', () => ({
  useBuyerMe: (...args: unknown[]) => useBuyerMeMock(...args),
}));

vi.mock('@/contexts/BuyerCartContext', () => ({
  useCart: (...args: unknown[]) => useCartMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => useRouterMock(),
  usePathname: () => '/buy/orders/ord-1',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/buyer/layout/BuyerDetailShell', () => ({
  BuyerDetailShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('buyer transaction detail page GST presentation', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useBuyerMeMock.mockReset();
    useCartMock.mockReset();
    useRouterMock.mockReset();

    useCartMock.mockReturnValue({
      items: [],
      clearCart: vi.fn(),
      addItem: vi.fn(),
    });
    useRouterMock.mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
    });
  });

  it('shows included-in-prices GST and keeps total equal to subtotal when the tenant policy is inclusive', async () => {
    useBuyerMeMock.mockReturnValue({
      data: {
        tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: true, gst_rate: 18 },
      },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        order: {
          order_number: 'SO-1001',
          status: 'confirmed',
          placed_at: '2026-07-20T00:00:00.000Z',
          notes: null,
          place_of_supply: 'Mumbai',
          subtotal: 1000,
          tax_total: 180,
          total_amount: 1180,
          items: [
            {
              tenant_product_id: 'tp-1',
              product_name: 'Camera',
              internal_sku: 'SKU-1',
              unit: 'pc',
              image_url: 'https://cdn.example.com/camera.webp',
              qty: 1,
              unit_price: 1000,
              tax_rate: 18,
              line_total: 1000,
            },
          ],
        },
      }),
    });

    const { TransactionDetailPage } = await import('@/components/buyer/documents/TransactionDetailPage');
    render(
      <TransactionDetailPage
        id="ord-1"
        title="Order"
        endpoint="/api/buyer/orders/ord-1"
        docType="order"
        respectBusinessPolicyTotals
        pickDoc={(payload) => {
          const order = payload.order;
          return order
            ? {
                docNumber: order.order_number,
                status: order.status,
                primaryDate: order.placed_at,
                secondaryDate: null,
                notes: order.notes ?? null,
                subtotal: order.subtotal,
                tax_total: order.tax_total,
                total_amount: order.total_amount,
                placeOfSupply: order.place_of_supply ?? null,
                items: order.items ?? [],
              }
            : null;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('SO-1001')).toBeInTheDocument();
    });

    expect(screen.getByText('Included in Prices')).toBeInTheDocument();
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('1 pc × ₹1,000')).toBeInTheDocument();
    expect(screen.getByAltText('Camera')).toHaveAttribute('src');
    expect(screen.getAllByText('₹1,000')).toHaveLength(3);
    expect(screen.queryByText('₹1,180')).not.toBeInTheDocument();
  });

  it('sets the tab title to the document number once the payload resolves', async () => {
    document.title = 'Order';
    useBuyerMeMock.mockReturnValue({
      data: { tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: false, gst_rate: 18 } },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        order: {
          order_number: 'SO-2002',
          status: 'confirmed',
          placed_at: '2026-07-20T00:00:00.000Z',
          subtotal: 100,
          tax_total: 18,
          total_amount: 118,
          items: [],
        },
      }),
    });

    const { TransactionDetailPage } = await import('@/components/buyer/documents/TransactionDetailPage');
    render(
      <TransactionDetailPage
        id="ord-2"
        title="Order"
        endpoint="/api/buyer/orders/ord-2"
        docType="order"
        pickDoc={(payload) => {
          const order = payload.order;
          return order
            ? {
                docNumber: order.order_number,
                status: order.status,
                primaryDate: order.placed_at,
                secondaryDate: null,
                notes: null,
                subtotal: order.subtotal,
                tax_total: order.tax_total,
                total_amount: order.total_amount,
                placeOfSupply: null,
                items: [],
              }
            : null;
        }}
      />,
    );

    await waitFor(() => expect(document.title).toBe('SO-2002'));
  });

  it('computes GST extra from subtotal when the tenant policy is exclusive', async () => {
    useBuyerMeMock.mockReturnValue({
      data: {
        tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: false, gst_rate: 18 },
      },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        estimate: {
          estimate_number: 'EST-1001',
          status: 'sent',
          created_at: '2026-07-20T00:00:00.000Z',
          valid_until: '2026-07-27T00:00:00.000Z',
          notes: null,
          place_of_supply: 'Mumbai',
          subtotal: 1000,
          tax_total: 0,
          total_amount: 1000,
          items: [
            {
              tenant_product_id: 'tp-1',
              product_name: 'Camera',
              internal_sku: 'SKU-1',
              unit: 'pc',
              image_url: null,
              qty: 1,
              unit_price: 1000,
              tax_rate: 18,
              line_total: 1000,
            },
          ],
        },
      }),
    });

    const { TransactionDetailPage } = await import('@/components/buyer/documents/TransactionDetailPage');
    render(
      <TransactionDetailPage
        id="est-1"
        title="Estimate"
        endpoint="/api/buyer/estimates/est-1"
        docType="estimate"
        respectBusinessPolicyTotals
        pickDoc={(payload) => {
          const estimate = payload.estimate;
          return estimate
            ? {
                docNumber: estimate.estimate_number,
                status: estimate.status,
                primaryDate: estimate.created_at,
                secondaryDate: estimate.valid_until ?? null,
                notes: estimate.notes ?? null,
                subtotal: estimate.subtotal,
                tax_total: estimate.tax_total,
                total_amount: estimate.total_amount,
                placeOfSupply: estimate.place_of_supply ?? null,
                items: estimate.items ?? [],
              }
            : null;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('EST-1001')).toBeInTheDocument();
    });

    expect(screen.getByText('₹180 (18%)')).toBeInTheDocument();
    expect(screen.getByText('₹1,180')).toBeInTheDocument();
    expect(screen.getByText('1 pc × ₹1,000')).toBeInTheDocument();
    expect(screen.getAllByText('₹1,000')).toHaveLength(2);
  });
});
