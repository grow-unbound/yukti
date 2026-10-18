import type { NextRequest } from 'next/server';
import { getPostHogClient } from '@/lib/posthog-server';

export function postHogCorrelationFromRequest(request: NextRequest) {
  return {
    browser_distinct_id: request.headers.get('x-posthog-distinct-id')?.trim() || null,
    posthog_session_id: request.headers.get('x-posthog-session-id')?.trim() || null,
  };
}

export function captureAuthoritativeBuyerDemand(params: {
  request: NextRequest;
  event: 'inquiry_created' | 'order_placed';
  tenantId: string;
  buyerId: string;
  documentId: string;
  documentNumber: string | null;
  documentType: 'estimate' | 'order';
  totalAmount: number;
  itemCount: number;
  lineProductIds: string[];
  campaignId?: string | null;
  estimateType?: string | null;
}): void {
  try {
    const ph = getPostHogClient();
    const correlation = postHogCorrelationFromRequest(params.request);
    ph.capture({
      distinctId: correlation.browser_distinct_id ?? params.buyerId,
      event: params.event,
      properties: {
        tenant_id: params.tenantId,
        buyer_id: params.buyerId,
        document_id: params.documentId,
        document_number: params.documentNumber,
        document_type: params.documentType,
        estimate_id: params.documentType === 'estimate' ? params.documentId : undefined,
        estimate_number: params.documentType === 'estimate' ? params.documentNumber : undefined,
        order_id: params.documentType === 'order' ? params.documentId : undefined,
        order_number: params.documentType === 'order' ? params.documentNumber : undefined,
        item_count: params.itemCount,
        total_amount: params.totalAmount,
        line_product_ids: params.lineProductIds,
        source: 'buyer_app',
        source_channel: 'storefront',
        campaign_id: params.campaignId ?? null,
        estimate_type: params.estimateType ?? null,
        buyer_distinct_id: params.buyerId,
        posthog_distinct_id: correlation.browser_distinct_id,
        posthog_session_id: correlation.posthog_session_id,
      },
    });
    void ph.flush().catch(() => {});
  } catch {
    // non-blocking
  }
}

type BuyerServerActivityEvent = 'catalog_viewed' | 'session_started';

const POSTHOG_VIEW_WINDOW_MS = 30 * 60 * 1000;
const MAX_POSTHOG_THROTTLE_ENTRIES = 5000;
const lastCatalogViewCapturedAt = new Map<string, number>();

function isCatalogViewThrottled(tenantId: string, buyerId: string, nowMs: number): boolean {
  const key = `${tenantId}:${buyerId}`;
  const last = lastCatalogViewCapturedAt.get(key);
  if (last != null && nowMs - last < POSTHOG_VIEW_WINDOW_MS) return true;
  if (lastCatalogViewCapturedAt.size >= MAX_POSTHOG_THROTTLE_ENTRIES) lastCatalogViewCapturedAt.clear();
  lastCatalogViewCapturedAt.set(key, nowMs);
  return false;
}

/**
 * Server-side buyer activity for PostHog, independent of client pageviews (ad-blockers, stale JWT role).
 * `role` must come from the server-resolved profile/candidate, never the browser. Without a browser
 * distinct id the event is personless so it never mints a second person per buyer in WAU/DAU charts;
 * `buyer_id` + `tenant_id` properties carry the identity for HogQL.
 */
export function captureBuyerServerActivity(params: {
  request?: NextRequest | null;
  event: BuyerServerActivityEvent;
  tenantId: string;
  buyerId: string;
  role?: string | null;
  path?: string | null;
  context?: Record<string, unknown>;
}): void {
  try {
    if (params.event === 'catalog_viewed' && isCatalogViewThrottled(params.tenantId, params.buyerId, Date.now())) return;
    const correlation = params.request ? postHogCorrelationFromRequest(params.request) : null;
    const browserDistinctId = correlation?.browser_distinct_id ?? null;
    const ph = getPostHogClient();
    ph.capture({
      distinctId: browserDistinctId ?? params.buyerId,
      event: params.event,
      properties: {
        ...(params.context ?? {}),
        tenant_id: params.tenantId,
        buyer_id: params.buyerId,
        role: params.role ?? null,
        path: params.path ?? null,
        source: 'server',
        source_channel: 'storefront',
        buyer_distinct_id: params.buyerId,
        posthog_distinct_id: browserDistinctId,
        posthog_session_id: correlation?.posthog_session_id ?? null,
        ...(browserDistinctId ? {} : { $process_person_profile: false }),
      },
    });
    void ph.flush().catch(() => {});
  } catch {
    // non-blocking
  }
}
