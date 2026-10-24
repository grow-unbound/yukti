'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ModalConvertEstimate } from '@/components/seller/estimates/modals/ModalConvertEstimate';
import { useCreateFlags } from '@/hooks/useCreateFlags';
import { useConvertEstimateToInvoice, useConvertEstimateToOrder, useEstimateDetail } from '@/hooks/useEstimates';
import { SELLER_ROUTES } from '@/lib/seller-routes';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

type AddedLine = { tenant_product_id: string; qty: number; unit_price: number; disc_pct: number; tax_pct: number };

interface InboxConvertEnquiryModalProps {
  entry: InboxEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reflect the resolved state immediately; the server sync then confirms it. */
  onConverted: () => void;
}

/**
 * Convert an enquiry (estimate) to a sales order / invoice from the Inbox using the same
 * dialog and routes as Estimate Details — lines can be deselected, re-quantified, or added.
 */
export function InboxConvertEnquiryModal({ entry, open, onOpenChange, onConverted }: InboxConvertEnquiryModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const estimateId = entry.source_entity_type === 'estimate' ? entry.source_entity_id : '';
  const { createSalesOrders, createInvoices } = useCreateFlags();
  const { data } = useEstimateDetail(open ? estimateId : '');
  const convertMut = useConvertEstimateToOrder(estimateId);
  const convertToInvoiceMut = useConvertEstimateToInvoice(estimateId);

  if (!open || !data) return null;

  function finish(message: string, href: string | null) {
    onOpenChange(false);
    toast.success(message, href ? { action: { label: 'View', onClick: () => router.push(href) } } : undefined);
    onConverted();
    void queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox-entry-enquiry', entry.id] });
    void queryClient.invalidateQueries({ queryKey: ['inbox-entry-enquiry', 'summary'] });
  }

  function handleSO(payload: { line_ids: string[]; qty_overrides: Record<string, number>; price_overrides?: Record<string, number>; delivery_date: string; order_number?: string; added_lines?: AddedLine[] }) {
    convertMut.mutate(payload, {
      onSuccess: (res) => {
        const orderId = typeof res.data.order_id === 'string' ? res.data.order_id : null;
        finish('Sales order created', orderId ? `${SELLER_ROUTES.sales.orders}/${orderId}` : null);
      },
    });
  }

  function handleInvoice(payload: { line_ids: string[]; qty_overrides: Record<string, number>; price_overrides?: Record<string, number>; invoice_date: string; invoice_number?: string; added_lines?: AddedLine[] }) {
    convertToInvoiceMut.mutate(payload, {
      onSuccess: (res) => {
        const invoiceId = typeof res.data.invoice_id === 'string' ? res.data.invoice_id : null;
        finish('Invoice created', invoiceId ? `${SELLER_ROUTES.sales.invoices}/${invoiceId}` : null);
      },
    });
  }

  return (
    <ModalConvertEstimate
      open={open}
      onOpenChange={onOpenChange}
      estimateNumber={data.estimate_number}
      buyerName={entry.buyer_name}
      buyerId={data.buyer_id ?? entry.buyer_id ?? null}
      lines={data.items}
      createSalesOrders={createSalesOrders}
      createInvoices={createInvoices}
      isSubmitting={convertMut.isPending || convertToInvoiceMut.isPending}
      promptForMissingPrices
      onConfirmSO={handleSO}
      onConfirmInvoice={handleInvoice}
    />
  );
}
