'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { usePulseSellThrough } from '@/hooks/usePulseV2';
import { formatNumberValue } from '@/lib/utils';
import type { PulseSellDimension, PulseSellRow } from '@/types/pulse-v2';

import { PulseBandShell } from './PulseBandShell';
import { useNearViewport } from './useNearViewport';

const TABS: Array<{ key: PulseSellDimension; label: string; noun: string }> = [
  { key: 'category', label: 'Categories', noun: 'categories' },
  { key: 'brand', label: 'Brands', noun: 'brands' },
  { key: 'product', label: 'Products', noun: 'products' },
];

const money = (n: number) => formatNumberValue(n, 'CURRENCY_THRESHOLD');

function SellRow({ row, top }: { row: PulseSellRow; top: number }) {
  const quotedPct = Math.max(row.quoted_value > 0 ? 2 : 0, Math.round((row.quoted_value / top) * 100));
  const invoicedPct = Math.max(row.invoiced_value > 0 ? 2 : 0, Math.round((row.invoiced_value / top) * 100));
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-cream-900">{row.name}</span>
        <span className="shrink-0 text-xs text-cream-600">
          {formatNumberValue(row.quoted_qty, 'COUNT')} units quoted · {formatNumberValue(row.invoiced_qty, 'COUNT')} invoiced
        </span>
      </div>
      <div className="mt-2 space-y-1" aria-hidden="true">
        <div className="h-2 rounded-full bg-cream-100"><div className="h-2 rounded-full bg-cream-400" style={{ width: `${quotedPct}%` }} /></div>
        <div className="h-2 rounded-full bg-cream-100"><div className="h-2 rounded-full bg-teal-600" style={{ width: `${invoicedPct}%` }} /></div>
      </div>
      <p className="mt-1 text-xs text-cream-700">
        Quoted <span className="font-medium text-cream-900">{money(row.quoted_value)}</span> · Invoiced <span className="font-medium text-cream-900">{money(row.invoiced_value)}</span>
      </p>
    </li>
  );
}

export function PulseSellThroughSkeleton() {
  return (
    <div className="mt-4 animate-pulse space-y-4 rounded-[14px] border border-cream-200 bg-cream-100 p-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i}>
          <div className="h-4 w-48 rounded bg-cream-200" />
          <div className="mt-2 h-2 rounded bg-cream-200" />
          <div className="mt-1 h-2 rounded bg-cream-200" />
        </div>
      ))}
    </div>
  );
}

export function PulseSellThrough({ query }: { query: string }) {
  const [by, setBy] = useState<PulseSellDimension>('category');
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const q = usePulseSellThrough(query, by, near);
  const tab = TABS.find((t) => t.key === by) ?? TABS[0];
  const top = Math.max(1, ...(q.data?.rows ?? []).map((r) => Math.max(r.quoted_value, r.invoiced_value)));

  return (
    <div ref={ref}>
      <PulseBandShell
        id="what-sells"
        title="What is selling"
        subtitle="What customers quoted through the app compared with what was invoiced, by category, brand or product."
        isFetching={q.isFetching && !q.isLoading}
      >
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Group by">
          {TABS.map((t) => (
            <Button key={t.key} type="button" size="sm" variant={by === t.key ? 'primary' : 'secondary'} aria-pressed={by === t.key} onClick={() => setBy(t.key)}>
              {t.label}
            </Button>
          ))}
        </div>
        {!near || q.isLoading ? <PulseSellThroughSkeleton /> : null}
        {q.isError ? <div className="mt-4"><ErrorState heading="This view could not load" description="The rest of Pulse remains available." /></div> : null}
        {q.data?.capped ? (
          <div className="mt-4 rounded-[8px] border border-cream-200 bg-cream-50 p-5 text-sm text-cream-700">
            This view covers up to 92 days. Choose a shorter period to see what is selling.
          </div>
        ) : null}
        {q.data && !q.data.capped ? (
          q.data.rows.length === 0 ? (
            <div className="mt-4 rounded-[8px] border border-cream-200 bg-cream-50 p-5 text-sm text-cream-700">
              No quotes or invoices from the app in this period.
            </div>
          ) : (
            <div className="mt-4 rounded-[14px] border border-cream-200 bg-white px-5 py-2">
              <ul className="divide-y divide-cream-200">
                {q.data.rows.map((row) => <SellRow key={row.id ?? row.name} row={row} top={top} />)}
              </ul>
              <p className="border-t border-cream-200 py-3 text-xs text-cream-600">
                Top {q.data.rows.length} of {formatNumberValue(q.data.totals?.items ?? q.data.rows.length, 'COUNT')} {tab.noun}, ranked by invoiced value.
                Grey bar: quoted. Green bar: invoiced.
              </p>
            </div>
          )
        ) : null}
      </PulseBandShell>
    </div>
  );
}
