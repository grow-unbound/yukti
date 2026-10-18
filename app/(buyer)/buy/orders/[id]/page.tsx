'use client';

import { use } from 'react';
import { TransactionDetailPage, type TransactionDoc } from '@/components/buyer/documents/TransactionDetailPage';

function pickDoc(payload: any): TransactionDoc | null {
  const o = payload?.order;
  if (!o) return null;
  return {
    docNumber: o.order_number,
    status: o.status,
    primaryDate: o.placed_at,
    secondaryDate: null,
    notes: o.notes ?? null,
    placeOfSupply: o.place_of_supply ?? null,
    subtotal: o.subtotal,
    tax_total: o.tax_total,
    total_amount: o.total_amount,
    discount_flat: o.discount_flat ?? 0,
    freight: o.freight ?? 0,
    round_off: o.round_off ?? 0,
    items: o.items ?? [],
  };
}

export default function BuyerOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <TransactionDetailPage
      id={id}
      title="Order"
      endpoint={`/api/buyer/orders/${id}`}
      docType="order"
      backFallbackHref="/buy/orders?tab=orders"
      respectBusinessPolicyTotals
      pickDoc={pickDoc}
    />
  );
}
