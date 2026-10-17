import { revalidateTag } from 'next/cache';

/** Tag on every cached buyer context / slim profile of one tenant (campaign, cohort, catalog edits). */
export function buyerContextTenantTag(tenantId: string): string {
  return `buyer-ctx:${tenantId}`;
}

/** Tag on one buyer's cached context / slim profile (enable, disable, membership flush). */
export function buyerContextBuyerTag(tenantId: string, buyerId: string): string {
  return `buyer-ctx:${tenantId}:${buyerId}`;
}

/**
 * Drop cached buyer context. Pass `buyerId` for a single buyer, omit it for the whole tenant.
 * Only effective from a Route Handler / Server Action (Next throws during render, so a render-time
 * caller must treat a throw as "cache will catch up on its TTL").
 */
export function revalidateBuyerContext(tenantId: string, buyerId?: string | null): void {
  revalidateTag(buyerId ? buyerContextBuyerTag(tenantId, buyerId) : buyerContextTenantTag(tenantId));
}

type RouteHandler<A extends unknown[]> = (...args: A) => Promise<Response>;

/**
 * Wrap a seller-side mutating Route Handler so a successful call (status < 400) drops the
 * tenant's cached buyer context and slim profiles. The tenant comes from the middleware-verified
 * `x-verified-tenant-id` header (the same claim every seller route authorizes against). Writers
 * outside Next (pg_cron membership tick, edge-function sync) cannot call this; the 60 s / 30 s
 * TTLs are their backstop.
 */
export function withBuyerContextRevalidation<A extends [Request, ...unknown[]]>(
  handler: RouteHandler<A>,
): RouteHandler<A> {
  return async (...args: A) => {
    const response = await handler(...args);
    if (response.status < 400) {
      const tenantId = args[0].headers.get('x-verified-tenant-id');
      if (!tenantId) {
        console.warn('[buyer-context-cache] successful mutation without x-verified-tenant-id; buyer context cache not invalidated');
      } else {
        try {
          revalidateBuyerContext(tenantId);
        } catch (error) {
          console.error('[buyer-context-cache] revalidate failed', error);
        }
      }
    }
    return response;
  };
}
