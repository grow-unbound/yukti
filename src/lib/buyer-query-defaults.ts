import type { QueryClient } from '@tanstack/react-query';

/** Buyer PWA surface: `/buy` and `/buy/...` (not the seller `/buyer-app` section). */
export function isBuyerAppPath(pathname: string): boolean {
  return pathname === '/buy' || pathname.startsWith('/buy/');
}

/**
 * On the buyer PWA a flaky mobile network fires `online` repeatedly, and TanStack's default
 * `refetchOnReconnect` then refetches every stale active query (infinite catalog lists refetch ALL
 * loaded pages). Stale data is still refreshed on the next mount or an explicit pull-to-refresh, so
 * reconnect refetch is turned off for the buyer surface only; seller behaviour is untouched.
 */
export function applyBuyerQueryDefaults(queryClient: QueryClient, isBuyer: boolean): void {
  const current = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...current,
    queries: { ...current.queries, refetchOnReconnect: !isBuyer },
  });
}

/**
 * Collapse rapid repeat triggers (rage pull-to-refresh) into one run: while a run is in flight the
 * same promise is returned, and a call within `minIntervalMs` of the last start is a no-op.
 */
export function createRefreshThrottle(minIntervalMs: number, now: () => number = Date.now) {
  let inFlight: Promise<void> | null = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  return function throttled(run: () => Promise<void>): Promise<void> {
    if (inFlight) return inFlight;
    if (now() - lastStartedAt < minIntervalMs) return Promise.resolve();
    lastStartedAt = now();
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
