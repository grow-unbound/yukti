'use client';

import { use } from 'react';
import { InboxDuesDetailPage } from '@/components/seller/inbox/InboxDuesDetailPage';

export default function InboxDuesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: buyerId } = use(params);
  return <InboxDuesDetailPage buyerId={buyerId} />;
}
