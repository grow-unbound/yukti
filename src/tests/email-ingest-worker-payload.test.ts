import { describe, expect, it } from 'vitest';
import { buildWorkerPayload, htmlToText } from '../../workers/email-ingest/src/build-payload';
import { normalizeInboundEmail } from '../../supabase/functions/_shared/email-inbound-normalize';

describe('htmlToText', () => {
  it('strips tags, scripts and entities', () => {
    expect(htmlToText('<p>Hi&nbsp;there</p><script>alert(1)</script><div>Price &amp; stock</div>')).toBe('Hi there\nPrice & stock');
  });
});

describe('buildWorkerPayload', () => {
  const parsed = {
    from: { address: 'Buyer@Example.test', name: 'Buyer' },
    to: [{ address: 'tok@mail.example.test' }],
    subject: 'Order',
    messageId: '<m1@example.test>',
    html: '<p>Need <b>10</b> pcs</p>',
    headers: [
      { key: 'Authentication-Results', value: 'mx; dkim=pass header.d=example.test' },
      { key: 'authentication-results', value: 'dkim=fail' },
    ],
  };

  it('falls back to html text, lowercases headers and keeps the first value', () => {
    const payload = buildWorkerPayload({ aliasToken: 'tok', receivedAt: '2026-10-23T10:00:00.000Z', rawR2Key: 'email-raw/x.eml', parsed, attachments: [] });
    expect(payload.text).toBe('Need 10 pcs');
    expect(payload.headers?.['authentication-results']).toBe('mx; dkim=pass header.d=example.test');
  });

  it('round-trips through the normalizer', () => {
    const payload = buildWorkerPayload({
      aliasToken: 'tok', receivedAt: '2026-10-23T10:00:00.000Z', rawR2Key: 'email-raw/x.eml', parsed,
      attachments: [{ filename: 'po.pdf', mime_type: 'application/pdf', size_bytes: 5, sha256: 'a', r2_key: 'email-att/a' }],
    });
    const normalized = normalizeInboundEmail(payload)!;
    expect(normalized.from_address).toBe('buyer@example.test');
    expect(normalized.auth.dkim).toBe('pass');
    expect(normalized.raw_r2_key).toBe('email-raw/x.eml');
    expect(normalized.attachments[0].filename).toBe('po.pdf');
  });
});
