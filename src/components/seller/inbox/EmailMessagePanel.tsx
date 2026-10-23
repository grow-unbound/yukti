'use client';

import { Paperclip } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { useEmailThread, useSetEmailSenderRule } from '@/hooks/useEmailInbox';
import type { InboxEntry } from '@/lib/inbox/inbox-types';
import { WhatsAppBuyerLinker } from './WhatsAppBuyerLinker';

function meta(entry: InboxEntry, key: string): string | null {
  const value = entry.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function sizeLabel(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Seller thread view for an email Today entry. Phase 1 is one-way: sellers
 * reply from their own mail client. Bodies render as plain text only and
 * attachments show metadata without a download (no scanner yet).
 */
export function EmailMessagePanel({ entry }: { entry: InboxEntry }) {
  const thread = useEmailThread(entry.id, true);
  const setRule = useSetEmailSenderRule();
  const resolutionStatus = meta(entry, 'resolution_status');
  const senderAddress = meta(entry, 'sender_address');
  const senderSource = meta(entry, 'sender_source');
  const verified = entry.metadata?.auth_verified === true;
  const messages = thread.data ?? [];

  async function onRule(rule: 'supplier' | 'ignore') {
    try {
      await setRule.mutateAsync({ entryId: entry.id, rule });
      toast.success(rule === 'supplier' ? 'Marked as supplier' : 'Sender ignored');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save sender rule');
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-cream-200 bg-cream-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            label={resolutionStatus === 'matched' ? 'Matched customer' : resolutionStatus === 'ambiguous' ? 'Needs review' : 'Unknown sender'}
            tone={resolutionStatus === 'matched' ? 'success' : resolutionStatus === 'ambiguous' ? 'warning' : 'neutral'}
          />
          <StatusPill label={verified ? 'Sender verified' : 'Sender not verified'} tone={verified ? 'success' : 'warning'} />
          {senderSource === 'parsed_forward' ? <StatusPill label="Sender read from forwarded text" tone="neutral" /> : null}
        </div>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">From</p>
            <p className="mt-0.5 break-all font-semibold text-cream-900">{senderAddress ?? 'Unknown'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Customer</p>
            <p className="mt-0.5 font-semibold text-cream-900">{entry.buyer_id ? entry.buyer_name : 'Not linked'}</p>
          </div>
        </div>
      </div>

      {resolutionStatus === 'ambiguous' || resolutionStatus === 'unknown' ? (
        <>
          <WhatsAppBuyerLinker entryId={entry.id} resolutionStatus={resolutionStatus} channel="email" />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={setRule.isPending} onClick={() => void onRule('supplier')}>
              Mark as supplier
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={setRule.isPending} onClick={() => void onRule('ignore')}>
              Ignore sender
            </Button>
          </div>
        </>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-cream-500">Messages</p>
        {thread.isLoading ? (
          <div className="h-24 animate-pulse rounded-[10px] bg-cream-100" aria-hidden />
        ) : thread.isError ? (
          <p className="text-sm text-cream-600">Couldn&apos;t load this email thread.</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-cream-600">{meta(entry, 'last_inbound_text') ?? 'No message text available.'}</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="rounded-[10px] border border-cream-200 bg-white p-3">
              {message.subject ? <p className="text-sm font-semibold text-cream-900">{message.subject}</p> : null}
              <p className="mt-0.5 break-all text-xs text-cream-500">
                {message.from_name ? `${message.from_name} · ` : ''}{message.from_address}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-cream-900">{message.text_body || 'No text content.'}</p>
              {message.attachments.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {message.attachments.map((attachment, index) => (
                    <li key={`${attachment.filename}-${index}`} className="flex items-center gap-1.5 text-xs text-cream-600">
                      <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{attachment.filename}</span>
                      {sizeLabel(attachment.size_bytes) ? <span className="shrink-0 text-cream-500">· {sizeLabel(attachment.size_bytes)}</span> : null}
                      {attachment.scan_status === 'blocked' ? <span className="shrink-0 text-warning-700">· blocked</span> : null}
                    </li>
                  ))}
                  <li className="text-xs text-cream-500">Attachments are not downloadable yet. Open the original in your mailbox.</li>
                </ul>
              ) : null}
              <p className="mt-2 text-xs text-cream-500">{new Date(message.at).toLocaleString()}</p>
            </div>
          ))
        )}
        <p className="text-xs text-cream-500">Reply from your own mailbox. Use Dismiss when you have handled this.</p>
      </div>
    </div>
  );
}
