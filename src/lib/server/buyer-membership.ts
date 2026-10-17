import type { SupabaseClient } from '@supabase/supabase-js';

export interface BuyerMembership {
  defaultCohortId: string | null;
  geography: { state?: string; city?: string; zone?: string } | null;
  /** Explicit `cohort_members_active` rows only; the default cohort is NOT merged in. */
  explicitCohortIds: string[];
}

// Zero-TTL request coalescing: callers that overlap in time (e.g. the brand allow-list and the
// visible-campaign lookups that `resolveBuyerCatalogContext` runs in parallel) share one pair of
// `buyers` + `cohort_members_active` reads instead of issuing one pair each. The entry is removed
// the moment the read settles, so nothing is ever served stale. Keyed by tenant + buyer.
const inflight = new Map<string, Promise<BuyerMembership>>();

export function loadBuyerMembership(
  db: SupabaseClient,
  tenantId: string,
  buyerId: string,
): Promise<BuyerMembership> {
  const key = `${tenantId}:${buyerId}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = (async (): Promise<BuyerMembership> => {
    const [buyerRes, membershipsRes] = await Promise.all([
      db
        .schema('app')
        .from('buyers')
        .select('default_cohort_id, geography')
        .eq('id', buyerId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      db
        .schema('app')
        .from('cohort_members_active')
        .select('cohort_id')
        .eq('buyer_id', buyerId),
    ]);
    if (buyerRes.error) throw new Error(buyerRes.error.message);
    if (membershipsRes.error) throw new Error(membershipsRes.error.message);

    const buyer = buyerRes.data as {
      default_cohort_id?: string | null;
      geography?: BuyerMembership['geography'];
    } | null;
    return {
      defaultCohortId: buyer?.default_cohort_id ?? null,
      geography: buyer?.geography ?? null,
      explicitCohortIds: ((membershipsRes.data ?? []) as Array<{ cohort_id: string }>).map((row) => row.cohort_id),
    };
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, pending);
  return pending;
}
