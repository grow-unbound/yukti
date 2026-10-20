'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

import { PerformanceCard, RankedList } from '@/components/seller/detail';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { usePulseActBuyers, usePulseActNow } from '@/hooks/usePulseV2';
import { ACT_GROUP_COPY, ACT_GROUP_ORDER } from '@/lib/pulse/act-copy';
import { cn, formatNumberValue } from '@/lib/utils';
import type { PulseActGroup, PulseActGroupId, PulseActRow } from '@/types/pulse-v2';

import { PulseBandShell } from './PulseBandShell';

function initials(name: string) {
  return name.split(' ').map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase();
}

function rankedItems(id: PulseActGroupId, rows: PulseActRow[]) {
  const copy = ACT_GROUP_COPY[id];
  return rows.map((row) => ({
    id: row.buyer_id,
    label: (
      <Link href={`/customers/${row.buyer_id}`} className="block truncate text-cream-900 no-underline hover:text-teal-700">
        {row.name}
      </Link>
    ),
    meta: copy.rowMeta(row),
    initials: initials(row.name),
  }));
}

function ScrollBody({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  return (
    <div
      className={cn('h-[320px] dashboard-vscroll overflow-y-auto', active && 'dashboard-vscroll--active')}
      onScroll={() => {
        setActive(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setActive(false), 900);
      }}
    >
      {children}
    </div>
  );
}

function ActCard({ group, onShowAll }: { group: PulseActGroup; onShowAll: (id: PulseActGroupId) => void }) {
  const copy = ACT_GROUP_COPY[group.id];
  return (
    <PerformanceCard
      title={copy.title}
      subtitle={(
        <span className="block">
          <span className="block">{copy.description}</span>
          <span className="mt-1 block font-medium text-cream-800">{copy.evidence(group)}</span>
        </span>
      )}
      actions={(
        <div className="text-right">
          <p className="font-display text-lg leading-none text-cream-950">{formatNumberValue(group.count, 'COUNT')}</p>
          <button type="button" className="mt-2 text-sm font-semibold text-teal-700 hover:text-teal-800" onClick={() => onShowAll(group.id)}>
            Show all
          </button>
        </div>
      )}
      bodyClassName="p-0"
      className="flex min-h-[320px] flex-col"
    >
      <ScrollBody>
        <RankedList
          items={rankedItems(group.id, group.previews)}
          emptyTitle="No customers to show"
          emptyDescription="Nothing to follow up on here right now."
          compact
        />
      </ScrollBody>
      <div className="border-t border-cream-200 px-5 py-3">
        <Button asChild variant="secondary" size="sm" className="w-fit">
          <Link href={copy.actionHref}>
            {copy.actionLabel}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </PerformanceCard>
  );
}

function BuyersSheet({ group, query, onClose }: { group: PulseActGroupId | null; query: string; onClose: () => void }) {
  const q = usePulseActBuyers(group, query);
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);
  const first = q.data?.pages[0];
  const copy = group ? ACT_GROUP_COPY[group] : null;

  return (
    <Sheet open={Boolean(group)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-[540px] p-0 sm:max-w-[540px]">
        <SheetHeader>
          <SheetTitle className="font-display text-xl font-semibold text-cream-950">{copy?.title ?? 'Customers'}</SheetTitle>
          {copy ? <p className="mt-1 text-base text-cream-700">{copy.description}</p> : null}
          {first && copy ? <p className="mt-2 text-sm font-semibold text-cream-800">{copy.evidence({ count: first.total, value: first.value })}</p> : null}
          {copy ? (
            <Button asChild variant="secondary" size="sm" className="mt-4 w-fit">
              <Link href={copy.actionHref}>
                {copy.actionLabel}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {q.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="grid grid-cols-[auto_1fr] items-center gap-3 border-b border-cream-200 px-3 py-3 last:border-b-0">
                  <div className="h-8 w-8 animate-pulse rounded-full bg-cream-100" />
                  <div className="min-w-0 space-y-2">
                    <div className="h-4 w-44 animate-pulse rounded bg-cream-100" />
                    <div className="h-3 w-28 animate-pulse rounded bg-cream-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : q.isError ? (
            <div className="p-5"><ErrorState heading="Customers could not load" description="Close this panel and try again." /></div>
          ) : (
            <>
              <RankedList
                items={group ? rankedItems(group, rows) : []}
                emptyTitle="No customers found"
                emptyDescription="Nobody matches this group for the selected period."
                compact
              />
              {q.hasNextPage ? (
                <div className="border-t border-cream-200 p-4">
                  <Button type="button" variant="secondary" size="sm" className="w-full" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                    {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

export function PulseActNowSkeleton() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="min-h-[320px] animate-pulse rounded-[14px] border border-cream-200 bg-cream-100 p-5">
          <div className="h-5 w-40 rounded bg-cream-200" />
          <div className="mt-3 h-3 w-56 rounded bg-cream-200" />
          <div className="mt-6 space-y-3">
            <div className="h-9 rounded bg-cream-200" />
            <div className="h-9 rounded bg-cream-200" />
            <div className="h-9 rounded bg-cream-200" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PulseActNow({ query }: { query: string }) {
  const q = usePulseActNow(query);
  const [open, setOpen] = useState<PulseActGroupId | null>(null);
  const groups = useMemo(
    () => [...(q.data?.groups ?? [])].sort((a, b) => ACT_GROUP_ORDER.indexOf(a.id) - ACT_GROUP_ORDER.indexOf(b.id)),
    [q.data],
  );

  return (
    <PulseBandShell
      id="act-now"
      title="Act now"
      subtitle="Customers worth a call or a message next, with the rupee value behind each group. These are views, not work queues."
      isFetching={q.isFetching && !q.isLoading}
    >
      {q.isLoading ? <PulseActNowSkeleton /> : null}
      {q.isError ? <div className="mt-4"><ErrorState heading="Customers to follow up could not load" description="The rest of Pulse remains available." /></div> : null}
      {q.data && groups.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {groups.map((g) => <ActCard key={g.id} group={g} onShowAll={setOpen} />)}
        </div>
      ) : null}
      {q.data && groups.length === 0 ? (
        <div className="mt-4 rounded-[8px] border border-cream-200 bg-cream-50 p-5">
          <h3 className="font-display text-lg font-semibold text-cream-950">Nothing needs follow-up right now</h3>
          <p className="mt-2 max-w-[64ch] text-sm leading-5 text-cream-700">Groups appear here when there are customers worth acting on in the selected period.</p>
        </div>
      ) : null}
      <BuyersSheet group={open} query={query} onClose={() => setOpen(null)} />
    </PulseBandShell>
  );
}
