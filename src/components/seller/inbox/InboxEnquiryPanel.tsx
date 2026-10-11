'use client';

import Image from 'next/image';
import { Fragment, useState } from 'react';
import { ChevronDown, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useEnquiryTriage, useSubstituteEnquiryLine } from '@/hooks/useInboxEntries';
import { useEstimateComposer } from '@/hooks/useEstimates';
import type { EnquiryTriageLine } from '@/lib/inbox/enquiry-triage';
import { buildTargetRangeLabel } from '@/lib/inbox/inbox-entry-copy';
import { cn, formatNumberValue } from '@/lib/utils';
import { velocityLabel } from './EnquiryLineDisplay';

const HEAD_CLASS = 'text-sm font-medium uppercase tracking-[0.08em] text-cream-500';

function money(value: number) {
  return formatNumberValue(value, 'CURRENCY_EXACT');
}

function hasVelocitySignal(velocity: EnquiryTriageLine['velocity']): boolean {
  return velocity.unitsPerWeek > 0 || velocity.daysCover != null || velocity.lastInvoiceAt != null;
}

function quotedPriceLabel(line: EnquiryTriageLine) {
  return line.unitPrice != null && line.unitPrice > 0 ? money(line.unitPrice) : '-';
}

function resolvedPriceLabel(line: EnquiryTriageLine) {
  return line.resolvedPrice != null && line.resolvedPrice > 0 ? money(line.resolvedPrice) : '-';
}

function expectedPriceLabel(line: EnquiryTriageLine) {
  return buildTargetRangeLabel(line.targetMin, line.targetMax) ?? '-';
}

function lineAmountLabel(line: EnquiryTriageLine, showTargetPricing: boolean) {
  if (showTargetPricing) {
    return line.unitPrice != null && line.unitPrice > 0 ? money(line.unitPrice * line.qty) : '-';
  }
  return line.resolvedPrice != null && line.resolvedPrice > 0 ? money(line.resolvedPrice * line.qty) : '-';
}

function desktopLineSubtext(line: EnquiryTriageLine) {
  const parts = [
    line.sku,
    line.resolvedPrice != null ? `Base Price ${money(line.resolvedPrice)}` : null,
    `Stock ${line.onHand}`,
    hasVelocitySignal(line.velocity) ? velocityLabel(line.velocity) : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function mobilePriceBasisLabel(line: EnquiryTriageLine, showTargetPricing: boolean) {
  if (!showTargetPricing) return resolvedPriceLabel(line);
  return line.resolvedPrice != null && line.resolvedPrice > 0 ? money(line.resolvedPrice) : quotedPriceLabel(line);
}

function ProductThumb({ src, name }: { src: string | null; name: string }) {
  const [imgError, setImgError] = useState(false);
  return (
    <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-cream-200 bg-cream-100 md:h-10 md:w-10 md:rounded-[12px]">
      {src && !imgError ? (
        <Image src={src} alt={name} fill className="object-cover" sizes="56px" unoptimized onError={() => setImgError(true)} />
      ) : (
        <Package className="h-5 w-5 text-cream-400" />
      )}
    </div>
  );
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

function MobileLineCard({
  line,
  imageUrl,
  estimateId,
  entryId,
  showTargetPricing,
}: {
  line: EnquiryTriageLine;
  imageUrl: string | null;
  estimateId: string;
  entryId: string;
  showTargetPricing: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const short = line.stock.tone !== 'ok';
  const showStockGapControl = short;
  const priceBasis = mobilePriceBasisLabel(line, showTargetPricing);

  return (
    <div className="overflow-hidden rounded-[14px] border border-cream-200 bg-white md:hidden">
      <div className={cn('px-4 py-4', line.stock.tone === 'danger' && 'border-l-4 border-l-danger-600', line.stock.tone === 'warning' && 'border-l-4 border-l-warning-500')}>
        <div className="flex items-start gap-3">
          <ProductThumb src={imageUrl} name={line.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-medium text-cream-900">{line.name}</p>
            <p className="mt-0.5 truncate font-mono text-sm text-cream-500">
              {line.sku}
            </p>
            <p className="mt-1 font-mono text-sm tabular-nums text-cream-700">{line.qty} unit x {priceBasis}</p>
            {line.onHand > 0 ? <p className="mt-0.5 font-mono text-sm tabular-nums text-cream-500">Stock {line.onHand}</p> : null}
            {line.buyerNote ? <p className="mt-1 text-sm italic text-cream-600">&ldquo;{line.buyerNote}&rdquo;</p> : null}
          </div>
          <div className="shrink-0 text-right">
            <p className="font-mono text-base font-semibold tabular-nums text-cream-950">
              {showTargetPricing ? quotedPriceLabel(line) : resolvedPriceLabel(line)}
            </p>
            {showTargetPricing ? (
              <p className="mt-1 font-mono text-xs tabular-nums text-cream-500">Expected {expectedPriceLabel(line)}</p>
            ) : null}
          </div>
        </div>

        {showStockGapControl ? (
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="mt-3 inline-flex items-center gap-1 rounded-full border border-warning-200 bg-warning-50 px-3 py-1.5 text-sm font-semibold text-warning-700 transition-colors hover:bg-warning-100"
          >
            Stock gap: {line.stock.label}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', detailsOpen && 'rotate-180')} aria-hidden />
          </button>
        ) : null}
      </div>
      {short && detailsOpen ? <AlternatesList line={line} estimateId={estimateId} entryId={entryId} /> : null}
    </div>
  );
}

function DesktopLineDetails({
  line,
  estimateId,
  entryId,
  open,
  colSpan,
}: {
  line: EnquiryTriageLine;
  estimateId: string;
  entryId: string;
  open: boolean;
  colSpan: number;
}) {
  if (!open) return null;
  const short = line.stock.tone !== 'ok';
  if (!short) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="border-b border-cream-100 bg-cream-50 px-6 py-4">
        <AlternatesList line={line} estimateId={estimateId} entryId={entryId} />
      </td>
    </tr>
  );
}

function DesktopLinesTable({
  lines,
  imageById,
  estimateId,
  entryId,
  showTargetPricing,
}: {
  lines: EnquiryTriageLine[];
  imageById: Map<string, string | null>;
  estimateId: string;
  entryId: string;
  showTargetPricing: boolean;
}) {
  const [openLineId, setOpenLineId] = useState<string | null>(null);
  const totalUnits = lines.reduce((sum, line) => sum + line.qty, 0);
  const colSpan = showTargetPricing ? 6 : 5;

  return (
    <section className="doc-lines hidden overflow-hidden rounded-[14px] border border-cream-300 bg-white md:block">
      <div className="border-b border-cream-200 px-4 py-3">
        <p className="title text-base font-semibold text-cream-950">
          {lines.length} item{lines.length === 1 ? '' : 's'}. {totalUnits} unit{totalUnits === 1 ? '' : 's'}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="lines-table w-full table-fixed text-left text-base">
          <colgroup>
            <col className="w-[4.25rem]" />
            <col className={showTargetPricing ? 'w-[38%]' : 'w-[48%]'} />
            <col className="w-[5.75rem]" />
            {showTargetPricing ? <col className="w-[7rem]" /> : null}
            <col className="w-[6.5rem]" />
            <col className="w-[6.75rem]" />
          </colgroup>
          <thead>
            <tr className="border-b border-cream-200 bg-white">
              <th className="table-label py-2 pl-6 pr-5 text-cream-700">#</th>
              <th className="table-label px-3 py-2 text-cream-700">Product</th>
              <th className="table-label num px-2 py-2 text-right text-cream-700">Quantity</th>
              {showTargetPricing ? (
                <th className="table-label num px-2 py-2 text-right text-cream-700">Expected</th>
              ) : null}
              <th className="table-label num px-2 py-2 text-right text-cream-700">{showTargetPricing ? 'Quote' : 'Price/unit'}</th>
              <th className="table-label num py-2 pl-2 pr-6 text-right text-cream-700">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const detailsOpen = openLineId === line.id;
              const short = line.stock.tone !== 'ok';
              return (
                <Fragment key={line.id}>
                  <tr className={cn('border-b border-cream-50', line.stock.tone === 'danger' && 'doc-line-stock-danger', line.stock.tone === 'warning' && 'doc-line-stock-warning')}>
                    <td className="py-3 pl-6 pr-5 tabular-nums text-cream-600">{index + 1}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-start gap-3">
                        <ProductThumb src={imageById.get(line.id) ?? null} name={line.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-cream-900" title={line.name}>{line.name}</p>
                          <p className="truncate text-xs text-cream-600">{desktopLineSubtext(line)}</p>
                          {line.buyerNote ? <p className="mt-1 truncate text-xs italic text-cream-600">&ldquo;{line.buyerNote}&rdquo;</p> : null}
                          {short ? (
                            <button
                              type="button"
                              onClick={() => setOpenLineId((current) => (current === line.id ? null : line.id))}
                              className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-warning-200 bg-warning-50 px-2.5 py-1 text-xs font-semibold text-warning-700 transition-colors hover:bg-warning-100"
                            >
                              Stock gap: {line.stock.label}
                              <ChevronDown className={cn('h-3 w-3 transition-transform', detailsOpen && 'rotate-180')} aria-hidden />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="num px-2 py-3 text-right tabular-nums text-cream-900">{line.qty}</td>
                    {showTargetPricing ? (
                      <td className="num px-2 py-3 text-right font-mono tabular-nums text-cream-800">{expectedPriceLabel(line)}</td>
                    ) : null}
                    <td className="num px-2 py-3 text-right font-mono font-semibold tabular-nums text-cream-900">
                      {showTargetPricing ? quotedPriceLabel(line) : resolvedPriceLabel(line)}
                    </td>
                    <td className="num-display py-3 pl-2 pr-6 text-right font-mono tabular-nums text-cream-900">{lineAmountLabel(line, showTargetPricing)}</td>
                  </tr>
                  <DesktopLineDetails line={line} estimateId={estimateId} entryId={entryId} open={detailsOpen} colSpan={colSpan} />
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
  const showTargetPricing = data.hiddenPricing && data.collectTargetUnitPriceRange;

  return (
    <div className="space-y-4">
      <div className="space-y-3 md:hidden">
        {data.lines.map((line) => (
          <MobileLineCard
            key={line.id}
            line={line}
            imageUrl={imageById.get(line.id) ?? null}
            estimateId={data.estimateId}
            entryId={entryId}
            showTargetPricing={showTargetPricing}
          />
        ))}
      </div>
      <DesktopLinesTable
        lines={data.lines}
        imageById={imageById}
        estimateId={data.estimateId}
        entryId={entryId}
        showTargetPricing={showTargetPricing}
      />

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
