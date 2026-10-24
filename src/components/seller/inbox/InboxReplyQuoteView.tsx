'use client';

import Image from 'next/image';
import { useMemo, useRef, useState } from 'react';
import { Package, Plus, RotateCcw, Search, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useBusinessPolicy } from '@/hooks/useBusinessPolicy';
import { useEnquiryLineAlternates, useEnquiryTriage } from '@/hooks/useInboxEntries';
import { useEstimateComposer, useEstimateProductSearch, useSaveEstimateComposer, useSendEstimateDetailWhatsApp } from '@/hooks/useEstimates';
import { computeDocumentTotals, type GstLineInput } from '@/lib/gst';
import { enquiryStockStatus } from '@/lib/inbox/enquiry-triage';
import { buildTargetRangeLabel } from '@/lib/inbox/inbox-entry-copy';
import { cn, formatNumberValue } from '@/lib/utils';
import { StockCell } from './EnquiryLineDisplay';
import type { EstimateComposerLineInput, EstimateComposerProductSearchRow, EstimateComposerSavePayload } from '@/types/estimate-composer';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

interface AddedLine {
  tempId: string;
  product: EstimateComposerProductSearchRow;
}

interface QuoteRow {
  key: string;
  itemId?: string;
  isAdded: boolean;
  name: string;
  sku: string;
  imageUrl: string | null;
  onHand: number;
  discPct: number;
  taxPct: number;
  targetMin: number | null;
  targetMax: number | null;
  resolvedPrice: number | null;
  baseRate: number | null;
  removed: boolean;
  priceValue: string;
  qtyValue: string;
}

/**
 * All the state/mutation logic behind the quote-editing surface, shared by the
 * desktop dialog and the mobile full-screen route so the two never diverge.
 * Reuses the estimate composer's own save (`useSaveEstimateComposer`) instead
 * of a scoped per-line endpoint -- that's what makes Subtotal/GST/Total
 * persist correctly and add/remove "just work" via its existing
 * insert-if-no-id / soft-delete-if-omitted semantics.
 */
export function useInboxReplyQuoteDraft(entry: InboxEntry, enabled = true) {
  const queryClient = useQueryClient();
  const estimateId = enabled && entry.source_entity_type === 'estimate' ? entry.source_entity_id : '';
  const composerQuery = useEstimateComposer(estimateId || null);
  const triageQuery = useEnquiryTriage(entry.id, enabled);
  const saveMutation = useSaveEstimateComposer(estimateId || null);
  const sendMutation = useSendEstimateDetailWhatsApp(estimateId);

  const composer = composerQuery.data;
  const triageByItemId = useMemo(
    () => new Map((triageQuery.data?.lines ?? []).map((l) => [l.id, l])),
    [triageQuery.data],
  );

  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [addedLines, setAddedLines] = useState<AddedLine[]>([]);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);

  const [productQuery, setProductQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchResult = useEstimateProductSearch(productQuery, composer?.buyer_id ?? null, searchOpen);
  const existingProductIds = useMemo(
    () => new Set([
      ...(composer?.items ?? []).map((i) => i.tenant_product_id),
      ...addedLines.map((a) => a.product.tenant_product_id),
    ]),
    [composer, addedLines],
  );
  const searchResults = useMemo(
    () => searchResult.data.filter((p) => !existingProductIds.has(p.tenant_product_id)),
    [searchResult.data, existingProductIds],
  );

  function priceFor(item: EstimateComposerLineInput): string {
    return priceDrafts[item.id] ?? (item.unit_price > 0 ? String(item.unit_price) : '');
  }
  function qtyFor(item: EstimateComposerLineInput): string {
    return qtyDrafts[item.id] ?? String(item.qty);
  }

  const existingRows: QuoteRow[] = (composer?.items ?? []).map((item) => {
    const triageLine = triageByItemId.get(item.id);
    return {
      key: item.id,
      itemId: item.id,
      isAdded: false,
      name: item.product_name,
      sku: item.sku,
      imageUrl: item.image_url ?? null,
      onHand: item.on_hand,
      discPct: item.disc_pct,
      taxPct: item.tax_pct,
      targetMin: item.buyer_target_unit_price_min ?? null,
      targetMax: item.buyer_target_unit_price_max ?? null,
      resolvedPrice: triageLine?.resolvedPrice ?? null,
      baseRate: triageLine?.baseRate ?? null,
      removed: removedIds.has(item.id),
      priceValue: priceFor(item),
      qtyValue: qtyFor(item),
    };
  });

  const addedRows: QuoteRow[] = addedLines.map((added) => ({
    key: added.tempId,
    isAdded: true,
    name: added.product.product_name,
    sku: added.product.sku,
    imageUrl: null,
    onHand: added.product.on_hand,
    discPct: 0,
    taxPct: added.product.tax_pct ?? 0,
    targetMin: null,
    targetMax: null,
    resolvedPrice: null,
    baseRate: null,
    removed: false,
    priceValue: priceDrafts[added.tempId] ?? (added.product.unit_price > 0 ? String(added.product.unit_price) : ''),
    qtyValue: qtyDrafts[added.tempId] ?? '1',
  }));

  const rows = [...existingRows, ...addedRows];

  const { gstInclusive, policyLoading } = useBusinessPolicy();

  const totals = useMemo(() => {
    const lines: GstLineInput[] = rows.map((row) => ({
      qty: Number(row.qtyValue) || 0,
      unit_price: Number(row.priceValue) || 0,
      disc_pct: row.discPct,
      tax_pct: row.taxPct,
      diff: row.removed ? 'removed' : 'clean',
    }));
    return computeDocumentTotals(lines, gstInclusive);
  }, [rows, gstInclusive]);

  function setPrice(key: string, value: string) {
    setPriceDrafts((prev) => ({ ...prev, [key]: value }));
  }
  function setQty(key: string, value: string) {
    setQtyDrafts((prev) => ({ ...prev, [key]: value }));
  }
  function toggleRemoved(itemId: string) {
    setRemovedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }
  function addProduct(product: EstimateComposerProductSearchRow) {
    setAddedLines((prev) => [...prev, { tempId: `added-${product.tenant_product_id}`, product }]);
    setProductQuery('');
    setSearchOpen(false);
  }
  function removeAdded(tempId: string) {
    setAddedLines((prev) => prev.filter((a) => a.tempId !== tempId));
  }
  function addAlternate(alt: { tenantProductId: string; name: string; sku: string }, unitPrice: number, taxPct: number, onHand: number) {
    addProduct({
      tenant_product_id: alt.tenantProductId,
      product_name: alt.name,
      sku: alt.sku,
      brand_name: '',
      brand_initials: '',
      brand_hue: 'cream',
      hsn_code: null,
      tax_pct: taxPct,
      on_hand: onHand,
      unit_price: unitPrice,
      mrp: unitPrice,
      base_selling_price: unitPrice,
      default_uom: null,
      pack_size: null,
    });
  }

  const notesValue = notesDraft ?? composer?.seller_note ?? '';

  async function saveDraft(): Promise<boolean> {
    type SaveItem = NonNullable<EstimateComposerSavePayload['items']>[number];
    const keptExisting: SaveItem[] = existingRows
      .filter((row) => !row.removed)
      .map((row) => {
        const item = composer!.items.find((i) => i.id === row.itemId)!;
        return {
          id: item.id,
          tenant_product_id: item.tenant_product_id,
          qty: Number(row.qtyValue) || item.qty,
          unit_price: Number(row.priceValue) || 0,
          disc_pct: item.disc_pct,
          tax_pct: item.tax_pct,
          item_order: item.item_order ?? null,
        };
      });
    const newlyAdded: SaveItem[] = addedRows.map((row) => {
      const added = addedLines.find((a) => a.tempId === row.key)!;
      return {
        tenant_product_id: added.product.tenant_product_id,
        qty: Number(row.qtyValue) || 1,
        unit_price: Number(row.priceValue) || 0,
        disc_pct: 0,
        tax_pct: added.product.tax_pct ?? 0,
      };
    });
    const items: SaveItem[] = [...keptExisting, ...newlyAdded];

    if (items.length === 0) {
      toast.error('At least one item is required');
      return false;
    }

    try {
      await saveMutation.mutateAsync({ items, seller_note: notesValue });
      // The triage panel/list rows read a separate cache from the composer's --
      // without this they keep showing removed lines and stale prices.
      void queryClient.invalidateQueries({ queryKey: ['inbox-entry-enquiry', entry.id] });
      void queryClient.invalidateQueries({ queryKey: ['inbox-entry-enquiry', 'summary'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      toast.success('Draft saved');
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this quote');
      return false;
    }
  }

  async function sendQuote(): Promise<boolean> {
    const saved = await saveDraft();
    if (!saved) return false;
    try {
      await sendMutation.mutateAsync();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send this quote');
      return false;
    }
  }

  const priceMissing = rows.some((row) => !row.removed && (!row.priceValue || Number(row.priceValue) <= 0));
  const activeRowCount = rows.filter((row) => !row.removed).length;

  return {
    isLoading: composerQuery.isLoading,
    isError: composerQuery.isError,
    composer,
    rows,
    totals,
    gstInclusive,
    policyLoading,
    notesValue,
    setNotes: (value: string) => setNotesDraft(value),
    setPrice,
    setQty,
    toggleRemoved,
    addAlternate,
    triageByItemId,
    entryId: entry.id,
    // Seller quotes against the buyer's resolved price only where prices are hidden and targets are collected.
    showTargetPricing: !!triageQuery.data && triageQuery.data.hiddenPricing && triageQuery.data.collectTargetUnitPriceRange,
    productQuery,
    setProductQuery,
    searchOpen,
    setSearchOpen,
    searchResults,
    searchLoading: searchResult.isLoading,
    addProduct,
    removeAdded,
    canSave: activeRowCount > 0 && !priceMissing,
    canSend: activeRowCount > 0 && !priceMissing,
    isSaving: saveMutation.isPending,
    isSending: sendMutation.isPending,
    saveDraft,
    sendQuote,
  };
}

export type InboxReplyQuoteDraft = ReturnType<typeof useInboxReplyQuoteDraft>;

function money(value: number): string {
  return formatNumberValue(value, 'CURRENCY_EXACT');
}

/** Blur-formats to comma-grouped digits; stays raw while focused so typing isn't fought. */
function CurrencyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [focused, setFocused] = useState(false);
  const display = !focused && value && Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN') : value;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-cream-500">₹</span>
      <Input
        type="text"
        inputMode="decimal"
        value={display}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, '');
          onChange(raw);
        }}
        className="h-9 w-28 pl-6 pr-2 text-right font-mono text-sm tabular-nums"
      />
    </div>
  );
}

/** Alternates for one short line, fetched only once the seller asks for them. */
function AlternateChips({ draft, lineId }: { draft: InboxReplyQuoteDraft; lineId: string }) {
  const query = useEnquiryLineAlternates(draft.entryId, lineId, true);
  if (query.isLoading) return <p className="mt-2 text-xs text-cream-500">Finding in-stock alternatives…</p>;
  const alternates = query.data?.alternates ?? [];
  if (alternates.length === 0) return <p className="mt-2 text-xs text-cream-500">No in-stock alternatives found.</p>;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {alternates.map((alt) => (
        <button
          key={alt.tenantProductId}
          type="button"
          onClick={() => draft.addAlternate(alt, alt.buyerPrice ?? 0, 0, alt.available)}
          className="inline-flex items-center gap-1 rounded-full border border-cream-300 bg-white px-2.5 py-1 text-xs font-medium text-cream-700 hover:bg-cream-50"
        >
          <Plus className="h-3 w-3" /> {alt.name}
        </button>
      ))}
    </div>
  );
}

function QuoteRowCard({ row, draft }: { row: QuoteRow; draft: InboxReplyQuoteDraft }) {
  const [imgError, setImgError] = useState(false);
  const qty = Number(row.qtyValue) || 0;
  const stock = enquiryStockStatus(qty, row.onHand);
  const [alternatesOpen, setAlternatesOpen] = useState(false);
  const targetLabel = buildTargetRangeLabel(row.targetMin, row.targetMax);

  return (
    <div className={cn('rounded-[14px] border border-cream-200 px-4 py-4', row.removed && 'bg-cream-50 opacity-60')}>
      <div className="flex items-start gap-3">
        <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-cream-200 bg-cream-100">
          {row.imageUrl && !imgError ? (
            <Image src={row.imageUrl} alt="" fill className="object-cover" sizes="56px" unoptimized onError={() => setImgError(true)} />
          ) : (
            <Package className="h-5 w-5 text-cream-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium text-cream-900', row.removed && 'line-through')}>{row.name}</p>
          <p className="mt-0.5 truncate font-mono text-xs text-cream-500">{row.sku}</p>
        </div>
        {row.itemId ? (
          <button
            type="button"
            onClick={() => draft.toggleRemoved(row.itemId!)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-cream-500 hover:bg-cream-100 hover:text-cream-900"
            aria-label={row.removed ? `Undo remove ${row.name}` : `Remove ${row.name}`}
          >
            {row.removed ? <RotateCcw className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => draft.removeAdded(row.key)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-cream-500 hover:bg-cream-100 hover:text-cream-900"
            aria-label={`Remove ${row.name}`}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {!row.removed ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            {draft.showTargetPricing ? (
              <>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-cream-500">Buyer target</p>
                  <p className="mt-0.5 font-mono text-sm text-cream-700">{targetLabel ?? 'None given'}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-cream-500">Resolved price</p>
                  <p className="mt-0.5 font-mono text-sm text-cream-700">{row.resolvedPrice != null ? money(row.resolvedPrice) : '—'}</p>
                </div>
              </>
            ) : (
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-cream-500">Base rate</p>
                <p className="mt-0.5 font-mono text-sm text-cream-700">{row.baseRate != null ? money(row.baseRate) : '—'}</p>
              </div>
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-cream-500">Stock</p>
              <StockCell stock={stock} onHand={row.onHand} align="start" />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-cream-500">Your quote</p>
              <div className="mt-0.5">
                <CurrencyInput value={row.priceValue} onChange={(v) => draft.setPrice(row.key, v)} />
              </div>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-cream-500">Quantity</p>
              <Input
                type="number"
                min={0}
                value={row.qtyValue}
                onChange={(e) => draft.setQty(row.key, e.target.value.replace(/[^0-9.]/g, ''))}
                className="mt-0.5 h-9 w-20 px-2 text-right font-mono text-sm tabular-nums"
              />
            </div>
          </div>

          {row.itemId && stock.tone !== 'ok' ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setAlternatesOpen((v) => !v)}
                aria-expanded={alternatesOpen}
                className="inline-flex items-center gap-1 rounded-full border border-warning-200 bg-warning-50 px-2.5 py-1 text-xs font-semibold text-warning-700 hover:bg-warning-100"
              >
                Find alternatives
              </button>
              {alternatesOpen ? <AlternateChips draft={draft} lineId={row.itemId} /> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ProductSearchBox({ draft }: { draft: InboxReplyQuoteDraft }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cream-500" />
        <Input
          placeholder="Add a product…"
          value={draft.productQuery}
          onChange={(e) => { draft.setProductQuery(e.target.value); draft.setSearchOpen(true); }}
          onFocus={() => draft.setSearchOpen(true)}
          className="h-10 pl-9 pr-3 text-sm"
        />
      </div>
      {draft.searchOpen && (draft.productQuery.length > 0 || draft.searchResults.length > 0) ? (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[220px] overflow-y-auto rounded-[10px] border border-cream-200 bg-white shadow-lg">
          {draft.searchLoading ? (
            <p className="px-3 py-3 text-sm text-cream-500">Searching…</p>
          ) : draft.searchResults.length === 0 ? (
            <p className="px-3 py-3 text-sm text-cream-500">{draft.productQuery ? 'No results' : 'Type to search products'}</p>
          ) : (
            draft.searchResults.map((product) => (
              <button
                key={product.tenant_product_id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); draft.addProduct(product); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-cream-50"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-teal-600" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-cream-900">{product.product_name}</p>
                  <p className="truncate font-mono text-xs text-cream-500">{product.sku} · {money(product.unit_price)}</p>
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function InboxReplyQuoteBody({ draft }: { draft: InboxReplyQuoteDraft }) {
  if (draft.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading quote">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-[14px] bg-cream-100" />
        ))}
      </div>
    );
  }
  if (draft.isError || !draft.composer) {
    return <p className="text-sm text-cream-600">Couldn&apos;t load this estimate.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {draft.rows.map((row) => (
          <QuoteRowCard key={row.key} row={row} draft={draft} />
        ))}
      </div>

      <ProductSearchBox draft={draft} />

      <div className="rounded-[14px] border border-cream-300 bg-cream-50 px-4 py-4">
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-cream-700">Subtotal</span>
            <span className="font-mono text-cream-900">{draft.policyLoading ? '—' : money(draft.totals.subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-cream-700">GST</span>
            <span className="font-mono text-cream-900">{draft.policyLoading ? '—' : draft.gstInclusive ? 'Included in prices' : money(draft.totals.tax_amount)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-cream-200 pt-2 text-base">
            <span className="font-medium text-cream-900">Total</span>
            <span className="font-mono font-semibold text-cream-950">{draft.policyLoading ? '—' : money(draft.totals.total)}</span>
          </div>
        </div>
      </div>

      <Textarea
        label="Notes for the buyer"
        placeholder="e.g. the roofing sheet is out of stock this week, or the price reflects a bulk discount"
        value={draft.notesValue}
        onChange={(e) => draft.setNotes(e.target.value)}
        hint="Saved on the estimate and visible to the buyer in-app -- WhatsApp's fixed message template can't carry free text."
      />
    </div>
  );
}
