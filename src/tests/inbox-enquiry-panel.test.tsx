import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EnquiryTriagePayload } from '@/lib/inbox/enquiry-triage';

const substituteMutateAsync = vi.fn().mockResolvedValue({});
let triagePayload: EnquiryTriagePayload = {
  estimateId: 'est-1',
  estimateNumber: 'EST-016127',
  status: 'sent',
  hiddenPricing: false,
  collectTargetUnitPriceRange: false,
  totalAmount: 5000,
  notes: 'Please ship by Friday',
  lines: [
    {
      id: 'l1', tenantProductId: 'p1', name: 'CAT6 Cable', sku: 'SKU-1', brandName: 'Brand A',
      qty: 10, unitPrice: 500, resolvedPrice: 500, targetMin: null, targetMax: null, buyerNote: 'urgent for install',
      onHand: 2, stock: { tone: 'danger', label: 'Out of stock', shortBy: 10 }, priceState: 'priced_oos',
      velocity: { unitsPerWeek: 3, daysCover: 12, lastInvoiceAt: null },
      alternates: [
        {
          tenantProductId: 'alt-1', name: 'CAT6 Cable (Brand B)', sku: 'SKU-2', brandName: 'Brand B',
          available: 40, velocity: { unitsPerWeek: 5, daysCover: 8, lastInvoiceAt: null },
          sameBrand: false, sameCategory: true, buyerPrice: 480,
        },
      ],
    },
  ],
};

vi.mock('@/hooks/useInboxEntries', () => ({
  useBuyerOutstandingInvoices: () => ({ data: undefined, isLoading: false, isError: false }),
  useEnquiryTriage: () => ({
    data: triagePayload,
    isLoading: false,
    isError: false,
  }),
  useSubstituteEnquiryLine: () => ({ mutateAsync: substituteMutateAsync, isPending: false }),
}));

vi.mock('@/hooks/useEstimates', () => ({
  useEstimateComposer: () => ({
    data: { items: [{ id: 'l1', image_url: null }], subtotal: 5000, tax_amount: 900, total_amount: 5900, seller_note: 'Ships Friday' },
  }),
}));

import { InboxEnquiryPanel } from '@/components/seller/inbox/InboxEnquiryPanel';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InboxEnquiryPanel entryId="e1" />
    </QueryClientProvider>,
  );
}

describe('InboxEnquiryPanel', () => {
  beforeEach(() => {
    substituteMutateAsync.mockClear();
    triagePayload = {
      estimateId: 'est-1',
      estimateNumber: 'EST-016127',
      status: 'sent',
      hiddenPricing: false,
      collectTargetUnitPriceRange: false,
      totalAmount: 5000,
      notes: 'Please ship by Friday',
      lines: [
        {
          id: 'l1', tenantProductId: 'p1', name: 'CAT6 Cable', sku: 'SKU-1', brandName: 'Brand A',
          qty: 10, unitPrice: 500, resolvedPrice: 500, targetMin: null, targetMax: null, buyerNote: 'urgent for install',
          onHand: 2, stock: { tone: 'danger', label: 'Out of stock', shortBy: 10 }, priceState: 'priced_oos',
          velocity: { unitsPerWeek: 3, daysCover: 12, lastInvoiceAt: null },
          alternates: [
            {
              tenantProductId: 'alt-1', name: 'CAT6 Cable (Brand B)', sku: 'SKU-2', brandName: 'Brand B',
              available: 40, velocity: { unitsPerWeek: 5, daysCover: 8, lastInvoiceAt: null },
              sameBrand: false, sameCategory: true, buyerPrice: 480,
            },
          ],
        },
      ],
    };
  });

  it('shows buyer quantity, resolved catalog price, totals and the seller note', () => {
    renderPanel();
    expect(screen.getByText('Quantity')).toBeInTheDocument();
    expect(screen.getByText('Price/unit')).toBeInTheDocument();
    expect(screen.queryByText('Quote')).not.toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
    expect(screen.getAllByText('₹500').length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('₹5,900')).toBeInTheDocument();
    expect(screen.getByText('Ships Friday')).toBeInTheDocument();
  });

  it('drops the estimate-number/total header row and the estimate-level buyer note', () => {
    renderPanel();
    expect(screen.queryByText('EST-016127')).not.toBeInTheDocument();
    expect(screen.queryByText(/Please ship by Friday/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open full enquiry/)).not.toBeInTheDocument();
  });

  it('keeps the per-line buyer note', () => {
    renderPanel();
    expect(screen.getAllByText('“urgent for install”').length).toBeGreaterThan(0);
  });

  it('keeps only the stock-gap control and opens alternatives without a stock/sales detail CTA', () => {
    renderPanel();
    const stockButtons = screen.getAllByRole('button', { name: /stock gap: out of stock/i });
    expect(stockButtons.length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /stock and sales/i })).not.toBeInTheDocument();
    fireEvent.click(stockButtons[0]);
    expect(screen.getByText('CAT6 Cable (Brand B)')).toBeInTheDocument();
    expect(screen.getByText('~5/wk')).toBeInTheDocument();
  });

  it('uses target and quote pricing only when hidden-price catalog collects target ranges', () => {
    triagePayload = {
      ...triagePayload,
      hiddenPricing: true,
      collectTargetUnitPriceRange: true,
      lines: [{
        ...triagePayload.lines[0],
        unitPrice: null,
        targetMin: 450,
        targetMax: 475,
        resolvedPrice: 500,
        stock: { tone: 'ok', label: 'In stock', shortBy: 0 },
        onHand: 25,
        velocity: { unitsPerWeek: 0, daysCover: null, lastInvoiceAt: null },
        alternates: [],
      }],
    };
    renderPanel();
    expect(screen.getByText('Expected')).toBeInTheDocument();
    expect(screen.getByText('₹450 – ₹475')).toBeInTheDocument();
    expect(screen.getAllByText(/Base Price ₹500/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Your quote')).not.toBeInTheDocument();
  });

  it('does not show expected pricing when hidden-price catalog target capture is off', () => {
    triagePayload = {
      ...triagePayload,
      hiddenPricing: true,
      collectTargetUnitPriceRange: false,
      lines: [{
        ...triagePayload.lines[0],
        unitPrice: null,
        targetMin: 450,
        targetMax: 475,
        resolvedPrice: 500,
        stock: { tone: 'ok', label: 'In stock', shortBy: 0 },
        onHand: 25,
        velocity: { unitsPerWeek: 0, daysCover: null, lastInvoiceAt: null },
        alternates: [],
      }],
    };
    renderPanel();
    expect(screen.getByText('Price/unit')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
    expect(screen.queryByText('₹450 – ₹475')).not.toBeInTheDocument();
    expect(screen.getAllByText('₹500').length).toBeGreaterThan(0);
  });

  it('shows the alternate’s buyer-resolved price and substitutes inline on click', async () => {
    renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: /stock gap: out of stock/i })[0]);
    expect(screen.getByText('₹480')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Substitute' }));
    await waitFor(() => {
      expect(substituteMutateAsync).toHaveBeenCalledWith({ estimateId: 'est-1', lineId: 'l1', tenantProductId: 'alt-1' });
    });
  });
});
