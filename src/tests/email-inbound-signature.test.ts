import { describe, expect, it } from 'vitest';
import {
  hashAliasToken,
  signEmailPayload,
  verifyEmailSignature,
} from '../../supabase/functions/_shared/email-inbound-signature';

const SECRET = 'test-secret-0123456789abcdef';
const OLD_SECRET = 'old-secret-0123456789abcdef';
const NOW_MS = 1_790_000_000_000;
const TS = Math.floor(NOW_MS / 1000);
const BODY = '{"alias_token":"tok"}';

async function check(overrides: Partial<Parameters<typeof verifyEmailSignature>[0]> = {}) {
  return verifyEmailSignature({
    secrets: [SECRET],
    timestampHeader: String(TS),
    signatureHeader: await signEmailPayload(SECRET, TS, BODY),
    rawBody: BODY,
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe('verifyEmailSignature', () => {
  it('accepts a valid signature', async () => {
    expect(await check()).toBe('ok');
  });

  it('fails closed when no secret is configured or secret is too short', async () => {
    expect(await check({ secrets: [undefined, ''] })).toBe('not_configured');
    expect(await check({ secrets: ['short'] })).toBe('not_configured');
  });

  it('rejects missing headers', async () => {
    expect(await check({ signatureHeader: null })).toBe('missing');
    expect(await check({ timestampHeader: null })).toBe('missing');
    expect(await check({ signatureHeader: 'abc' })).toBe('missing');
  });

  it('rejects a tampered body', async () => {
    expect(await check({ rawBody: BODY + ' ' })).toBe('invalid');
  });

  it('rejects the wrong secret and malformed hex', async () => {
    expect(await check({ secrets: [OLD_SECRET] })).toBe('invalid');
    expect(await check({ signatureHeader: 'sha256=zz' })).toBe('invalid');
  });

  it('rejects stale and future timestamps (replay window)', async () => {
    const stale = TS - 301;
    expect(
      await check({ timestampHeader: String(stale), signatureHeader: await signEmailPayload(SECRET, stale, BODY) }),
    ).toBe('stale');
    const future = TS + 301;
    expect(
      await check({ timestampHeader: String(future), signatureHeader: await signEmailPayload(SECRET, future, BODY) }),
    ).toBe('stale');
  });

  it('a signature for one timestamp cannot be replayed under another', async () => {
    const sig = await signEmailPayload(SECRET, TS - 10, BODY);
    expect(await check({ signatureHeader: sig })).toBe('invalid');
  });

  it('accepts the previous secret during rotation', async () => {
    const sig = await signEmailPayload(OLD_SECRET, TS, BODY);
    expect(await check({ secrets: [SECRET, OLD_SECRET], signatureHeader: sig })).toBe('ok');
  });
});

describe('hashAliasToken', () => {
  it('is stable, case-insensitive and hex', async () => {
    const a = await hashAliasToken('AbC123');
    expect(a).toBe(await hashAliasToken(' abc123 '));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
