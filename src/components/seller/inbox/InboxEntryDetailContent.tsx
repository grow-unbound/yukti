'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useMemo } from 'react';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { formatNumberValue } from '@/lib/utils';
import { useSendWhatsAppInboxReply } from '@/hooks/useInboxEntries';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { useBuyerOutstandingInvoices } from '@/hooks/useInboxEntries';
import { buildOutstandingSections } from '@/lib/inbox/inbox-detail-groups';
import { InboxApprovalDetails } from './InboxApprovalDetails';
import { InboxApprovalDocuments } from './InboxApprovalDocuments';
import { DuesSectionList } from './InboxCollectionGroupCard';
import { InboxOrderPanel } from './InboxOrderPanel';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

const InboxEnquiryPanel = dynamic(
  () => import('./InboxEnquiryPanel').then((m) => m.InboxEnquiryPanel),
  { ssr: false, loading: () => <div className="h-[220px]" aria-hidden /> },
);
export const APPROVAL_ENTRY_TYPES = new Set(['business_approval', 'new_user_login']);

export function isApprovalEntry(entry: InboxEntry): boolean {
  return APPROVAL_ENTRY_TYPES.has(entry.entry_type);
}

/** Open invoices behind an over-limit entry, grouped by aging with the total outstanding. */
function OutstandingInvoices({ buyerId }: { buyerId: string }) {
  const { data, isLoading, isError } = useBuyerOutstandingInvoices(buyerId);
  const outstanding = useMemo(() => buildOutstandingSections(data?.invoices ?? []), [data?.invoices]);

  if (isLoading) return <div className="h-40 animate-pulse rounded-[10px] bg-cream-100" aria-hidden />;
  if (isError) return <p className="text-base text-cream-600">Couldn&apos;t load outstanding invoices.</p>;
  if (outstanding.sections.length === 0) return null;

  return (
    <div className="space-y-5">
      <DuesSectionList sections={outstanding.sections} />
      <div className="flex items-baseline justify-between gap-3 border-t border-cream-200 pt-4">
        <p className="text-base font-semibold text-cream-800">Total outstanding</p>
        <p className="font-mono text-md font-bold tabular-nums text-cream-950">{outstanding.totalAmountLabel}</p>
      </div>
    </div>
  );
}

interface WhatsAppBundleMessage {
  id?: string;
  direction?: string;
  text_body?: string;
  created_at?: string;
  provider_message_id?: string;
}

function stringMeta(entry: InboxEntry, key: string): string | null {
  const value = entry.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function messageBundle(entry: InboxEntry): WhatsAppBundleMessage[] {
  const raw = entry.metadata?.message_bundle;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is WhatsAppBundleMessage => Boolean(item && typeof item === 'object'));
}

function matchStatusLabel(status: string | null): string {
  if (status === 'matched') return 'Matched buyer';
  if (status === 'ambiguous') return 'Needs buyer match';
  return 'Unknown sender';
}

function serviceWindowLabel(expiresAt: string | null): { label: string; expired: boolean } {
  if (!expiresAt) return { label: 'Service window unavailable', expired: true };
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return { label: 'Service window unavailable', expired: true };
  if (expiry <= Date.now()) return { label: 'Template required', expired: true };
  const hours = Math.max(1, Math.ceil((expiry - Date.now()) / (60 * 60 * 1000)));
  return { label: `${hours}h service window`, expired: false };
}

function WhatsAppMessagePanel({ entry }: { entry: InboxEntry }) {
  if (entry.entry_type !== 'whatsapp_buyer_message') return null;

  const [body, setBody] = useState('');
  const sendReply = useSendWhatsAppInboxReply();
  const messages = messageBundle(entry);
  const resolutionStatus = stringMeta(entry, 'resolution_status');
  const senderPhone = stringMeta(entry, 'sender_phone');
  const buyerRole = stringMeta(entry, 'buyer_contact_role');
  const expiresAt = stringMeta(entry, 'service_window_expires_at');
  const windowState = serviceWindowLabel(expiresAt);
  const canSend = !windowState.expired && body.trim().length > 0 && !sendReply.isPending;

  async function onSend() {
    try {
      await sendReply.mutateAsync({ entryId: entry.id, body });
      setBody('');
      toast.success('WhatsApp reply queued');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send WhatsApp reply');
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-cream-200 bg-cream-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={matchStatusLabel(resolutionStatus)} tone={resolutionStatus === 'matched' ? 'success' : resolutionStatus === 'ambiguous' ? 'warning' : 'neutral'} />
          <StatusPill label={windowState.label} tone={windowState.expired ? 'warning' : 'neutral'} />
        </div>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Sender</p>
            <p className="mt-0.5 font-mono font-semibold tabular-nums text-cream-900">{senderPhone ?? 'Unknown'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Buyer</p>
            <p className="mt-0.5 font-semibold text-cream-900">{entry.buyer_id ? entry.buyer_name : 'Not linked'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Reply mode</p>
            <p className="mt-0.5 font-semibold text-cream-900">{buyerRole === 'buyer_admin' ? 'Manual' : 'Manual only'}</p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Messages</p>
        <div className="space-y-2">
          {messages.length > 0 ? messages.map((message) => (
            <div key={message.id ?? message.provider_message_id ?? message.created_at} className="rounded-[10px] border border-cream-200 bg-white p-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-cream-900">{message.text_body ?? ''}</p>
              {message.created_at ? <p className="mt-2 text-xs text-cream-500">{new Date(message.created_at).toLocaleString()}</p> : null}
            </div>
          )) : (
            <p className="text-sm text-cream-600">{stringMeta(entry, 'last_inbound_text') ?? 'No message text available.'}</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <Textarea
          label="Manual reply"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={buyerRole === 'buyer_admin' && entry.buyer_name ? `Hi ${entry.buyer_name}, we received your message.` : 'Type a WhatsApp reply'}
          disabled={windowState.expired || sendReply.isPending}
          hint={windowState.expired ? 'Approved Meta template replies are not available in P0.' : 'Seller-reviewed manual reply only. No AI draft is generated in P0.'}
        />
        <div className="flex justify-end">
          <Button type="button" size="md" onClick={() => void onSend()} disabled={!canSend}>
            <Send className="h-4 w-4" aria-hidden />
            Send reply
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The single place that decides what an entry's body looks like -- shared by
 * desktop's inline-expand card and mobile's stacked full-screen route so the
 * two never drift apart. Action bars are NOT included here: they're the
 * frame's `footer` slot (sticky on mobile), selected by the caller via
 * `isApprovalEntry`.
 */
export function InboxEntryDetailContent({ entry }: { entry: InboxEntry }) {
  return (
    <div className="space-y-5">
      {entry.metadata.last_reminder_at ? (
        <p className="text-base leading-relaxed text-cream-700">
          Last reminder sent {new Date(String(entry.metadata.last_reminder_at)).toLocaleDateString()}.
        </p>
      ) : null}
      {entry.entry_type === 'credit_limit_breach' && entry.buyer_id ? <OutstandingInvoices buyerId={entry.buyer_id} /> : null}
      {isApprovalEntry(entry) ? (
        <>
          <InboxApprovalDetails entry={entry} />
          <InboxApprovalDocuments entryId={entry.id} />
        </>
      ) : entry.entry_type === 'new_enquiry' ? (
        <InboxEnquiryPanel entryId={entry.id} />
      ) : entry.entry_type === 'new_order_confirmation' || entry.entry_type === 'order_dispatch_needed' ? (
        <InboxOrderPanel entry={entry} />
      ) : entry.entry_type === 'whatsapp_buyer_message' ? (
        <WhatsAppMessagePanel entry={entry} />
      ) : null}
    </div>
  );
}
