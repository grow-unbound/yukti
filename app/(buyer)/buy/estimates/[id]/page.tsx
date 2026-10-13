'use client';

import { use } from 'react';
import { TransactionDetailPage, type TransactionDoc } from '@/components/buyer/documents/TransactionDetailPage';

function pickDoc(payload: any): TransactionDoc | null {
  const e = payload?.estimate;
  if (!e) return null;
  return {
    docNumber: e.estimate_number ?? `ENQ-${e.id.slice(0, 6).toUpperCase()}`,
    status: e.status,
    primaryDate: e.created_at,
    secondaryDate: e.valid_until ?? null,
    notes: e.notes ?? null,
    placeOfSupply: e.place_of_supply ?? null,
    subtotal: e.subtotal,
    tax_total: e.tax_total,
    total_amount: e.total_amount,
    items: e.items ?? [],
    campaignName: e.campaign_name ?? null,
  };
}

export default function BuyerEstimateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <TransactionDetailPage
      id={id}
      title="Estimate"
      endpoint={`/api/buyer/estimates/${id}`}
      docType="estimate"
      backFallbackHref="/buy/orders?tab=enquiries"
      respectBusinessPolicyTotals
      pickDoc={pickDoc}
    />
  );
}
