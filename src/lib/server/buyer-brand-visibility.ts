import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBuyerMembership } from '@/lib/server/buyer-membership';

type BuyerCohortRow = {
  id: string;
  allowed_tenant_brand_ids: string[] | null;
};

export async function resolveBuyerAllowedTenantBrandIds(
  db: SupabaseClient,
  tenantId: string,
  buyerId: string,
): Promise<string[] | null> {
  const membership = await loadBuyerMembership(db, tenantId, buyerId);
  const cohortIds = new Set<string>(membership.explicitCohortIds);
  if (membership.defaultCohortId) cohortIds.add(membership.defaultCohortId);

  if (cohortIds.size === 0) return null;

  const { data: cohorts, error: cohortsError } = await db
    .schema('app')
    .from('cohorts')
    .select('id, allowed_tenant_brand_ids')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .in('id', Array.from(cohortIds));

  if (cohortsError) throw new Error(cohortsError.message);

  const rows = (cohorts ?? []) as BuyerCohortRow[];
  if (rows.length === 0) return null;
  if (rows.some((row) => row.allowed_tenant_brand_ids == null)) return null;

  return Array.from(
    new Set(
      rows.flatMap((row) => row.allowed_tenant_brand_ids ?? []),
    ),
  );
}
