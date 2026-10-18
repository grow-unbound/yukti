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

  it('shows resolved qty x unit price lines and totals when stored amounts are ex-GST under an inclusive policy', async () => {
    useBuyerMeMock.mockReturnValue({
      data: {
        tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: true, gst_rate: 18 },
      },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        estimate: {
          estimate_number: 'EST-1',
          status: 'invoiced',
          created_at: '2026-10-16T00:00:00.000Z',
          valid_until: null,
          notes: null,
          place_of_supply: 'Telangana',
          subtotal: 2669.5,
          tax_total: 480.5,
          total_amount: 3150,
          items: [
            {
              tenant_product_id: 'tp-1',
              product_name: 'Memory Card',
              internal_sku: 'CP-NM64',
              unit: 'pcs',
              image_url: null,
              qty: 3,
              unit_price: 1050,
              tax_rate: 18,
              line_total: 2669.5,
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
          const e = payload.estimate;
          return e
            ? {
                docNumber: e.estimate_number,
                status: e.status,
                primaryDate: e.created_at,
                secondaryDate: null,
                notes: null,
                subtotal: e.subtotal,
                tax_total: e.tax_total,
                total_amount: e.total_amount,
                placeOfSupply: e.place_of_supply,
                items: e.items,
              }
            : null;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('EST-1')).toBeInTheDocument();
    });

    expect(screen.getByText('Included in Prices')).toBeInTheDocument();
    expect(screen.getAllByText('₹3,150')).toHaveLength(3);
    expect(screen.queryByText('₹2,669.50')).not.toBeInTheDocument();
  });

  it('derives invoice lines as qty x unit_price and shows GST included for inclusive tenants', async () => {
    useBuyerMeMock.mockReturnValue({
      data: { tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: true, gst_rate: 18 } },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        invoice: {
          invoice_number: 'INV-1', status: 'sent', invoice_date: '2026-10-01T00:00:00.000Z', due_date: null,
          place_of_supply: null, subtotal: 186.44, tax_total: 33.56, total_amount: 220,
          outstanding_balance: null, discount_flat: 0, freight: 0, round_off: 0,
          items: [{ tenant_product_id: 'p1', product_name: 'P1', internal_sku: null, unit: 'pcs', image_url: null, qty: 1, unit_price: 40, tax_rate: 18, line_total: 33.9, disc_pct: 0 },{ tenant_product_id: 'p2', product_name: 'P2', internal_sku: null, unit: 'pcs', image_url: null, qty: 3, unit_price: 60, tax_rate: 18, line_total: 152.54, disc_pct: 0 }],
        },
      }),
    });
    const { TransactionDetailPage } = await import('@/components/buyer/documents/TransactionDetailPage');
    render(
      <TransactionDetailPage
        id="inv-1" title="Invoice" endpoint="/api/buyer/invoices/inv-1" docType="invoice" respectBusinessPolicyTotals
        pickDoc={(payload) => {
          const i = payload.invoice;
          return i ? {
            docNumber: i.invoice_number, status: i.status, primaryDate: i.invoice_date, secondaryDate: null, notes: null,
            subtotal: i.subtotal, tax_total: i.tax_total, total_amount: i.total_amount, placeOfSupply: null,
            discount_flat: i.discount_flat, freight: i.freight, round_off: i.round_off, items: i.items,
          } : null;
        }}
      />,
    );
    await waitFor(() => { expect(screen.getByText('INV-1')).toBeInTheDocument(); });
    expect(screen.getByText('Included in Prices')).toBeInTheDocument();
    expect(screen.getByText('₹40')).toBeInTheDocument();
    expect(screen.getByText('₹180')).toBeInTheDocument();
    expect(screen.queryByText('₹33.90')).not.toBeInTheDocument();
    expect(screen.queryByText('₹152.54')).not.toBeInTheDocument();
    expect(screen.queryByText('₹186.44')).not.toBeInTheDocument();
  });

  it('uses line discount and backend tax for exclusive-tax invoices', async () => {
    useBuyerMeMock.mockReturnValue({
      data: { tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: false, gst_rate: 18 } },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        invoice: {
          invoice_number: 'INV-1', status: 'sent', invoice_date: '2026-10-01T00:00:00.000Z', due_date: null,
          place_of_supply: null, subtotal: 186.44, tax_total: 162, total_amount: 1062,
          outstanding_balance: null, discount_flat: 0, freight: 50, round_off: 0,
          items: [{ tenant_product_id: 'p1', product_name: 'P1', internal_sku: null, unit: 'pcs', image_url: null, qty: 10, unit_price: 100, tax_rate: 18, line_total: 1180, disc_pct: 10 }],
        },
      }),
    });
    const { TransactionDetailPage } = await import('@/components/buyer/documents/TransactionDetailPage');
    render(
      <TransactionDetailPage
        id="inv-1" title="Invoice" endpoint="/api/buyer/invoices/inv-1" docType="invoice" respectBusinessPolicyTotals
        pickDoc={(payload) => {
          const i = payload.invoice;
          return i ? {
            docNumber: i.invoice_number, status: i.status, primaryDate: i.invoice_date, secondaryDate: null, notes: null,
            subtotal: i.subtotal, tax_total: i.tax_total, total_amount: i.total_amount, placeOfSupply: null,
            discount_flat: i.discount_flat, freight: i.freight, round_off: i.round_off, items: i.items,
          } : null;
        }}
      />,
    );
    await waitFor(() => { expect(screen.getByText('INV-1')).toBeInTheDocument(); });
    expect(screen.getAllByText('₹900').length).toBeGreaterThan(0);
    expect(screen.getByText('₹162')).toBeInTheDocument();
    expect(screen.getByText('Freight')).toBeInTheDocument();
    expect(screen.getByText('₹1,112')).toBeInTheDocument();
    expect(screen.queryByText('₹1,180')).not.toBeInTheDocument();
  });

  it('uses line discount and backend tax for exclusive-tax orders', async () => {
    useBuyerMeMock.mockReturnValue({
      data: { tenant: { name: 'Acme Traders' },
        business_policy: { gst_inclusive: false, gst_rate: 18 } },
    });
    apiFetchMock.mockResolvedValue({
      json: async () => ({
        order: {
          order_number: 'SO-1', status: 'confirmed', placed_at: '2026-10-01T00:00:00.000Z', notes: null,
          place_of_supply: null, subtotal: 186.44, tax_total: 162, total_amount: 1062,
          discount_flat: 0, freight: 50, round_off: 0,
          items: [{ tenant_product_id: 'p1', product_name: 'P1', internal_sku: null, unit: 'pcs', image_url: null, qty: 10, unit_price: 100, tax_rate: 18, line_total: 1180, disc_pct: 10 }],
        },
      }),
    });
    const { TransactionDetailPage } = await import('@/components/buyer/documents/TransactionDetailPage');
    render(
      <TransactionDetailPage
        id="o-1" title="Order" endpoint="/api/buyer/orders/o-1" docType="order" respectBusinessPolicyTotals
        pickDoc={(payload) => {
          const i = payload.order;
          return i ? {
            docNumber: i.order_number, status: i.status, primaryDate: i.placed_at, secondaryDate: null, notes: null,
            subtotal: i.subtotal, tax_total: i.tax_total, total_amount: i.total_amount, placeOfSupply: null,
            discount_flat: i.discount_flat, freight: i.freight, round_off: i.round_off, items: i.items,
          } : null;
        }}
      />,
    );
    await waitFor(() => { expect(screen.getByText('SO-1')).toBeInTheDocument(); });
    expect(screen.getAllByText('₹900').length).toBeGreaterThan(0);
    expect(screen.getByText('₹162')).toBeInTheDocument();
    expect(screen.getByText('Freight')).toBeInTheDocument();
    expect(screen.getByText('₹1,112')).toBeInTheDocument();
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
