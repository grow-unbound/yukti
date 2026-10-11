'use client';

import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { apiFetch, apiPost, type ApiFetchInit } from '@/lib/api-fetch';
import { useBuyerDeliveryOptional } from '@/contexts/BuyerDeliveryContext';
import type { BuyerDeliveryLocation } from '@/lib/buyer-delivery-location';
import type {
  BuyerBrand,
  BuyerCatalogItem,
  BuyerCatalogResponse,
  BuyerCatalogSummary,
  BuyerCategory,
  BuyerProductFamilyDetail,
  BuyerResolvedProductsResponse,
} from '@/types/buyer';
import type { BuyerProductPageRecos } from '@/lib/buyer-home-types';
import {
  BUYER_REFERENCE_QUERY_STALE_TIME,
  BUYER_REFERENCE_QUERY_GC_TIME,
  BUYER_PRICE_QUERY_STALE_TIME,
  BUYER_PRICE_QUERY_GC_TIME,
  BUYER_PDP_QUERY_STALE_TIME,
  BUYER_PDP_QUERY_GC_TIME,
} from '@/lib/query-navigation';

export type BuyerProductDetailApiResponse = { item: BuyerCatalogItem };
export type BuyerProductFamilyDetailApiResponse = BuyerProductFamilyDetail;

export const EMPTY_RECOS: BuyerProductPageRecos = { co_order: [], co_buyer: [], same_category: [] };

export function buyerProductDetailQueryKey(tenantProductId: string, stockSignature: string) {
  return ['buyer-product-detail', tenantProductId, stockSignature] as const;
}

export function buyerProductRecommendationsQueryKey(tenantProductId: string) {
  return ['buyer-product-recommendations', tenantProductId] as const;
}

export function buyerProductFamilyDetailQueryKey(productFamilyId: string, stockSignature: string) {
  return ['buyer-product-family-detail', productFamilyId, stockSignature] as const;
}

export function buyerProductDetailUrl(tenantProductId: string): string {
  return `/api/buyer/products/${encodeURIComponent(tenantProductId)}`;
}

export function buyerProductFamilyDetailUrl(productFamilyId: string): string {
  return `/api/buyer/product-families/${encodeURIComponent(productFamilyId)}`;
}

export function buyerProductRecommendationsUrl(tenantProductId: string): string {
  return `/api/buyer/recommendations?product_id=${encodeURIComponent(tenantProductId)}`;
}

/**
 * Warm the PDP detail query on pointerdown — shared by ProductCard / search. Recommendations are
 * deliberately not prefetched: they load when the rail nears the viewport (useInViewOnce), so a
 * tap that never scrolls to them costs no reco RPC + 8-product pricing pass.
 */
export function prefetchBuyerProductDetail(
  queryClient: QueryClient,
  tenantProductId: string,
  stockSignature: string,
): void {
  void queryClient.prefetchQuery({
    queryKey: buyerProductDetailQueryKey(tenantProductId, stockSignature),
    queryFn: async () =>
      fetchJson<BuyerProductDetailApiResponse>(buyerProductDetailUrl(tenantProductId), { fresh: true }),
    staleTime: BUYER_PDP_QUERY_STALE_TIME,
    gcTime: BUYER_PDP_QUERY_GC_TIME,
  });
}

type FilterMode = 'category' | 'brand' | 'list';

const PAGE_SIZE = 40;

const BUYER_CATEGORIES_KEY = ['buyer-categories'] as const;
const BUYER_BRANDS_KEY = ['buyer-brands'] as const;
const BUYER_CATALOGS_KEY = ['buyer-catalogs'] as const;

export function buyerDeliveryStockSignature(selected: BuyerDeliveryLocation | null | undefined): string {
  if (!selected) return 'no-delivery';
  return [
    selected.nearest_warehouse_id ?? 'no-warehouse',
    selected.routed_location_id ?? 'no-location',
    selected.place_id,
    selected.lat,
    selected.lng,
  ].join(':');
}

async function fetchJson<T>(url: string, init?: ApiFetchInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (response.status === 429) throw new Error("You're browsing very quickly. Please wait a moment and try again.");
  if (!response.ok) throw new Error(`Request failed: ${url}`);
  return response.json() as Promise<T>;
}

export function useBuyerCategories(initialData?: BuyerCategory[]) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  return useQuery<BuyerCategory[]>({
    queryKey: [...BUYER_CATEGORIES_KEY, stockSignature],
    queryFn: async () => {
      const body = await fetchJson<{ categories?: BuyerCategory[] }>('/api/buyer/categories');
      return body.categories ?? [];
    },
    staleTime: BUYER_REFERENCE_QUERY_STALE_TIME,
    gcTime: BUYER_REFERENCE_QUERY_GC_TIME,
    initialData,
  });
}

export function useBuyerBrands(initialData?: BuyerBrand[]) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  return useQuery<BuyerBrand[]>({
    queryKey: [...BUYER_BRANDS_KEY, stockSignature],
    queryFn: async () => {
      const body = await fetchJson<{ brands?: BuyerBrand[] }>('/api/buyer/brands');
      return body.brands ?? [];
    },
    staleTime: BUYER_REFERENCE_QUERY_STALE_TIME,
    gcTime: BUYER_REFERENCE_QUERY_GC_TIME,
    initialData,
  });
}

export function useBuyerCatalogs() {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  return useQuery<BuyerCatalogSummary[]>({
    queryKey: [...BUYER_CATALOGS_KEY, stockSignature],
    queryFn: async () => {
      const body = await fetchJson<{ catalogs?: BuyerCatalogSummary[] }>('/api/buyer/catalogs');
      return body.catalogs ?? [];
    },
    staleTime: BUYER_REFERENCE_QUERY_STALE_TIME,
    gcTime: BUYER_REFERENCE_QUERY_GC_TIME,
  });
}

export interface BuyerCatalogSearchFilters {
  categoryId?: string;
  brandId?: string;
  campaignId?: string;
}

export function useBuyerCatalogSearchInfinite(
  search: string,
  filters: BuyerCatalogSearchFilters = {},
  enabled = true,
  options: { allowEmpty?: boolean } = {},
) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  const trimmedSearch = search.trim();
  const categoryId = filters.categoryId?.trim() ?? '';
  const brandId = filters.brandId?.trim() ?? '';
  const campaignId = filters.campaignId?.trim() ?? '';
  const allowEmpty = options.allowEmpty === true;

  return useInfiniteQuery<BuyerCatalogResponse>({
    queryKey: [
      'buyer-catalog-search',
      trimmedSearch,
      categoryId,
      brandId,
      campaignId,
      stockSignature,
      allowEmpty ? 'browse' : 'search',
    ],
    enabled: enabled && (allowEmpty || trimmedSearch.length > 0),
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(pageParam),
      });
      if (trimmedSearch) params.set('search', trimmedSearch);
      if (categoryId) params.set('category_id', categoryId);
      if (brandId) params.set('brand_id', brandId);
      if (campaignId) params.set('campaign_id', campaignId);
      return fetchJson<BuyerCatalogResponse>(`/api/buyer/catalog?${params.toString()}`, { fresh: true });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage.has_more) return undefined;
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded;
    },
    placeholderData: keepPreviousData,
    staleTime: BUYER_PRICE_QUERY_STALE_TIME,
    gcTime: BUYER_PRICE_QUERY_GC_TIME,
  });
}

/**
 * `initialCatalogPage` is a server-resolved first page (SSR-seeded from
 * app/(buyer)/buy/home/{category,brand,list}/[id]/page.tsx via
 * loadInitialCatalogListData) — only ever meaningful on first mount for the
 * `id`/mode this hook was called with, matching how `activeId`/`search`
 * start equal to the page's own `id`/`''` in CatalogFilteredBrowse. Once the
 * user switches entity or types a search, the queryKey changes and this
 * seed is irrelevant (React Query only consults `initialData` on a cache
 * miss for a given key, never for key transitions).
 */
export function useBuyerCatalogList(
  mode: FilterMode,
  id: string,
  search = '',
  initialCatalogPage?: BuyerCatalogResponse | null,
) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  const trimmedSearch = search.trim();
  return useInfiniteQuery<BuyerCatalogResponse, Error, InfiniteData<BuyerCatalogResponse>, readonly unknown[], number>({
    queryKey: ['buyer-catalog-list', mode, id, trimmedSearch, stockSignature],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(pageParam),
      });
      if (mode === 'category') params.set('category_id', id);
      if (mode === 'brand') params.set('brand_id', id);
      if (mode === 'list') params.set('campaign_id', id);
      if (trimmedSearch) params.set('search', trimmedSearch);
      return fetchJson<BuyerCatalogResponse>(`/api/buyer/catalog?${params.toString()}`, { fresh: true });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage.has_more) return undefined;
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded;
    },
    placeholderData: keepPreviousData,
    staleTime: BUYER_PRICE_QUERY_STALE_TIME,
    gcTime: BUYER_PRICE_QUERY_GC_TIME,
    initialData: initialCatalogPage
      ? { pages: [initialCatalogPage], pageParams: [0] }
      : undefined,
  });
}

/** Campaign name for `/buy/home/list/[id]` breadcrumb. */
export function useBuyerCampaignName(id: string) {
  return useQuery<string | undefined>({
    queryKey: ['buyer-catalog-list-name', id],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '20', offset: '0', campaign_id: id });
      const body = await fetchJson<BuyerCatalogResponse>(`/api/buyer/catalog?${params.toString()}`);
      return body.selected_campaign_name ?? undefined;
    },
    enabled: Boolean(id),
    staleTime: BUYER_PRICE_QUERY_STALE_TIME,
    gcTime: BUYER_PRICE_QUERY_GC_TIME,
  });
}

/** Campaign name for the share_token guest breadcrumb. */
export function useBuyerCampaignShareName(shareToken: string) {
  return useQuery<string | undefined>({
    queryKey: ['buyer-catalog-share-token-meta', shareToken],
    queryFn: async () => {
      const body = await fetchJson<{ name?: string }>(`/api/buyer/catalog/${encodeURIComponent(shareToken)}`);
      return body.name ?? undefined;
    },
    enabled: Boolean(shareToken),
    staleTime: BUYER_PRICE_QUERY_STALE_TIME,
    gcTime: BUYER_PRICE_QUERY_GC_TIME,
  });
}

/** `enabled: false` defers the fetch (e.g. until the rail is near the viewport). */
export function useBuyerProductRecommendations(
  tenantProductId: string,
  options?: { enabled?: boolean },
) {
  return useQuery<BuyerProductPageRecos>({
    queryKey: buyerProductRecommendationsQueryKey(tenantProductId),
    queryFn: async () =>
      fetchJson<BuyerProductPageRecos>(buyerProductRecommendationsUrl(tenantProductId)),
    enabled: Boolean(tenantProductId) && (options?.enabled ?? true),
    staleTime: BUYER_PDP_QUERY_STALE_TIME,
    gcTime: BUYER_PDP_QUERY_GC_TIME,
  });
}

export function useBuyerProductDetail(tenantProductId: string) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  const productQuery = useQuery<BuyerProductDetailApiResponse>({
    queryKey: buyerProductDetailQueryKey(tenantProductId, stockSignature),
    queryFn: async () =>
      fetchJson<BuyerProductDetailApiResponse>(buyerProductDetailUrl(tenantProductId), { fresh: true }),
    enabled: Boolean(tenantProductId),
    staleTime: BUYER_PDP_QUERY_STALE_TIME,
    gcTime: BUYER_PDP_QUERY_GC_TIME,
  });

  const item = productQuery.data?.item ?? null;

  return {
    item,
    isLoading: productQuery.isLoading,
    isError: productQuery.isError || (!productQuery.isLoading && !item),
  };
}

export function useBuyerProductFamilyDetail(productFamilyId: string) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  const familyQuery = useQuery<BuyerProductFamilyDetailApiResponse>({
    queryKey: buyerProductFamilyDetailQueryKey(productFamilyId, stockSignature),
    queryFn: async () =>
      fetchJson<BuyerProductFamilyDetailApiResponse>(buyerProductFamilyDetailUrl(productFamilyId), { fresh: true }),
    enabled: Boolean(productFamilyId),
    staleTime: BUYER_PDP_QUERY_STALE_TIME,
    gcTime: BUYER_PDP_QUERY_GC_TIME,
  });

  return {
    detail: familyQuery.data ?? null,
    family: familyQuery.data?.family ?? null,
    isLoading: familyQuery.isLoading,
    isError: familyQuery.isError || (!familyQuery.isLoading && !familyQuery.data),
  };
}

export function useBuyerResolvedProducts(
  items: Array<{ tenant_product_id: string; qty: number }>,
) {
  const delivery = useBuyerDeliveryOptional();
  const stockSignature = buyerDeliveryStockSignature(delivery?.selected);
  return useQuery<BuyerResolvedProductsResponse>({
    queryKey: [
      'buyer-resolved-products',
      items.map((item) => `${item.tenant_product_id}:${item.qty}`).join('|'),
      stockSignature,
    ],
    enabled: items.length > 0,
    queryFn: async () => {
      const response = await apiPost('/api/buyer/products/resolve', { items });
      if (!response.ok) throw new Error('Failed to resolve buyer products');
      return response.json() as Promise<BuyerResolvedProductsResponse>;
    },
    // Cart/checkout price resolution — shortest tier, refetch on every remount.
    // keepPreviousData renders the last-known resolved items instantly (cart
    // opens with no blank/loading gap) while the revalidation above still
    // runs in the background and patches in fresh price/stock the moment it
    // lands — staleTime stays 0 so a distributor's price edit is never held
    // back by a cache, only the paint is no longer blocked on the network.
    staleTime: 0,
    gcTime: BUYER_PRICE_QUERY_GC_TIME,
    placeholderData: keepPreviousData,
  });
}
