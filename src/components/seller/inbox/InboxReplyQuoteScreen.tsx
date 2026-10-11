'use client';

import { useRouter } from 'next/navigation';
import { useMobileHeaderTitle } from '@/components/layout/MobileHeaderTitle';
import { Button } from '@/components/ui/button';
import { useInboxEntries } from '@/hooks/useInboxEntries';
import { InboxEntryHeading } from './InboxEntryHeading';
import { InboxEntryFrame } from './InboxEntryFrame';
import { InboxReplyQuoteBody, useInboxReplyQuoteDraft } from './InboxReplyQuoteView';
import { InboxEntryScreenSkeleton } from './InboxDetailSkeleton';

/**
 * Mobile full-screen route for the quote editor (`/inbox/[buyerId]/[entryId]/quote`).
 * The content is rich enough (image, sku, stock, resolved price, two inputs per
 * line, add-item search, totals, notes) that a centered dialog at phone width
 * just re-creates the original cramped-dialog bug -- this gets its own screen
 * instead, reusing the same InboxEntryFrame stacked shell the entry detail
 * screen already uses.
 */
export function InboxReplyQuoteScreen({ buyerId, entryId }: { buyerId: string; entryId: string }) {
  const router = useRouter();
  const { data, isLoading } = useInboxEntries('active');
  const entry = (data?.entries ?? []).find((e) => e.id === entryId);
  const draft = useInboxReplyQuoteDraft(entry ?? { id: entryId, entry_type: 'new_enquiry', source_entity_type: '', source_entity_id: '' } as any);

  useMobileHeaderTitle(entry?.buyer_name, { phone: entry?.buyer_phone });

  if (isLoading) return <InboxEntryScreenSkeleton />;
  if (!entry) {
    return (
      <div className="p-6 text-sm text-cream-500">This item is no longer in your active list.</div>
    );
  }

  async function handleSend() {
    const sent = await draft.sendQuote();
    if (sent) router.push(`/inbox/${buyerId}/${entryId}`);
  }

  return (
    <InboxEntryFrame
      variant="stacked"
      footer={
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={() => router.push(`/inbox/${buyerId}/${entryId}`)}>
            Cancel
          </Button>
          <Button type="button" variant="outline" className="flex-1" onClick={() => draft.saveDraft()} disabled={!draft.canSave || draft.isSaving}>
            {draft.isSaving ? 'Saving…' : 'Save Draft'}
          </Button>
          <Button type="button" variant="primary" className="flex-1" onClick={handleSend} disabled={!draft.canSend || draft.isSending}>
            {draft.isSending ? 'Sending…' : 'Send quote'}
          </Button>
        </div>
      }
    >
      <InboxEntryHeading title="Reply with a quote" />
      <InboxReplyQuoteBody draft={draft} />
    </InboxEntryFrame>
  );
}
