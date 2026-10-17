import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getVerifiedClaims, decodeJWTPayload } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getFlag } from '@/lib/flags';
import { FEATURE_FLAGS } from '@/constants';
import { getPostHogClient } from '@/lib/posthog-server';
import { parseRowsLimit, SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';
import { getSellerLocationScope } from '@/lib/server/seller-location-access';
import type { AccessPageResponse } from '@/hooks/useBuyerAppAccess';
import { queueBuyerAppEnabledMessages } from '@/lib/server/buyer-app-enable-notify';
import { syncBuyerEntrySafe } from '@/lib/server/inbox-entries';
import { flushBuyerMembershipsNow } from '@/lib/server/buyer-membership-flush';

const AccessQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  status: z.enum(['all', 'enabled', 'disabled', 'suggested', 'inactive']).default('all'),
  last_ordered: z.enum(['all', '30d', '90d', 'dormant']).default('all'),
  sort: z.enum(['business_name', 'app_gmv', 'offline_spend', 'last_ordered']).default('business_name'),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  summary: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
});

// ─── GET /api/tenant/buyer-app/access ───────────────────────────────────────
// Returns a bounded, SQL-filtered page. The unparameterized SSR bootstrap also
// returns authoritative global counts; ordinary client requests opt out so
// searches and page changes aggregate only their filtered candidate buyers.

export async function GET(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);

    if (!claims.tenant_id || !claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const flagEnabled = await getFlag(FEATURE_FLAGS.BUYER_APP, claims.tenant_id);
    if (!flagEnabled) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const tenantId = claims.tenant_id;
    const limit = parseRowsLimit(request.nextUrl.searchParams.get('limit'));
    const parsedQuery = AccessQuerySchema.safeParse({
      q: request.nextUrl.searchParams.get('q') ?? undefined,
      status: request.nextUrl.searchParams.get('status') ?? undefined,
      last_ordered: request.nextUrl.searchParams.get('last_ordered') ?? undefined,
      sort: request.nextUrl.searchParams.get('sort') ?? undefined,
      offset: request.nextUrl.searchParams.get('offset') ?? undefined,
      summary: request.nextUrl.searchParams.get('summary') ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.errors[0]?.message ?? 'Invalid query parameters' },
        { status: 400 },
      );
    }

    const locationScope = getSellerLocationScope({
      role: claims.role ?? null,
      location_ids: claims.location_ids ?? null,
    });
    const includeSummary = parsedQuery.data.summary
      && parsedQuery.data.q === ''
      && parsedQuery.data.status === 'all'
      && parsedQuery.data.last_ordered === 'all'
      && parsedQuery.data.sort === 'business_name'
      && parsedQuery.data.offset === 0;

    if (locationScope.mode === 'none') {
      const emptyResponse: AccessPageResponse = {
        summary_authoritative: includeSummary,
        kpis: includeSummary
          ? {
              enabled_count: 0,
              not_enabled_count: 0,
              suggested_count: 0,
              inactive_count: 0,
              total_count: 0,
            }
          : null,
        buyers: [],
        filtered_count: 0,
        has_more: false,
        limit,
        offset: parsedQuery.data.offset,
      };

      return NextResponse.json(emptyResponse, { headers: SELLER_CACHE_PERSONAL });
    }

    const { data, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('search_buyer_app_access_v4', {
        p_tenant_id: tenantId,
        p_query: parsedQuery.data.q || null,
        p_segment: parsedQuery.data.status,
        p_last_ordered: parsedQuery.data.last_ordered,
        p_sort: parsedQuery.data.sort,
        p_location_ids: locationScope.mode === 'subset' ? locationScope.locationIds : null,
        p_limit: limit,
        p_offset: parsedQuery.data.offset,
        p_include_summary: includeSummary,
      });

    if (error || !data) {
      console.error('[GET /api/tenant/buyer-app/access] RPC failed', error);
      return NextResponse.json({ error: 'Failed to fetch buyers' }, { status: 500 });
    }

    return NextResponse.json(data as AccessPageResponse, { headers: SELLER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/tenant/buyer-app/access]', error);
    return NextResponse.json({ error: 'Failed to load buyer app access data' }, { status: 500 });
  }
}

// ─── PATCH /api/tenant/buyer-app/access ─────────────────────────────────────
// Bulk-toggle buyer_app_enabled for one or more buyers.
// Restricted to seller_admin.

const BulkToggleSchema = z.object({
  buyer_ids: z.array(z.string().uuid()).min(1, 'At least one buyer ID is required'),
  enabled: z.boolean(),
});

async function PATCHImpl(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);

    if (!claims.tenant_id || !claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const flagEnabled = await getFlag(FEATURE_FLAGS.BUYER_APP, claims.tenant_id);
    if (!flagEnabled) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = BulkToggleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Validation failed' },
        { status: 422 },
      );
    }

    const db = supabaseAdmin as any;
    const { buyer_ids, enabled } = parsed.data;

    let newlyEnabledIds: string[] = [];
    if (enabled) {
      const { data: disabledBuyers, error: lookupError } = await db
        .schema('app')
        .from('buyers')
        .select('id')
        .in('id', buyer_ids)
        .eq('tenant_id', claims.tenant_id)
        .eq('is_active', true)
        .eq('buyer_app_enabled', false)
        .is('deleted_at', null);

      if (lookupError) {
        return NextResponse.json({ error: 'Failed to update buyer app access' }, { status: 500 });
      }

      newlyEnabledIds = ((disabledBuyers ?? []) as { id: string }[]).map((row) => row.id);
    }

    const { data: updated, error: updateError } = await db
      .schema('app')
      .from('buyers')
      .update({ buyer_app_enabled: enabled, updated_at: new Date().toISOString() })
      .in('id', buyer_ids)
      .eq('tenant_id', claims.tenant_id)
      .eq('is_active', true)
      .is('deleted_at', null)
      .select('id');

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update buyer app access' }, { status: 500 });
    }

    // Audit log (fire-and-forget)
    let actorUserId: string | null = null;
    const token = request.headers.get('authorization')?.replace('Bearer ', '');
    if (token) {
      try {
        const payload = decodeJWTPayload(token);
        actorUserId = (payload.sub as string) ?? null;
      } catch {
        // ignore
      }
    }

    if ((updated ?? []).length > 0) {
      void Promise.all(
        (updated as { id: string }[]).map((row) =>
          db.schema('app').from('audit_log').insert({
            tenant_id: claims.tenant_id,
            actor_user_id: actorUserId,
            entity_type: 'buyer',
            entity_id: row.id,
            action: 'update',
            diff: { buyer_app_enabled: enabled },
          }),
        ),
      );

      for (const row of updated as { id: string }[]) {
        syncBuyerEntrySafe(db, row.id);
      }
    }

    if (enabled && newlyEnabledIds.length > 0) {
      // Join their campaign audiences now rather than at the next 15-min membership tick.
      const tenantId = claims.tenant_id;
      after(() => flushBuyerMembershipsNow(db, tenantId, newlyEnabledIds));
    }

    let whatsappSentCount = 0;
    let whatsappEligibleCount = 0;
    if (enabled && newlyEnabledIds.length > 0) {
      const queueResult = await queueBuyerAppEnabledMessages(db, claims.tenant_id, newlyEnabledIds);
      whatsappSentCount = queueResult.sent_count;
      whatsappEligibleCount = queueResult.eligible_count;
    }

    getPostHogClient()?.capture({
      distinctId: claims.sub ?? claims.tenant_id,
      event: enabled ? 'buyer_app_access_enabled' : 'buyer_app_access_disabled',
      properties: {
        tenant_id: claims.tenant_id,
        seller_id: claims.sub,
        requested_buyer_count: buyer_ids.length,
        updated_buyer_count: (updated ?? []).length,
        newly_enabled_count: newlyEnabledIds.length,
        whatsapp_sent_count: whatsappSentCount,
        whatsapp_eligible_count: whatsappEligibleCount,
        role: claims.role,
      },
    });

    return NextResponse.json({
      updated_count: (updated ?? []).length,
      whatsapp_sent_count: whatsappSentCount,
      whatsapp_eligible_count: whatsappEligibleCount,
    });
  } catch (error) {
    console.error('[PATCH /api/tenant/buyer-app/access]', error);
    return NextResponse.json({ error: 'Failed to update buyer app access' }, { status: 500 });
  }
}

export const PATCH = withBuyerContextRevalidation(PATCHImpl);
