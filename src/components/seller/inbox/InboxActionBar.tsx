'use client';

import { useState } from 'react';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useRouter } from 'next/navigation';
import { Bell, MoreHorizontal, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { formatDate } from '@/lib/utils';
import { useApplyGenericEntryAction } from '@/hooks/useInboxEntries';
import { shouldSkipConfirm } from '@/lib/inbox/inbox-confirm-prefs';
import { InboxConfirmDialog } from './InboxConfirmDialog';
import { InboxNoteHost, InboxRemindSheet, REMIND_OPTIONS } from './InboxActionSheets';
import { InboxConvertEnquiryModal } from './InboxConvertEnquiryModal';
import { InboxReplyQuoteSheet } from './InboxReplyQuoteSheet';
import type { EntryHistoryEvent } from '@/hooks/useInboxEntries';
import type { LocalEntryEvent } from '@/lib/inbox/inbox-local-actions';
import type { InboxEntry, InboxEntryStatus } from '@/lib/inbox/inbox-types';

export const GENERIC_ACTIONS = new Set(['remind_later', 'add_note', 'dismiss', 'reopen']);

export const ACTION_LABELS: Record<string, string> = {
  approve: 'Approve',
  request_more_info: 'Request more info',
  decline: 'Decline',
  view_details: 'View details',
  view_buyer: 'View buyer',
  add_note: 'Add note',
  view_activity: 'View activity',
  ignore: 'Ignore',
  reply_quote: 'Reply / Quote',
  send: 'Send',
  convert: 'Convert',
  contact_buyer: 'Contact buyer',
  view_enquiry: 'View enquiry',
  view_buyer_history: 'View buyer history',
  mark_converted_manually: 'Mark as converted',
  remind_later: 'Remind later',
  accept_order: 'Accept order',
  reject: 'Reject',
  view_order: 'View order',
  mark_dispatched: 'Mark dispatched',
  send_reminder: 'Send reminder',
  view_invoice: 'View invoice',
  log_call: 'Log a call',
  adjust_limit: 'Adjust limit',
  view_account: 'View account',
  reopen: 'Reopen',
  reply_whatsapp: 'Reply',
};

export const DESTRUCTIVE_ACTIONS: Record<string, { title: string; description: (entry: InboxEntry) => string; confirmLabel: string }> = {
  decline: {
    title: 'Decline this account?',
    description: (entry) => `${entry.buyer_name} will not be approved. You can reconsider later from Resolved.`,
    confirmLabel: 'Decline',
  },
  reject: {
    title: 'Reject this order?',
    description: (entry) => `${entry.buyer_name}'s order will be rejected and they'll be notified.`,
    confirmLabel: 'Reject',
  },
};

const LEFT_ICON_ACTIONS = new Set(['add_note', 'remind_later']);
/** Hidden because the flow lives inside the detail body rather than the sticky action bar. */
const HIDDEN_ACTIONS = new Set(['contact_buyer', 'reply_whatsapp']);
const CARD_HEADER_ACTIONS = new Set(['view_buyer', 'view_account']);

const ACTION_ICON: Record<string, typeof StickyNote> = {
  add_note: StickyNote,
  remind_later: Bell,
};

function primaryActionsFor(entry: InboxEntry): string[] {
  switch (entry.entry_type) {
    case 'credit_limit_breach':
      return ['send_reminder', 'adjust_limit'];
    case 'new_enquiry':
      return ['convert', 'reply_quote'];
    case 'new_order_confirmation':
      return ['accept_order'];
    case 'order_dispatch_needed':
      return ['mark_dispatched'];
    case 'invoice_due':
    case 'invoice_overdue':
      return ['send_reminder', 'log_call'];
    default:
      return entry.allowed_actions.filter((action) => !LEFT_ICON_ACTIONS.has(action) && !CARD_HEADER_ACTIONS.has(action) && action !== 'hold_new_orders').slice(0, 2);
  }
}

interface InboxActionBarProps {
  entry: InboxEntry;
  tenantId: string;
  historyEvents?: EntryHistoryEvent[];
  localEvents?: LocalEntryEvent[];
  applyLocalAction: (
    entry: InboxEntry,
    action: string,
    opts?: { note?: string; nextStatus?: InboxEntryStatus; nextSummary?: string },
  ) => void;
}

export function InboxActionBar({ entry, tenantId, historyEvents, localEvents, applyLocalAction }: InboxActionBarProps) {
  const router = useRouter();
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [remindPickerOpen, setRemindPickerOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const applyGenericAction = useApplyGenericEntryAction();

  function runLocalAction(action: string) {
    applyLocalAction(entry, action, { nextStatus: 'resolved', nextSummary: `${ACTION_LABELS[action] ?? action} done` });
  }

  async function runGenericAction(action: string, remindAt?: string) {
    try {
      await applyGenericAction.mutateAsync({ entryId: entry.id, action: action as 'remind_later' | 'dismiss' | 'reopen' | 'add_note', remind_at: remindAt });
      if (action === 'remind_later' && remindAt) {
        toast.success(`Snoozed until ${formatDate(remindAt)}`);
        // The snooze pill sits at the top of this card -- bring it into view so the
        // seller sees the state actually changed, not just a toast that fades.
        document.getElementById(`inbox-entry-${entry.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update this item');
    }
  }

  function handleActionClick(action: string) {
    if (action === 'remind_later') {
      setRemindPickerOpen(true);
      return;
    }
    if (action === 'add_note') {
      setNoteOpen((open) => !open);
      return;
    }
    if (GENERIC_ACTIONS.has(action)) {
      void runGenericAction(action);
      return;
    }
    if (action === 'convert' && entry.source_entity_type === 'estimate') {
      setConvertOpen(true);
      return;
    }
    if (action === 'reply_quote') {
      // The quote editor is too content-rich for a phone-width dialog (image,
      // sku, stock, resolved price, two inputs per line, add-item search,
      // totals, notes) -- mobile gets its own full screen instead.
      if (isDesktop) {
        setQuoteOpen(true);
      } else if (entry.buyer_id) {
        router.push(`/inbox/${entry.buyer_id}/${entry.id}/quote`);
      }
      return;
    }
    if (DESTRUCTIVE_ACTIONS[action] && !shouldSkipConfirm(tenantId, action)) {
      setPendingConfirm(action);
      return;
    }
    runLocalAction(action);
  }

  const destructiveMeta = pendingConfirm ? DESTRUCTIVE_ACTIONS[pendingConfirm] : null;
  const effectiveAllowedActions = (entry.entry_type === 'credit_limit_breach'
    ? Array.from(new Set(['send_reminder', ...entry.allowed_actions]))
    : entry.allowed_actions).filter((action) => !HIDDEN_ACTIONS.has(action));
  const textActions = primaryActionsFor(entry).filter((action) => effectiveAllowedActions.includes(action) && action !== 'hold_new_orders').slice(0, 2);
  const destructiveTextActions = effectiveAllowedActions.filter((action) => DESTRUCTIVE_ACTIONS[action] && !textActions.includes(action));
  const rightActions = [...textActions, ...destructiveTextActions];
  // Charcoal primary sits rightmost; secondary and destructive actions stack to its left.
  const primaryAction = rightActions.find((action) => !DESTRUCTIVE_ACTIONS[action]) ?? null;
  const orderedRightActions = [...rightActions.filter((action) => action !== primaryAction), ...(primaryAction ? [primaryAction] : [])];
  const iconActions = effectiveAllowedActions.filter((action) => LEFT_ICON_ACTIONS.has(action) && !rightActions.includes(action));

  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {iconActions.map((action) => {
            const Icon = ACTION_ICON[action] ?? MoreHorizontal;
            return (
              <button
                key={action}
                type="button"
                title={ACTION_LABELS[action] ?? action}
                aria-label={ACTION_LABELS[action] ?? action}
                onClick={() => handleActionClick(action)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-cream-600 transition-colors hover:bg-cream-100 hover:text-cream-900 active:scale-[var(--yk-press-scale)]"
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          {orderedRightActions.map((action) => (
            <Button
              key={action}
              type="button"
              size="md"
              variant={action === primaryAction ? 'primary' : 'outline'}
              onClick={() => handleActionClick(action)}
            >
              {ACTION_LABELS[action] ?? action}
            </Button>
          ))}
        </div>
      </div>

      {!isDesktop ? (
        <InboxRemindSheet
          open={remindPickerOpen}
          onOpenChange={setRemindPickerOpen}
          onPick={(days) => void runGenericAction('remind_later', new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString())}
        />
      ) : null}

      {isDesktop && remindPickerOpen ? (
        <div className="flex w-full flex-wrap items-center gap-2 pt-1">
          <p className="w-full text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Remind later</p>
          {REMIND_OPTIONS.map((opt) => (
            <Button
              key={opt.label}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                const remindAt = new Date(Date.now() + opt.days * 24 * 60 * 60 * 1000).toISOString();
                setRemindPickerOpen(false);
                void runGenericAction('remind_later', remindAt);
              }}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : null}

      <InboxNoteHost
        entryIds={[entry.id]}
        primaryEntryId={entry.id}
        historyEvents={historyEvents}
        localEvents={localEvents}
        open={noteOpen}
        onOpenChange={setNoteOpen}
      />

      {entry.entry_type === 'new_enquiry' ? (
        <>
          <InboxConvertEnquiryModal
            entry={entry}
            open={convertOpen}
            onOpenChange={setConvertOpen}
            onConverted={() => applyLocalAction(entry, 'convert', { nextStatus: 'resolved', nextSummary: 'Converted' })}
          />
          <InboxReplyQuoteSheet entry={entry} open={quoteOpen} onOpenChange={setQuoteOpen} />
        </>
      ) : null}

      {destructiveMeta ? (
        <InboxConfirmDialog
          open
          onOpenChange={(open) => !open && setPendingConfirm(null)}
          title={destructiveMeta.title}
          description={destructiveMeta.description(entry)}
          confirmLabel={destructiveMeta.confirmLabel}
          tenantId={tenantId}
          actionKey={pendingConfirm!}
          onConfirm={() => {
            runLocalAction(pendingConfirm!);
            setPendingConfirm(null);
          }}
        />
      ) : null}
    </div>
  );
}
