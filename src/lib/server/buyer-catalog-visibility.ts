import { isoDateInTimeZone } from '@/lib/date-utils';

export interface BuyerVisibleCatalog {
  id: string;
  tenant_id: string;
  name: string;
  share_token: string;
  valid_to: string | null;
  message: string | null;
  created_at: string;
  scope_type: 'cohort' | 'buyer' | 'geography' | 'all';
  scope_value: Record<string, unknown> | null;
  hero_image_url: string | null;
}

export function buyerMatchesCatalog(
  catalog: BuyerVisibleCatalog,
  buyerId: string,
  buyerDefaultCohortId: string | null,
  explicitCohortIds: Set<string>,
  buyerGeography: { state?: string; city?: string; zone?: string } | null,
) {
  if (catalog.scope_type === 'all') return true;

  const scopeValue = (catalog.scope_value ?? {}) as {
    buyer_id?: string;
    buyer_ids?: string[];
    cohort_id?: string;
    geography?: { state?: string; city?: string; zone?: string };
  };

  if (catalog.scope_type === 'buyer') {
    if (Array.isArray(scopeValue.buyer_ids) && scopeValue.buyer_ids.length > 0) {
      return scopeValue.buyer_ids.includes(buyerId);
    }
    return scopeValue.buyer_id === buyerId;
  }

  if (catalog.scope_type === 'cohort') {
    const cohortId = scopeValue.cohort_id;
    if (!cohortId) return false;
    if (explicitCohortIds.has(cohortId)) return true;
    return buyerDefaultCohortId === cohortId;
  }

  if (catalog.scope_type === 'geography') {
    const geo = scopeValue.geography;
    if (!geo || !buyerGeography) return false;
    if (geo.state && geo.state !== buyerGeography.state) return false;
    if (geo.city && geo.city !== buyerGeography.city) return false;
    if (geo.zone && geo.zone !== buyerGeography.zone) return false;
    return true;
  }

  return false;
}

export function isCatalogVisibleOnCurrentIstDay(validTo: string | null, now = new Date()): boolean {
  if (!validTo) return true;

  const validToDate = new Date(validTo);
  if (Number.isNaN(validToDate.getTime())) return false;

  return isoDateInTimeZone(validToDate) >= isoDateInTimeZone(now);
}

