'use client';

import { useMemo } from 'react';

import { ErrorState } from '@/components/ui/empty-state';
import {
  DocumentCustomerStrip,
  LinesTable,
  TotalsCard,
  type EstimateComposerLineRow,
} from '@/components/seller/document-composer';
import { SellerMobileTransactionDetail } from '@/components/seller/mobile';
import { TransactionOriginMark } from '@/components/seller/transactional/TransactionOriginMark';
import { useSalesOrderDetail } from '@/hooks/useSalesOrderDetail';
import { defaultPaymentTerms } from '@/lib/documents/composer-math';
import { mapSalesOrderDetailToComposerLines } from '@/lib/sales-orders/tenant-order-detail';
import { formatNumberValue } from '@/lib/utils';
import type { InboxEntry } from '@/lib/inbox/inbox-types';
import type { SalesOrderDetail, SalesOrderUiStatus } from '@/types/tenant-sales-orders';
import type { EstimateComposerProductSearchRow } from '@/types/estimate-composer';

const noop = () => {};

const SO_STATUS_TITLE: Record<SalesOrderUiStatus, string> = {
  received: 'Received',
  confirmed: 'Confirmed',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

function formatPlacedAt(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusLabel(ui: SalesOrderUiStatus): string {
  return SO_STATUS_TITLE[ui];
}

function statusTone(ui: SalesOrderUiStatus) {
  if (ui === 'delivered') return 'success' as const;
  if (ui === 'cancelled') return 'danger' as const;
  if (ui === 'dispatched') return 'warning' as const;
  if (ui === 'confirmed') return 'accent' as const;
  return 'info' as const;
}

function orderTotals(data: SalesOrderDetail) {
  const subtotal = data.subtotal ?? 0;
  const discountFlat = data.discount_flat ?? 0;
  const freight = data.freight ?? 0;
  const roundOff = data.round_off ?? 0;
  return {
    subtotal,
    discount_flat: discountFlat,
    freight,
    taxable_amount: Math.max(subtotal - discountFlat, 0),
    tax_amount: data.tax_amount ?? 0,
    grand_total: data.total_amount ?? 0,
    round_off: roundOff,
    total_units: data.lines.reduce((sum, line) => sum + line.qty, 0),
    gst_inclusive: (data.tax_amount ?? 0) === 0,
  };
}

function OrderDetailBody({ data, lines }: { data: SalesOrderDetail; lines: EstimateComposerLineRow[] }) {
  const buyer = data.buyer_context;
  const totals = orderTotals(data);
  const paymentTermsLabel = buyer ? defaultPaymentTerms(buyer.payment_terms_days) : 'Due on receipt';
  const overLimitBy = buyer ? totals.grand_total - buyer.credit_available : 0;
  const creditWarning = buyer && overLimitBy > 0 ? `Over limit by ${formatNumberValue(overLimitBy, 'CURRENCY_EXACT')}.` : null;
  const isInterState = Boolean(
    buyer?.seller_state
    && buyer?.place_of_supply
    && buyer.seller_state.toLowerCase() !== buyer.place_of_supply.toLowerCase(),
  );

  return (
    <div className="hidden flex-col gap-4 md:flex">
      <DocumentCustomerStrip
        buyer={buyer}
        previewTotal={totals.grand_total}
        paymentTermsValue={paymentTermsLabel}
        mode="view"
        placeOfSupplyValue={data.place_of_supply ?? buyer?.place_of_supply ?? ''}
      />
      {data.has_backorder && (data.ui_status === 'confirmed' || data.ui_status === 'dispatched') ? (
        <div className="callout callout--warning text-sm leading-[1.5]">
          <strong>Backorder.</strong> Some lines exceed available stock. Buyer has been notified.
        </div>
      ) : null}
      <LinesTable
        kind="so"
        buyerSelected={Boolean(data.buyer_context)}
        readOnly
        lines={lines}
        productQuery=""
        productResults={[]}
        searchOpen={false}
        notesExpanded={false}
        freightExpanded={false}
        internalExpanded={false}
        singleNoteMode
        notesValue={data.notes ?? ''}
        freightValue={String(data.freight)}
        internalValue={data.seller_note ?? ''}
        onProductQueryChange={noop}
        onSearchOpenChange={noop}
        onAddProduct={((_product: EstimateComposerProductSearchRow) => {})}
        onLineChange={noop}
        onRemoveLine={noop}
        onNotesValueChange={noop}
        onFreightValueChange={noop}
        onInternalValueChange={noop}
        onToggleNotes={noop}
        onToggleFreight={noop}
        onToggleInternal={noop}
      />
      <TotalsCard
        totals={totals}
        previousTotals={null}
        creditWarning={creditWarning}
        isInterState={isInterState}
        lineCount={lines.length}
        gstInclusiveOverride={data.tax_amount === 0}
      />
    </div>
  );
}

function OrderMobileBody({ data }: { data: SalesOrderDetail }) {
  const buyer = data.buyer_context;
  const totals = orderTotals(data);

  return (
    <SellerMobileTransactionDetail
      className="-mx-4 -my-5"
      eyebrow="Sales order"
      documentNumber={data.order_number}
      originMark={(
        <TransactionOriginMark
          isBuyerApp={data.is_buyer_app}
          transactionType="order"
          size={28}
        />
      )}
      statusLabel={statusLabel(data.ui_status)}
      statusTone={statusTone(data.ui_status)}
      buyerName={buyer?.business_name}
      buyerMeta={buyer ? [buyer.phone, buyer.bill_address].filter(Boolean).join(' · ') : null}
      dateLabel={`Placed ${formatPlacedAt(data.placed_at)}`}
      secondaryDateLabel={data.expected_delivery ? `Expected ${data.expected_delivery}` : null}
      locationName={data.location_name}
      placeOfSupply={data.place_of_supply ?? buyer?.place_of_supply}
      notes={data.seller_note ?? data.notes}
      lines={data.lines.map((line) => ({
        id: line.id,
        name: line.name,
        sku: line.sku,
        qty: line.qty,
        unit: line.unit,
        unitPrice: line.unit_price,
        lineTotal: line.line_total,
      }))}
      totals={[
        { label: 'Subtotal', value: totals.subtotal },
        ...(totals.discount_flat ? [{ label: 'Discount', value: `-${formatNumberValue(totals.discount_flat, 'CURRENCY_EXACT')}`, tone: 'muted' as const }] : []),
        ...(totals.freight ? [{ label: 'Freight', value: totals.freight }] : []),
        { label: 'GST', value: totals.tax_amount },
        { label: 'Total', value: totals.grand_total, emphasis: true },
      ]}
    />
  );
}

export function InboxOrderSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading order">
      <div className="h-24 animate-pulse rounded-[14px] bg-cream-100" />
      <div className="h-48 animate-pulse rounded-[14px] bg-cream-100" />
      <div className="h-32 animate-pulse rounded-[14px] bg-cream-100" />
    </div>
  );
}

export function InboxOrderPanel({ entry }: { entry: InboxEntry }) {
  const orderId = entry.source_entity_type === 'order' ? entry.source_entity_id : null;
  const { data, isLoading, isError, error } = useSalesOrderDetail(orderId ?? undefined);

  const lines = useMemo(() => (data ? mapSalesOrderDetailToComposerLines(data) : []), [data]);

  if (!orderId) {
    return <p className="text-base text-cream-600">No order is linked to this Inbox entry.</p>;
  }
  if (isLoading) return <InboxOrderSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        heading="Couldn't load order"
        description={error instanceof Error ? error.message : 'Failed to load order details.'}
      />
    );
  }

  return (
    <>
      <OrderMobileBody data={data} />
      <OrderDetailBody data={data} lines={lines} />
    </>
  );
}
