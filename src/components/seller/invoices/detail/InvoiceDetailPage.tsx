'use client';

import { Ban, Edit2, IndianRupee, Mail, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { FeatureDisabledState } from '@/components/FeatureGate';
import { PermissionDenied } from '@/components/auth/PermissionDenied';
import { DocumentComposerShell } from '@/components/seller/composer/DocumentComposerShell';
import { DetailActions, type DetailActionItem } from '@/components/seller/detail';
import {
  DocumentCustomerStrip,
  invoiceBandChipClass,
  LinesTable,
  resolveInvoiceBandStatus,
  TotalsCard,
  type EstimateComposerLineRow,
  type InvoiceViewBandStatus,
} from '@/components/seller/document-composer';
import { InvoicePaymentsCard } from '@/components/seller/invoices/detail/InvoicePaymentsCard';
import { ModalMarkInvoicePaid, ModalSendInvoice, ModalVoidInvoice } from '@/components/seller/invoices/modals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { ROLES } from '@/constants';
import { useAuth } from '@/contexts/AuthContext';
import { SELLER_ROUTES } from '@/lib/seller-routes';
import { useDocumentWhatsAppRealtime } from '@/hooks/useDocumentWhatsAppRealtime';
import { useFlagState } from '@/hooks/useFeatureFlag';
import {
  useInvoiceDetail,
  useMarkInvoicePaid,
  useSendInvoiceDetailWhatsApp,
  useSendInvoiceReminder,
  useVoidInvoice,
} from '@/hooks/useInvoiceDetail';
import { prefetchInvoiceComposer } from '@/hooks/useInvoices';
import { defaultPaymentTerms } from '@/lib/documents/composer-math';
import { formatNumberValue } from '@/lib/utils';
import { useBusinessPolicy } from '@/hooks/useBusinessPolicy';
import { computeDisplayDocumentTotals, computeLineTaxableAmount, roundMoney } from '@/lib/gst';
import type { EstimateComposerBuyerContext, EstimateComposerProductSearchRow, EstimateComposerTotals } from '@/types/estimate-composer';
import { DocumentDetailLoadingSkeleton } from '@/components/seller/loading/SellerLoadingSkeletons';
import { SendDocumentWhatsAppDialog } from '@/components/seller/shared/SendDocumentWhatsAppDialog';
import { SellerMobileTransactionDetail } from '@/components/seller/mobile';
import { TransactionOriginMark } from '@/components/seller/transactional/TransactionOriginMark';

const noop = () => {};

const INVOICE_CHIP_LABEL: Record<InvoiceViewBandStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

export function InvoiceDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { currentTenantId } = useAuth();
  const orderManagement = useFlagState('ORDER_MANAGEMENT');
  const invoicesFlag = useFlagState('INVOICES');
  const { data, isLoading, isError, error } = useInvoiceDetail(id);
  const { gstInclusive, policyLoading } = useBusinessPolicy();
  useDocumentWhatsAppRealtime({
    kind: 'invoice',
    documentId: id,
    tenantId: currentTenantId,
    enabled: Boolean(data),
  });
  const payMut = useMarkInvoicePaid(id);
  const voidMut = useVoidInvoice(id);
  const remindMut = useSendInvoiceReminder(id);
  const sendInvoiceMut = useSendInvoiceDetailWhatsApp(id);

  const [payOpen, setPayOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const buyerContext: EstimateComposerBuyerContext | null = useMemo(() => {
    if (!data?.buyer?.id) return null;
    const b = data.buyer;
    const creditAvailable = Math.max(b.credit_limit - b.credit_used, 0);
    return {
      id: b.id,
      business_name: b.name,
      contact_name: b.contact_name,
      phone: b.phone,
      email: b.email,
      gstin: b.gstin,
      bill_address: b.bill_address,
      city: b.city,
      state: b.state,
      pincode: b.pincode,
      place_of_supply: data.place_of_supply,
      seller_state: b.seller_state,
      payment_terms_days: b.payment_terms_days,
      credit_limit: b.credit_limit,
      credit_used: b.credit_used,
      credit_available: creditAvailable,
      active_pricelist: b.active_pricelist,
      sales_agent_name: b.sales_agent_name,
    };
  }, [data]);

  const diffLines: EstimateComposerLineRow[] = useMemo(() => {
    if (!data) return [];
    return data.items.map((line, index) => ({
      id: line.id ?? (line.tenant_product_id ? `inv-line-${line.tenant_product_id}` : `inv-line-${index}`),
      tenant_product_id: line.tenant_product_id,
      product_name: line.product_name,
      sku: line.sku,
      brand_name: line.brand_name,
      brand_initials: line.brand_initials,
      brand_hue: line.brand_hue,
      image_url: line.image_url ?? null,
      hsn_code: line.hsn,
      on_hand: 0,
      qty: line.qty,
      unit_price: line.rate,
      mrp: line.mrp,
      base_selling_price: line.rate,
      disc_pct: line.discount_pct,
      tax_pct: line.tax_pct ?? 0,
      // Price captured on the invoice line; stored line_total can be ex-GST (Zoho sync-back) or tax-inclusive.
      line_total: roundMoney(computeLineTaxableAmount({ qty: line.qty, unit_price: line.rate, disc_pct: line.discount_pct })),
      scheme_tag: null,
      diff: 'clean' as const,
    }));
  }, [data]);

  const totals: EstimateComposerTotals = useMemo(() => {
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
      };
    }
    const display = computeDisplayDocumentTotals(
      diffLines.map((line) => ({ qty: line.qty, unit_price: line.unit_price, disc_pct: line.disc_pct })),
      {
        gstInclusive,
        taxAmount: data.totals.tax_amount,
        discount_flat: data.totals.discount_amt,
        freight: data.totals.freight,
        round_off: data.totals.round_off,
      },
    );
    return {
      subtotal: display.subtotal,
      discount_flat: data.totals.discount_amt,
      freight: data.totals.freight,
      taxable_amount: Math.max(display.subtotal - data.totals.discount_amt, 0),
      tax_amount: display.tax_amount,
      round_off: data.totals.round_off,
      grand_total: display.grand_total,
      total_units: diffLines.reduce((sum, line) => sum + line.qty, 0),
    };
  }, [data, diffLines, gstInclusive]);

  const isInterState = useMemo(() => {
    if (!data) return false;
    if (data.gstin_locked) return !data.intra_state_tax;
    const st = data.buyer.state?.toLowerCase().trim();
    const seller = data.buyer.seller_state?.toLowerCase().trim();
    if (!st || !seller) return false;
    return st !== seller;
  }, [data]);

  const taxRows = useMemo(() => {
    if (!data?.gstin_locked || !data.totals.gst_rows.length) return undefined;
    return data.totals.gst_rows.map((row) => ({
      label: row.label,
      value: row.amount,
      previous: null as number | null,
      rowClassName: `tax-row--${row.token}`,
    }));
  }, [data]);

  const paymentTermsLabel = buyerContext ? defaultPaymentTerms(buyerContext.payment_terms_days) : 'Due on receipt';

  const overLimitBy = buyerContext ? totals.grand_total - buyerContext.credit_available : 0;
  const creditWarning =
    buyerContext && overLimitBy > 0 && data?.status !== 'paid' && data?.status !== 'void'
      ? `Over limit by ${formatNumberValue(overLimitBy, 'CURRENCY_EXACT')}.`
      : null;

  if (orderManagement === false || invoicesFlag === false) {
    return <FeatureDisabledState />;
  }

  if (isLoading || policyLoading) {
    return <DocumentDetailLoadingSkeleton />;
  }

  if (isError) {
    if (error instanceof Error && error.message === 'forbidden') {
      return <PermissionDenied />;
    }
    return (
      <div className="mx-auto w-full max-w-[1920px] px-4 py-4 md:px-6 md:py-4">
        <ErrorState
          heading="Couldn't load invoice"
          description={error instanceof Error ? error.message : 'Failed to load invoice.'}
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['tenant-invoice', id] })}
        />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const terminalPaidOrVoid = data.status === 'paid' || data.status === 'void';
  const showEdit = !terminalPaidOrVoid;
  const showVoidBtn =
    data.viewer_role === ROLES.SELLER_ADMIN && (data.status === 'draft' || data.status === 'sent' || data.status === 'overdue');

  const invoiceBandStatus = resolveInvoiceBandStatus(data.db_status, data.due_date);
  const invoiceChipTone: 'draft' | 'live' =
    invoiceBandStatus === 'paid' || invoiceBandStatus === 'void' || invoiceBandStatus === 'draft' ? 'draft' : 'live';
  const mobileStatusTone =
    invoiceBandStatus === 'paid' ? 'success' :
    invoiceBandStatus === 'void' ? 'danger' :
    invoiceBandStatus === 'overdue' ? 'danger' :
    invoiceBandStatus === 'sent' ? 'warning' : 'neutral';

  return (
    <>
      <SellerMobileTransactionDetail
        eyebrow="Invoice"
        documentNumber={data.doc_number}
        originMark={(
          <TransactionOriginMark
            isBuyerApp={data.is_buyer_app}
            transactionType="invoice"
            size={28}
          />
        )}
        statusLabel={INVOICE_CHIP_LABEL[invoiceBandStatus]}
        statusTone={mobileStatusTone}
        buyerName={data.buyer.name}
        buyerMeta={[data.buyer.phone, buyerContext?.bill_address].filter(Boolean).join(' · ')}
        dateLabel={data.invoice_date ? `Invoiced ${data.invoice_date}` : null}
        secondaryDateLabel={data.due_date ? `Due ${data.due_date}` : null}
        locationName={data.location_name}
        placeOfSupply={data.place_of_supply}
        notes={data.seller_note}
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
          { label: 'GST', value: gstInclusive ? 'Included in prices' : totals.tax_amount },
          { label: 'Total', value: totals.grand_total, emphasis: true },
          ...(data.amount_outstanding > 0 ? [{ label: 'Outstanding', value: data.amount_outstanding, tone: 'danger' as const }] : []),
        ]}
      />
      <div className="hidden md:block">
        <DocumentComposerShell
          mode="view"
          containerClassName="max-w-none px-4 py-4 md:px-6 md:py-4"
          kind="invoice"
          title={data.doc_number}
          titleLeading={(
            <TransactionOriginMark
              isBuyerApp={data.is_buyer_app}
              transactionType="invoice"
              size={28}
            />
          )}
          subtitle={buyerContext
            ? `${data.invoice_date || '—'} · due ${data.due_date || '—'} · Branch: ${data.location_name || '—'}`
            : 'No buyer on this invoice.'}
          status={{
            label: INVOICE_CHIP_LABEL[invoiceBandStatus],
            tone: invoiceChipTone,
            chipClassName: invoiceBandChipClass(invoiceBandStatus),
          }}
          titleActions={(
            <DetailActions
              inline={(
                <>
                  {data.version > 1 ? (
                    <Badge variant="warning" icon>
                      v
                      {data.version}
                    </Badge>
                  ) : null}
                  {invoiceBandStatus === 'draft' ? (
                    <Button type="button" variant="accent" size="sm" className="gap-2" onClick={() => setSendOpen(true)} disabled={sendInvoiceMut.isPending}>
                      <Send className="h-4 w-4" />
                      Send invoice
                    </Button>
                  ) : null}
                  {invoiceBandStatus === 'sent' || invoiceBandStatus === 'overdue' ? (
                    <Button type="button" variant="primary" size="sm" className="gap-2" onClick={() => setPayOpen(true)}>
                      <IndianRupee className="h-4 w-4" />
                      Collect payment
                    </Button>
                  ) : null}
                  {invoiceBandStatus === 'sent' || invoiceBandStatus === 'overdue' ? (
                    <Button type="button" variant="accent" size="sm" className="gap-2" onClick={() => setRemindOpen(true)}>
                      <Mail className="h-4 w-4" />
                      Send reminder
                    </Button>
                  ) : null}
                </>
              )}
              overflow={[
                ...(showEdit
                  ? [
                      {
                        label: data.status === 'draft' ? 'Edit before send' : 'Edit invoice',
                        icon: <Edit2 className="h-4 w-4" />,
                        onClick: () => {
                          void prefetchInvoiceComposer(queryClient, id);
                          router.push(`${SELLER_ROUTES.sales.invoices}/${id}/edit`);
                        },
                      } satisfies DetailActionItem,
                    ]
                  : []),
                ...(showVoidBtn
                  ? [
                      {
                        label: 'Void invoice',
                        icon: <Ban className="h-4 w-4" />,
                        onClick: () => setVoidOpen(true),
                        disabled: voidMut.isPending,
                        destructive: true,
                      } satisfies DetailActionItem,
                    ]
                  : []),
              ]}
            />
        )}
        body={(
          <div className="flex h-full min-h-0 flex-col gap-4">
            <DocumentCustomerStrip
              buyer={buyerContext}
              previewTotal={totals.grand_total}
              paymentTermsValue={paymentTermsLabel}
              mode="view"
              placeOfSupplyValue={data.place_of_supply}
            />
            <LinesTable
              kind="invoice"
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
              notesValue={data.seller_note}
              freightValue={String(data.totals.freight)}
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
            <TotalsCard
              totals={totals}
              previousTotals={null}
              creditWarning={creditWarning}
              isInterState={isInterState}
              lineCount={diffLines.length}
              taxRows={taxRows}
              gstInclusiveOverride={gstInclusive}
            />
            <InvoicePaymentsCard payments={data.payments} amountOutstanding={data.amount_outstanding} />
          </div>
        )}
      />
      </div>

      <ModalMarkInvoicePaid
        open={payOpen}
        onOpenChange={setPayOpen}
        amountOutstanding={data.amount_outstanding}
        isPending={payMut.isPending}
        onConfirm={async (payload) => {
          await payMut.mutateAsync(payload);
        }}
      />

      <ModalSendInvoice
        open={remindOpen}
        onOpenChange={setRemindOpen}
        buyerName={data.buyer.name}
        reminderState={data.whatsapp_reminder}
        isPending={remindMut.isPending}
        onConfirm={async () => {
          await remindMut.mutateAsync();
        }}
      />

      <ModalVoidInvoice
        open={voidOpen}
        onOpenChange={setVoidOpen}
        confirmToken={data.doc_number}
        isPending={voidMut.isPending}
        onConfirm={async () => {
          await voidMut.mutateAsync();
        }}
      />

      <SendDocumentWhatsAppDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        title="Send invoice"
        confirmLabel="Send invoice"
        isPending={sendInvoiceMut.isPending}
        sendState={data.whatsapp_send}
        buyerName={data.buyer.name}
        phoneNumber={data.whatsapp_send.recipient_phone}
        documentNumberLabel="Invoice Number"
        documentNumber={data.doc_number}
        amount={data.totals.grand_total}
        itemCount={diffLines.length}
        onConfirm={() => {
          sendInvoiceMut.mutate(undefined, {
            onSuccess: () => {
              setSendOpen(false);
            },
          });
        }}
      />
    </>
  );
}
