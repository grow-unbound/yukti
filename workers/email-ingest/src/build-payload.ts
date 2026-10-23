// Pure helpers: turn a postal-mime parse result into the JSON contract the
// email-inbound-webhook expects (EmailWorkerPayload). Kept free of Workers
// APIs so vitest can cover it.
import type { EmailWorkerPayload } from '../../../supabase/functions/_shared/email-inbound-normalize';

export interface ParsedAddress {
  address?: string;
  name?: string;
}

export interface ParsedEmail {
  from?: ParsedAddress;
  to?: ParsedAddress[];
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
  headers?: Array<{ key: string; value: string }>;
}

export interface StoredAttachment {
  filename?: string | null;
  mime_type?: string | null;
  size_bytes: number;
  sha256: string;
  r2_key: string | null;
}

/** Crude HTML -> text for HTML-only mail. Output is shown as plain text, never rendered. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function buildWorkerPayload(args: {
  aliasToken: string;
  receivedAt: string;
  rawR2Key: string;
  parsed: ParsedEmail;
  attachments: StoredAttachment[];
}): EmailWorkerPayload {
  const { parsed } = args;
  const headers: Record<string, string> = {};
  for (const header of parsed.headers ?? []) {
    const key = header.key.toLowerCase();
    if (!(key in headers)) headers[key] = header.value;
  }
  const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : '';
  return {
    alias_token: args.aliasToken,
    received_at: args.receivedAt,
    raw_r2_key: args.rawR2Key,
    headers,
    from_address: parsed.from?.address,
    from_name: parsed.from?.name,
    to_addresses: (parsed.to ?? []).map((a) => a.address).filter((a): a is string => Boolean(a)),
    subject: parsed.subject,
    message_id: parsed.messageId,
    in_reply_to: parsed.inReplyTo,
    references: parsed.references,
    text,
    attachments: args.attachments.map((a) => ({
      filename: a.filename ?? undefined,
      mime_type: a.mime_type ?? undefined,
      size_bytes: a.size_bytes,
      sha256: a.sha256,
      r2_key: a.r2_key ?? undefined,
    })),
  };
}
