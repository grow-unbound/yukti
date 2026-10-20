'use client';

import { ErrorState } from '@/components/ui/empty-state';
import { usePulseFunnel } from '@/hooks/usePulseV2';
import { formatNumberValue } from '@/lib/utils';
import type { PulseFunnelResponse } from '@/types/pulse-v2';

import { PulseBandShell } from './PulseBandShell';

const STEPS: Array<{ key: keyof NonNullable<PulseFunnelResponse['funnel']>; label: string }> = [
  { key: 'users', label: 'Used the app' },
  { key: 'browsed', label: 'Browsed the catalogue' },
  { key: 'quoted', label: 'Sent a quote or order' },
  { key: 'invoiced', label: 'Were invoiced' },
];

function Funnel({ funnel }: { funnel: NonNullable<PulseFunnelResponse['funnel']> }) {
  const top = Math.max(funnel.users, funnel.browsed, funnel.quoted, funnel.invoiced, 1);
  return (
    <ol className="space-y-3" aria-label="Customers at each step">
      {STEPS.map((step) => {
        const value = funnel[step.key];
        return (
          <li key={step.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-cream-800">{step.label}</span>
              <span className="font-display text-base text-cream-950">{formatNumberValue(value, 'COUNT')}</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-cream-100" aria-hidden="true">
              <div className="h-2 rounded-full bg-teal-600" style={{ width: `${Math.max(2, Math.round((value / top) * 100))}%` }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Strip({ days }: { days: PulseFunnelResponse['days'] }) {
  const max = Math.max(...days.map((d) => d.active_buyers), 1);
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-cream-800">Customers using the app each day</p>
      <div className="flex h-24 items-end gap-[2px]" role="img" aria-label="Daily number of customers who used the app">
        {days.map((d) => (
          <div
            key={d.day}
            title={`${d.day}: ${d.active_buyers} customers, ${d.quotes} quotes`}
            className="flex-1 rounded-t bg-teal-600/80"
            style={{ height: `${Math.max(d.active_buyers > 0 ? 4 : 1, Math.round((d.active_buyers / max) * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function PulseFunnelSkeleton() {
  return (
    <div className="mt-4 grid animate-pulse grid-cols-1 gap-6 rounded-[14px] border border-cream-200 bg-cream-100 p-5 lg:grid-cols-2">
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-4 w-48 rounded bg-cream-200" />
            <div className="mt-2 h-2 rounded bg-cream-200" />
          </div>
        ))}
      </div>
      <div className="h-32 rounded bg-cream-200" />
    </div>
  );
}

export function PulseFunnel({ query }: { query: string }) {
  const q = usePulseFunnel(query);
  return (
    <PulseBandShell
      id="funnel"
      title="From browsing to invoice"
      subtitle="How many of your customers moved from using the app to ordering and being invoiced in this period."
      isFetching={q.isFetching && !q.isLoading}
    >
      {q.isLoading ? <PulseFunnelSkeleton /> : null}
      {q.isError ? <div className="mt-4"><ErrorState heading="This view could not load" description="The rest of Pulse remains available." /></div> : null}
      {q.data?.capped ? (
        <div className="mt-4 rounded-[8px] border border-cream-200 bg-cream-50 p-5 text-sm text-cream-700">
          This view covers up to 92 days. Choose a shorter period to see how customers moved from browsing to invoice.
        </div>
      ) : null}
      {q.data && !q.data.capped && q.data.funnel ? (
        <div className="mt-4 grid grid-cols-1 gap-6 rounded-[14px] border border-cream-200 bg-white p-5 lg:grid-cols-2">
          <Funnel funnel={q.data.funnel} />
          <Strip days={q.data.days} />
        </div>
      ) : null}
    </PulseBandShell>
  );
}
