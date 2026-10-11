import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const useInboxEntriesMock = vi.fn();
const useSalesOrderDetailMock = vi.fn();

vi.mock('@/hooks/useInboxEntries', () => ({
  useBuyerOutstandingInvoices: () => ({ data: undefined, isLoading: false, isError: false }),
  useInboxEntries: (...args: unknown[]) => useInboxEntriesMock(...args),
  useApplyGenericEntryAction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSendCollectionReminder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEntryHistory: () => ({ data: { events: [] }, isLoading: false }),
  useEnquiryTriage: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock('@/hooks/useSalesOrderDetail', () => ({
  useSalesOrderDetail: (...args: unknown[]) => useSalesOrderDetailMock(...args),
}));
vi.mock('@/hooks/useBusinessPolicy', () => ({
  useBusinessPolicy: () => ({ creditEnabled: true, gstInclusive: false, gstRate: 18 }),
}));
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useParams: () => ({ buyerId: 'b1' }),
}));

import { InboxDetailClient } from '@/components/seller/inbox/InboxDetailClient';

const ENTRIES = [
  {
    id: 'e1', entry_number: 1, tenant_id: 't1', buyer_id: 'b1', buyer_name: 'Sri Krishna Enterprises',
    buyer_phone: null, location_id: null, entry_type: 'new_order_confirmation', status: 'new',
    source_channel: 'storefront', source_entity_type: 'order', source_entity_id: 'o1',
    title: 'Sri Krishna Enterprises', summary: '₹58,000 · 14 items', amount: 58000, currency: 'INR',
    priority_at: '2026-09-07T10:00:00Z', remind_at: null, created_at: '2026-09-07T10:00:00Z',
    last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
    metadata: {}, allowed_actions: ['accept_order', 'reject'], time_bucket: 'today', customer_entry_count: 2,
  },
  {
    id: 'e2', entry_number: 2, tenant_id: 't1', buyer_id: 'b1', buyer_name: 'Sri Krishna Enterprises',
    buyer_phone: null, location_id: null, entry_type: 'invoice_due', status: 'new',
    source_channel: 'backend', source_entity_type: 'invoice', source_entity_id: 'inv1',
    title: 'Sri Krishna Enterprises', summary: '₹18,400 due in 4 days', amount: 18400, currency: 'INR',
    priority_at: '2026-09-05T10:00:00Z', remind_at: null, created_at: '2026-09-05T10:00:00Z',
    last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
    metadata: { invoice_number: 'INV-1042', due_date: '2026-09-18T00:00:00Z', days_from_due: 4, aging_tier: 'due_soon' }, allowed_actions: ['send_reminder'], time_bucket: 'this_week', customer_entry_count: 2,
  },
];

const ORDER_DETAIL = {
  id: 'o1',
  order_number: 'SO-00042',
  location_id: null,
  location_name: 'Main branch',
  db_status: 'received',
  ui_status: 'received',
  placed_at: '2026-09-07T10:00:00Z',
  source: 'storefront',
  is_buyer_app: true,
  catalog_name: 'General',
  subtotal: 58000,
  tax_amount: 0,
  total_amount: 58000,
  currency: 'INR',
  notes: 'Deliver tomorrow',
  cancel_reason: null,
  viewer_role: 'seller_admin',
  buyer_context: {
    id: 'b1',
    business_name: 'Sri Krishna Enterprises',
    contact_name: null,
    phone: null,
    email: null,
    gstin: null,
    bill_address: 'Hyderabad',
    city: 'Hyderabad',
    state: 'TS',
    pincode: null,
    place_of_supply: 'TS',
    seller_state: 'TS',
    payment_terms_days: 30,
    credit_limit: 100000,
    credit_used: 0,
    credit_available: 100000,
    active_pricelist: null,
    sales_agent_name: null,
  },
  discount_flat: 0,
  freight: 0,
  round_off: 0,
  has_backorder: false,
  expected_delivery: '2026-09-09',
  buyer_po_ref: null,
  place_of_supply: 'TS',
  seller_note: null,
  received_at: '2026-09-07T10:00:00Z',
  confirmed_at: null,
  dispatched_at: null,
  delivered_at: null,
  cancelled_at: null,
  carrier: null,
  dispatch_notes: null,
  buyer: {
    id: 'b1',
    name: 'Sri Krishna Enterprises',
    city: 'Hyderabad',
    state: 'TS',
    gstin: null,
    credit_limit: 100000,
    payment_terms_days: 30,
    contact_name: null,
    phone: null,
  },
  lines: [
    {
      id: 'ol1',
      tenant_product_id: '00000000-0000-0000-0000-000000000001',
      name: 'CAT6 Cable',
      brand: 'CP Plus',
      brand_initials: 'CP',
      brand_hue: 'teal',
      image_url: null,
      sku: 'CP-CAT6',
      qty: 2,
      unit_price: 29000,
      tax_rate: 0,
      tax_pct: 0,
      disc_pct: 0,
      hsn_code: null,
      unit: 'unit',
      line_total: 58000,
      on_hand: 10,
      on_hand_at_confirm: null,
      scheme_tag: null,
    },
  ],
  invoice: null,
  estimate: null,
  activity: [],
  stepper_timestamps: { received: '2026-09-07T10:00:00Z' },
};

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: width >= 768,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InboxDetailClient buyerId="b1" />
    </QueryClientProvider>,
  );
}

describe('InboxDetailClient on mobile', () => {
  beforeEach(() => {
    useInboxEntriesMock.mockReset();
    useSalesOrderDetailMock.mockReset();
    pushMock.mockReset();
    useSalesOrderDetailMock.mockReturnValue({ data: ORDER_DETAIL, isLoading: false, isError: false });
    useInboxEntriesMock.mockReturnValue({ data: { entries: ENTRIES, nextCursor: null }, isLoading: false });
    setViewportWidth(375);
  });

  it('renders a non-collection entry as a tappable row that pushes to its own stacked screen', () => {
    renderDetail();
    const row = screen.getByRole('button', { name: /New order/ });
    expect(row).toBeInTheDocument();
    fireEvent.click(row);
    expect(pushMock).toHaveBeenCalledWith('/inbox/b1/e1');
    // Row navigates away instead of expanding inline -- no per-item action CTA here.
    expect(screen.queryByRole('button', { name: 'Accept order' })).not.toBeInTheDocument();
  });

  it('renders the grouped Dues as a card like the other rows, navigating to its own screen', () => {
    renderDetail();
    const duesCard = screen.getByRole('button', { name: /Upcoming dues or overdue/ });
    // Card, not an accordion: nothing expands inline, no invoice list or actions in the flow.
    expect(duesCard).not.toHaveAttribute('aria-expanded');
    expect(screen.queryByRole('button', { name: 'Send reminder' })).not.toBeInTheDocument();
    expect(screen.queryByText('INV-1042')).not.toBeInTheDocument();

    fireEvent.click(duesCard);
    expect(pushMock).toHaveBeenCalledWith('/inbox/b1/dues');
  });

  it('opens the only open entry directly instead of a one-row list', () => {
    const [orderEntry] = ENTRIES.filter((e) => e.entry_type !== 'invoice_due' && e.entry_type !== 'invoice_overdue');
    useInboxEntriesMock.mockReturnValue({ data: { entries: [orderEntry], nextCursor: null }, isLoading: false });
    renderDetail();
    expect(screen.getByRole('heading', { name: /New order/ })).toBeInTheDocument();
    expect(screen.getByText('SO-00042')).toBeInTheDocument();
    expect(screen.getAllByText('CAT6 Cable').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /New order/ })).not.toBeInTheDocument();
  });
});
