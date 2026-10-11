'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bell, ChevronDown, Loader2, ReceiptText, Send, StickyNote } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useApplyGenericEntryAction, useSendCollectionReminder, type EntryHistoryEvent } from '@/hooks/useInboxEntries';
import { buildDuesSummaryLine } from '@/lib/inbox/inbox-entry-copy';
import { cn, formatDate } from '@/lib/utils';
import type { LocalEntryEvent } from '@/lib/inbox/inbox-local-actions';
import type { DuesSection, InboxDetailGroup } from '@/lib/inbox/inbox-detail-groups';
import { InboxNoteHost, InboxRemindSheet, REMIND_OPTIONS } from './InboxActionSheets';

interface InboxCollectionGroupCardProps {
  group: InboxDetailGroup;
  buyerId: string;
  historyEvents?: EntryHistoryEvent[];
  localEvents?: LocalEntryEvent[];
  expanded: boolean;
  onToggle: () => void;
}

export const DUES_TITLE = 'Upcoming dues or overdue';

export function duesSubtitle(group: InboxDetailGroup): string {
  const summary = group.summary;
  return summary ? buildDuesSummaryLine(summary.totalAmount, summary.entryIds.length, summary.overdueCount) : '';
}

/** Aged invoice sections -- shared by the dues card/screen and the over-limit body. */
export function DuesSectionList({ sections }: { sections: DuesSection[] }) {
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <div key={section.key} className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-base font-semibold uppercase tracking-[0.06em] text-cream-800">
              {section.label} <span className="font-medium text-cream-500">({section.count})</span>
            </p>
            <p className="font-mono text-base font-bold tabular-nums text-cream-950">{section.totalAmountLabel}</p>
          </div>
          <div className="space-y-2">
            {section.rows.map((row) => (
              <Link
                key={row.id}
                href={`/invoices/${row.invoiceId}`}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] border border-cream-200 bg-white px-3 py-3 transition-colors hover:border-cream-300 hover:bg-cream-50"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cream-200 bg-cream-50 text-cream-600">
                  <ReceiptText className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-mono text-base font-semibold text-cream-950">{row.invoiceNumber}</span>
                  <span className="mt-0.5 block truncate text-sm text-cream-600">{row.dateLabel}</span>
                </span>
                <span className="shrink-0 text-right font-mono text-base font-semibold tabular-nums text-cream-900">{row.amountLabel}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DuesSections({ group }: { group: InboxDetailGroup }) {
  return <DuesSectionList sections={group.rowsByAging ?? []} />;
}

/**
 * Note / remind-later / send-reminder actions for a dues group. On mobile the
 * remind picker and note editor open as bottom sheets (the bar itself is pinned
 * in a footer, where inline expansions would open out of view).
 */
export function DuesActions({ group, buyerId, historyEvents, localEvents }: Pick<InboxCollectionGroupCardProps, 'group' | 'buyerId' | 'historyEvents' | 'localEvents'>) {
  const isDesktop = useIsDesktop();
  const sendReminder = useSendCollectionReminder();
  const genericAction = useApplyGenericEntryAction();
  const [noteOpen, setNoteOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const summary = group.summary;

  async function handleSendReminder() {
    if (!summary) return;
    try {
      await sendReminder.mutateAsync({ buyerId, entryIds: summary.entryIds });
      toast.success('Reminder sent');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send reminder');
    }
  }

  async function remindLater(days: number) {
    const remindAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    try {
      await Promise.all(group.entries.map((entry) => genericAction.mutateAsync({
        entryId: entry.id,
        action: 'remind_later',
        remind_at: remindAt,
      })));
      toast.success(`Snoozed until ${formatDate(remindAt)}`);
      document.getElementById('inbox-dues-group')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not set reminder');
    }
  }

  const iconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-full text-cream-600 transition-colors hover:bg-cream-100 hover:text-cream-900 active:scale-[var(--yk-press-scale)]';

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" title="Add note" aria-label="Add note" onClick={() => setNoteOpen((open) => !open)} className={iconButtonClass}>
            <StickyNote className="h-4 w-4" aria-hidden />
          </button>
          {isDesktop ? (
            <div className="group/remind relative">
              <button type="button" title="Remind later" aria-label="Remind later" className={iconButtonClass}>
                <Bell className="h-4 w-4" aria-hidden />
              </button>
              <div className="invisible absolute bottom-full left-0 z-10 mb-2 flex min-w-36 flex-col rounded-[10px] border border-cream-200 bg-white p-1 opacity-0 shadow-lg transition group-hover/remind:visible group-hover/remind:opacity-100 group-focus-within/remind:visible group-focus-within/remind:opacity-100">
                <p className="px-3 py-2 text-sm font-semibold uppercase tracking-[0.08em] text-cream-500">Remind later</p>
                {REMIND_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => void remindLater(option.days)}
                    className="rounded-[8px] px-3 py-2 text-left text-base text-cream-800 hover:bg-cream-100"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" title="Remind later" aria-label="Remind later" onClick={() => setRemindOpen(true)} className={iconButtonClass}>
              <Bell className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
        <Button type="button" size="sm" onClick={handleSendReminder} disabled={sendReminder.isPending}>
          {sendReminder.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          Send reminder
        </Button>
      </div>

      {!isDesktop ? <InboxRemindSheet open={remindOpen} onOpenChange={setRemindOpen} onPick={(days) => void remindLater(days)} /> : null}

      {group.entries[0] ? (
        <InboxNoteHost
          entryIds={group.entries.map((entry) => entry.id)}
          primaryEntryId={group.entries[0].id}
          historyEvents={historyEvents}
          localEvents={localEvents}
          open={noteOpen}
          onOpenChange={setNoteOpen}
        />
      ) : null}
    </>
  );
}

/** Desktop expandable card. Mobile navigates to the dues screen instead (see InboxDuesDetailPage). */
export function InboxCollectionGroupCard({ group, buyerId, historyEvents, localEvents, expanded, onToggle }: InboxCollectionGroupCardProps) {
  const subtitle = duesSubtitle(group);

  return (
    <section id="inbox-dues-group" className="relative overflow-hidden rounded-[14px] border border-cream-300 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className={cn('flex w-full items-start justify-between gap-4 px-6 py-5 text-left', expanded ? 'border-b border-cream-200' : undefined)}
      >
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-[-0.015em] text-cream-900">{DUES_TITLE}</h3>
          {subtitle ? <p className="mt-1 text-base text-cream-600">{subtitle}</p> : null}
        </div>
        <ChevronDown
          size={16}
          className={cn('mt-1 shrink-0 text-cream-500 transition-transform duration-200', expanded && 'rotate-180')}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="space-y-6 px-6 py-6">
          <DuesSections group={group} />
          <DuesActions group={group} buyerId={buyerId} historyEvents={historyEvents} localEvents={localEvents} />
        </div>
      ) : null}
    </section>
  );
}
