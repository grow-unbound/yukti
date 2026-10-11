'use client';
import { InboxApprovalDetails } from '@/components/seller/inbox/InboxApprovalDetails';
import { ExistingBuyerAccountPicker } from '@/components/buyer/onboarding/ExistingBuyerAccountPicker';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

const entry = {
  id: 'e1', entry_type: 'business_approval', buyer_phone: '8074139572', created_at: '2026-10-01T10:00:00Z',
  metadata: {
    business_name: 'Sri Lakshmi Wines & Traders', contact_name: 'Ravi Kumar', phone: '8074139572', gstin: '36ABCDE1234F1Z5',
    request_kind: 'existing_buyer_access',
    buyer_context: {
      sales: { current: { invoice_value: 12345678, invoice_count: 41 }, previous: { invoice_value: 8450000, invoice_count: 28 } },
      demand: { kind: 'orders', current: { value: 950000, count: 12 }, previous: { value: 0, count: 0 } },
      dues: { receivable_amount: 3012345, receivable_invoice_count: 7, overdue_amount: 1250000, overdue_invoice_count: 3, credit_limit: 5000000, credit_available: 1987655 },
      sources: { period: 'live', dues: 'summary' }, computed_at: '2026-10-01T17:24:00Z',
    },
  },
} as unknown as InboxEntry;

export default function Scratch() {
  return (
    <div className="mx-auto max-w-[760px] space-y-10 p-4 bg-white">
      <section><p className="mb-3 text-xs text-cream-500">INBOX ENTRY BODY (desktop width up to 760, resize for mobile)</p><div className="rounded-xl border border-cream-300 px-4 py-5 sm:px-6"><InboxApprovalDetails entry={entry} /></div></section>
      <section className="max-w-md"><p className="mb-3 text-xs text-cream-500">ACCOUNT PICKER</p>
        <ExistingBuyerAccountPicker selectedBuyerId="b1" busyBuyerId={null} onSelect={() => {}} onAction={() => {}}
          accounts={[
            { buyer_id: 'a1', business_name: 'Sri Lakshmi Wines — Banjara Hills', contact_name: 'Ravi Kumar', state: 'active' },
            { buyer_id: 'b1', business_name: 'Sri Lakshmi Wines — Kukatpally', contact_name: 'Ravi Kumar', state: 'can_request' },
            { buyer_id: 'b2', business_name: 'Sri Lakshmi Bar & Restaurant', contact_name: null, state: 'can_request' },
            { buyer_id: 'c1', business_name: 'SLW Warehouse', contact_name: null, state: 'requested' },
            { buyer_id: 'd1', business_name: 'SLW Old Account', contact_name: null, state: 'needs_more_info' },
            { buyer_id: 'e1', business_name: 'SLW New Outlet', contact_name: null, state: 'declined' },
          ]} />
      </section>
    </div>
  );
}
