'use client';

import { ArrowRightCircle, Copy, Edit2, Loader2, Send, Ban } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { FeatureDisabledState } from '@/components/FeatureGate';
import { PermissionDenied } from '@/components/auth/PermissionDenied';
import { DocumentComposerShell } from '@/components/seller/composer/DocumentComposerShell';
import { DetailActions, type DetailActionItem } from '@/components/seller/detail';
import {
  DocumentCustomerStrip,
  LinesTable,
  estimateBandChipClass,
  resolveEstimateBandStatus,
  TotalsCard,
  type EstimateComposerLineRow,
} from '@/components/seller/document-composer';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROLES } from '@/constants';
import {
  useConvertEstimateToOrder,
  useConvertEstimateToInvoice,
  useDuplicateEstimate,
  useEstimateDetail,
  useSendEstimateDetailWhatsApp,
  useVoidEstimate,
  seedEstimateComposerCache,
} from '@/hooks/useEstimates';
import { useAuth } from '@/contexts/AuthContext';
import { useCreateFlags } from '@/hooks/useCreateFlags';
import { useDocumentWhatsAppRealtime } from '@/hooks/useDocumentWhatsAppRealtime';
import { useFlagState } from '@/hooks/useFeatureFlag';
import { defaultPaymentTerms } from '@/lib/documents/composer-math';
import type { EstimateComposerProductSearchRow } from '@/types/estimate-composer';
import { formatNumberValue } from '@/lib/utils';
import { computeDisplayDocumentTotals, computeLineTaxableAmount, roundMoney } from '@/lib/gst';
import { useBusinessPolicy } from '@/hooks/useBusinessPolicy';
import { SellerMobileTransactionDetail } from '@/components/seller/mobile';
import { TransactionOriginMark } from '@/components/seller/transactional/TransactionOriginMark';

import { ModalConvertEstimate } from '@/components/seller/estimates/modals/ModalConvertEstimate';
import { DocumentDetailLoadingSkeleton } from '@/components/seller/loading/SellerLoadingSkeletons';
import { SendDocumentWhatsAppDialog } from '@/components/seller/shared/SendDocumentWhatsAppDialog';
import { SELLER_ROUTES } from '@/lib/seller-routes';

const noop = () => {};

export function EstimateDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { currentTenantId } = useAuth();
  const orderManagement = useFlagState('ORDER_MANAGEMENT');
  const estimatesFlag = useFlagState('ESTIMATES');
  const { createSalesOrders, createInvoices } = useCreateFlags();
  const { data, isLoading, isError, error } = useEstimateDetail(id);
  const { gstInclusive } = useBusinessPolicy();
  useDocumentWhatsAppRealtime({
    kind: 'estimate',
    documentId: id,
    tenantId: currentTenantId,
    enabled: Boolean(data),
  });
  const convertMut = useConvertEstimateToOrder(id);
  const convertToInvoiceMut = useConvertEstimateToInvoice(id);
  const voidMut = useVoidEstimate(id);
  const dupMut = useDuplicateEstimate(id);
  const sendMut = useSendEstimateDetailWhatsApp(id);

  const [convertOpen, setConvertOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const diffLines: EstimateComposerLineRow[] = useMemo(() => {
    if (!data) return [];
    return data.items.map((line, index) => ({
      ...line,
      diff: 'clean' as const,
      // qty x price, not the stored line_total (ex-GST after a Zoho sync-back)
      line_total: roundMoney(computeLineTaxableAmount(line)),
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
        round_off: 0,
        grand_total: 0,
        total_units: 0,
        gst_inclusive: false,
      };
    }
    const discountFlat = data.discount_flat ?? 0;
    const freight = data.freight ?? 0;
    const roundOff = data.round_off ?? 0;
    const display = computeDisplayDocumentTotals(data.items, {
      gstInclusive,
      taxAmount: data.tax_amount,
      discount_flat: discountFlat,
      freight,
      round_off: roundOff,
    });
    return {
      subtotal: display.subtotal,
      discount_flat: discountFlat,
      freight,
      taxable_amount: Math.max(display.subtotal - discountFlat, 0),
      tax_amount: display.tax_amount,
      grand_total: display.grand_total,
      round_off: roundOff,
      total_units: data.items.reduce((sum, line) => sum + line.qty, 0),
      gst_inclusive: gstInclusive,
    };
  }, [data, gstInclusive]);

  if (orderManagement === false || estimatesFlag === false) {
    return <FeatureDisabledState />;
  }

  if (isLoading) {
    return <DocumentDetailLoadingSkeleton />;
  }

  if (isError) {
    if (error instanceof Error && error.message === 'forbidden') {
      return <PermissionDenied />;
    }
    return (
      <div className="mx-auto w-full max-w-[1920px] px-8 pt-7 pb-6">
        <ErrorState
          heading="Couldn't load estimate"
          description={error instanceof Error ? error.message : 'Failed to load estimate.'}
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['tenant-estimate-detail', id] })}
        />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const buyer = data.buyer_context;
  const bandStatus = resolveEstimateBandStatus(data.status, data.valid_until);
  const paymentTermsLabel = buyer ? defaultPaymentTerms(buyer.payment_terms_days) : 'Due on receipt';
  const isAdmin = data.viewer_role === ROLES.SELLER_ADMIN;
  const terminal = data.status === 'converted' || data.status === 'void' || data.status === 'expired';
  const showEdit = !terminal;
  const showVoid = isAdmin && (data.status === 'draft' || data.status === 'sent');
  const showDuplicate = false; // data.status !== 'void' && data.status !== 'converted';
  const showSend = data.status === 'draft' || data.status === 'sent';
  const targetRateLines = data.items.filter(
    (line) => line.buyer_target_unit_price_min != null && line.buyer_target_unit_price_max != null,
  );

  const overLimitBy = buyer ? totals.grand_total - buyer.credit_available : 0;
  const creditWarning = buyer && overLimitBy > 0
    ? `Over limit by ${formatNumberValue(overLimitBy, 'CURRENCY_EXACT')}.`
    : null;
  const isInterState = Boolean(
    buyer?.seller_state
    && buyer?.place_of_supply
    && buyer.seller_state.toLowerCase() !== buyer.place_of_supply.toLowerCase(),
  );

  const statusTone = data.status === 'sent' || data.status === 'converted' ? 'live' : 'draft';
  const mobileStatusTone =
    data.status === 'converted' ? 'success' :
    data.status === 'declined' || data.status === 'void' ? 'danger' :
    data.status === 'sent' ? 'warning' :
    data.status === 'accepted' ? 'accent' : 'neutral';

  function handleDuplicate() {
    dupMut.mutate(undefined, {
      onSuccess: (res) => {
        const newId = res.data?.estimate_id;
        const newIdStr = typeof newId === 'string' ? newId : null;
        if (!newIdStr) {
          toast.error('Duplicate succeeded but no id returned');
          return;
        }
        router.push(`${SELLER_ROUTES.sales.estimates}/${newIdStr}/edit`);
      },
    });
  }

  function handleConvertToSO(payload: { line_ids: string[]; qty_overrides: Record<string, number>; delivery_date: string; order_number?: string; added_lines?: { tenant_product_id: string; qty: number; unit_price: number; disc_pct: number; tax_pct: number }[] }) {
    convertMut.mutate(payload, {
      onSuccess: (res) => {
        const orderId = typeof res.data.order_id === 'string' ? res.data.order_id : null;
        setConvertOpen(false);
        toast.success('Sales order created');
        if (orderId) {
          router.push(`${SELLER_ROUTES.sales.orders}/${orderId}`);
        } else {
          router.push(`${SELLER_ROUTES.sales.estimates}/${id}`);
        }
      },
    });
  }

  function handleConvertToInvoice(payload: { line_ids: string[]; qty_overrides: Record<string, number>; invoice_date: string; invoice_number?: string; added_lines?: { tenant_product_id: string; qty: number; unit_price: number; disc_pct: number; tax_pct: number }[] }) {
    convertToInvoiceMut.mutate(payload, {
      onSuccess: (res) => {
        const invoiceId = typeof res.data.invoice_id === 'string' ? res.data.invoice_id : null;
        setConvertOpen(false);
        toast.success('Invoice created');
        if (invoiceId) {
          router.push(`${SELLER_ROUTES.sales.invoices}/${invoiceId}`);
        } else {
          router.push(`${SELLER_ROUTES.sales.estimates}/${id}`);
        }
      },
    });
  }

  function confirmVoid() {
    voidMut.mutate(undefined, {
      onSuccess: () => {
        setVoidOpen(false);
      },
    });
  }

  return (
    <>
      <SellerMobileTransactionDetail
        eyebrow="Estimate"
        documentNumber={data.estimate_number}
        originMark={(
          <TransactionOriginMark
            isBuyerApp={data.is_buyer_app}
            transactionType="estimate"
            size={28}
          />
        )}
        statusLabel={data.status_label}
        statusTone={mobileStatusTone}
        buyerName={buyer?.business_name}
        buyerMeta={buyer ? [buyer.phone, buyer.bill_address].filter(Boolean).join(' · ') : null}
        dateLabel={data.estimate_date ? `Created ${data.estimate_date}` : null}
        secondaryDateLabel={data.valid_until ? `Valid until ${data.valid_until}` : null}
        locationName={data.location_name}
        placeOfSupply={data.place_of_supply}
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
          kind="estimate"
          containerClassName="max-w-none px-4 py-4 md:px-6 md:py-4"
          title={data.estimate_number}
          titleLeading={(
            <TransactionOriginMark
              isBuyerApp={data.is_buyer_app}
              transactionType="estimate"
              size={28}
            />
          )}
          subtitle={buyer
            ? `${data.estimate_date || '—'} · valid until ${data.valid_until || '—'} · Branch: ${data.location_name || '—'}`
            : 'No buyer assigned.'}
          status={{ label: data.status_label, tone: statusTone, chipClassName: estimateBandChipClass(bandStatus) }}
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
                      Send estimate
                    </Button>
                  ) : null}
                  {(data.status === 'draft' || data.status === 'sent') && orderManagement && (createSalesOrders || createInvoices) ? (
                    <Button type="button" variant="accent" disabled={convertMut.isPending || convertToInvoiceMut.isPending} size="sm" className="gap-2" onClick={() => setConvertOpen(true)}>
                      <ArrowRightCircle className="h-4 w-4" />
                      Convert estimate
                    </Button>
                  ) : null}
                </>
              )}
              overflow={[
                ...(showVoid
                  ? [
                      {
                        label: 'Void estimate',
                        icon: <Ban className="h-4 w-4" />,
                        onClick: () => setVoidOpen(true),
                        disabled: voidMut.isPending,
                        destructive: true,
                      } satisfies DetailActionItem,
                    ]
                  : []),
                ...(showDuplicate
                  ? [
                      {
                        label: 'Duplicate',
                        icon: <Copy className="h-4 w-4" />,
                        onClick: handleDuplicate,
                        disabled: dupMut.isPending,
                      } satisfies DetailActionItem,
                    ]
                  : []),
                ...(showEdit
                  ? [
                      {
                        label: 'Edit estimate',
                        icon: <Edit2 className="h-4 w-4" />,
                        onClick: () => {
                          seedEstimateComposerCache(queryClient, id, data);
                          router.push(`${SELLER_ROUTES.sales.estimates}/${id}/edit`);
                        },
                      } satisfies DetailActionItem,
                    ]
                  : []),
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
              placeOfSupplyValue={data.place_of_supply}
            />
            <LinesTable
              kind="estimate"
              buyerSelected={Boolean(data.buyer_id)}
              readOnly
              lines={diffLines}
              productQuery=""
              productResults={[]}
              searchOpen={false}
              notesExpanded={false}
              freightExpanded={false}
              internalExpanded={false}
              singleNoteMode
              notesValue={data.seller_note ?? data.notes ?? ''}
              freightValue={String(data.freight)}
              internalValue=""
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
            {targetRateLines.length > 0 ? (
              <div className="rounded-lg border border-warning-50 bg-warning-50/70 p-4">
                <p className="text-sm font-semibold text-warning-700">Buyer target rates</p>
                <div className="mt-2 space-y-2">
                  {targetRateLines.map((line) => (
                    <div key={line.id} className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-warning-700">{line.product_name}</p>
                        <p className="text-warning-700">{line.sku}</p>
                      </div>
                      <p className="shrink-0 font-mono font-semibold text-warning-700">
                        {formatNumberValue(line.buyer_target_unit_price_min ?? 0, 'CURRENCY_EXACT')} - {formatNumberValue(line.buyer_target_unit_price_max ?? 0, 'CURRENCY_EXACT')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
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

      <ModalConvertEstimate
        open={convertOpen}
        onOpenChange={setConvertOpen}
        estimateNumber={data.estimate_number}
        buyerName={buyer?.business_name ?? 'Buyer'}
        buyerId={data.buyer_id ?? null}
        lines={data.items}
        createSalesOrders={createSalesOrders}
        createInvoices={createInvoices}
        isSubmitting={convertMut.isPending || convertToInvoiceMut.isPending}
        onConfirmSO={handleConvertToSO}
        onConfirmInvoice={handleConvertToInvoice}
      />

      <SendDocumentWhatsAppDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        title="Send estimate"
        confirmLabel="Send estimate"
        isPending={sendMut.isPending}
        sendState={data.whatsapp_send}
        buyerName={buyer?.business_name ?? '—'}
        phoneNumber={data.whatsapp_send.recipient_phone}
        documentNumberLabel="Estimate Number"
        documentNumber={data.estimate_number}
        amount={totals.grand_total}
        itemCount={diffLines.length}
        onConfirm={() => {
          sendMut.mutate(undefined, {
            onSuccess: () => {
              setSendOpen(false);
            },
          });
        }}
      />

      <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
        <DialogContent className="max-w-[300px]">
          <DialogHeader>
            <DialogTitle>Void this estimate?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-base text-cream-700">This action cannot be undone. The estimate will be marked as void.</p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setVoidOpen(false)} disabled={voidMut.isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmVoid} disabled={voidMut.isPending}>
              Confirm void
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
