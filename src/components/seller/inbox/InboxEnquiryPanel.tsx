'use client';

import Image from 'next/image';
import { useState } from 'react';
import { ChevronDown, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useEnquiryTriage, useSubstituteEnquiryLine } from '@/hooks/useInboxEntries';
import { useEstimateComposer } from '@/hooks/useEstimates';
import type { EnquiryTriageLine } from '@/lib/inbox/enquiry-triage';
import { buildTargetRangeLabel } from '@/lib/inbox/inbox-entry-copy';
import { cn, formatNumberValue } from '@/lib/utils';
import { StockCell, VelocityCell, velocityLabel } from './EnquiryLineDisplay';

const HEAD_CLASS = 'text-sm font-medium uppercase tracking-[0.08em] text-cream-500';

function money(value: number) {
  return formatNumberValue(value, 'CURRENCY_EXACT');
}

function hasVelocitySignal(velocity: EnquiryTriageLine['velocity']): boolean {
  return velocity.unitsPerWeek > 0 || velocity.daysCover != null || velocity.lastInvoiceAt != null;
}

function hasOperationalDetails(line: EnquiryTriageLine): boolean {
  return line.stock.tone !== 'ok'
    || line.onHand > 0
    || hasVelocitySignal(line.velocity)
    || line.alternates.length > 0;
}

function linePriceFacts(line: EnquiryTriageLine, hiddenPricing: boolean): Array<{ label: string; value: string; strong?: boolean }> {
  const facts: Array<{ label: string; value: string; strong?: boolean }> = [];
  const targetLabel = buildTargetRangeLabel(line.targetMin, line.targetMax);

  if (hiddenPricing) {
    if (targetLabel) facts.push({ label: 'Buyer target', value: targetLabel });
    if (line.resolvedPrice != null) facts.push({ label: 'Resolved price', value: money(line.resolvedPrice) });
    if (line.unitPrice != null && line.unitPrice > 0) facts.push({ label: 'Your quote', value: money(line.unitPrice), strong: true });
  } else if (line.unitPrice != null && line.unitPrice > 0) {
    facts.push({ label: 'Your quote', value: money(line.unitPrice), strong: true });
  } else if (line.resolvedPrice != null) {
    facts.push({ label: 'Resolved price', value: money(line.resolvedPrice) });
  }

  facts.push({ label: 'Buyer quantity', value: String(line.qty), strong: true });
  return facts;
}

function AlternatesList({ line, estimateId, entryId }: { line: EnquiryTriageLine; estimateId: string; entryId: string }) {
  const substitute = useSubstituteEnquiryLine(entryId);
  const [substitutingId, setSubstitutingId] = useState<string | null>(null);

  async function handleSubstitute(alt: EnquiryTriageLine['alternates'][number]) {
    setSubstitutingId(alt.tenantProductId);
    try {
      await substitute.mutateAsync({ estimateId, lineId: line.id, tenantProductId: alt.tenantProductId });
      toast.success(`Substituted with ${alt.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not substitute this item');
    } finally {
      setSubstitutingId(null);
    }
  }

  return (
    <div className="border-t border-cream-200 bg-cream-50 px-4 py-4">
      <p className="text-base text-cream-700">
        Buyer asked for {line.qty}; {line.stock.label.toLowerCase()}.
        {line.alternates.length > 0
          ? ' In-stock alternatives, same category first — substituting updates this line in place:'
          : ' No in-stock alternatives found in this category or brand.'}
      </p>
      {line.alternates.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {line.alternates.map((alt) => {
            const isPending = substitute.isPending && substitutingId === alt.tenantProductId;
            return (
              <li
                key={alt.tenantProductId}
                className="flex items-center justify-between gap-4 rounded-[10px] border border-cream-300 bg-white px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-cream-900">{alt.name}</p>
                  <p className="mt-0.5 truncate font-mono text-sm text-cream-500">
                    {alt.sku}
                    {alt.sameCategory ? ' · same category' : ''}
                    {alt.sameBrand ? ' · same brand' : alt.brandName ? ` · ${alt.brandName}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-right">
                  <span className="font-mono text-base font-semibold tabular-nums text-cream-900">
                    {alt.buyerPrice != null ? money(alt.buyerPrice) : '—'}
                  </span>
                  <span className="font-mono text-base tabular-nums text-cream-800">{alt.available} in stock</span>
                  {hasVelocitySignal(alt.velocity) ? (
                    <span className="hidden font-mono text-sm tabular-nums text-cream-500 sm:inline">{velocityLabel(alt.velocity)}</span>
                  ) : null}
                  <button
                    type="button"
                    disabled={substitute.isPending}
                    onClick={() => void handleSubstitute(alt)}
                    className="inline-flex items-center rounded-[10px] border border-cream-300 bg-white px-3 py-1.5 text-base font-medium text-cream-900 transition-colors hover:bg-cream-100 disabled:opacity-50"
                  >
                    {isPending ? 'Substituting…' : 'Substitute'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function ReadOnlyLineCard({
  line,
  imageUrl,
  estimateId,
  entryId,
  hiddenPricing,
}: {
  line: EnquiryTriageLine;
  imageUrl: string | null;
  estimateId: string;
  entryId: string;
  hiddenPricing: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const short = line.stock.tone !== 'ok';
  const showDetailsControl = hasOperationalDetails(line);
  const facts = linePriceFacts(line, hiddenPricing);

  return (
    <div className="overflow-hidden rounded-[14px] border border-cream-200">
      <div className={cn('px-4 py-4', line.stock.tone === 'danger' && 'doc-line-stock-danger', line.stock.tone === 'warning' && 'doc-line-stock-warning')}>
        <div className="flex items-start gap-3">
          <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-cream-200 bg-cream-100">
            {imageUrl && !imgError ? (
              <Image src={imageUrl} alt="" fill className="object-cover" sizes="56px" unoptimized onError={() => setImgError(true)} />
            ) : (
              <Package className="h-5 w-5 text-cream-400" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-medium text-cream-900">{line.name}</p>
            <p className="mt-0.5 truncate font-mono text-sm text-cream-500">
              {line.sku}{line.brandName ? ` · ${line.brandName}` : ''}
            </p>
            {line.buyerNote ? <p className="mt-1 text-sm italic text-cream-600">&ldquo;{line.buyerNote}&rdquo;</p> : null}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label}>
              <p className={HEAD_CLASS}>{fact.label}</p>
              <p className={cn(
                'mt-0.5 font-mono text-base tabular-nums text-cream-700',
                fact.strong && 'font-semibold text-cream-900',
              )}
              >
                {fact.value}
              </p>
            </div>
          ))}
        </div>

        {showDetailsControl ? (
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className={cn(
              'mt-3 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors',
              short
                ? 'border-warning-200 bg-warning-50 text-warning-700 hover:bg-warning-100'
                : 'border-cream-300 bg-white text-cream-700 hover:bg-cream-100',
            )}
          >
            {short ? `Stock gap: ${line.stock.label}` : 'Stock and sales'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', detailsOpen && 'rotate-180')} aria-hidden />
          </button>
        ) : null}

        {detailsOpen ? (
          <div className="mt-3 grid grid-cols-1 gap-3 rounded-[10px] border border-cream-200 bg-white px-3 py-3 sm:grid-cols-2">
            {(short || line.onHand > 0) ? (
              <div>
                <p className={HEAD_CLASS}>Stock</p>
                <StockCell stock={line.stock} onHand={line.onHand} align="start" />
              </div>
            ) : null}
            {hasVelocitySignal(line.velocity) ? (
              <div>
                <p className={HEAD_CLASS}>Recent sales</p>
                <VelocityCell velocity={line.velocity} align="start" />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {short && detailsOpen ? <AlternatesList line={line} estimateId={estimateId} entryId={entryId} /> : null}
    </div>
  );
}

export function InboxEnquirySkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading enquiry">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-28 animate-pulse rounded-[14px] bg-cream-100" />
      ))}
    </div>
  );
}

export function InboxEnquiryPanel({ entryId }: { entryId: string }) {
  const { data, isLoading, isError } = useEnquiryTriage(entryId);
  const composer = useEstimateComposer(data?.estimateId ?? null).data;

  if (isLoading) return <InboxEnquirySkeleton />;
  if (isError || !data) {
    return <p className="text-base text-cream-600">Couldn&apos;t load enquiry items.</p>;
  }

  const imageById = new Map((composer?.items ?? []).map((item) => [item.id, item.image_url ?? null]));
  const hasTotals = composer?.total_amount != null;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {data.lines.map((line) => (
          <ReadOnlyLineCard
            key={line.id}
            line={line}
            imageUrl={imageById.get(line.id) ?? null}
            estimateId={data.estimateId}
            entryId={entryId}
            hiddenPricing={data.hiddenPricing}
          />
        ))}
      </div>

      {hasTotals ? (
        <div className="rounded-[14px] border border-cream-300 bg-cream-50 px-4 py-4">
          <div className="space-y-2 text-base">
            <div className="flex items-center justify-between">
              <span className="text-cream-700">Subtotal</span>
              <span className="font-mono text-cream-900">{money(Number(composer?.subtotal ?? 0))}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-cream-700">GST</span>
              <span className="font-mono text-cream-900">{money(Number(composer?.tax_amount ?? 0))}</span>
            </div>
            <div className="flex items-center justify-between border-t border-cream-200 pt-2 text-base">
              <span className="font-medium text-cream-900">Total</span>
              <span className="font-mono font-semibold text-cream-950">{money(Number(composer?.total_amount ?? 0))}</span>
            </div>
          </div>
        </div>
      ) : null}

      {composer?.seller_note ? (
        <div className="rounded-[14px] border border-cream-200 px-4 py-3">
          <p className={HEAD_CLASS}>Your note to the buyer</p>
          <p className="mt-1 whitespace-pre-wrap text-base text-cream-800">{composer.seller_note}</p>
        </div>
      ) : null}
    </div>
  );
}
