'use client';

import { use } from 'react';
import { InboxDetailClient } from '@/components/seller/inbox/InboxDetailClient';

export default function InboxBuyerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: buyerId } = use(params);
  return <InboxDetailClient buyerId={buyerId} />;
}
