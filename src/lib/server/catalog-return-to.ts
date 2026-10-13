import type { LoginOtpCandidate } from '@/lib/server/buyer-otp-store';
import {
  CANONICAL_STOREFRONT_SUFFIX,
  LEGACY_STOREFRONT_SUFFIX,
  LOCAL_STOREFRONT_SUFFIX,
  isReservedStorefrontLabel,
} from '@/lib/storefront-host';

const STOREFRONT_SUFFIXES = [CANONICAL_STOREFRONT_SUFFIX, LEGACY_STOREFRONT_SUFFIX, LOCAL_STOREFRONT_SUFFIX];

export function tenantSlugFromReturnTo(returnTo: string | null | undefined): string | null {
  if (!returnTo?.trim()) return null;
  try {
    const hostname = new URL(returnTo.trim()).hostname.toLowerCase();
    // Only a host under one of our storefront suffixes can name a tenant: `https://evil.example.com`
    // must not resolve to a tenant called "evil".
    if (!STOREFRONT_SUFFIXES.some((suffix) => hostname.endsWith(`.${suffix}`))) return null;
    const slug = hostname.split('.')[0];
    if (!slug || isReservedStorefrontLabel(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

/** Buyer accounts for the tenant named in `return_to`, if any. */
export function filterBuyerCandidatesForReturnTo(
  candidates: LoginOtpCandidate[],
  returnTo: string | null | undefined,
): LoginOtpCandidate[] {
  const slug = tenantSlugFromReturnTo(returnTo);
  if (!slug) return [];
  return candidates.filter(
    (c) => c.kind === 'buyer' && c.tenant_slug?.toLowerCase() === slug,
  );
}

const BUYER_ROLE_PRIORITY: Record<string, number> = {
  buyer_admin: 0,
  buyer_assistant: 1,
};

function buyerRolePriority(candidate: LoginOtpCandidate): number {
  return BUYER_ROLE_PRIORITY[candidate.role] ?? 99;
}

function compareBuyerCandidates(a: LoginOtpCandidate, b: LoginOtpCandidate): number {
  const enabledA = a.buyer_app_enabled === true ? 0 : 1;
  const enabledB = b.buyer_app_enabled === true ? 0 : 1;
  if (enabledA !== enabledB) return enabledA - enabledB;

  const roleA = buyerRolePriority(a);
  const roleB = buyerRolePriority(b);
  if (roleA !== roleB) return roleA - roleB;

  return (a.business_name ?? '').localeCompare(b.business_name ?? '');
}

/**
 * A phone can surface both an owner candidate and a delegate candidate for the
 * same app.buyers row. The buyer account picker should list the business once,
 * preferring enabled/admin candidates for the actual session mint.
 */
export function dedupeBuyerAccountCandidates(candidates: LoginOtpCandidate[]): LoginOtpCandidate[] {
  const byBuyerId = new Map<string, LoginOtpCandidate>();

  for (const candidate of candidates) {
    if (candidate.kind !== 'buyer' || !candidate.buyer_id) continue;
    const existing = byBuyerId.get(candidate.buyer_id);
    if (!existing || compareBuyerCandidates(candidate, existing) < 0) {
      byBuyerId.set(candidate.buyer_id, candidate);
    }
  }

  return Array.from(byBuyerId.values()).sort(compareBuyerCandidates);
}

/** Prefer buyer_admin; stable tie-break on business name. */
export function pickPreferredBuyerCandidate(candidates: LoginOtpCandidate[]): LoginOtpCandidate {
  return dedupeBuyerAccountCandidates(candidates)[0]!;
}
