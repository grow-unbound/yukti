/**
 * Opt-in, low-rate CPU sampling for middleware (MIDDLEWARE_CPU_SAMPLE_RATE, default off).
 *
 * Vercel's Hobby plan gives no per-route CPU breakdown, so this logs one JSON line per sampled
 * request (`evt: 'mw_cpu_sample'`) with a coarse path class, CPU microseconds and wall time. It logs
 * no ids, no query strings and no cookies. `process.cpuUsage()` is process-wide, so on a Fluid
 * instance serving concurrent requests it can over-attribute; treat it as an upper bound per class
 * and aggregate many samples rather than reading single lines.
 */
export type MiddlewarePathClass =
  | 'guest_api'
  | 'api'
  | 'page_prefetch'
  | 'page'
  | 'ingest'
  | 'manifest'
  | 'other';

export function parseSampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 1);
}

export function classifyMiddlewareRequest(pathname: string, headers: Pick<Headers, 'get'>): MiddlewarePathClass {
  if (pathname === '/ingest' || pathname.startsWith('/ingest/')) return 'ingest';
  if (pathname === '/manifest.webmanifest') return 'manifest';
  if (pathname.startsWith('/api/public/g/') || pathname.startsWith('/api/buyer/')) return 'guest_api';
  if (pathname.startsWith('/api/')) return 'api';
  const prefetch = headers.get('next-router-prefetch') === '1'
    || `${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''}`.toLowerCase().includes('prefetch');
  if (prefetch) return 'page_prefetch';
  return pathname.startsWith('/_next/') ? 'other' : 'page';
}
