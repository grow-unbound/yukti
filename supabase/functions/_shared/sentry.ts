// Minimal Sentry error reporting for Deno edge functions — no SDK dependency,
// just the legacy "store" ingest endpoint (still supported, far simpler than
// building envelope multipart bodies by hand). Reads the same DSN the
// Next.js app uses (NEXT_PUBLIC_SENTRY_DSN is public by design — safe to
// reuse), set as the edge function secret SENTRY_DSN.
//
// Fire-and-forget: never throws, never blocks the caller on Sentry being
// down/misconfigured — this exists to make failures visible, not to become
// a new failure mode itself.

interface ParsedDsn {
  publicKey: string;
  projectId: string;
  host: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId || !url.host) return null;
    return { publicKey: url.username, projectId, host: url.host };
  } catch {
    return null;
  }
}

const DSN = Deno.env.get('SENTRY_DSN') ?? null;
const PARSED = DSN ? parseDsn(DSN) : null;
const ENVIRONMENT = Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production';

export async function captureSentryError(
  message: string,
  opts: {
    level?: 'error' | 'warning' | 'info';
    fingerprint?: string[];
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  } = {},
): Promise<void> {
  if (!PARSED) return; // no DSN configured — no-op, not an error
  try {
    const endpoint = `https://${PARSED.host}/api/${PARSED.projectId}/store/`;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${PARSED.publicKey}, sentry_client=supabase-edge-function/1.0`,
      },
      body: JSON.stringify({
        message,
        level: opts.level ?? 'error',
        ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
        platform: 'other',
        environment: ENVIRONMENT,
        timestamp: Date.now() / 1000,
        tags: { runtime: 'supabase-edge-function', ...opts.tags },
        extra: opts.extra,
      }),
    });
  } catch (e) {
    console.error(`[sentry] failed to report error: ${String(e)}`);
  }
}
