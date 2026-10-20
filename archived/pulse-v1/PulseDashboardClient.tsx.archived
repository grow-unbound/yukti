'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, PackageSearch, RefreshCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { PerformanceCard, RankedList } from '@/components/seller/detail';
import { InsightStrip4 } from '@/components/seller/layout';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { usePulseContribution, usePulseDemandSignal, usePulseOpportunities, usePulseOpportunityBuyers } from '@/hooks/usePulse';
import { cn, formatNumberValue } from '@/lib/utils';
import type { PulseContributionCard, PulseDemandSignalKind, PulseDemandSignalRow, PulseOpportunityGroup, PulseOpportunityPreview } from '@/types/pulse';

const PULSE_OPPORTUNITY_SCROLL_CARD_HEIGHT = 'h-[320px]';

function formatPulseFreshness(iso: string | null | undefined) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  const deltaMs = Math.max(0, Date.now() - time);
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `Updated ${days}d ago`;
  return `Updated ${new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`;
}

function formatLastSeen(iso: string | null | undefined) {
  const freshness = formatPulseFreshness(iso);
  return freshness ? freshness.replace(/^Updated /, 'Last seen ') : null;
}

function formatCardValue(card: PulseContributionCard) {
  return card.value_kind === 'currency'
    ? formatNumberValue(card.value, 'CURRENCY_THRESHOLD')
    : formatNumberValue(card.value, 'COUNT');
}

function ScrollCardBody({ children }: { children: ReactNode }) {
  const [scrollActive, setScrollActive] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current != null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      className={cn(
        PULSE_OPPORTUNITY_SCROLL_CARD_HEIGHT,
        'dashboard-vscroll overflow-y-auto',
        scrollActive && 'dashboard-vscroll--active',
      )}
      onScroll={() => {
        setScrollActive(true);
        if (resetTimerRef.current != null) {
          window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = window.setTimeout(() => {
          setScrollActive(false);
          resetTimerRef.current = null;
        }, 900);
      }}
    >
      {children}
    </div>
  );
}

function PulseSectionShell({
  title,
  subtitle,
  freshness,
  isFetching,
  children,
}: {
  title: string;
  subtitle: string;
  freshness?: string | null;
  isFetching?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-cream-950">{title}</h2>
          <p className="mt-1 max-w-[72ch] text-sm leading-5 text-cream-700">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-cream-600">
          {isFetching ? <RefreshCcw size={13} className="animate-spin" aria-hidden="true" /> : null}
          {freshness ? <span>{freshness}</span> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function PulseContributionSkeleton() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="min-h-[132px] animate-pulse rounded-[14px] border border-cream-200 bg-cream-100 px-[18px] py-[16px]">
          <div className="h-3 w-24 rounded bg-cream-200" />
          <div className="mt-5 h-7 w-28 rounded bg-cream-200" />
          <div className="mt-4 h-3 w-36 rounded bg-cream-200" />
        </div>
      ))}
    </div>
  );
}

function ContributionEmpty() {
  return (
    <div className="p-5">
      <div className="rounded-[8px] border border-cream-200 bg-cream-50 p-5">
        <h3 className="font-display text-lg font-semibold text-cream-950">Pulse will focus once Yukti captures demand</h3>
        <p className="mt-2 max-w-[64ch] text-sm leading-5 text-cream-700">
          Contribution cards stay hidden until there is meaningful Yukti-attributed demand or invoice evidence.
        </p>
      </div>
    </div>
  );
}

function ContributionSection() {
  const query = usePulseContribution();
  const freshness = formatPulseFreshness(query.data?.freshness_label);

  return (
    <PulseSectionShell
      title="Business captured through Yukti"
      subtitle="Channel-neutral contribution from submitted demand, invoicing, and repeat buyer behavior."
      freshness={freshness}
      isFetching={query.isFetching && !query.isLoading}
    >
      {query.isLoading ? <PulseContributionSkeleton /> : null}
      {query.isError ? (
        <div className="mt-4">
          <ErrorState heading="Contribution could not load" description="Opportunities and the rest of Pulse remain available." />
        </div>
      ) : null}
      {!query.isLoading && !query.isError && (query.data?.cards.length ?? 0) > 0 ? (
        <InsightStrip4
          tiles={(query.data?.cards ?? []).slice(0, 4).map((card) => ({
            label: `${card.label} · ${card.time_basis}`,
            value: formatCardValue(card),
            sub: card.share_pct != null && card.share_pct > 0 ? `${card.evidence} · ${card.share_pct}% share` : card.evidence,
          }))}
        />
      ) : null}
      {!query.isLoading && !query.isError && (query.data?.cards.length ?? 0) === 0 ? (
        <ContributionEmpty />
      ) : null}
    </PulseSectionShell>
  );
}

function DemandSignalSkeleton() {
  return (
    <div className="min-h-[320px] animate-pulse rounded-[14px] border border-cream-200 bg-cream-100 p-4">
      <div className="h-3 w-24 rounded bg-cream-200" />
      <div className="mt-4 h-6 w-44 rounded bg-cream-200" />
      <div className="mt-3 h-3 w-full rounded bg-cream-200" />
      <div className="mt-2 h-3 w-3/4 rounded bg-cream-200" />
      <div className="mt-6 space-y-3">
        <div className="h-12 rounded bg-cream-200" />
        <div className="h-12 rounded bg-cream-200" />
        <div className="h-12 rounded bg-cream-200" />
      </div>
    </div>
  );
}

export function PulseDemandSignalsSkeleton() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
      <DemandSignalSkeleton />
      <DemandSignalSkeleton />
      <DemandSignalSkeleton />
    </div>
  );
}

const DEMAND_SIGNAL_COPY: Record<PulseDemandSignalKind, {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}> = {
  missing_assortment: {
    title: 'Missing assortment',
    description: 'Searches buyers made that the catalog did not satisfy.',
    emptyTitle: 'No privacy-safe missing assortment yet',
    emptyDescription: 'Signals will appear after enough buyers search for unavailable products without exposing one-person terms.',
  },
  conversion_gaps: {
    title: 'Conversion gaps',
    description: 'Top 5 products buyers viewed or added to cart without matching demand in the current window.',
    emptyTitle: 'No meaningful conversion gaps detected',
    emptyDescription: 'Browsed products are either converting or have not crossed the minimum signal threshold yet.',
  },
  stock_mismatch: {
    title: 'Stock mismatch',
    description: 'Products attracting interest while current availability may be blocking conversion.',
    emptyTitle: 'No stock mismatch detected',
    emptyDescription: 'Pulse will flag products here once current inventory and buyer interest both support the signal.',
  },
};

function demandSignalRows(kind: PulseDemandSignalKind, rows: PulseDemandSignalRow[]) {
  return rows.map((row) => {
    const lastSeen = formatLastSeen(row.last_seen_at);
    const href = kind === 'missing_assortment'
      ? `/products?search=${encodeURIComponent(row.label)}`
      : row.tenant_product_id
        ? `/products/${row.tenant_product_id}`
        : '/products';
    const trailingLabel = kind === 'missing_assortment'
      ? 'searches'
      : kind === 'conversion_gaps'
        ? 'views'
        : 'interest';
    const customerLabel = row.unique_count === 1 ? 'customer' : 'customers';
    const secondaryMetric = `${formatNumberValue(row.unique_count, 'COUNT')} ${customerLabel}`;
    const stock = kind === 'stock_mismatch' && row.stock_state ? ` · ${row.stock_state.replace(/_/g, ' ')}` : '';

    return {
      id: row.id,
      label: (
        <Link href={href} className="block min-w-0 text-cream-900 no-underline hover:text-teal-700">
          <span className="block truncate">{row.product_name ?? row.label}</span>
        </Link>
      ),
      meta: `${secondaryMetric}${stock}${lastSeen ? ` · ${lastSeen}` : ''}`,
      value: formatNumberValue(row.count, 'COUNT'),
      valueSupporting: trailingLabel,
    };
  });
}

function DemandSignalWidget({
  kind,
  onShowAll,
}: {
  kind: PulseDemandSignalKind;
  onShowAll: (payload: { kind: PulseDemandSignalKind; rows: PulseDemandSignalRow[]; total: number }) => void;
}) {
  const query = usePulseDemandSignal(kind);
  const copy = DEMAND_SIGNAL_COPY[kind];
  const rows = query.data?.[kind] ?? [];
  const visibleRows = rows.slice(0, 5);
  const total = query.data?.signal_counts[kind] ?? rows.length;
  const stale = Boolean(query.data?.stale);
  const actionHref = kind === 'missing_assortment' ? '/products' : '/products';
  const actionText = kind === 'missing_assortment'
    ? 'Search products'
    : kind === 'conversion_gaps'
      ? 'Review products'
      : 'Review inventory';

  if (query.isLoading) return <DemandSignalSkeleton />;

  return (
    <PerformanceCard
      title={copy.title}
      subtitle={copy.description}
      actions={(
        <div className="text-right">
          <p className="font-display text-lg leading-none text-cream-950">{formatNumberValue(total, 'COUNT')}</p>
          {total > 0 ? (
            <button
              type="button"
              className="mt-2 text-sm font-semibold text-teal-700 no-underline hover:text-teal-800"
              onClick={() => onShowAll({ kind, rows, total })}
            >
              Show all
            </button>
          ) : (
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-500">signals</p>
          )}
        </div>
      )}
      bodyClassName="p-0"
      className="flex min-h-[320px] flex-col"
    >
      {query.isError ? (
        <div className="flex min-h-[224px] items-center gap-3 p-5 text-amber-900">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <h3 className="font-display text-base font-semibold">Signal could not load</h3>
            <p className="mt-1 text-sm text-amber-900/80">Other Pulse sections remain available.</p>
          </div>
        </div>
      ) : rows.length > 0 ? (
        <ScrollCardBody>
          <RankedList
            items={demandSignalRows(kind, visibleRows)}
            emptyTitle={copy.emptyTitle}
            emptyDescription={copy.emptyDescription}
            compact
          />
        </ScrollCardBody>
      ) : (
        <div className="flex min-h-[224px] flex-col justify-between p-5">
          <div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cream-100 text-cream-700">
              <PackageSearch size={18} aria-hidden="true" />
            </div>
            <h3 className="mt-4 font-display text-lg font-semibold text-cream-950">{copy.emptyTitle}</h3>
            <p className="mt-2 text-sm leading-5 text-cream-700">{copy.emptyDescription}</p>
            {stale ? <p className="mt-3 text-sm font-medium text-amber-700">Last successful extraction is stale.</p> : null}
          </div>
          <Button asChild variant="secondary" size="sm" className="mt-5 w-fit">
            <Link href={actionHref}>
              {actionText}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </Button>
        </div>
      )}
    </PerformanceCard>
  );
}

function DemandSignalSheet({
  signal,
  onOpenChange,
}: {
  signal: { kind: PulseDemandSignalKind; rows: PulseDemandSignalRow[]; total: number } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const copy = signal ? DEMAND_SIGNAL_COPY[signal.kind] : null;

  return (
    <Sheet open={Boolean(signal)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-[540px] p-0 sm:max-w-[540px]">
        <SheetHeader>
          <SheetTitle className="font-display text-xl font-semibold text-cream-950">{copy?.title ?? 'Demand signals'}</SheetTitle>
          {copy?.description ? <p className="mt-1 text-base text-cream-700">{copy.description}</p> : null}
          <p className="mt-2 text-sm font-medium text-cream-600">{formatNumberValue(signal?.total ?? 0, 'COUNT')} signals</p>
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {signal ? (
            <RankedList
              items={demandSignalRows(signal.kind, signal.rows)}
              emptyTitle={copy?.emptyTitle ?? 'No signals found'}
              emptyDescription={copy?.emptyDescription}
              compact
            />
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

export function DemandSignalsSection() {
  const freshnessQuery = usePulseDemandSignal('conversion_gaps');
  const freshness = formatPulseFreshness(freshnessQuery.data?.source_watermark ?? freshnessQuery.data?.computed_at);
  const [selectedSignal, setSelectedSignal] = useState<{ kind: PulseDemandSignalKind; rows: PulseDemandSignalRow[]; total: number } | null>(null);

  return (
    <PulseSectionShell
      title="Demand signals"
      subtitle="PostHog-derived storefront interest from the latest local snapshot. Each widget ranks at most five actionable rows."
      freshness={freshness ? `Demand signals ${freshness.toLowerCase()}` : null}
      isFetching={freshnessQuery.isFetching && !freshnessQuery.isLoading}
    >
      <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <DemandSignalWidget kind="missing_assortment" onShowAll={setSelectedSignal} />
        <DemandSignalWidget kind="conversion_gaps" onShowAll={setSelectedSignal} />
        <DemandSignalWidget kind="stock_mismatch" onShowAll={setSelectedSignal} />
      </div>
      <DemandSignalSheet signal={selectedSignal} onOpenChange={(open) => setSelectedSignal(open ? selectedSignal : null)} />
    </PulseSectionShell>
  );
}

export function PulseOpportunitiesSkeleton() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="min-h-[256px] animate-pulse rounded-[14px] border border-cream-200 bg-cream-100 p-4">
          <div className="h-3 w-20 rounded bg-cream-200" />
          <div className="mt-4 h-6 w-44 rounded bg-cream-200" />
          <div className="mt-3 h-3 w-full rounded bg-cream-200" />
          <div className="mt-2 h-3 w-3/4 rounded bg-cream-200" />
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

function opportunityRows(previews: PulseOpportunityPreview[]) {
  return previews.map((preview) => ({
    id: preview.buyer_id || preview.name,
    label: (
      <Link href={preview.href} className="block truncate text-cream-900 no-underline hover:text-teal-700">
        {preview.name}
      </Link>
    ),
    meta: preview.supporting_text ?? undefined,
    initials: preview.initials,
  }));
}

function OpportunityCard({
  group,
  onShowAll,
}: {
  group: PulseOpportunityGroup;
  onShowAll: (group: PulseOpportunityGroup) => void;
}) {
  return (
    <PerformanceCard
      title={group.title}
      subtitle={(
        <span className="block">
          <span className="block">{group.description}</span>
          {group.evidence ? <span className="mt-1 block font-medium text-cream-800">{group.evidence}</span> : null}
        </span>
      )}
      actions={(
        <div className="text-right">
          <p className="font-display text-lg leading-none text-cream-950">{formatNumberValue(group.count, 'COUNT')}</p>
          <button
            type="button"
            className="mt-2 text-sm font-semibold text-teal-700 no-underline hover:text-teal-800"
            onClick={() => onShowAll(group)}
          >
            Show all
          </button>
        </div>
      )}
      bodyClassName="p-0"
      className="flex min-h-[320px] flex-col"
    >
      <ScrollCardBody>
        <RankedList
          items={opportunityRows(group.previews)}
          emptyTitle="No preview customers"
          emptyDescription="The group count is available; preview rows will appear when the source includes ranked buyers."
          compact
        />
      </ScrollCardBody>
      <div className="border-t border-cream-200 px-5 py-3">
        <Button asChild variant="secondary" size="sm" className="w-fit">
          <Link href={group.action_href}>
            {group.action_label}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </PerformanceCard>
  );
}

function OpportunityBuyerSheet({
  group,
  onOpenChange,
}: {
  group: PulseOpportunityGroup | null;
  onOpenChange: (open: boolean) => void;
}) {
  const query = usePulseOpportunityBuyers(group?.id ?? null, Boolean(group));
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.rows) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? group?.count ?? 0;

  return (
    <Sheet open={Boolean(group)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-[540px] p-0 sm:max-w-[540px]">
        <SheetHeader>
          <SheetTitle className="font-display text-xl font-semibold text-cream-950">{group?.title ?? 'Opportunity customers'}</SheetTitle>
          {group?.description ? <p className="mt-1 text-base text-cream-700">{group.description}</p> : null}
          {group?.evidence ? <p className="mt-2 text-sm font-semibold text-cream-800">{group.evidence}</p> : null}
          <p className="mt-2 text-sm font-medium text-cream-600">{formatNumberValue(total, 'COUNT')} customers</p>
          {group ? (
            <Button asChild variant="secondary" size="sm" className="mt-4 w-fit">
              <Link href={group.action_href}>
                {group.action_label}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {query.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="grid grid-cols-[auto_1fr] items-center gap-3 border-b border-cream-200 px-3 py-3 last:border-b-0">
                  <div className="h-8 w-8 animate-pulse rounded-full bg-cream-100" />
                  <div className="min-w-0 space-y-2">
                    <div className="h-4 w-44 animate-pulse rounded bg-cream-100" />
                    <div className="h-3 w-28 animate-pulse rounded bg-cream-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : query.isError ? (
            <div className="p-5">
              <ErrorState heading="Customers could not load" description="Close this panel and try again." />
            </div>
          ) : (
            <>
              <RankedList
                items={opportunityRows(rows)}
                emptyTitle="No customers found"
                emptyDescription="No ranked customers are available for this opportunity right now."
                compact
              />
              {query.hasNextPage ? (
                <div className="border-t border-cream-200 p-4">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    disabled={query.isFetchingNextPage}
                    onClick={() => query.fetchNextPage()}
                  >
                    {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
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

function OpportunitiesSection() {
  const query = usePulseOpportunities();
  const freshness = formatPulseFreshness(query.data?.freshness_label);
  const [selectedGroup, setSelectedGroup] = useState<PulseOpportunityGroup | null>(null);

  return (
    <PulseSectionShell
      title="Opportunities"
      subtitle="Computed customer groups worth acting on next. These are analytical views, not Inbox work queues."
      freshness={freshness}
      isFetching={query.isFetching && !query.isLoading}
    >
      {query.isLoading ? <PulseOpportunitiesSkeleton /> : null}
      {query.isError ? (
        <div className="mt-4">
          <div className="flex min-h-[160px] items-center gap-3 rounded-[8px] border border-amber-200 bg-amber-50 p-5 text-amber-900">
            <AlertCircle size={18} aria-hidden="true" />
            <div>
              <h3 className="font-display text-lg font-semibold">Opportunities could not load</h3>
              <p className="mt-1 text-sm">Contribution remains available while this section recovers.</p>
            </div>
          </div>
        </div>
      ) : null}
      {!query.isLoading && !query.isError && (query.data?.groups.length ?? 0) > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
          {query.data?.groups.map((group) => <OpportunityCard key={group.id} group={group} onShowAll={setSelectedGroup} />)}
        </div>
      ) : null}
      {!query.isLoading && !query.isError && (query.data?.groups.length ?? 0) === 0 ? (
        <div className="mt-4">
          <div className="rounded-[8px] border border-cream-200 bg-cream-50 p-5">
            <h3 className="font-display text-lg font-semibold text-cream-950">No qualifying opportunities right now</h3>
            <p className="mt-2 max-w-[64ch] text-sm leading-5 text-cream-700">
              Pulse will show up to three customer groups when synced history or Yukti activity produces a useful next action.
            </p>
          </div>
        </div>
      ) : null}
      <OpportunityBuyerSheet group={selectedGroup} onOpenChange={(open) => setSelectedGroup(open ? selectedGroup : null)} />
    </PulseSectionShell>
  );
}

export function PulseDashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1920px] px-8 py-6">
      <div className="mb-5">
        <div className="h-3 w-20 animate-pulse rounded bg-cream-200" />
        <div className="mt-3 h-10 w-40 animate-pulse rounded bg-cream-200" />
        <div className="mt-3 h-5 w-[36rem] max-w-full animate-pulse rounded bg-cream-200" />
      </div>
      <section>
        <div className="mb-2">
          <div className="h-6 w-64 animate-pulse rounded bg-cream-200" />
          <div className="mt-2 h-4 w-[34rem] max-w-full animate-pulse rounded bg-cream-200" />
        </div>
        <PulseContributionSkeleton />
      </section>
      <section className="mt-5">
        <div className="mb-2">
          <div className="h-6 w-40 animate-pulse rounded bg-cream-200" />
          <div className="mt-2 h-4 w-[38rem] max-w-full animate-pulse rounded bg-cream-200" />
        </div>
        <PulseOpportunitiesSkeleton />
      </section>
      <section className="mt-5">
        <div className="mb-2">
          <div className="h-6 w-44 animate-pulse rounded bg-cream-200" />
          <div className="mt-2 h-4 w-[42rem] max-w-full animate-pulse rounded bg-cream-200" />
        </div>
        <PulseDemandSignalsSkeleton />
      </section>
    </div>
  );
}

export function PulseDashboardClient() {
  return (
    <div className="mx-auto w-full max-w-[1920px] px-8 py-6">
      <header className="mb-5">
        <p className="eyebrow text-cream-600">Pulse</p>
        <h1 className="font-display text-[var(--b-text-page-sm)] font-semibold leading-[0.96] text-cream-900 md:text-xl md:font-extrabold md:leading-[1]">
          Pulse
        </h1>
        <p className="mt-2 max-w-[68ch] text-md leading-6 text-cream-700">
          Emerging demand, business captured through Yukti, and where to act next.
        </p>
      </header>
      <div className={cn('space-y-5')}>
        <ContributionSection />
        <OpportunitiesSection />
        <DemandSignalsSection />
      </div>
    </div>
  );
}
