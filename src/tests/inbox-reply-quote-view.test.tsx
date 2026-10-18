import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let gstInclusiveMock = false;
const saveMutateAsync = vi.fn().mockResolvedValue({ data: {} });
const sendMutateAsync = vi.fn().mockResolvedValue({});

const COMPOSER_ITEMS = [
  {
    id: 'l1', tenant_product_id: 'p1', product_name: 'Gate Valve 150mm', sku: 'SKU-1',
    brand_name: '', brand_initials: '', brand_hue: 'cream', image_url: null, hsn_code: null,
    on_hand: 0, qty: 1, unit_price: 0, mrp: 1500, base_selling_price: 1500,
    disc_pct: 0, tax_pct: 18, line_total: 0, item_order: 1, scheme_tag: null,
    buyer_target_unit_price_min: 1800, buyer_target_unit_price_max: 2000,
  },
  {
    id: 'l2', tenant_product_id: 'p2', product_name: 'Wing Nut 15mm', sku: 'SKU-2',
    brand_name: '', brand_initials: '', brand_hue: 'cream', image_url: null, hsn_code: null,
    on_hand: 40, qty: 2, unit_price: 40, mrp: 50, base_selling_price: 50,
    disc_pct: 0, tax_pct: 18, line_total: 80, item_order: 2, scheme_tag: null,
    buyer_target_unit_price_min: null, buyer_target_unit_price_max: null,
  },
];

vi.mock('@/hooks/useEstimates', () => ({
  useEstimateComposer: () => ({
    data: { id: 'est-1', buyer_id: 'b1', seller_note: '', items: COMPOSER_ITEMS },
    isLoading: false,
    isError: false,
  }),
  useEstimateProductSearch: () => ({ data: [], isLoading: false }),
  useSaveEstimateComposer: () => ({ mutateAsync: saveMutateAsync, isPending: false }),
  useSendEstimateDetailWhatsApp: () => ({ mutateAsync: sendMutateAsync, isPending: false }),
}));

vi.mock('@/hooks/useInboxEntries', () => ({
  useBuyerOutstandingInvoices: () => ({ data: undefined, isLoading: false, isError: false }),
  useEnquiryTriage: () => ({
    data: {
      lines: [
        { id: 'l1', resolvedPrice: 1750, velocity: { unitsPerWeek: 0, daysCover: null, lastInvoiceAt: null }, alternates: [] },
        { id: 'l2', resolvedPrice: 45, velocity: { unitsPerWeek: 3, daysCover: 10, lastInvoiceAt: null }, alternates: [] },
      ],
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/hooks/useBusinessPolicy', () => ({
  useBusinessPolicy: () => ({ creditEnabled: true, gstInclusive: gstInclusiveMock, gstRate: 18, policyLoading: false }),
}));

import { InboxReplyQuoteSheet } from '@/components/seller/inbox/InboxReplyQuoteSheet';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

const ENTRY = {
  id: 'e1', entry_number: 1, tenant_id: 't1', buyer_id: 'b1', buyer_name: 'Phani Krishna Yukti',
  buyer_phone: null, location_id: null, entry_type: 'new_enquiry', status: 'new',
  source_channel: 'storefront', source_entity_type: 'estimate', source_entity_id: 'est-1',
  title: 'Phani Krishna Yukti', summary: '₹0 · Open enquiry', amount: 0, currency: 'INR',
  priority_at: '2026-09-23T10:00:00Z', remind_at: null, created_at: '2026-09-23T10:00:00Z',
  last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
  metadata: {}, allowed_actions: ['reply_quote'], time_bucket: 'today', customer_entry_count: 1,
} as unknown as InboxEntry;

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InboxReplyQuoteSheet entry={ENTRY} open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('InboxReplyQuoteSheet / InboxReplyQuoteView', () => {
  beforeEach(() => {
    gstInclusiveMock = false;
  });

  it('shows every line regardless of price state, with target, resolved price, stock, and recent sales', () => {
    renderSheet();
    expect(screen.getByText('Gate Valve 150mm')).toBeInTheDocument();
    expect(screen.getByText('Wing Nut 15mm')).toBeInTheDocument();
    expect(screen.getByText('₹1,800 – ₹2,000')).toBeInTheDocument();
    expect(screen.getByText('₹1,750')).toBeInTheDocument();
    expect(screen.getByText('~3/wk')).toBeInTheDocument();
  });

  it('keeps a removed line visible, struck-through, and excludes it from the saved payload', async () => {
    renderSheet();
    const removeButtons = screen.getAllByRole('button', { name: /^Remove /i });
    fireEvent.click(removeButtons[0]!);
    // Still visible.
    expect(screen.getByText('Gate Valve 150mm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Undo remove/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(saveMutateAsync).toHaveBeenCalled();
    const payload = saveMutateAsync.mock.calls.at(-1)![0];
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].id).toBe('l2');
  });

  it('recomputes totals live as a price draft changes', () => {
    renderSheet();
    const totalBefore = screen.getByText('Total').nextElementSibling!.textContent;

    // The first line has no unit_price yet -- its price input starts empty.
    const priceInputs = screen.getAllByRole('textbox').filter((el) => (el as HTMLInputElement).value === '');
    expect(priceInputs.length).toBeGreaterThan(0);
    fireEvent.change(priceInputs[0]!, { target: { value: '1900' } });

    const totalAfter = screen.getByText('Total').nextElementSibling!.textContent;
    expect(totalAfter).not.toBe(totalBefore);
    // 1900 * qty 1 at 18% GST = 2242, plus the unchanged line's 80 taxable + 14.4 tax = 94.4 -> 2336.40 total.
    expect(totalAfter).toBe('₹2,336.40');
  });

  it('adds no GST on top and shows it as included when the tenant policy is inclusive', () => {
    gstInclusiveMock = true;
    renderSheet();
    const priceInputs = screen.getAllByRole('textbox').filter((el) => (el as HTMLInputElement).value === '');
    fireEvent.change(priceInputs[0]!, { target: { value: '1900' } });

    expect(screen.getByText('Included in prices')).toBeInTheDocument();
    // 1900 + the unchanged line's 80 taxable = 1980, no GST added.
    expect(screen.getByText('Total').nextElementSibling!.textContent).toBe('₹1,980');
  });
});
