import type { SupabaseClient } from '@supabase/supabase-js';

import { allowedTenantBrandIdsFrom, getBuyerCatalogContext } from '@/lib/server/buyer-catalog-context';

/**
 * Cohort brand allow-list for a buyer: null = unrestricted, otherwise the union of the buyer's
 * cohorts' allowed_tenant_brand_ids. Read from the shared per-buyer catalog context (one cached
 * RPC) instead of three separate PostgREST reads. `_db` is kept so existing callers/tests keep
 * their signature.
 */
export async function resolveBuyerAllowedTenantBrandIds(
  _db: SupabaseClient,
  tenantId: string,
  buyerId: string,
): Promise<string[] | null> {
  return allowedTenantBrandIdsFrom(await getBuyerCatalogContext(tenantId, buyerId));
}
