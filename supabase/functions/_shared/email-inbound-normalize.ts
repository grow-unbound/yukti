// Pure (no Deno APIs) so it is unit-testable from vitest.
//
// Turns the already-MIME-parsed payload sent by the Cloudflare email-ingest
// Worker into the jsonb payload of app.process_email_inbound_message. All
// classification (noise, forwarded senders, GSTIN, attachment blocking) lives
// here, not in SQL, so it is covered by unit tests.

export interface EmailWorkerAttachment {
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  r2_key?: string;
}

export interface EmailWorkerPayload {
  /** Local part of the recipient address; the per-tenant alias token. */
  alias_token?: string;
  received_at?: string;
  raw_r2_key?: string;
  html_r2_key?: string;
  /** Lower-cased header name -> first value. */
  headers?: Record<string, string>;
  from_address?: string;
  from_name?: string;
  to_addresses?: string[];
  subject?: string;
  message_id?: string;
  in_reply_to?: string;
  /** Raw References header (space separated message ids). */
  references?: string;
  text?: string;
  attachments?: EmailWorkerAttachment[];
}

export interface NormalizedEmailAuth {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface NormalizedInboundEmail {
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from_address: string;
  from_name: string | null;
  original_from_address: string | null;
  to_addresses: string[];
  subject: string;
  text_body: string;
  received_at: string | null;
  auth: NormalizedEmailAuth;
  headers: Record<string, string>;
  filter_reason: string | null;
  message_kind: 'message' | 'setup_verification';
  gstins: string[];
  raw_r2_key: string | null;
  html_r2_key: string | null;
  attachments: Array<{
    filename: string;
    mime_type: string | null;
    size_bytes: number | null;
    sha256: string | null;
    r2_key: string | null;
    blocked: boolean;
  }>;
}

export const MAX_BODY_CHARS = 20000;

// Headers worth keeping for audit/debug. Everything else (Received chains,
// X-* tracking, DKIM blobs) is dropped to protect the DB budget and PII.
const HEADER_WHITELIST = [
  'auto-submitted',
  'precedence',
  'x-autoreply',
  'x-auto-response-suppress',
  'list-unsubscribe',
  'list-id',
  'return-path',
  'x-forwarded-for',
  'x-forwarded-to',
  'content-type',
];

// System senders whose mail is setup traffic, not buyer mail. Gmail sends the
// forwarding confirmation code from one of these.
const SETUP_VERIFICATION_SENDERS = new Set([
  'forwarding-noreply@google.com',
  'mail-noreply@google.com',
]);

const NOREPLY_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[s]?|notifications?)(\+.*)?$/i;

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'ps1',
  'jar', 'apk', 'app', 'dmg', 'iso', 'lnk', 'reg', 'sh', 'hta', 'cpl',
  'zip', 'rar', '7z', 'gz', 'tar',
]);

export function normalizeAddress(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = input.match(/<([^>]+)>/);
  const raw = (match ? match[1] : input).trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)) return null;
  return raw;
}

export function parseMessageIds(input: string | null | undefined): string[] {
  if (!input) return [];
  const ids = input.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids.map((id) => id.trim()))];
}

function cleanId(input: string | null | undefined): string | null {
  if (!input) return null;
  const ids = parseMessageIds(input);
  if (ids.length > 0) return ids[0];
  const trimmed = input.trim();
  return trimmed || null;
}

/** True when `signer` is the From domain or a sub/parent domain of it (relaxed alignment). */
export function isAlignedDomain(signer: string, fromDomain: string): boolean {
  const a = signer.toLowerCase().replace(/\.$/, '');
  const b = fromDomain.toLowerCase().replace(/\.$/, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Reads the verdicts of the Authentication-Results header. A dkim=pass only
 * counts when its signing domain (header.d) aligns with the From domain: any
 * third party can DKIM-sign mail it relays, which proves nothing about From.
 * An unaligned pass is reported as 'unaligned'. dmarc=pass already implies
 * alignment. Callers must pass the header added by our own MX (the topmost
 * one); other copies are sender-controlled and must be ignored.
 */
export function parseAuthenticationResults(
  header: string | null | undefined,
  fromDomain?: string | null,
): NormalizedEmailAuth {
  const out: NormalizedEmailAuth = { spf: null, dkim: null, dmarc: null };
  if (!header) return out;
  for (const key of ['spf', 'dmarc'] as const) {
    const matches = [...header.matchAll(new RegExp(`\\b${key}\\s*=\\s*([a-z]+)`, 'gi'))].map((m) => m[1].toLowerCase());
    if (matches.length > 0) out[key] = matches.includes('pass') ? 'pass' : matches[0];
  }
  const dkimClauses = header.split(/;/).filter((clause) => /\bdkim\s*=/i.test(clause));
  for (const clause of dkimClauses) {
    const result = clause.match(/\bdkim\s*=\s*([a-z]+)/i)?.[1].toLowerCase();
    if (!result) continue;
    if (result !== 'pass') {
      out.dkim ??= result;
      continue;
    }
    const signer = clause.match(/header\.(?:d|i)\s*=\s*"?@?([^\s;"]+)/i)?.[1];
    const aligned = Boolean(fromDomain && signer && isAlignedDomain(signer.split('@').pop() ?? signer, fromDomain));
    if (aligned) out.dkim = 'pass';
    else if (out.dkim !== 'pass') out.dkim = 'unaligned';
  }
  return out;
}

const GSTIN_PATTERN = /\b[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check digit: Luhn mod-36 variant used by GSTN. */
export function isValidGstin(gstin: string): boolean {
  if (!/^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(gstin[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  return check === gstin[14];
}

export function extractGstins(text: string): string[] {
  const found = new Set<string>();
  for (const candidate of text.toUpperCase().match(GSTIN_PATTERN) ?? []) {
    if (isValidGstin(candidate)) found.add(candidate);
  }
  return [...found].slice(0, 5);
}

/**
 * Detects a hand-forwarded wrapper ("Fwd:" + an original From block) and
 * returns the original sender. Only used for matching, at lower confidence.
 */
export function parseForwardedSender(subject: string, text: string): string | null {
  const looksForwarded = /^\s*(fwd?|fw)\s*:/i.test(subject) || /-{2,}\s*(forwarded message|original message)\s*-{2,}/i.test(text);
  if (!looksForwarded) return null;
  const block = text.match(/-{2,}\s*(?:forwarded message|original message)\s*-{2,}([\s\S]{0,1500})/i);
  const scope = block ? block[1] : text.slice(0, 1500);
  const from = scope.match(/^\s*from\s*:\s*(.+)$/im);
  return from ? normalizeAddress(from[1]) : null;
}

function classifyNoise(
  from: string,
  headers: Record<string, string>,
  contentType: string,
): string | null {
  const autoSubmitted = headers['auto-submitted']?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_reply';
  if (headers['x-autoreply'] || headers['x-auto-response-suppress']) return 'auto_reply';
  if (/multipart\/report/i.test(contentType) || from.startsWith('mailer-daemon@') || from.startsWith('postmaster@')) return 'bounce';
  const precedence = headers['precedence']?.toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return 'bulk';
  if (headers['list-unsubscribe'] || headers['list-id']) return 'bulk';
  if (NOREPLY_LOCAL.test(from.split('@')[0] ?? '')) return 'no_reply';
  return null;
}

function blockedByName(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return BLOCKED_EXTENSIONS.has(ext);
}

export function normalizeInboundEmail(input: EmailWorkerPayload): NormalizedInboundEmail | null {
  const from = normalizeAddress(input.from_address);
  if (!from) return null;

  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {})
      .map(([key, value]) => [key.toLowerCase(), String(value).slice(0, 500)] as const)
      .filter(([key]) => HEADER_WHITELIST.includes(key)),
  );
  const authHeader = input.headers?.['authentication-results'] ?? null;

  const subject = (input.subject ?? '').slice(0, 500);
  const text = (input.text ?? '').slice(0, MAX_BODY_CHARS);

  let filterReason = classifyNoise(from, headers, input.headers?.['content-type'] ?? '');
  let messageKind: 'message' | 'setup_verification' = 'message';
  if (SETUP_VERIFICATION_SENDERS.has(from)) {
    messageKind = 'setup_verification';
    filterReason = null;
  }

  const references = parseMessageIds(input.references);
  const original = messageKind === 'message' ? parseForwardedSender(subject, text) : null;

  return {
    rfc_message_id: cleanId(input.message_id),
    in_reply_to: cleanId(input.in_reply_to),
    references,
    from_address: from,
    from_name: input.from_name?.trim().slice(0, 200) || null,
    original_from_address: original && original !== from ? original : null,
    to_addresses: (input.to_addresses ?? []).map(normalizeAddress).filter((a): a is string => a !== null).slice(0, 20),
    subject,
    text_body: text,
    received_at: input.received_at ?? null,
    auth: parseAuthenticationResults(authHeader, from.split('@')[1]),
    headers,
    filter_reason: filterReason,
    message_kind: messageKind,
    gstins: extractGstins(`${subject}\n${text}`),
    raw_r2_key: input.raw_r2_key ?? null,
    html_r2_key: input.html_r2_key ?? null,
    attachments: (input.attachments ?? []).slice(0, 50).map((att) => {
      const filename = (att.filename ?? 'attachment').slice(0, 255);
      return {
        filename,
        mime_type: att.mime_type ?? null,
        size_bytes: typeof att.size_bytes === 'number' ? att.size_bytes : null,
        sha256: att.sha256 ?? null,
        r2_key: att.r2_key ?? null,
        blocked: blockedByName(filename),
      };
    }),
  };
}
