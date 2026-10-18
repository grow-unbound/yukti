'use client';

import { use } from 'react';
import { TransactionDetailPage, type TransactionDoc } from '@/components/buyer/documents/TransactionDetailPage';
import { effectiveInvoiceStatus } from '@/lib/invoice-status';

function pickDoc(payload: any): TransactionDoc | null {
  const inv = payload?.invoice;
  if (!inv) return null;
  return {
    docNumber: inv.invoice_number,
    status: effectiveInvoiceStatus({ status: inv.status, due_date: inv.due_date }),
    primaryDate: inv.invoice_date,
    secondaryDate: inv.due_date ?? null,
    notes: null,
    placeOfSupply: inv.place_of_supply ?? null,
    subtotal: inv.subtotal,
    tax_total: inv.tax_total,
    total_amount: inv.total_amount,
    discount_flat: inv.discount_flat ?? 0,
    freight: inv.freight ?? 0,
    round_off: inv.round_off ?? 0,
    outstandingBalance: inv.outstanding_balance,
    items: inv.items ?? [],
  };
}

export default function BuyerInvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <TransactionDetailPage
      id={id}
      title="Invoice"
      endpoint={`/api/buyer/invoices/${id}`}
      docType="invoice"
      backFallbackHref="/buy/orders?tab=invoices"
      respectBusinessPolicyTotals
      pickDoc={pickDoc}
    />
  );
}
