import { ChevronRight } from 'lucide-react';
import { InboxEntrySummary } from './InboxEntryCard';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

/**
 * Mobile-only tappable row -- pushes to the entry's own stacked screen
 * (`/inbox/[buyerId]/[entryId]`) instead of expanding in place. Desktop keeps
 * `InboxEntryCard`'s inline expand; this is its mobile-list counterpart,
 * sharing the same `InboxEntrySummary` so the two surfaces show identical
 * title/meta content.
 */
export function InboxEntryListRow({ entry, onOpen }: { entry: InboxEntry; onOpen: () => void }) {
  return (
    <section id={`inbox-entry-${entry.id}`} className="relative overflow-hidden rounded-[14px] border border-cream-300 bg-white">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start justify-between gap-4 px-6 py-5 text-left"
      >
        <InboxEntrySummary entry={entry} />
        <ChevronRight size={16} className="mt-1 shrink-0 text-cream-500" aria-hidden />
      </button>
    </section>
  );
}
