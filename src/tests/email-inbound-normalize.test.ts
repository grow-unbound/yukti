import { describe, expect, it } from 'vitest';
import {
  extractGstins,
  isValidGstin,
  normalizeAddress,
  normalizeInboundEmail,
  parseAuthenticationResults,
  parseForwardedSender,
  parseMessageIds,
  type EmailWorkerPayload,
} from '../../supabase/functions/_shared/email-inbound-normalize';

// Synthetic GSTIN: derive the check character so the fixture is valid without
// using any real taxpayer number.
const GSTIN_BODY = '27AAAAA0000A1Z';
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const VALID_GSTIN = GSTIN_BODY + [...CHARS].find((c) => isValidGstin(GSTIN_BODY + c))!;

function base(overrides: Partial<EmailWorkerPayload> = {}): EmailWorkerPayload {
  return {
    alias_token: 'tok',
    received_at: '2026-10-23T10:00:00.000Z',
    from_address: 'Buyer Person <Buyer@Example-Traders.test>',
    from_name: 'Buyer Person',
    to_addresses: ['tok@mail.example.test'],
    subject: 'Need price for item 12',
    message_id: '<abc123@example-traders.test>',
    text: 'Hi, please share price.',
    headers: {},
    ...overrides,
  };
}

describe('normalizeAddress', () => {
  it('lowercases and unwraps display names', () => {
    expect(normalizeAddress('Buyer Person <Buyer@Example.TEST>')).toBe('buyer@example.test');
  });
  it('rejects malformed input', () => {
    expect(normalizeAddress('not-an-email')).toBeNull();
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
  });
});

describe('parseMessageIds', () => {
  it('splits and de-duplicates References', () => {
    expect(parseMessageIds('<a@x> <b@x>\n <a@x>')).toEqual(['<a@x>', '<b@x>']);
  });
});

describe('parseAuthenticationResults', () => {
  it('reads spf/dkim/dmarc verdicts', () => {
    const header = 'mx.example; spf=pass smtp.mailfrom=a.test; dkim=pass header.d=a.test; dmarc=pass header.from=a.test';
    expect(parseAuthenticationResults(header, 'a.test')).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });
  it('prefers pass when several dkim results exist', () => {
    expect(parseAuthenticationResults('x; dkim=fail header.d=a.test; dkim=pass header.d=a.test', 'a.test').dkim).toBe('pass');
  });
  it('counts dkim=pass only when the signing domain aligns with From', () => {
    const header = 'mx; dkim=pass header.d=relay-service.test; dmarc=fail';
    expect(parseAuthenticationResults(header, 'buyer.test').dkim).toBe('unaligned');
    expect(parseAuthenticationResults('mx; dkim=pass header.d=buyer.test', 'buyer.test').dkim).toBe('pass');
    expect(parseAuthenticationResults('mx; dkim=pass header.d=mail.buyer.test', 'buyer.test').dkim).toBe('pass');
    expect(parseAuthenticationResults('mx; dkim=pass header.d=buyer.test').dkim).toBe('unaligned');
  });
  it('returns nulls when header missing', () => {
    expect(parseAuthenticationResults(null)).toEqual({ spf: null, dkim: null, dmarc: null });
  });
});

describe('GSTIN', () => {
  it('validates the checksum', () => {
    expect(isValidGstin(VALID_GSTIN)).toBe(true);
    const wrong = VALID_GSTIN.slice(0, 14) + (VALID_GSTIN[14] === 'A' ? 'B' : 'A');
    expect(isValidGstin(wrong)).toBe(false);
  });
  it('extracts only checksum-valid numbers from text', () => {
    const text = `GSTIN: ${VALID_GSTIN}\nOther: 27AAAAA0000A1ZX`;
    expect(extractGstins(text)).toEqual([VALID_GSTIN]);
  });
});

describe('parseForwardedSender', () => {
  it('reads the original sender from a Fwd wrapper', () => {
    const text = 'FYI\n---------- Forwarded message ---------\nFrom: Real Buyer <real@buyer.test>\nDate: x\n';
    expect(parseForwardedSender('Fwd: Order', text)).toBe('real@buyer.test');
  });
  it('returns null for non-forwarded mail', () => {
    expect(parseForwardedSender('Hello', 'From: x@y.test in body')).toBeNull();
  });
});

describe('normalizeInboundEmail', () => {
  it('normalizes a plain buyer email', () => {
    const out = normalizeInboundEmail(base())!;
    expect(out.from_address).toBe('buyer@example-traders.test');
    expect(out.rfc_message_id).toBe('<abc123@example-traders.test>');
    expect(out.filter_reason).toBeNull();
    expect(out.message_kind).toBe('message');
    expect(out.original_from_address).toBeNull();
  });

  it('returns null when there is no usable sender', () => {
    expect(normalizeInboundEmail(base({ from_address: 'garbage' }))).toBeNull();
  });

  it('keeps a null Message-ID so the RPC can hash a fallback', () => {
    expect(normalizeInboundEmail(base({ message_id: undefined }))!.rfc_message_id).toBeNull();
  });

  it.each([
    ['auto reply', { 'auto-submitted': 'auto-replied' }, 'auto_reply'],
    ['x-autoreply', { 'x-autoreply': 'yes' }, 'auto_reply'],
    ['bulk precedence', { precedence: 'bulk' }, 'bulk'],
    ['list-unsubscribe', { 'list-unsubscribe': '<mailto:u@x.test>' }, 'bulk'],
    ['dsn bounce', { 'content-type': 'multipart/report; report-type=delivery-status' }, 'bounce'],
  ])('filters %s', (_name, headers, reason) => {
    expect(normalizeInboundEmail(base({ headers }))!.filter_reason).toBe(reason);
  });

  it('filters no-reply senders and mailer-daemon', () => {
    expect(normalizeInboundEmail(base({ from_address: 'no-reply@shop.test' }))!.filter_reason).toBe('no_reply');
    expect(normalizeInboundEmail(base({ from_address: 'MAILER-DAEMON@mx.test' }))!.filter_reason).toBe('bounce');
  });

  it('does not filter Auto-Submitted: no', () => {
    expect(normalizeInboundEmail(base({ headers: { 'auto-submitted': 'no' } }))!.filter_reason).toBeNull();
  });

  it('keeps Gmail forwarding verification mail as setup_verification, not filtered', () => {
    const out = normalizeInboundEmail(base({ from_address: 'forwarding-noreply@google.com', headers: { precedence: 'bulk' } }))!;
    expect(out.message_kind).toBe('setup_verification');
    expect(out.filter_reason).toBeNull();
  });

  it('extracts original sender for forwarded mail but keeps header sender', () => {
    const out = normalizeInboundEmail(base({
      from_address: 'staff@distributor.test',
      subject: 'Fwd: PO 55',
      text: 'see below\n-------- Original Message --------\nFrom: buyer@customer.test\nSubject: PO 55',
    }))!;
    expect(out.from_address).toBe('staff@distributor.test');
    expect(out.original_from_address).toBe('buyer@customer.test');
  });

  it('whitelists headers and caps body length', () => {
    const out = normalizeInboundEmail(base({
      text: 'x'.repeat(30000),
      headers: { received: 'secret chain', 'x-tracking': 'abc', precedence: 'first-class', 'authentication-results': 'dkim=pass header.d=example-traders.test' },
    }))!;
    expect(Object.keys(out.headers)).toEqual(['precedence']);
    expect(out.text_body.length).toBe(20000);
    expect(out.auth.dkim).toBe('pass');
  });

  it('extracts GSTIN from body', () => {
    expect(normalizeInboundEmail(base({ text: `Our GST ${VALID_GSTIN}` }))!.gstins).toEqual([VALID_GSTIN]);
  });

  it('blocks executable and archive attachments by extension', () => {
    const out = normalizeInboundEmail(base({
      attachments: [
        { filename: 'po.pdf', mime_type: 'application/pdf', size_bytes: 10 },
        { filename: 'run.EXE', mime_type: 'application/octet-stream', size_bytes: 10 },
        { filename: 'bundle.zip', size_bytes: 10 },
      ],
    }))!;
    expect(out.attachments.map((a) => a.blocked)).toEqual([false, true, true]);
  });

  it('parses References and In-Reply-To', () => {
    const out = normalizeInboundEmail(base({ in_reply_to: '<root@x.test>', references: '<root@x.test> <mid@x.test>' }))!;
    expect(out.in_reply_to).toBe('<root@x.test>');
    expect(out.references).toEqual(['<root@x.test>', '<mid@x.test>']);
  });
});
