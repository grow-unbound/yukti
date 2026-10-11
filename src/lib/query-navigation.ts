// Default tier — also the QueryClientProvider global default. Use for seller-side
// transactional/dynamic data (estimates, orders, invoices, dashboard, customers):
// changes often enough that a long cache would show stale numbers, but still benefits
// from surviving a quick back/forward nav.
export const NAVIGATION_QUERY_STALE_TIME = 5 * 60 * 1000;
export const NAVIGATION_QUERY_GC_TIME = 30 * 60 * 1000;

// Reference/config tier — seller-side static-ish data (brands, catalogs, cohorts,
// price lists, warehouses, locations, categories, buyer-app settings): edited rarely,
// safe to cache long. Use explicitly instead of relying on the transactional default.
export const REFERENCE_QUERY_STALE_TIME = 20 * 60 * 1000;
export const REFERENCE_QUERY_GC_TIME = 60 * 60 * 1000;

// Buyer PWA default tier — buyer-side dynamic data (orders, invoices, estimates,
// activity): kept short since buyers expect near-real-time status on their own docs.
export const BUYER_QUERY_STALE_TIME = 30_000;
export const BUYER_QUERY_GC_TIME = 2 * 60_000;

// Buyer PWA reference tier — non-priced data that changes rarely within a session:
// categories, brands, catalogs list, buyer profile/policy, home promotions,
// home reco rails (product identity; rails refresh weekly). Prefer this over
// BUYER_QUERY_* so tab hops stay instant (gcTime keeps cache warm).
// Home KPI metrics stay on BUYER_QUERY_* — same cadence as recent activity,
// since new docs/payments can move those totals.
export const BUYER_REFERENCE_QUERY_STALE_TIME = 15 * 60 * 1000;
export const BUYER_REFERENCE_QUERY_GC_TIME = 60 * 60 * 1000;

// Buyer PWA price tier — any response whose primary job is per-item selling price
// (catalog grid/search/product-detail, cart bundles, resolved cart items):
// distributors edit prices through the day, so this stays the shortest TTL.
// Pair with BUYER_CACHE_PRICED on the API route (buyer-cache-headers.ts).
// Home reco embeds prices but uses REFERENCE client cache for rail UX; pull-to-
// refresh and post-stale refetch still revalidate via BUYER_CACHE_PRICED HTTP.
export const BUYER_PRICE_QUERY_STALE_TIME = 15_000;
export const BUYER_PRICE_QUERY_GC_TIME = 60_000;

// Product detail page (PDP) tier — product / family detail and "more in this
// category" recos. Price edits are infrequent and the cart re-resolves every
// line price on open (useBuyerResolvedProducts stays on BUYER_PRICE_*), so a
// PDP revisit within this window reuses the cached payload instead of paying
// two priced origin calls again. Do not use for cart or list surfaces.
export const BUYER_PDP_QUERY_STALE_TIME = 5 * 60_000;
export const BUYER_PDP_QUERY_GC_TIME = 10 * 60_000;
