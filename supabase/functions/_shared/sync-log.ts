/**
 * Lightweight checkpoint logging for sync orchestration diagnostics.
 *
 * Purpose: when a phase invocation hangs with no further heartbeat_at
 * movement (the products/transaction-line-items incidents), there was no
 * way to tell which step it died in — Zoho fetch, a specific persist
 * step, a specific DB helper — since none of that emitted anything.
 * console.log output is captured into Supabase's edge-function logs, so
 * the next time a job hangs, filtering logs by job_id and reading the last
 * checkpoint line tells you exactly where it got stuck, without needing a
 * debugger or stack trace.
 *
 * Kept dependency-free (no imports) so both sync-utils.ts and
 * integrations-persist.ts can use it without creating a circular import
 * (sync-utils.ts already imports from integrations-persist.ts).
 */

let seq = 0;

function syncDebugEnabled(): boolean {
  // `Deno` is absent when this module is imported under vitest/Node.
  if (typeof Deno === 'undefined') return false;
  const value = Deno.env.get('SYNC_LOG_LEVEL') ?? Deno.env.get('LOG_LEVEL') ?? '';
  return value.toLowerCase() === 'debug';
}

/**
 * Logs one checkpoint. `elapsedMs` (if the caller tracked a start time) makes
 * it possible to spot "this step alone took 40s" without cross-referencing
 * timestamps by hand.
 */
export function logCheckpoint(
  jobId: string | null | undefined,
  phase: string,
  step: string,
  extra?: Record<string, unknown>,
): void {
  if (!syncDebugEnabled()) return;

  seq += 1;
  const parts: string[] = [
    `[sync-checkpoint #${seq}]`,
    `job=${jobId ?? 'n/a'}`,
    `phase=${phase}`,
    `step=${step}`,
  ];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  console.log(parts.join(' '));
}

/** Returns a function that logs a checkpoint with elapsed ms since this call. */
export function startTimer(
  jobId: string | null | undefined,
  phase: string,
  step: string,
): (extra?: Record<string, unknown>) => void {
  const startedAt = Date.now();
  logCheckpoint(jobId, phase, `${step}:start`);
  return (extra?: Record<string, unknown>) => {
    logCheckpoint(jobId, phase, `${step}:done`, { ms: Date.now() - startedAt, ...extra });
  };
}
