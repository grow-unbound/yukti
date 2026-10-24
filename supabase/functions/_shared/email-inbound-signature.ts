// Shared by the Cloudflare email-ingest Worker (signs) and the
// email-inbound-webhook edge function (verifies). Uses only Web Crypto so it
// runs in Deno, Workers and Node (vitest).
//
// Cloudflare Email Routing has no provider signature, so this is our own
// contract: HMAC-SHA256 over `${timestamp}.${rawBody}` with a shared secret,
// plus a timestamp window to bound replay.

export const SIGNATURE_MAX_SKEW_SECONDS = 300;

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

export async function signEmailPayload(secret: string, timestampSeconds: number, rawBody: string): Promise<string> {
  return `sha256=${toHex(await hmac(secret, `${timestampSeconds}.${rawBody}`))}`;
}

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'invalid' | 'not_configured';

/**
 * Fails closed. `secrets` may hold two values so the shared secret can be
 * rotated without downtime (current first, previous second).
 */
export async function verifyEmailSignature(args: {
  secrets: Array<string | undefined | null>;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs?: number;
}): Promise<SignatureCheck> {
  const secrets = args.secrets.filter((s): s is string => typeof s === 'string' && s.length >= 16);
  if (secrets.length === 0) return 'not_configured';
  if (!args.timestampHeader || !args.signatureHeader?.startsWith('sha256=')) return 'missing';

  const timestamp = Number(args.timestampHeader);
  if (!Number.isInteger(timestamp)) return 'missing';
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_MAX_SKEW_SECONDS) return 'stale';

  const provided = hexToBytes(args.signatureHeader.slice('sha256='.length));
  if (!provided) return 'invalid';

  for (const secret of secrets) {
    const expected = new Uint8Array(await hmac(secret, `${timestamp}.${args.rawBody}`));
    if (timingSafeEqual(provided, expected)) return 'ok';
  }
  return 'invalid';
}

/** sha256 hex of the lower-cased alias token; only the hash is ever stored. */
export async function hashAliasToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.trim().toLowerCase()));
  return toHex(digest);
}
