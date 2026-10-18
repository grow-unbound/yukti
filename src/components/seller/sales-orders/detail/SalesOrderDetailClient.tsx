'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Edit2, Loader2, PackageCheck, Send, Truck, X } from 'lucide-react';

import { FeatureDisabledState } from '@/components/FeatureGate';
import { PermissionDenied } from '@/components/auth/PermissionDenied';
import { DocumentComposerShell } from '@/components/seller/composer/DocumentComposerShell';
import { DetailActions, type DetailActionItem } from '@/components/seller/detail';
import {
  DocumentCustomerStrip,
  LinesTable,
  salesOrderBandChipClass,
  TotalsCard,
  resolveSalesOrderBandStatus,
  type EstimateComposerLineRow,
  ModalSendDocument,
} from '@/components/seller/document-composer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { ROLES } from '@/constants';
import { useAuth } from '@/contexts/AuthContext';
import { SELLER_ROUTES } from '@/lib/seller-routes';
import { useDocumentWhatsAppRealtime } from '@/hooks/useDocumentWhatsAppRealtime';
import {
  useCancelSalesOrder,
  useDeliverSalesOrder,
  useDispatchSalesOrder,
  useSalesOrderDetail,
  useSendSalesOrder,
  useConfirmSalesOrder,
} from '@/hooks/useSalesOrderDetail';
import { useCreateFlags } from '@/hooks/useCreateFlags';
import { useBusinessPolicy } from '@/hooks/useBusinessPolicy';
import { prefetchSalesOrderComposer } from '@/hooks/useSalesOrders';
import { useFlagState } from '@/hooks/useFeatureFlag';
import { deriveSalesOrderDisplayTotals, mapSalesOrderDetailToComposerLines, formatEstimateChipLabel } from '@/lib/sales-orders/tenant-order-detail';
import { defaultPaymentTerms } from '@/lib/documents/composer-math';
import { formatNumberValue } from '@/lib/utils';
import type { SalesOrderUiStatus } from '@/types/tenant-sales-orders';
import type { EstimateComposerProductSearchRow } from '@/types/estimate-composer';
import { DocumentDetailLoadingSkeleton } from '@/components/seller/loading/SellerLoadingSkeletons';
import { SellerMobileTransactionDetail } from '@/components/seller/mobile';
import { TransactionOriginMark } from '@/components/seller/transactional/TransactionOriginMark';

import { ModalCancelOrder } from './ModalCancelOrder';
import { ModalDispatch } from './ModalDispatch';
import { ModalConfirmSalesOrder } from './ModalConfirmSalesOrder';

const noop = () => {};

const SO_STATUS_TITLE: Record<SalesOrderUiStatus, string> = {
  received: 'Received',
  confirmed: 'Confirmed',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

function formatPlacedAt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function SalesOrderDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { currentTenantId } = useAuth();
  const orderManagement = useFlagState('ORDER_MANAGEMENT');
  const salesOrdersFlag = useFlagState('SALES_ORDERS');
  const { createInvoices } = useCreateFlags();
  const { data, isLoading, isError, error } = useSalesOrderDetail(id);
  const { gstInclusive, policyLoading } = useBusinessPolicy();
  useDocumentWhatsAppRealtime({
    kind: 'order',
    documentId: id,
    tenantId: currentTenantId,
    enabled: Boolean(data),
  });
  const dispatchMut = useDispatchSalesOrder(id);
  const deliverMut = useDeliverSalesOrder(id);
  const cancelMut = useCancelSalesOrder(id);
  const sendMut = useSendSalesOrder(id);
  const confirmMut = useConfirmSalesOrder(id);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const diffLines: EstimateComposerLineRow[] = useMemo(() => {
    if (!data) return [];
    return mapSalesOrderDetailToComposerLines(data).map((line) => ({
      ...line,
      line_total: line.line_total,
    }));
  }, [data]);

  const totals = useMemo(() => {
    if (!data) {
      return {
        subtotal: 0,
        discount_flat: 0,
        freight: 0,
        taxable_amount: 0,
        tax_amount: 0,
        grand_total: 0,
        round_off: 0,
        total_units: 0,
        gst_inclusive: false,
      };
    }
    return deriveSalesOrderDisplayTotals(data, gstInclusive);
  }, [data, gstInclusive]);

  const orderMeta = useMemo(() => {
    if (!data?.estimate) return null;
    const label = formatEstimateChipLabel(data.estimate.estimate_number);
    return (
      <Link
        href={`${SELLER_ROUTES.sales.estimates}/${data.estimate.id}`}
        className="inline-flex items-center rounded-full border border-cream-200 bg-cream-50 px-2 py-0.5 text-sm font-medium text-teal-800 hover:bg-cream-100"
      >
        From: {label}
      </Link>
    );
  }, [data]);

  if (orderManagement === false || salesOrdersFlag === false) {
    return <FeatureDisabledState />;
  }

  if (isLoading || policyLoading) {
    return <DocumentDetailLoadingSkeleton />;
  }

  if (isError) {
    if (error instanceof Error && error.message === 'Forbidden') {
      return <PermissionDenied />;
    }
    return (
      <div className="mx-auto w-full max-w-[1920px] px-4 py-4 md:px-6 md:py-4">
        <ErrorState
          heading="Couldn't load sales order"
          description={error instanceof Error ? error.message : 'Failed to load sales order.'}
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['tenant-sales-order', id] })}
        />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const buyer = data.buyer_context;
  const bandStatus = resolveSalesOrderBandStatus(data.db_status, data.ui_status);
  const paymentTermsLabel = buyer ? defaultPaymentTerms(buyer.payment_terms_days) : 'Due on receipt';
  const isAdmin = data.viewer_role === ROLES.SELLER_ADMIN;
  const ui = data.ui_status;

  const showConfirm = ui === 'received';
  const showDispatch = ui === 'confirmed';
  const showEdit = ui === 'received' || ui === 'confirmed';
  const showCancel = (ui === 'received' || ui === 'confirmed') && isAdmin;
  const showSend = ui === 'received' || ui === 'confirmed' || ui === 'dispatched';

  const overLimitBy = buyer ? totals.grand_total - buyer.credit_available : 0;
  const creditWarning = buyer && overLimitBy > 0 ? `Over limit by ${formatNumberValue(overLimitBy, 'CURRENCY_EXACT')}.` : null;
  const isInterState = Boolean(
    buyer?.seller_state
    && buyer?.place_of_supply
    && buyer.seller_state.toLowerCase() !== buyer.place_of_supply.toLowerCase(),
  );

  const statusLabel = bandStatus === 'draft' ? 'Draft' : SO_STATUS_TITLE[ui];
  const statusTone: 'draft' | 'live' = ui === 'cancelled' || ui === 'delivered' ? 'draft' : 'live';
  const mobileStatusTone =
    ui === 'delivered' ? 'success' :
    ui === 'cancelled' ? 'danger' :
    ui === 'dispatched' ? 'warning' :
    ui === 'confirmed' ? 'accent' : 'info';

  return (
    <>
      <SellerMobileTransactionDetail
        eyebrow="Sales order"
        documentNumber={data.order_number}
        originMark={(
          <TransactionOriginMark
            isBuyerApp={data.is_buyer_app}
            transactionType="order"
            size={28}
          />
        )}
        statusLabel={statusLabel}
        statusTone={mobileStatusTone}
        buyerName={buyer?.business_name}
        buyerMeta={buyer ? [buyer.phone, buyer.bill_address].filter(Boolean).join(' · ') : null}
        dateLabel={`Placed ${formatPlacedAt(data.placed_at)}`}
        secondaryDateLabel={data.expected_delivery ? `Expected ${data.expected_delivery}` : null}
        locationName={data.location_name}
        placeOfSupply={data.place_of_supply ?? buyer?.place_of_supply}
        notes={data.seller_note ?? data.notes}
        lines={diffLines.map((line) => ({
          id: line.id,
          name: line.product_name,
          sku: line.sku,
          qty: line.qty,
          unitPrice: line.unit_price,
          lineTotal: line.line_total,
        }))}
        totals={[
          { label: 'Subtotal', value: totals.subtotal },
          ...(totals.discount_flat ? [{ label: 'Discount', value: `-${formatNumberValue(totals.discount_flat, 'CURRENCY_EXACT')}`, tone: 'muted' as const }] : []),
          ...(totals.freight ? [{ label: 'Freight', value: totals.freight }] : []),
          { label: 'GST', value: totals.gst_inclusive ? 'Included in prices' : totals.tax_amount },
          { label: 'Total', value: totals.grand_total, emphasis: true },
        ]}
      />
      <div className="hidden md:block">
        <DocumentComposerShell
          mode="view"
          kind="so"
          containerClassName="max-w-none px-4 py-4 md:px-6 md:py-4"
          title={data.order_number}
          titleLeading={(
            <TransactionOriginMark
              isBuyerApp={data.is_buyer_app}
              transactionType="order"
              size={28}
            />
          )}
          subtitle={buyer
            ? `${formatPlacedAt(data.placed_at)} · expected ${data.expected_delivery || '—'} · Branch: ${data.location_name || '—'}`
            : 'No buyer assigned.'}
          status={{
            label: statusLabel,
            tone: statusTone,
            chipClassName: salesOrderBandChipClass(bandStatus),
          }}
          titleActions={(
            <DetailActions
              inline={(
                <>
                  {showSend ? (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      className="gap-2"
                      onClick={() => setSendOpen(true)}
                      disabled={sendMut.isPending}
                    >
                      {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Send order
                    </Button>
                  ) : null}
                  {ui === 'dispatched' ? (
                    <Button type="button" variant="accent" size="sm" className="gap-2" onClick={() => setDeliverOpen(true)} disabled={deliverMut.isPending}>
                      <PackageCheck className="h-4 w-4" />
                      Mark delivered
                    </Button>
                  ) : null}
                  {showConfirm ? (
                    <Button
                      type="button"
                      variant="accent"
                      size="sm"
                      className="gap-2"
                      onClick={() => setConfirmOpen(true)}
                      disabled={confirmMut.isPending}
                    >
                      <Truck className="h-4 w-4" />
                      Confirm order
                    </Button>
                  ) : null}
                </>
              )}
              overflow={[
                ...(ui === 'confirmed' ? [{
                  label: 'Dispatch',
                  icon: <Truck size={14} />,
                  onClick: () => setDispatchOpen(true),
                  disabled: dispatchMut.isPending,
                } satisfies DetailActionItem] : []),
                ...(showEdit ? [{
                  label: 'Edit order',
                  icon: <Edit2 size={14} />,
                  onClick: () => {
                    void prefetchSalesOrderComposer(queryClient, id);
                    router.push(`${SELLER_ROUTES.sales.orders}/${id}/edit`);
                  },
                } satisfies DetailActionItem] : []),
                ...(showCancel ? [{
                  label: 'Cancel order',
                  icon: <X size={14} />,
                  onClick: () => setCancelOpen(true),
                  disabled: cancelMut.isPending,
                  destructive: true,
                } satisfies DetailActionItem] : []),
              ]}
            />
        )}
        body={(
          <div className="flex h-full min-h-0 flex-col gap-4">
            <DocumentCustomerStrip
              buyer={buyer}
              previewTotal={totals.grand_total}
              paymentTermsValue={paymentTermsLabel}
              mode="view"
              placeOfSupplyValue={data.place_of_supply ?? buyer?.place_of_supply ?? ''}
            />
            {orderMeta ? (
              <div className="rounded-[10px] border border-cream-200 bg-cream-50 px-3 py-3 text-sm leading-[1.55] text-cream-800">
                {orderMeta}
              </div>
            ) : null}
            {data.has_backorder && (ui === 'confirmed' || ui === 'dispatched') ? (
              <div className="callout callout--warning text-sm leading-[1.5]">
                <strong>Backorder.</strong> Some lines exceed available stock — buyer has been notified.
              </div>
            ) : null}
            <LinesTable
              kind="so"
              buyerSelected={Boolean(data.buyer_context)}
              readOnly
              lines={diffLines}
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
              lineCount={diffLines.length}
              gstInclusiveOverride={totals.gst_inclusive}
            />
          </div>
        )}
      />
      </div>

      <ModalDispatch
        open={dispatchOpen}
        onOpenChange={setDispatchOpen}
        orderNumber={data.order_number}
        isPending={dispatchMut.isPending}
        onConfirm={(payload) => {
          dispatchMut.mutate({ ...payload, notify_buyer: false }, {
            onSuccess: () => {
              setDispatchOpen(false);
            },
          });
        }}
      />

      <ModalSendDocument
        open={sendOpen}
        onOpenChange={setSendOpen}
        title="Send sales order"
        recipientDefault={buyer?.phone ?? buyer?.email ?? ''}
        messageDefault="Please review this sales order."
        lineCount={diffLines.length}
        grandTotal={totals.grand_total}
        isPending={sendMut.isPending}
        onConfirm={async (payload) => {
          await sendMut.mutateAsync(payload);
          setSendOpen(false);
        }}
      />

      <ModalCancelOrder
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        orderNumber={data.order_number}
        isPending={cancelMut.isPending}
        onConfirm={(payload) => {
          cancelMut.mutate(payload, {
            onSuccess: () => {
              setCancelOpen(false);
            },
          });
        }}
      />

      <ModalConfirmSalesOrder
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        orderNumber={data.order_number}
        lines={data.lines}
        createInvoices={createInvoices}
        isSubmitting={confirmMut.isPending}
        onConfirm={(input) => {
          confirmMut.mutate(input, {
            onSuccess: () => {
              setConfirmOpen(false);
            },
          });
        }}
      />

      <AlertDialog open={deliverOpen} onOpenChange={setDeliverOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this order as delivered?</AlertDialogTitle>
            <AlertDialogDescription>
              This updates the order status to delivered. You can undo only by support if you make a mistake.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deliverMut.isPending}>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={deliverMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                deliverMut.mutate({}, {
                  onSuccess: () => {
                    setDeliverOpen(false);
                  },
                });
              }}
            >
              {deliverMut.isPending ? 'Saving…' : 'Confirm delivered'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
