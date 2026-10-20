'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, PackageSearch, RefreshCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PerformanceCard, RankedList } from '@/components/seller/detail';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { usePulseDemandSignal } from '@/hooks/usePulseV2';
import { cn, formatNumberValue } from '@/lib/utils';
import type { PulseDemandSignalKind, PulseDemandSignalRow } from '@/types/pulse';

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
            {stale ? <p className="mt-3 text-sm font-medium text-amber-700">The latest daily summary is out of date.</p> : null}
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
      subtitle="What customers searched for, viewed and added to cart in the storefront, from the latest daily summary. It covers its own recent window, not the period above."
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
