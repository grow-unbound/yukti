// Supabase/PostgREST errors sometimes carry a whole Cloudflare/gateway HTML
// page as `message` when the upstream is down (5xx, timeouts). Interpolating
// that into an Error produces a multi-KB message that Sentry cannot group
// (each page embeds a ray id) and that hides the real cause. Collapse it to a
// short, stable string. Pure and runtime-agnostic: imported from both Next.js
// and Deno edge functions.

const HTML_BODY = /^\s*<(?:!doctype|html)/i;

export function describeDbError(error: { message?: string | null; code?: string | null } | null | undefined): string {
  const message = error?.message ?? '';
  if (HTML_BODY.test(message)) {
    const title = /<title>([^<]{1,120})<\/title>/i.exec(message)?.[1]?.trim();
    return `upstream gateway error${title ? ` (${title.replace(/\s+/g, ' ')})` : ''}`;
  }
  return message || error?.code || 'unknown error';
}
