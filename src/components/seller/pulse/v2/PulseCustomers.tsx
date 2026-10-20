'use client';

import Link from 'next/link';

import { RankedList } from '@/components/seller/detail';
import { ErrorState } from '@/components/ui/empty-state';
import { usePulseCustomers, usePulseScorecard } from '@/hooks/usePulseV2';
import { formatNumberValue } from '@/lib/utils';
import type { PulseCustomerRow } from '@/types/pulse-v2';

import { PulseBandShell } from './PulseBandShell';
import { useNearViewport } from './useNearViewport';

const money = (n: number) => formatNumberValue(n, 'CURRENCY_THRESHOLD');
const count = (n: number) => formatNumberValue(n, 'COUNT');
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[14px] border border-cream-200 bg-white px-[18px] py-[14px]">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-600">{label}</p>
      <p className="mt-2 font-display text-lg text-cream-950">{value}</p>
      {sub ? <p className="mt-1 text-xs text-cream-700">{sub}</p> : null}
    </div>
  );
}

function rows(top: PulseCustomerRow[]) {
  return top.map((r) => ({
    id: r.buyer_id,
    label: <Link href={`/customers/${r.buyer_id}`} className="block truncate text-cream-900 no-underline hover:text-teal-700">{r.name}</Link>,
    meta: `${count(r.invoiced_docs)} ${plural(r.invoiced_docs, 'invoice', 'invoices')} · ${count(r.quoted_docs)} ${plural(r.quoted_docs, 'quote', 'quotes')} (${money(r.quoted_value)})`,
    value: money(r.invoiced_value),
    valueSupporting: 'invoiced',
    initials: r.name.split(' ').map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase(),
  }));
}

export function PulseCustomersSkeleton() {
  return (
    <div className="mt-4 animate-pulse space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-[14px] border border-cream-200 bg-cream-100" />)}
      </div>
      <div className="h-64 rounded-[14px] border border-cream-200 bg-cream-100" />
    </div>
  );
}

export function PulseCustomers({ query }: { query: string }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const q = usePulseCustomers(query, near);
  const sc = usePulseScorecard(query).data;
  const s = q.data?.summary;
  const top3Share = s && s.invoiced_value > 0 ? Math.round((s.top3_invoiced_value / s.invoiced_value) * 100) : null;

  return (
    <div ref={ref}>
      <PulseBandShell
        id="customers"
        title="Your customers"
        subtitle="Who bought the most through the app, how many came back, and how much rests on a few customers."
        isFetching={q.isFetching && !q.isLoading}
      >
        {!near || q.isLoading ? <PulseCustomersSkeleton /> : null}
        {q.isError ? <div className="mt-4"><ErrorState heading="This view could not load" description="The rest of Pulse remains available." /></div> : null}
        {q.data && s ? (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
              <Stat
                label="Customers ordering"
                value={count(s.buyers)}
                sub={sc ? `${count(sc.quoting_buyers.new)} new · ${count(sc.quoting_buyers.returning)} returning · ${count(sc.quoting_buyers.reactivated)} came back` : undefined}
              />
              <Stat label="Invoiced twice or more" value={count(s.repeat_buyers)} sub={`of ${count(s.invoicing_buyers)} ${plural(s.invoicing_buyers, 'customer', 'customers')} invoiced`} />
              <Stat label="Typical invoice" value={s.median_invoice != null ? money(s.median_invoice) : '—'} sub={s.avg_invoice != null ? `Average ${money(s.avg_invoice)}` : 'No invoices in this period'} />
              <Stat
                label="Top 3 customers"
                value={top3Share != null ? `${top3Share}%` : '—'}
                sub={top3Share != null ? 'of app invoiced value' : 'No invoices in this period'}
              />
            </div>
            <div className="rounded-[14px] border border-cream-200 bg-white">
              <RankedList items={rows(q.data.top)} emptyTitle="No customers yet" emptyDescription="Nobody has ordered through the app in this period." compact />
            </div>
          </div>
        ) : null}
      </PulseBandShell>
    </div>
  );
}
