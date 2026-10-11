'use client';

import { useMemo } from 'react';
import { useMobileHeaderTitle } from '@/components/layout/MobileHeaderTitle';
import { useEntryHistory, useInboxEntries } from '@/hooks/useInboxEntries';
import { buildCollectionGroup, isCollectionEntry } from '@/lib/inbox/inbox-detail-groups';
import { useLocalEntryActions } from '@/lib/inbox/inbox-local-actions';
import { DuesActions, DuesSections, DUES_TITLE, duesSubtitle } from './InboxCollectionGroupCard';
import { InboxEntryScreenSkeleton } from './InboxDetailSkeleton';
import { InboxEntryHeading } from './InboxEntryHeading';
import { InboxEntryFrame } from './InboxEntryFrame';

/** Mobile full-screen dues screen (`/inbox/[buyerId]/dues`): invoices in the body, actions pinned in the footer. */
export function InboxDuesDetailPage({ buyerId }: { buyerId: string }) {
  const { data, isLoading } = useInboxEntries('active');
  const { overrides, localEvents } = useLocalEntryActions();
  const history = useEntryHistory(buyerId);

  const group = useMemo(() => {
    const entries = (data?.entries ?? [])
      .filter((e) => (e.buyer_id ? e.buyer_id === buyerId : e.id === buyerId) && isCollectionEntry(e))
      .map((e) => (overrides[e.id] ? { ...e, ...overrides[e.id] } : e));
    return buildCollectionGroup(entries);
  }, [data, buyerId, overrides]);

  useMobileHeaderTitle(group?.entries[0]?.buyer_name, { phone: group?.entries[0]?.buyer_phone });

  if (isLoading) return <InboxEntryScreenSkeleton />;
  if (!group) {
    return <div className="p-6 text-sm text-cream-500">No dues in your active list.</div>;
  }

  return (
    <InboxEntryFrame
      variant="stacked"
      footer={<DuesActions group={group} buyerId={buyerId} historyEvents={history.data?.events} localEvents={localEvents} />}
    >
      <InboxEntryHeading title={DUES_TITLE} subtitle={duesSubtitle(group)} />
      <DuesSections group={group} />
    </InboxEntryFrame>
  );
}
