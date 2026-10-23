import { createHash } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * JSON response with a content ETag and `If-None-Match` handling for per-buyer GETs.
 *
 * Priced buyer routes keep `Cache-Control: private, max-age=0, must-revalidate` (a price edit must
 * never be browser-held), so every back/forward, tab hop or pull-to-refresh used to re-download the
 * full body. With a validator the browser revalidates and an unchanged body comes back as an empty
 * 304 - the server still authenticates and computes the response first, so a 304 never skips auth,
 * and any change in the body (a new price) changes the ETag and returns the full 200.
 */
export function etagFor(payload: string): string {
  return `W/"${createHash('sha1').update(payload).digest('base64url')}"`;
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const weak = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = weak(etag);
  return header.split(',').some((candidate) => weak(candidate) === wanted);
}

export function jsonWithEtag<T>(
  request: NextRequest,
  body: T,
  headers: Record<string, string>,
): NextResponse<T> {
  const payload = JSON.stringify(body);
  const etag = etagFor(payload);
  const responseHeaders = { ...headers, ETag: etag, Vary: 'Authorization, Cookie' };

  if (request.method === 'GET' && matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, { status: 304, headers: responseHeaders }) as NextResponse<T>;
  }
  return new NextResponse<T>(payload, {
    status: 200,
    headers: { ...responseHeaders, 'Content-Type': 'application/json' },
  });
}
