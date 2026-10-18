'use client';

import { formatNumberValue } from '@/lib/utils';
import * as React from 'react';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MapPin, Package, ShoppingCart } from 'lucide-react';
import { BuyerDetailShell } from '@/components/buyer/layout/BuyerDetailShell';
import { ErrorState } from '@/components/ui/empty-state';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { apiFetch } from '@/lib/api-fetch';
import { BUYER_PREVIEW_MAX_WIDTH } from '@/lib/buyer-preview';
import { BuyerFixedFooter } from '@/components/buyer/layout/BuyerFixedFooter';
import { BUYER_CARD_RADIUS_CLASS } from '@/lib/buyer-ui';
import { useCart, type BuyerCartItem } from '@/contexts/BuyerCartContext';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { computeDisplayDocumentTotals, computeLineTaxableAmount, roundMoney } from '@/lib/gst';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TransactionLineItem {
  tenant_product_id: string;
  product_name: string;
  internal_sku: string | null;
  unit: string | null;
  image_url?: string | null;
  qty: number;
  unit_price: number | null;
  tax_rate: number | null;
  line_total: number | null;
  /** Line discount %; invoices/orders can carry one (buyer estimate lines never do). */
  disc_pct?: number | null;
  buyer_target_unit_price_min?: number | null;
  buyer_target_unit_price_max?: number | null;
}

export interface TransactionDoc {
  /** Document identifier shown in body title row */
  docNumber: string;
  status: string;
  /** ISO date string — created / placed / invoice date */
  primaryDate: string;
  /** Due date (invoices) or valid-until date (estimates) */
  secondaryDate?: string | null;
  notes: string | null;
  subtotal: number;
  tax_total: number;
  total_amount: number;
  /** Extra amount shown below total (e.g. outstanding balance on invoices) */
  outstandingBalance?: number | null;
  placeOfSupply: string | null;
  /** Header-level adjustments (invoices) folded into the derived total. */
  discount_flat?: number | null;
  freight?: number | null;
  round_off?: number | null;
  items: TransactionLineItem[];
  /** Campaign whose price was applied to the lines (estimates) — same price the buyer saw on cards and cart. */
  campaignName?: string | null;
}

export type DocType = 'order' | 'estimate' | 'invoice';

interface TransactionDetailPageProps {
  id: string;
  title: string;
  endpoint: string;
  docType: DocType;
  backFallbackHref?: string;
  respectBusinessPolicyTotals?: boolean;
  /** Extract TransactionDoc from the API response payload */
  pickDoc: (payload: any) => TransactionDoc | null;
}

// ── Status pill mappings ──────────────────────────────────────────────────────

const orderStatusBadge: Record<string, { tone: StatusTone; label: string }> = {
  draft:               { tone: 'neutral', label: 'Draft' },
  received:            { tone: 'info', label: 'Received' },
  confirmed:           { tone: 'accent', label: 'Confirmed' },
  partially_dispatched:{ tone: 'warning', label: 'In Transit' },
  dispatched:          { tone: 'warning', label: 'Dispatched' },
  delivered:           { tone: 'success', label: 'Delivered' },
  cancelled:           { tone: 'danger', label: 'Cancelled' },
  pending:             { tone: 'info', label: 'Pending' },
  sent:                { tone: 'warning', label: 'Sent' },
  accepted:            { tone: 'success', label: 'Accepted' },
  declined:            { tone: 'danger', label: 'Declined' },
  expired:             { tone: 'info', label: 'Expired' },
  converted:           { tone: 'success', label: 'Converted' },
  invoiced:            { tone: 'success', label: 'Invoiced' },
  paid:                { tone: 'success', label: 'Paid' },
  due:                 { tone: 'warning', label: 'Due' },
  overdue:             { tone: 'danger', label: 'Overdue' },
  void:                { tone: 'danger', label: 'Void' },
};

function getStatusBadge(status: string): { tone: StatusTone; label: string } {
  return orderStatusBadge[status] ?? { tone: 'neutral', label: status };
}

export function getTransactionStatusBadge(status: string): { tone: StatusTone; label: string } {
  return getStatusBadge(status);
}

export function formatTransactionDocSubtitle(doc: TransactionDoc, docType: DocType): string {
  const created = fmtDate(doc.primaryDate);
  if (docType === 'invoice' && doc.secondaryDate) {
    return `${created} · due ${fmtDate(doc.secondaryDate)}`;
  }
  if (docType === 'estimate' && doc.secondaryDate) {
    return `${created} · valid until ${fmtDate(doc.secondaryDate)}`;
  }
  return created;
}

function LineItemRow({ item }: { item: TransactionLineItem }) {
  const pricePending = item.unit_price == null;
  const hasTargetRange = item.buyer_target_unit_price_min != null && item.buyer_target_unit_price_max != null;
  return (
    <div className="flex items-start gap-3 py-3">
      <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-cream-200 bg-cream-100">
        {item.image_url ? (
          <Image
            src={item.image_url}
            alt={item.product_name}
            fill
            className="object-cover"
            sizes="56px"
            unoptimized
          />
        ) : (
          <Package className="h-5 w-5 text-[var(--cream-400)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[var(--b-text-body)] font-semibold text-[var(--cream-900)]">
          {item.product_name}
        </p>
        {item.internal_sku && (
          <p className="mt-0.5 font-mono text-[var(--b-text-eyebrow)] text-[var(--cream-600)]">
            {item.internal_sku}
          </p>
        )}
        <p className="mt-1 text-[var(--b-text-sub)] text-[var(--cream-600)]">
          {pricePending
            ? `${item.qty} ${item.unit ?? 'unit'} · Price pending`
            : `${item.qty} ${item.unit ?? 'unit'} × ${formatNumberValue(item.unit_price ?? 0, 'CURRENCY_EXACT')}`}
        </p>
        {hasTargetRange ? (
          <p className="mt-1 text-[var(--b-text-sub)] text-[var(--cream-700)]">
            Target rate: {formatNumberValue(item.buyer_target_unit_price_min ?? 0, 'CURRENCY_EXACT')} - {formatNumberValue(item.buyer_target_unit_price_max ?? 0, 'CURRENCY_EXACT')} / {item.unit ?? 'unit'}
          </p>
        ) : null}
      </div>
      {!pricePending ? (
        <p className="shrink-0 font-mono text-[var(--b-text-body)] font-semibold text-[var(--cream-900)]">
          {formatNumberValue(item.line_total ?? 0, 'CURRENCY_EXACT')}
        </p>
      ) : null}
    </div>
  );
}

function TotalsBlock({
  subtotal,
  tax_total,
  total_amount,
  outstandingBalance,
  gstInclusive,
  gstRate,
  respectBusinessPolicyTotals,
  derivedTotals,
  adjustments,
}: {
  subtotal: number;
  tax_total: number;
  total_amount: number;
  outstandingBalance?: number | null;
  gstInclusive: boolean;
  gstRate: number;
  respectBusinessPolicyTotals: boolean;
  derivedTotals?: { subtotal: number; tax_amount: number; grand_total: number } | null;
  adjustments?: { discount_flat?: number | null; freight?: number | null; round_off?: number | null } | null;
}) {
  const displayTax = derivedTotals
    ? derivedTotals.tax_amount
    : respectBusinessPolicyTotals
    ? (gstInclusive ? 0 : roundMoney(subtotal * (gstRate / 100)))
    : tax_total;
  const displayTotal = derivedTotals
    ? derivedTotals.grand_total
    : respectBusinessPolicyTotals
      ? roundMoney(subtotal + displayTax)
      : total_amount;

  return (
    <div
      className={`${BUYER_CARD_RADIUS_CLASS} border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-4`}
      style={{ background: 'white' }}
    >
      <div className="flex justify-between text-[var(--b-text-body)] text-[var(--cream-700)]">
        <span>Subtotal</span>
        <span className="font-mono">{formatNumberValue(subtotal, 'CURRENCY_EXACT')}</span>
      </div>
      <div className="mt-2 flex justify-between text-[var(--b-text-body)] text-[var(--cream-600)]">
        <span>GST</span>
        <span className="font-mono">
          {gstInclusive
            ? 'Included in Prices'
            : `${formatNumberValue(displayTax, 'CURRENCY_EXACT')}${respectBusinessPolicyTotals && !derivedTotals ? ` (${gstRate}%)` : ''}`}
        </span>
      </div>
      {(adjustments?.discount_flat ?? 0) !== 0 ? (
        <div className="mt-2 flex justify-between text-[var(--b-text-body)] text-[var(--cream-600)]">
          <span>Discount</span>
          <span className="font-mono">-{formatNumberValue(adjustments?.discount_flat ?? 0, 'CURRENCY_EXACT')}</span>
        </div>
      ) : null}
      {(adjustments?.freight ?? 0) !== 0 ? (
        <div className="mt-2 flex justify-between text-[var(--b-text-body)] text-[var(--cream-600)]">
          <span>Freight</span>
          <span className="font-mono">{formatNumberValue(adjustments?.freight ?? 0, 'CURRENCY_EXACT')}</span>
        </div>
      ) : null}
      {(adjustments?.round_off ?? 0) !== 0 ? (
        <div className="mt-2 flex justify-between text-[var(--b-text-body)] text-[var(--cream-600)]">
          <span>Round off</span>
          <span className="font-mono">{formatNumberValue(adjustments?.round_off ?? 0, 'CURRENCY_EXACT')}</span>
        </div>
      ) : null}
      <div className="mt-3 flex justify-between border-t border-[var(--border-1)] pt-3">
        <span className="font-semibold text-[var(--cream-900)]">Total</span>
        <span className="font-mono text-lg font-bold text-[var(--cream-900)]">{formatNumberValue(displayTotal, 'CURRENCY_EXACT')}</span>
      </div>
      {outstandingBalance != null && outstandingBalance > 0 && (
        <div className="mt-2 flex justify-between text-[var(--b-text-sub)] text-[var(--danger-500)]">
          <span>Outstanding</span>
          <span className="font-mono font-semibold">{formatNumberValue(outstandingBalance, 'CURRENCY_EXACT')}</span>
        </div>
      )}
    </div>
  );
}

export function TransactionDetailDocumentBody({
  doc,
  docType,
  gstInclusive,
  gstRate,
  respectBusinessPolicyTotals,
}: {
  doc: TransactionDoc;
  docType: DocType;
  gstInclusive: boolean;
  gstRate: number;
  respectBusinessPolicyTotals: boolean;
}) {
  const { data: meData } = useBuyerMe();
  const tenantName = meData?.tenant.name?.trim() || 'Seller';
  const badge = getStatusBadge(doc.status);
  const totalUnits = doc.items.reduce((sum, item) => sum + item.qty, 0);
  const deliveryPlace = doc.placeOfSupply?.trim() ?? '';
  const pricePending = docType === 'estimate' && doc.items.some((item) => item.unit_price == null);
  // Estimates, invoices and orders: stored line_total/subtotal can be ex-GST after a Zoho sync-back, so lines are
  // qty x unit_price (less any line discount) as captured at submission and the subtotal is their sum.
  // Partially-priced estimates hide totals via `pricePending`.
  const showResolvedPrices = respectBusinessPolicyTotals;
  const displayItems = showResolvedPrices
    ? doc.items.map((item) => (
        item.unit_price == null
          ? item
          : {
              ...item,
              line_total: roundMoney(
                computeLineTaxableAmount({ qty: item.qty, unit_price: item.unit_price, disc_pct: item.disc_pct ?? 0 }),
              ),
            }
      ))
    : doc.items;
  const displaySubtotal = showResolvedPrices
    ? roundMoney(displayItems.reduce((sum, item) => sum + (item.line_total ?? 0), 0))
    : doc.subtotal;
  // Invoices and orders keep the backend tax (per-line rates) when exclusive; estimates derive it from the policy rate.
  const derivedTotals = showResolvedPrices && docType !== 'estimate'
    ? computeDisplayDocumentTotals(
        displayItems.map((item) => ({ qty: item.qty, unit_price: item.unit_price ?? 0, disc_pct: item.disc_pct ?? 0 })),
        { gstInclusive, taxAmount: doc.tax_total, discount_flat: doc.discount_flat, freight: doc.freight, round_off: doc.round_off },
      )
    : null;

  return (
    <div className="flex flex-col space-y-3">
      <div className="px-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--cream-600)]">
          {doc.items.length} product{doc.items.length !== 1 ? 's' : ''} · {totalUnits} unit{totalUnits !== 1 ? 's' : ''}
        </p>
        <div className="mt-1 flex items-start justify-between gap-3">
          <h2 className="min-w-0 flex-1 font-mono text-[var(--b-text-page)] font-semibold leading-tight text-[var(--cream-900)]">
            {doc.docNumber}
          </h2>
          <StatusPill label={badge.label} tone={badge.tone} />
        </div>
        <p className="mt-1 text-[var(--b-text-sub)] text-[var(--cream-600)]">
          {formatTransactionDocSubtitle(doc, docType)}
        </p>
        {doc.campaignName ? (
          <p className="mt-2 text-[var(--b-text-sub)] font-medium text-[var(--success-700)]">
            Campaign price applied: {doc.campaignName}
          </p>
        ) : null}
        {doc.notes ? (
          <p className="mt-2 text-sm leading-5 text-[var(--cream-800)]">{doc.notes}</p>
        ) : null}
      </div>

      <div
        className={`${BUYER_CARD_RADIUS_CLASS} border border-[var(--border-1)] px-4 py-4`}
        style={{ background: 'white' }}
      >
        {doc.items.length > 0 ? (
          <div>
            {displayItems.map((item, idx) => (
              <React.Fragment key={item.tenant_product_id + idx}>
                <LineItemRow item={item} />
                {idx < displayItems.length - 1 && <div className="h-px bg-[var(--border-1)]" />}
              </React.Fragment>
            ))}
          </div>
        ) : (
          <div className="py-2 text-center text-[var(--b-text-sub)] text-[var(--cream-600)]">
            No items found.
          </div>
        )}
      </div>

      {pricePending ? (
        <div className={`${BUYER_CARD_RADIUS_CLASS} border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-4`}>
          <p className="font-semibold text-[var(--cream-900)]">{tenantName} will respond with prices.</p>
          <p className="mt-1 text-[var(--b-text-sub)] text-[var(--cream-600)]">No subtotal or total is calculated for this enquiry yet.</p>
        </div>
      ) : (
      <TotalsBlock
        subtotal={displaySubtotal}
        tax_total={doc.tax_total}
        total_amount={doc.total_amount}
        outstandingBalance={doc.outstandingBalance}
        gstInclusive={gstInclusive}
        gstRate={gstRate}
        respectBusinessPolicyTotals={respectBusinessPolicyTotals}
        derivedTotals={derivedTotals}
        adjustments={showResolvedPrices && docType !== 'estimate'
          ? { discount_flat: doc.discount_flat, freight: doc.freight, round_off: doc.round_off }
          : null}
      />
      )}

      {deliveryPlace ? (
        <div className={`${BUYER_CARD_RADIUS_CLASS} border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-4`}>
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-cream-200 bg-cream-100">
              <MapPin className="h-4 w-4 text-[var(--teal-500)]" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--cream-600)]">
                Delivery to
              </p>
              <p className="mt-1 font-semibold text-[var(--cream-900)]">
                {deliveryPlace}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReorderButton({
  items,
  docType,
  className,
}: {
  items: TransactionLineItem[];
  docType: DocType;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { items: cartItems, clearCart, addItem } = useCart();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const hasPendingPrice = items.some((item) => item.unit_price == null);

  function fillCart() {
    clearCart();
    items.forEach((item) => {
      const cartItem: BuyerCartItem = {
        tenant_product_id: item.tenant_product_id,
        name: item.product_name,
        internal_sku: item.internal_sku ?? undefined,
        unit_price: item.unit_price,
        resolved_price: null,
        has_campaign_price: false,
        unit: item.unit ?? undefined,
        quantity: item.qty,
        line_total: item.line_total ?? 0,
        gst_rate: item.tax_rate ?? null,
      };
      addItem(cartItem, undefined, {
        source_surface: 'document_reorder',
        source_document_type: docType,
      });
    });
    // Desktop keeps the persistent header/cart Sheet mounted across routes —
    // open it in place instead of navigating to the mobile-only /buy/cart page.
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      next.set('cart', 'open');
      router.push(`${pathname}?${next.toString()}`);
    } else {
      router.push('/buy/cart');
    }
  }

  function handleReorder() {
    if (cartItems.length > 0) {
      setConfirmOpen(true);
    } else {
      fillCart();
    }
  }

  const cartCount = cartItems.reduce((s, i) => s + i.quantity, 0);
  const sourceLabel = docType === 'order' ? 'order' : docType === 'invoice' ? 'invoice' : 'estimate';

  return (
    <>
      <button
        type="button"
        onClick={handleReorder}
        disabled={hasPendingPrice}
        className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-[var(--b-text-body)] font-semibold text-white transition-opacity active:opacity-80 ${className ?? ''}`}
        style={{ background: 'var(--teal-500)', opacity: hasPendingPrice ? 0.55 : undefined }}
      >
        <ShoppingCart className="h-4 w-4" />
        {hasPendingPrice ? 'Price pending' : 'Reorder'}
      </button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace cart?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove {cartCount} item{cartCount !== 1 ? 's' : ''} currently in your cart and replace them with items from this {sourceLabel}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                fillCart();
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TransactionDetailStickyFooter({ children }: { children: React.ReactNode }) {
  return (
    <BuyerFixedFooter
      className="left-1/2 w-full -translate-x-1/2 px-4 py-3"
      style={{
        maxWidth: BUYER_PREVIEW_MAX_WIDTH,
        paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
        background: 'rgba(253,251,247,0.96)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderTop: '1px solid var(--border-1)',
      }}
    >
      {children}
    </BuyerFixedFooter>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TransactionDetailPage({
  id,
  title,
  endpoint,
  docType,
  backFallbackHref,
  respectBusinessPolicyTotals = false,
  pickDoc,
}: TransactionDetailPageProps) {
  const { data: meData } = useBuyerMe();
  const [loading, setLoading] = React.useState(true);
  const [fetchError, setFetchError] = React.useState(false);
  const [doc, setDoc] = React.useState<TransactionDoc | null>(null);
  const gstInclusive = meData?.business_policy.gst_inclusive ?? false;
  const gstRate = meData?.business_policy.gst_rate ?? 18;

  // The server layout title is static; show the document number once the payload resolves.
  const docNumber = doc?.docNumber?.trim();
  React.useEffect(() => {
    if (docNumber) document.title = docNumber;
  }, [docNumber]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(false);
    apiFetch(endpoint)
      .then((r) => r.json())
      .then((payload) => {
        if (cancelled) return;
        setDoc(pickDoc(payload));
      })
      .catch(() => {
        if (!cancelled) setFetchError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // pickDoc is a page-level constant; only re-fetch when the route id changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, id]);

  const showReorderFooter = Boolean(doc && doc.items.length > 0 && docType !== 'invoice');

  return (
    <div className="flex min-h-[50dvh] flex-col pb-[var(--tab-bar)]">
      <BuyerDetailShell
        title={title}
        hideSearchOnDesktop
        showLocationControl={false}
        backFallbackHref={backFallbackHref}
      >
        {loading ? (
          <div className="space-y-3 px-4 py-4 pb-24">
            <div className="space-y-2 px-1">
              <div className="h-3 w-32 animate-pulse rounded-full bg-cream-200" />
              <div className="flex items-start justify-between gap-3">
                <div className="h-8 w-40 animate-pulse rounded bg-cream-200" />
                <div className="h-6 w-20 animate-pulse rounded-full bg-cream-200" />
              </div>
              <div className="h-4 w-52 animate-pulse rounded-full bg-cream-200" />
            </div>
            <div className={`h-40 animate-pulse border border-cream-200 bg-[var(--bg-surface)] ${BUYER_CARD_RADIUS_CLASS}`} />
            <div className={`h-28 animate-pulse border border-cream-200 bg-[var(--bg-surface)] ${BUYER_CARD_RADIUS_CLASS}`} />
            <div className={`h-24 animate-pulse border border-cream-200 bg-[var(--bg-surface)] ${BUYER_CARD_RADIUS_CLASS}`} />
          </div>
        ) : fetchError ? (
          <div className="p-4">
            <ErrorState
              heading={`Couldn't load ${title.toLowerCase()}`}
              description="Check your connection and try again."
              onRetry={() => {
                setDoc(null);
                setLoading(true);
                setFetchError(false);
              }}
            />
          </div>
        ) : !doc ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--fg-3)]">{title} not found.</div>
        ) : (
          <div className={`flex flex-col space-y-3 px-4 py-4 ${showReorderFooter ? 'pb-24' : 'pb-6'}`}>
            <TransactionDetailDocumentBody
              doc={doc}
              docType={docType}
              gstInclusive={gstInclusive}
              gstRate={gstRate}
              respectBusinessPolicyTotals={respectBusinessPolicyTotals}
            />
          </div>
        )}
      </BuyerDetailShell>

      {showReorderFooter && doc ? (
        <TransactionDetailStickyFooter>
          <ReorderButton items={doc.items} docType={docType} />
        </TransactionDetailStickyFooter>
      ) : null}
    </div>
  );
}
