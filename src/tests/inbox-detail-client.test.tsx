import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const useInboxEntriesMock = vi.fn();
const pushMock = vi.fn();
const useBuyerOutstandingInvoicesMock = vi.fn();
const useSalesOrderDetailMock = vi.fn();

vi.mock('@/hooks/useInboxEntries', () => ({
  useInboxEntries: (...args: unknown[]) => useInboxEntriesMock(...args),
  useApplyGenericEntryAction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSendCollectionReminder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEntryHistory: () => ({ data: { events: [] }, isLoading: false }),
  useEnquiryTriage: () => ({ data: undefined, isLoading: false, isError: false }),
  useEntryDocuments: () => ({ data: { documents: [] }, isLoading: false }),
  useBuyerOutstandingInvoices: (...args: unknown[]) => useBuyerOutstandingInvoicesMock(...args),
}));
vi.mock('@/hooks/useSalesOrderDetail', () => ({
  useSalesOrderDetail: (...args: unknown[]) => useSalesOrderDetailMock(...args),
}));
vi.mock('@/hooks/useBusinessPolicy', () => ({
  useBusinessPolicy: () => ({ creditEnabled: true, gstInclusive: false, gstRate: 18 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useParams: () => ({ id: 'b1' }),
}));

import { InboxDetailClient } from '@/components/seller/inbox/InboxDetailClient';
import { SplitPaneCloseContext } from '@/components/seller/layout/EntitySplitShell';

const ENTRIES = [
  {
    id: 'e1', entry_number: 1, tenant_id: 't1', buyer_id: 'b1', buyer_name: 'Sri Krishna Enterprises',
    buyer_phone: '9990001111', location_id: null, entry_type: 'new_order_confirmation', status: 'new',
    source_channel: 'storefront', source_entity_type: 'order', source_entity_id: 'o1',
    title: 'Sri Krishna Enterprises', summary: '₹58,000 · 14 items', amount: 58000, currency: 'INR',
    priority_at: '2026-09-07T10:00:00Z', remind_at: null, created_at: '2026-09-07T10:00:00Z',
    last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
    metadata: {}, allowed_actions: ['accept_order', 'reject'], time_bucket: 'today', customer_entry_count: 2,
  },
  {
    id: 'e2', entry_number: 2, tenant_id: 't1', buyer_id: 'b1', buyer_name: 'Sri Krishna Enterprises',
    buyer_phone: '9990001111', location_id: null, entry_type: 'invoice_due', status: 'new',
    source_channel: 'backend', source_entity_type: 'invoice', source_entity_id: 'inv1',
    title: 'Sri Krishna Enterprises', summary: '₹18,400 due in 4 days', amount: 18400, currency: 'INR',
    priority_at: '2026-09-05T10:00:00Z', remind_at: null, created_at: '2026-09-05T10:00:00Z',
    last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
    metadata: { invoice_number: 'INV-1042', due_date: '2026-09-18T00:00:00Z', days_from_due: 4, aging_tier: 'due_soon' }, allowed_actions: ['send_reminder'], time_bucket: 'this_week', customer_entry_count: 2,
  },
];

const CREDIT_LIMIT_ENTRY = {
  id: 'credit-1', entry_number: 3, tenant_id: 't1', buyer_id: 'b1', buyer_name: 'Sri Krishna Enterprises',
  buyer_phone: '9990001111', location_id: null, entry_type: 'credit_limit_breach', status: 'new',
  source_channel: 'backend', source_entity_type: 'buyer', source_entity_id: 'b1',
  title: 'Sri Krishna Enterprises', summary: 'Over credit limit', amount: 25000, currency: 'INR',
  priority_at: '2026-09-08T10:00:00Z', remind_at: null, created_at: '2026-09-08T10:00:00Z',
  last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
  metadata: {
    over_limit_amount: 25000,
    credit_limit: 100000,
    payment_terms_days: 30,
    outstanding_balance: 125000,
  },
  allowed_actions: ['adjust_limit'],
  time_bucket: 'today',
  customer_entry_count: 1,
};

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
    phone: '9990001111',
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
    phone: '9990001111',
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

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InboxDetailClient buyerId="b1" />
    </QueryClientProvider>,
  );
}

describe('InboxDetailClient', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    useInboxEntriesMock.mockReset();
    useBuyerOutstandingInvoicesMock.mockReset();
    useBuyerOutstandingInvoicesMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    useSalesOrderDetailMock.mockReset();
    useSalesOrderDetailMock.mockReturnValue({ data: ORDER_DETAIL, isLoading: false, isError: false });
    useInboxEntriesMock.mockReturnValue({ data: { entries: ENTRIES, nextCursor: null }, isLoading: false });
  });

  it('renders a card stack for a customer with multiple open items, all collapsed by default', () => {
    renderDetail();
    expect(screen.getByText('Sri Krishna Enterprises')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept order' })).not.toBeInTheDocument();
  });

  it('expands one card at a time', () => {
    renderDetail();
    fireEvent.click(screen.getByText(/58,000/));
    expect(screen.getByRole('button', { name: 'Accept order' })).toBeInTheDocument();
    expect(screen.getByText('SO-00042')).toBeInTheDocument();
    expect(screen.getAllByText('CAT6 Cable').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Upcoming dues or overdue/ }));
    expect(screen.queryByRole('button', { name: 'Accept order' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
    expect(screen.getByText('INV-1042')).toBeInTheDocument();
    expect(screen.getByText('Due in 4 days')).toBeInTheDocument();
  });

  it('never renders a close-pane button — Inbox has no closed state, even when the shell provides a close callback', () => {
    const closeMock = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SplitPaneCloseContext.Provider value={closeMock}>
          <InboxDetailClient buyerId="b1" />
        </SplitPaneCloseContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Close detail pane' })).not.toBeInTheDocument();
  });

  it('shows the customer name and open-issue count in the header', () => {
    renderDetail();
    expect(screen.getByText('Sri Krishna Enterprises')).toBeInTheDocument();
    expect(screen.getByText('2 open issues')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View Sri Krishna Enterprises/i })).not.toBeInTheDocument();
  });

  it('shows a loading skeleton (not the fallback empty message) while entries are still loading', () => {
    useInboxEntriesMock.mockReturnValue({ data: undefined, isLoading: true });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <InboxDetailClient buyerId="b1" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText(/no longer in your active list/i)).not.toBeInTheDocument();
  });

  it('resolves a buyer-less entry by its own id (buyer_id is null before a buyer row exists)', () => {
    const BUYERLESS_ENTRY = {
      id: 'entry-no-buyer', entry_number: 3, tenant_id: 't1', buyer_id: null, buyer_name: 'New signup',
      buyer_phone: '9990002222', location_id: null, entry_type: 'invoice_due', status: 'new',
      source_channel: 'backend', source_entity_type: 'invoice', source_entity_id: 'inv-x',
      title: 'New signup', summary: '₹5,000 due', amount: 5000, currency: 'INR',
      priority_at: '2026-09-07T10:00:00Z', remind_at: null, created_at: '2026-09-07T10:00:00Z',
      last_actor_id: null, last_action: null, last_action_at: null, external_sync_status: 'not_required',
      metadata: {}, allowed_actions: ['send_reminder'], time_bucket: 'today', customer_entry_count: 1,
    };
    useInboxEntriesMock.mockReturnValue({ data: { entries: [BUYERLESS_ENTRY], nextCursor: null }, isLoading: false });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <InboxDetailClient buyerId="entry-no-buyer" />
      </QueryClientProvider>,
    );
    expect(screen.getByText('New signup')).toBeInTheDocument();
    expect(screen.queryByText(/no longer in your active list/i)).not.toBeInTheDocument();
  });

  it('hides the Show history CTA', () => {
    renderDetail();
    expect(screen.queryByRole('button', { name: /show history/i })).not.toBeInTheDocument();
  });

  it('renders over-limit cards as grouped open invoices with the total outstanding, without a repeated context box', () => {
    useInboxEntriesMock.mockReturnValue({ data: { entries: [CREDIT_LIMIT_ENTRY], nextCursor: null }, isLoading: false });
    useBuyerOutstandingInvoicesMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        invoices: [
          { id: 'i1', invoice_number: 'INV-1', due_date: '2020-01-01', outstanding_amount: 100000 },
          { id: 'i2', invoice_number: 'INV-2', due_date: '2999-01-01', outstanding_amount: 25000 },
        ],
      },
    });
    renderDetail();

    expect(screen.getByText('₹25,000 over your ₹1,00,000 limit')).toBeInTheDocument();
    expect(screen.queryByText(/when flagged/)).not.toBeInTheDocument();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText(/30\+ days overdue/)).toBeInTheDocument();
    expect(screen.getByText('Not yet due')).toBeInTheDocument();
    expect(screen.getByText('Total outstanding')).toBeInTheDocument();
    expect(screen.getAllByText('₹1,25,000').length).toBeGreaterThan(0);
    expect(screen.queryByText('Net payment terms')).not.toBeInTheDocument();

    const actions = screen.getAllByRole('button').map((button) => button.textContent?.trim()).filter(Boolean);
    expect(actions.indexOf('Adjust limit')).toBeLessThan(actions.indexOf('Send reminder'));
  });
});
