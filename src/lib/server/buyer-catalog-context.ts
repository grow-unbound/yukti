import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { supabaseAdmin } from '@/lib/supabase';
import {
  buyerMatchesCatalog,
  isCatalogVisibleOnCurrentIstDay,
  type BuyerVisibleCatalog,
} from '@/lib/server/buyer-catalog-visibility';
import { buyerContextBuyerTag, buyerContextTenantTag } from '@/lib/server/buyer-context-cache';
import type {
  CatalogAccessMode,
  CatalogPricingMode,
  CatalogProductDisplayMode,
  PublicCatalogRecord,
} from '@/lib/server/public-catalog';

/**
 * The tenant/buyer context every buyer catalog request needs, from ONE RPC
 * (app.get_buyer_catalog_context) instead of 8-10 PostgREST reads, cached per (tenant, buyer).
 * The RPC returns raw rows; visibility rules and the brand allow-list union are derived here
 * (single source of truth: buyer-catalog-visibility.ts).
 */

const CONTEXT_REVALIDATE_SECONDS = 60;

const geographySchema = z
  .object({ state: z.string().optional(), city: z.string().optional(), zone: z.string().optional() })
  .passthrough()
  .nullable();

const rpcSchema = z.object({
  buyer: z
    .object({
      default_cohort_id: z.string().nullable(),
      geography: geographySchema.optional().transform((value) => value ?? null),
      explicit_cohort_ids: z.array(z.string()),
    })
    .nullable(),
  campaigns: z.array(
    z.object({
      id: z.string(),
      tenant_id: z.string(),
      name: z.string(),
      share_token: z.string().nullable().transform((value) => value ?? ''),
      valid_to: z.string().nullable(),
      message: z.string().nullable(),
      created_at: z.string(),
      scope_type: z.enum(['cohort', 'buyer', 'geography', 'all']),
      scope_value: z.record(z.string(), z.unknown()).nullable(),
      hero_image_url: z.string().nullable(),
      item_count: z.coerce.number(),
    }),
  ),
  cohorts: z.array(z.object({ id: z.string(), allowed_tenant_brand_ids: z.array(z.string()).nullable() })),
  public_catalog: z
    .object({
      id: z.string(),
      tenant_id: z.string(),
      include_all: z.boolean().nullable(),
      pricing_mode: z.string().nullable(),
      price_list_id: z.string().nullable(),
      access_mode: z.string().nullable(),
      collect_target_unit_price_range: z.boolean().nullable(),
      product_display_mode: z.string().nullable(),
      live_at: z.string().nullable(),
    })
    .nullable(),
});

export interface BuyerCatalogContext {
  buyer: {
    defaultCohortId: string | null;
    geography: { state?: string; city?: string; zone?: string } | null;
    explicitCohortIds: string[];
  } | null;
  /** Published, non-deleted campaigns of the tenant, newest first (NOT yet filtered for this buyer). */
  campaigns: BuyerVisibleCatalog[];
  /** Live item count per campaign id. */
  itemCountByCampaignId: Record<string, number>;
  cohorts: Array<{ id: string; allowed_tenant_brand_ids: string[] | null }>;
  publicCatalog: PublicCatalogRecord | null;
}

export function parseBuyerCatalogContext(raw: unknown): BuyerCatalogContext {
  const parsed = rpcSchema.parse(raw);
  const itemCountByCampaignId: Record<string, number> = {};
  const campaigns: BuyerVisibleCatalog[] = parsed.campaigns.map(({ item_count, ...campaign }) => {
    itemCountByCampaignId[campaign.id] = item_count;
    return campaign;
  });
  const catalog = parsed.public_catalog;
  return {
    buyer: parsed.buyer
      ? {
          defaultCohortId: parsed.buyer.default_cohort_id,
          geography: parsed.buyer.geography,
          explicitCohortIds: parsed.buyer.explicit_cohort_ids,
        }
      : null,
    campaigns,
    itemCountByCampaignId,
    cohorts: parsed.cohorts,
    publicCatalog:
      catalog && catalog.live_at
        ? {
            id: catalog.id,
            tenantId: catalog.tenant_id,
            includeAll: catalog.include_all !== false,
            pricingMode: (catalog.pricing_mode as CatalogPricingMode | null) ?? null,
            priceListId: catalog.price_list_id,
            accessMode: (catalog.access_mode as CatalogAccessMode | null) ?? 'public_link',
            collectTargetUnitPriceRange: catalog.collect_target_unit_price_range === true,
            productDisplayMode: (catalog.product_display_mode as CatalogProductDisplayMode | null) ?? 'sku_list',
            liveAt: catalog.live_at,
          }
        : null,
  };
}

export async function fetchBuyerCatalogContextUncached(
  tenantId: string,
  buyerId: string,
): Promise<BuyerCatalogContext> {
  if (!supabaseAdmin) throw new Error('Server configuration error');
  const { data, error } = await supabaseAdmin
    .schema('app')
    .rpc('get_buyer_catalog_context', { p_tenant_id: tenantId, p_buyer_id: buyerId });
  if (error) throw new Error(error.message);
  return parseBuyerCatalogContext(data);
}

// Key and tags always carry BOTH tenant and buyer (cross-tenant rule, .claude/rules/data-fetching.md).
// `public-catalog:<tenant>` is the tag the public-catalog writers already revalidate, so going live /
// off or editing the public catalog drops the cached copy without a new call site.
const getBuyerCatalogContextCached = (tenantId: string, buyerId: string): Promise<BuyerCatalogContext> =>
  unstable_cache(
    () => fetchBuyerCatalogContextUncached(tenantId, buyerId),
    ['buyer-catalog-ctx', tenantId, buyerId],
    {
      revalidate: CONTEXT_REVALIDATE_SECONDS,
      tags: [buyerContextBuyerTag(tenantId, buyerId), buyerContextTenantTag(tenantId), `public-catalog:${tenantId}`],
    },
  )();

/** Cached per (tenant, buyer) for 60 s; also deduped within one render pass via React `cache()`. */
export const getBuyerCatalogContext = cache(getBuyerCatalogContextCached);

export function visibleCampaignsFrom(
  ctx: BuyerCatalogContext,
  buyerId: string,
  now: Date = new Date(),
): BuyerVisibleCatalog[] {
  const explicit = new Set(ctx.buyer?.explicitCohortIds ?? []);
  return ctx.campaigns.filter(
    (campaign) =>
      isCatalogVisibleOnCurrentIstDay(campaign.valid_to, now)
      && buyerMatchesCatalog(campaign, buyerId, ctx.buyer?.defaultCohortId ?? null, explicit, ctx.buyer?.geography ?? null),
  );
}

/** True when a published, still-visible cohort campaign targets a cohort the buyer is not (yet) in. */
export function hasUnmatchedCohortCampaign(ctx: BuyerCatalogContext, now: Date = new Date()): boolean {
  const explicit = new Set(ctx.buyer?.explicitCohortIds ?? []);
  const defaultCohortId = ctx.buyer?.defaultCohortId ?? null;
  return ctx.campaigns.some((campaign) => {
    if (campaign.scope_type !== 'cohort' || !isCatalogVisibleOnCurrentIstDay(campaign.valid_to, now)) return false;
    const cohortId = ((campaign.scope_value ?? {}) as { cohort_id?: string }).cohort_id;
    return Boolean(cohortId) && !explicit.has(cohortId as string) && defaultCohortId !== cohortId;
  });
}

/** null = unrestricted; otherwise the union of the buyer's cohorts' allow-lists. */
export function allowedTenantBrandIdsFrom(ctx: BuyerCatalogContext): string[] | null {
  const cohortIds = new Set<string>(ctx.buyer?.explicitCohortIds ?? []);
  if (ctx.buyer?.defaultCohortId) cohortIds.add(ctx.buyer.defaultCohortId);
  if (cohortIds.size === 0) return null;
  if (ctx.cohorts.length === 0) return null;
  if (ctx.cohorts.some((cohort) => cohort.allowed_tenant_brand_ids == null)) return null;
  return Array.from(new Set(ctx.cohorts.flatMap((cohort) => cohort.allowed_tenant_brand_ids ?? [])));
}
