'use client';

import * as React from 'react';
import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { BuyerCatalogDesktopLayout } from '@/components/buyer/catalog/BuyerCatalogDesktopLayout';
import { usePostHog } from 'posthog-js/react';
import { BuyerDetailShell } from '@/components/buyer/layout/BuyerDetailShell';
import { BuyerEntityChipNav } from '@/components/buyer/catalog/BuyerEntityChipNav';
import { CampaignSummaryBlock, CampaignTitleRow } from '@/components/buyer/catalog/CampaignSummaryBlock';
import { CatalogRailSkeleton } from '@/components/buyer/catalog/CatalogBrowseDetailLoading';
import { CatalogSearchState } from '@/components/buyer/catalog/CatalogSearchState';
import { ProductGrid } from '@/components/buyer/catalog/ProductGrid';
import { RecoSection } from '@/components/buyer/catalog/RecoSection';
import { BuyerCatalogSearchInput } from '@/components/buyer/layout/BuyerCatalogSearchInput';
import { ErrorState } from '@/components/ui/empty-state';
import { useBuyerRealtimeContext } from '@/contexts/BuyerRealtimeContext';
import { useDebounce } from '@/hooks/useDebounce';
import { getSentinelInsertIndex, useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { setBuyerRailPathname } from '@/hooks/useBuyerRailPathnameOverride';
import { STOREFRONT } from '@/lib/storefront-paths';
import {
  useBuyerBrands,
  useBuyerCatalogList,
  useBuyerCategories,
} from '@/hooks/useBuyerProducts';
import { useBuyerBrandRecos, useBuyerCategoryRecos } from '@/hooks/useBuyerCategoryRecos';
import { useCart } from '@/contexts/BuyerCartContext';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import {
  BUYER_INFINITE_SCROLL_RATIO,
  dedupeBuyerCatalogItems,
  guestPriceReveal,
} from '@/lib/buyer-ui';
import { cn } from '@/lib/utils';
import { normalizeBuyerSearchQuery, useBuyerAnalyticsProperties } from '@/lib/buyer-analytics';
import type { BuyerBrand, BuyerCatalogResponse, BuyerCategory } from '@/types/buyer';

export type CatalogFilteredMode = 'category' | 'brand' | 'list';

interface CatalogFilteredBrowseProps {
  mode: CatalogFilteredMode;
  id: string;
  /** SSR-seeded first page (authenticated buyers only) — see loadInitialCatalogListData. */
  initialCatalogPage?: BuyerCatalogResponse | null;
  initialBrands?: BuyerBrand[];
  initialCategories?: BuyerCategory[];
}

export function CatalogFilteredBrowse({
  mode,
  id,
  initialCatalogPage,
  initialBrands,
  initialCategories,
}: CatalogFilteredBrowseProps): React.ReactNode {
  const posthog = usePostHog();
  const buyerAnalytics = useBuyerAnalyticsProperties();
  const { data: me } = useBuyerMe();
  const isGuest = me?.mode !== 'buyer' && me?.mode !== 'preview';
  const { setCampaignId } = useCart();
  const { setRefreshFn } = useBuyerRealtimeContext();
  const [campaignTitle, setCampaignTitle] = React.useState('Catalog');
  const [campaignImageUrl, setCampaignImageUrl] = React.useState<string | null>(null);
  const [campaignTitleResolved, setCampaignTitleResolved] = React.useState(false);
  const [retryNonce, setRetryNonce] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [activeId, setActiveId] = React.useState(id);
  const [resolvedGridId, setResolvedGridId] = React.useState(id);
  const debouncedSearch = useDebounce(search, 300);
  const searchEventKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setActiveId(id);
    setResolvedGridId(id);
    setBuyerRailPathname(null);
    return () => setBuyerRailPathname(null);
  }, [id]);

  const {
    data: categories,
    isLoading: categoriesLoading,
    refetch: refetchCategories,
  } = useBuyerCategories(initialCategories);
  const {
    data: brands,
    isLoading: brandsLoading,
    refetch: refetchBrands,
  } = useBuyerBrands(initialBrands);

  const {
    data: categoryRecos,
    isLoading: categoryRecosLoading,
    refetch: refetchCategoryRecos,
  } = useBuyerCategoryRecos(mode === 'category' ? activeId : '');
  const {
    data: brandRecos,
    isLoading: brandRecosLoading,
    refetch: refetchBrandRecos,
  } = useBuyerBrandRecos(mode === 'brand' ? activeId : '');

  // initialData re-seeds ANY new queryKey miss, not just the key it was
  // fetched for — TanStack Query applies it whenever the current queryKey
  // has no cache entry, regardless of which key the data actually belongs
  // to. initialCatalogPage is SSR data for this page's own `id`/empty
  // search only; once the rail nav switches activeId (no real navigation,
  // `id` prop never changes) or the user types a search, the queryKey
  // changes but the stale initialCatalogPage would otherwise get reapplied
  // as if it were fresh data for the new key — exactly the bug where
  // switching category/brand silently kept showing the original list.
  const isInitialDataStillValid = activeId === id && !debouncedSearch.trim();
  const listQuery = useBuyerCatalogList(
    mode,
    activeId,
    debouncedSearch,
    isInitialDataStillValid ? initialCatalogPage : undefined,
  );
  const pages = listQuery.data?.pages ?? [];
  const items = React.useMemo(() => dedupeBuyerCatalogItems(pages.flatMap((page) => page.items ?? [])), [pages]);
  const hasMore = pages.at(-1)?.has_more ?? false;
  const isSwitchingEntity = mode !== 'list' && activeId !== resolvedGridId;
  // Cold-cache only, plus detail-rail switches where we want the grid to show an explicit refresh state.
  const showProductsSkeleton = (listQuery.isLoading && items.length === 0) || (isSwitchingEntity && listQuery.isFetching);
  const productsError = listQuery.isError && items.length === 0;
  const loadingMore = listQuery.isFetchingNextPage;

  React.useEffect(() => {
    if (listQuery.isFetching) return;
    setResolvedGridId(activeId);
  }, [activeId, listQuery.isFetching]);

  const showCategoryRecosSkeleton = mode === 'category' && categoryRecosLoading && categoryRecos === undefined;
  const showBrandRecosSkeleton = mode === 'brand' && brandRecosLoading && brandRecos === undefined;
  const showChipsSkeleton =
    (mode === 'category' && categoriesLoading && categories === undefined)
    || (mode === 'brand' && brandsLoading && brands === undefined);

  const sentinelIndex = getSentinelInsertIndex(items.length, BUYER_INFINITE_SCROLL_RATIO);
  const { sentinelRef } = useInfiniteScroll({
    hasMore,
    isLoading: loadingMore,
    onLoadMore: () => { void listQuery.fetchNextPage(); },
  });

  const firstPage = pages[0];
  // Prefer the catalog list response's own (same-request-fresh) pricing_mode —
  // it's read from the identical live catalog config that decides SKU-vs-family
  // grouping server-side. me.guest_pricing_mode is a 15-min-stale reference
  // query and would drift out of sync with grouping whenever a seller changes
  // catalog settings; only fall back to it before the catalog list has loaded.
  const priceReveal = isGuest
    ? guestPriceReveal(firstPage ? firstPage.pricing_mode : me?.guest_pricing_mode)
    : undefined;
  const campaignMessage = mode === 'list' ? (firstPage?.selected_campaign_message ?? null) : null;
  const campaignValidUntil = mode === 'list' ? (firstPage?.selected_campaign_valid_until ?? null) : null;

  // Bind cart attribution to the campaign route id immediately — don't wait for catalog API.
  React.useEffect(() => {
    if (mode === 'list' && id) {
      setCampaignId(id);
    }
  }, [mode, id, setCampaignId]);

  React.useEffect(() => {
    if (mode !== 'list' || campaignTitleResolved) return;
    const page = pages[0];
    if (!page?.selected_campaign_name) return;
    setCampaignTitle(page.selected_campaign_name);
    setCampaignImageUrl(page.selected_campaign_image_url ?? null);
    setCampaignTitleResolved(true);
    if (page.selected_campaign_id) {
      setCampaignId(page.selected_campaign_id);
    }
  }, [mode, pages, campaignTitleResolved, setCampaignId]);

  React.useEffect(() => {
    if (mode !== 'list') return;
    setCampaignTitle('Catalog');
    setCampaignImageUrl(null);
    setCampaignTitleResolved(false);
  }, [mode, id, retryNonce]);

  React.useEffect(() => {
    setRefreshFn(async () => {
      const tasks: Array<Promise<unknown>> = [listQuery.refetch()];
      if (mode === 'category') {
        tasks.push(refetchCategories(), refetchCategoryRecos());
      } else if (mode === 'brand') {
        tasks.push(refetchBrands(), refetchBrandRecos());
      }
      await Promise.all(tasks);
    });
    return () => setRefreshFn(null);
  }, [
    listQuery.refetch,
    mode,
    refetchBrandRecos,
    refetchBrands,
    refetchCategories,
    refetchCategoryRecos,
    setRefreshFn,
  ]);

  React.useEffect(() => {
    if (!posthog || debouncedSearch.length === 0 || listQuery.isFetching) return;
    const key = `${mode}:${activeId}:${debouncedSearch}:${items.length}:${listQuery.isError ? 'error' : 'ok'}`;
    if (searchEventKeyRef.current === key) return;
    searchEventKeyRef.current = key;
    const normalized = normalizeBuyerSearchQuery(debouncedSearch);
    posthog.capture('buyer_catalog_search_results_viewed', {
      ...buyerAnalytics('catalog_filtered_browse'),
      source_surface: 'catalog_filtered_browse',
      browse_mode: mode,
      entity_id: activeId,
      ...normalized,
      query_length: debouncedSearch.length,
      result_count: items.length,
      result_product_ids: items.slice(0, 20).map((item) => item.tenant_product_id),
      result_product_count: items.length,
      has_more: hasMore,
      status: listQuery.isError ? 'error' : 'success',
    });
  }, [activeId, buyerAnalytics, debouncedSearch, hasMore, items, listQuery.isError, listQuery.isFetching, mode, posthog]);

  const selectedCategoryName = categories?.find((c) => c.id === activeId)?.name;
  const selectedBrandName = brands?.find((b) => b.id === activeId)?.name;
  const title =
    mode === 'category'
      ? (selectedCategoryName ?? 'Category')
      : mode === 'brand'
        ? (selectedBrandName ?? 'Brand')
        : campaignTitle;

  // Server page title is static; reflect the resolved category/brand name (tracks rail switches too).
  const resolvedBrowseName = mode === 'category' ? selectedCategoryName : mode === 'brand' ? selectedBrandName : undefined;
  React.useEffect(() => {
    if (resolvedBrowseName) document.title = resolvedBrowseName;
  }, [resolvedBrowseName]);

  const searchPlaceholder =
    mode === 'brand'
      ? `Search ${selectedBrandName ?? 'brand'} products`
      : mode === 'category'
        ? `Search products in ${selectedCategoryName ?? 'this category'}`
      : 'Search products in this campaign';

  const handleRailSelect = React.useCallback((nextId: string) => {
    setActiveId(nextId);
    if (typeof window === 'undefined') return;

    const nextPath =
      mode === 'category'
        ? STOREFRONT.category(nextId)
        : STOREFRONT.brand(nextId);
    window.history.replaceState(window.history.state, '', nextPath);
    setBuyerRailPathname(nextPath);
  }, [mode]);

  const desktopRail =
    mode === 'category' ? (
      showChipsSkeleton ? (
        <CatalogRailSkeleton />
      ) : (categories?.length ?? 0) > 0 ? (
        <BuyerEntityChipNav
          kind="category"
          categories={categories ?? []}
          selectedId={activeId}
          mode="detail"
          variant="rail"
          onSelectId={handleRailSelect}
        />
      ) : null
    ) : mode === 'brand' ? (
      showChipsSkeleton ? (
        <CatalogRailSkeleton />
      ) : (brands?.length ?? 0) > 0 ? (
        <BuyerEntityChipNav
          kind="brand"
          brands={brands ?? []}
          selectedId={activeId}
          mode="detail"
          variant="rail"
          onSelectId={handleRailSelect}
        />
      ) : null
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <BuyerDetailShell
        title={title}
        hideDesktopHeader
        backFallbackHref={STOREFRONT.home}
        headerSearch={
          <BuyerCatalogSearchInput
            value={search}
            onChange={setSearch}
            placeholder={searchPlaceholder}
          />
        }
      >
        <BuyerCatalogDesktopLayout rail={desktopRail} splitScroll>
          <div className="hidden px-2 pt-5 md:block lg:px-2 lg:pt-6">
            {mode !== 'list' ? (
              <h1
                className="mb-3 truncate font-semibold text-[var(--fg-1)]"
                style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--b-text-page-sm)', letterSpacing: '-0.01em' }}
              >
                {title}
              </h1>
            ) : (
              <CampaignTitleRow name={title} imageUrl={campaignImageUrl} />
            )}
            {mode === 'list' ? (
              <CampaignSummaryBlock message={campaignMessage} validUntil={campaignValidUntil} />
            ) : null}
            <div className={cn('flex items-center gap-3', mode === 'list' ? 'mt-4' : '')}>
              <BuyerCatalogSearchInput
                value={search}
                onChange={setSearch}
                placeholder={searchPlaceholder}
                className="max-w-[34rem]"
              />
            </div>
          </div>

          {mode === 'list' ? (
            <div className="md:hidden">
              <CampaignSummaryBlock message={campaignMessage} validUntil={campaignValidUntil} />
            </div>
          ) : null}

          {mode === 'category' && !debouncedSearch && (showCategoryRecosSkeleton || (categoryRecos?.length ?? 0) > 0) ? (
            <div className="pt-1 lg:pt-6">
              <RecoSection
                title="Trending in this category"
                widget="w5_category_trending"
                items={categoryRecos ?? []}
                isLoading={showCategoryRecosSkeleton}
                priceReveal={priceReveal}
              />
            </div>
          ) : null}

          {mode === 'brand' && !debouncedSearch && (showBrandRecosSkeleton || (brandRecos?.length ?? 0) > 0) ? (
            <div className="pt-1 lg:pt-6">
              <RecoSection
                title="Trending in this brand"
                widget="w6_brand_trending"
                items={brandRecos ?? []}
                isLoading={showBrandRecosSkeleton}
                priceReveal={priceReveal}
              />
            </div>
          ) : null}

          {productsError ? (
            <div className="p-4">
              <ErrorState
                heading="Couldn't load products"
                description="Check your connection and try again."
                onRetry={() => {
                  setRetryNonce((n) => n + 1);
                  void listQuery.refetch();
                }}
              />
            </div>
          ) : (
            <>
              {showProductsSkeleton || items.length > 0 ? (
                <div className="px-4 pb-3 pt-4 lg:px-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--fg-3)]">
                    Browse
                  </p>
                  <h2
                    className="mt-1 text-base font-semibold text-[var(--fg-1)]"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    All Products
                  </h2>
                </div>
              ) : null}

              <ProductGrid
                items={items}
                loading={showProductsSkeleton}
                loadingMore={loadingMore}
                sentinelIndex={sentinelIndex}
                sentinelRef={sentinelRef}
                showPromotionBadge={mode !== 'list'}
                priceReveal={priceReveal}
              />

              {!showProductsSkeleton && items.length === 0 ? (
                <NoProductsFoundState />
              ) : null}
            </>
          )}
        </BuyerCatalogDesktopLayout>
      </BuyerDetailShell>
    </div>
  );
}

function NoProductsFoundState(): React.ReactNode {
  return (
    <CatalogSearchState
      icon={<SearchX className="h-5 w-5" />}
      title="No products found"
      description="Try a different search or switch filters to explore more products."
      action={(
        <Link
          href={STOREFRONT.home}
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--teal-500)] px-5 py-2.5 text-sm font-semibold text-[var(--teal-500)] transition-colors hover:bg-[var(--teal-500)] hover:text-white"
        >
          Browse Catalog
        </Link>
      )}
    />
  );
}
