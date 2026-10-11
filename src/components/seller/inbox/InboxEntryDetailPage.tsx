'use client';

import { useMemo } from 'react';
import { useMobileHeaderTitle } from '@/components/layout/MobileHeaderTitle';
import { useEntryHistory, useInboxEntries } from '@/hooks/useInboxEntries';
import { useLocalEntryActions } from '@/lib/inbox/inbox-local-actions';
import { InboxActionBar } from './InboxActionBar';
import { InboxEntrySummary } from './InboxEntryCard';
import { InboxApprovalActionBar } from './InboxApprovalActionBar';
import { InboxEntryDetailContent, isApprovalEntry } from './InboxEntryDetailContent';
import { InboxEntryFrame } from './InboxEntryFrame';
import { InboxEntryScreenSkeleton } from './InboxDetailSkeleton';

/**
 * Mobile full-screen route for a single entry (`/inbox/[buyerId]/[entryId]`).
 * Desktop shows the same content inline via InboxEntryCard -- this is
 * mobile's stacked-navigation counterpart, sharing InboxEntryDetailContent
 * and InboxEntryFrame so the body/footer never diverge from desktop's.
 */
export function InboxEntryDetailPage({ buyerId, entryId }: { buyerId: string; entryId: string }) {
  const { data, isLoading } = useInboxEntries('active');
  const { overrides, localEvents, applyLocalAction } = useLocalEntryActions();
  const history = useEntryHistory(buyerId);

  const entry = useMemo(() => {
    const found = (data?.entries ?? []).find((e) => e.id === entryId);
    if (!found) return null;
    return overrides[found.id] ? { ...found, ...overrides[found.id] } : found;
  }, [data, entryId, overrides]);

  useMobileHeaderTitle(entry?.buyer_name, { phone: entry?.buyer_phone });

  if (isLoading) return <InboxEntryScreenSkeleton />;

  if (!entry) {
    return (
      <div className="p-6 text-sm text-cream-500">This item is no longer in your active list.</div>
    );
  }

  const tenantId = entry.tenant_id;

  return (
    <InboxEntryFrame
      variant="stacked"
      footer={isApprovalEntry(entry) ? (
        <InboxApprovalActionBar
          entry={entry}
          tenantId={tenantId}
          historyEvents={history.data?.events}
          localEvents={localEvents}
          applyLocalAction={applyLocalAction}
        />
      ) : (
        <InboxActionBar
          entry={entry}
          tenantId={tenantId}
          historyEvents={history.data?.events}
          localEvents={localEvents}
          applyLocalAction={applyLocalAction}
        />
      )}
    >
      <InboxEntrySummary entry={entry} size="page" live />
      <InboxEntryDetailContent entry={entry} />
    </InboxEntryFrame>
  );
}
