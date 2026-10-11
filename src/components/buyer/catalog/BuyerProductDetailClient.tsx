'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Minus, Package, Plus } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { cn, formatNumberInput, formatNumberValue, parseNumberInput } from '@/lib/utils';
import { navigateBuyerBack } from '@/hooks/useBuyerNavigationDirection';
import { useCart } from '@/contexts/BuyerCartContext';
import { useStorefrontLogin } from '@/contexts/StorefrontLoginContext';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { RecoSection } from '@/components/buyer/catalog/RecoSection';
import { BuyerDetailShell } from '@/components/buyer/layout/BuyerDetailShell';
import { BuyerFixedFooter } from '@/components/buyer/layout/BuyerFixedFooter';
import { BUYER_PREVIEW_MAX_WIDTH } from '@/lib/buyer-preview';
import { BUYER_CARD_RADIUS_CLASS, getBuyerProductPrimaryImageUrl, guestPriceReveal, hasBuyerCampaignPrice, hasVisibleBuyerPrice, isHiddenPriceEnquiryMode } from '@/lib/buyer-ui';
import {
  EMPTY_RECOS,
  useBuyerProductDetail,
  useBuyerProductRecommendations,
} from '@/hooks/useBuyerProducts';
import { useInViewOnce } from '@/hooks/useInViewOnce';
import { useBuyerAnalyticsIds } from '@/lib/analytics-identity';
import { useBuyerAnalyticsProperties } from '@/lib/buyer-analytics';

interface BuyerProductDetailClientProps {
  tenantProductId: string;
}

export function BuyerProductDetailClient({ tenantProductId }: BuyerProductDetailClientProps): React.ReactNode {
  const router = useRouter();
  const posthog = usePostHog();
  const analyticsIds = useBuyerAnalyticsIds();
  const buyerAnalytics = useBuyerAnalyticsProperties();
  const { addItem, updateQty, items: cartItems, campaignId } = useCart();
  const { data: meData } = useBuyerMe();
  const { openLogin } = useStorefrontLogin();
  const isGuest = meData?.mode !== 'buyer' && meData?.mode !== 'preview';
  const stockVisible = meData?.stock_visibility?.enabled ?? false;
  const {
    item,
    isLoading: productLoading,
    isError: productError,
  } = useBuyerProductDetail(tenantProductId);
  // Recos (reco RPC + 8-product pricing pass) load only once the rail is near the viewport.
  const [recoRailRef, recoRailNear] = useInViewOnce();
  const recosQuery = useBuyerProductRecommendations(tenantProductId, { enabled: recoRailNear });
  const recos = recosQuery.data ?? EMPTY_RECOS;
  const isRecosLoading = recosQuery.isPending;
  // Prefer the product's own same-request-fresh catalog_pricing_mode over
  // meData.guest_pricing_mode, which is a 15-min-stale reference query and
  // can drift out of sync with the catalog's actual current pricing mode.
  // Fall back to /me only before the product has loaded.
  const priceReveal = isGuest
    ? guestPriceReveal(item ? item.catalog_pricing_mode : meData?.guest_pricing_mode)
    : 'amount';
  const [imgError, setImgError] = React.useState(false);
  const [familyImgError, setFamilyImgError] = React.useState(false);
  const [categoryImgError, setCategoryImgError] = React.useState(false);
  const [brandImgError, setBrandImgError] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(true);
  const [targetMin, setTargetMin] = React.useState('');
  const [targetMax, setTargetMax] = React.useState('');
  const viewedKeyRef = React.useRef<string | null>(null);

  // The server page no longer looks the title up (a DB read per open); the detail payload carries it.
  React.useEffect(() => {
    if (item?.display_name) document.title = item.display_name;
  }, [item?.display_name]);

  React.useEffect(() => {
    if (!item || viewedKeyRef.current === item.tenant_product_id) return;
    viewedKeyRef.current = item.tenant_product_id;
    posthog?.capture('product_viewed', {
      ...buyerAnalytics('product_detail'),
      ...analyticsIds,
      tenant_product_id: item.tenant_product_id,
      brand_id: item.brand_id ?? null,
      category_id: item.category_id ?? null,
      internal_sku: item.internal_sku ?? null,
      brand: item.brand_name ?? null,
      has_campaign_price: item.has_campaign_price === true,
      campaign_id: item.campaign_id ?? null,
      stock_status: item.stock_status ?? null,
    });
  }, [item, posthog, analyticsIds, buyerAnalytics]);

  const cartLine = item ? cartItems.find((i) => i.tenant_product_id === item.tenant_product_id) : undefined;

  function handleBack(): void {
    navigateBuyerBack(router);
  }

  function handleAddToCart(): void {
    if (!item) return;
    const hiddenPriceEnquiry = isHiddenPriceEnquiryMode(item.catalog_pricing_mode);
    if (isGuest || (!hiddenPriceEnquiry && !hasVisibleBuyerPrice(item.price))) {
      openLogin();
      return;
    }
    addItem({
      tenant_product_id: item.tenant_product_id,
      name: item.display_name,
      brand: item.brand_name ?? undefined,
      internal_sku: item.internal_sku,
      image_url: getBuyerProductPrimaryImageUrl(item) ?? undefined,
      unit_price: hiddenPriceEnquiry ? null : (item.price ?? 0),
      resolved_price: item.resolved_price,
      has_campaign_price: item.has_campaign_price,
      gst_rate: item.gst_rate ?? null,
      unit: item.default_uom ?? undefined,
      quantity: 1,
      line_total: hiddenPriceEnquiry ? 0 : (item.price ?? 0),
      cart_mode: hiddenPriceEnquiry ? 'hidden_price_enquiry' : 'priced',
      collect_target_unit_price_range: item.collect_target_unit_price_range === true,
      buyer_target_unit_price_min: parseNumberInput(targetMin, 'CURRENCY_EXACT'),
      buyer_target_unit_price_max: parseNumberInput(targetMax, 'CURRENCY_EXACT'),
      tenant_category_id: item.category_id ?? undefined,
    }, item.campaign_id ?? campaignId, {
      source_surface: 'product_detail',
    });
    // Same event name/shape as the reco-widget add-to-cart captures
    // (ProductCard.tsx, CartGapWidget.tsx) so the existing "products added
    // to cart" PostHog endpoint picks this up too -- previously only the
    // two narrow recommendation-widget paths fired this event, so the main
    // add-to-cart flow (this one) was invisible to that dashboard card.
    posthog?.capture('reco_add_to_cart', {
      ...buyerAnalytics('product_detail'),
      ...analyticsIds,
      widget: 'product_detail',
      product_id: item.tenant_product_id,
      source_product_id: null,
    });
  }

  function handleDecrement(): void {
    if (!item || !cartLine) return;
    updateQty(item.tenant_product_id, cartLine.quantity - 1);
  }

  function handleIncrement(): void {
    if (!item || !cartLine) return;
    updateQty(item.tenant_product_id, cartLine.quantity + 1);
  }

  if (productError && !productLoading) {
    return (
      <div className="flex min-h-[50dvh] flex-col" style={{ background: 'var(--bg-base)' }}>
        <BuyerDetailShell title="Product" hideSearchOnDesktop>
          <div className="flex flex-col gap-4 px-3 py-8">
            <p className="text-sm" style={{ color: 'var(--fg-2)' }}>Product not found or unavailable.</p>
            <button
              type="button"
              onClick={handleBack}
              className="w-fit rounded-full border px-4 py-2 text-sm font-semibold"
              style={{ borderColor: 'var(--border-1)', color: 'var(--fg-2)' }}
            >
              Go back
            </button>
          </div>
        </BuyerDetailShell>
      </div>
    );
  }

  const showCampaignPrice = item ? hasBuyerCampaignPrice(item) : false;
  const hiddenPriceEnquiry = item ? isHiddenPriceEnquiryMode(item.catalog_pricing_mode) : false;
  const collectTargetRange = hiddenPriceEnquiry && item?.collect_target_unit_price_range === true;
  const metaParts = item ? [item.internal_sku, item.category_name].filter(Boolean) : [];
  const stockLabel = item
    ? item.stock_status === 'out_of_stock'
      ? '0 units'
      : item.on_hand > 0
        ? `${item.on_hand} units`
        : item.stock_status === 'limited'
          ? 'Limited'
          : 'Available'
    : '';
  const taxLabel = item ? (item.gst_rate != null ? `${item.gst_rate}% GST` : '—') : '';
  const productImage = item && !imgError && item.image_urls.length > 0
    ? (item.image_url_large ?? item.image_urls[0])
    : null;
  const familyImage = item && !productImage && !familyImgError && item.family_image_url
    ? item.family_image_url
    : null;
  const categoryImage = item && !productImage && !familyImage && !categoryImgError && item.category_image_url
    ? item.category_image_url
    : null;
  const brandLogo = item && !productImage && !familyImage && !categoryImage && !brandImgError && item.brand_logo_url
    ? item.brand_logo_url
    : null;
  const activeImage = productImage ?? familyImage ?? categoryImage ?? brandLogo;
  const showStockOverlay = stockVisible && (item?.stock_status === 'limited' || item?.stock_status === 'out_of_stock');
  const categoryRecoTitle = item?.category_name
    ? `More in ${item.category_name}`
    : 'More in this category';

  return (
    <div className="flex min-h-[50dvh] flex-col pb-[calc(8.5rem+env(safe-area-inset-bottom,0px))] md:pb-10" style={{ background: 'var(--bg-base)' }}>
      <BuyerDetailShell title="Product" hideDesktopHeader>
        {/* Hero — square, card-like padding, aligned to header px-3 */}
        <div className="px-3 pb-4 md:px-6 md:pb-6 md:pt-6">
          <div className="grid gap-5 md:grid-cols-[minmax(340px,0.95fr)_minmax(0,1.05fr)] md:items-start">
            <div className={cn('relative aspect-square w-full overflow-hidden border border-[var(--border-1)] bg-[var(--bg-surface)] md:sticky md:top-6', BUYER_CARD_RADIUS_CLASS)}>
            {productLoading ? (
              <div className="absolute inset-0 animate-pulse bg-cream-100" />
            ) : activeImage ? (
              <Image
                src={activeImage}
                alt={item?.display_name ?? 'Product'}
                fill
                className="object-contain p-3.5 md:p-5"
                sizes="(min-width: 768px) 42vw, 100vw"
                onError={() => {
                  if (productImage) setImgError(true);
                  else if (familyImage) setFamilyImgError(true);
                  else if (categoryImage) setCategoryImgError(true);
                  else setBrandImgError(true);
                }}
                unoptimized
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Package className="h-16 w-16" style={{ color: 'var(--fg-3)' }} />
              </div>
            )}
            {!productLoading && showStockOverlay && item ? (
              <ProductHeroStockLabel
                status={item.stock_status === 'limited' ? 'limited' : 'out_of_stock'}
              />
            ) : null}
            </div>

            <div className="min-w-0 space-y-4 md:space-y-5">
        <div className="space-y-1.5 py-4 md:rounded-[12px] md:border md:border-[var(--border-1)] md:bg-[var(--bg-surface)] md:px-5 md:py-5">
          {productLoading ? (
            <>
              <div className="h-3 w-16 animate-pulse rounded bg-cream-200" />
              <div className="min-h-[2.5rem] w-full animate-pulse rounded bg-cream-200" />
              <div className="h-4 w-40 animate-pulse rounded bg-cream-200" />
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <div className="h-7 w-24 animate-pulse rounded bg-cream-200" />
                <div className="h-4 w-16 animate-pulse rounded bg-cream-200" />
              </div>
              <div className="h-4 w-36 animate-pulse rounded bg-cream-200" />
            </>
          ) : item ? (
            <>
              {item.brand_name ? (
                <p
                  className="font-semibold uppercase tracking-wide"
                  style={{ fontSize: 'var(--b-text-eyebrow)', color: 'var(--fg-3)' }}
                >
                  {item.brand_name}
                </p>
              ) : null}
              <h2
                className="w-full font-semibold leading-snug [text-wrap:wrap]"
                style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--b-text-section)', color: 'var(--fg-1)' }}
              >
                {item.display_name}
              </h2>
              {metaParts.length > 0 ? (
                <p style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>
                  {metaParts.join(' · ')}
                </p>
              ) : null}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pt-1">
                {hiddenPriceEnquiry ? (
                  <div className="space-y-1">
                    <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                      Price on enquiry
                    </p>
                    <p style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>
                      Seller will respond after you send the enquiry.
                    </p>
                  </div>
                ) : item.price == null ? (
                  priceReveal === 'login_cta' ? (
                    <button
                      type="button"
                      onClick={openLogin}
                      className="inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-xs border border-cream-300 bg-[var(--bg-surface)] px-3 py-1.5 font-medium text-cream-600 transition-colors duration-fast [@media(hover:hover)]:hover:border-cream-400 [@media(hover:hover)]:hover:bg-[var(--bg-surface)] [@media(hover:hover)]:hover:text-cream-800"
                      style={{ fontSize: 'var(--b-text-label)' }}
                    >
                      Login for Price
                    </button>
                  ) : (
                    <span className="inline-block h-7 w-28 rounded-md bg-cream-300" aria-label="Price hidden" />
                  )
                ) : (
                  <p className="font-semibold" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--b-text-price-lg)', color: 'var(--fg-1)' }}>
                    {formatNumberValue(item.price, 'CURRENCY_EXACT')}
                  </p>
                )}
                {showCampaignPrice ? (
                  <span className="line-through text-[var(--fg-3)]" style={{ fontSize: 'var(--b-text-sub)' }}>
                    {formatNumberValue(item.resolved_price, 'CURRENCY_EXACT')}
                  </span>
                ) : null}
              </div>
              {item.has_campaign_price && item.campaign_valid_until ? (
                <p className="text-amber-700" style={{ fontSize: 'var(--b-text-sub)' }}>
                  Valid until{' '}
                  {new Date(item.campaign_valid_until).toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
              ) : null}

              {collectTargetRange ? (
                <div className="space-y-2 rounded-[10px] border border-[var(--border-1)] bg-[var(--bg-base)] p-3">
                  <div>
                    <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                      Target buying price per unit
                    </p>
                    <p style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>
                      Optional. This helps the seller prepare a suitable price.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span style={{ fontSize: 'var(--b-text-eyebrow)', color: 'var(--fg-3)' }}>Min target rate</span>
                      <CurrencyTargetRateInput value={targetMin} onChange={setTargetMin} placeholder="Min" />
                    </label>
                    <label className="space-y-1">
                      <span style={{ fontSize: 'var(--b-text-eyebrow)', color: 'var(--fg-3)' }}>Max target rate</span>
                      <CurrencyTargetRateInput value={targetMax} onChange={setTargetMax} placeholder="Max" />
                    </label>
                  </div>
                  {item.default_uom ? (
                    <p style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>Per {item.default_uom}</p>
                  ) : null}
                </div>
              ) : null}

              {/* Desktop-only CTA — replaces the mobile sticky footer */}
              <div className="hidden pt-2 md:block">
                {cartLine ? (
                  <div
                    className="flex min-h-11 w-fit items-center overflow-hidden rounded-[10px]"
                    style={{ background: 'var(--teal-500)' }}
                  >
                    <button
                      type="button"
                      className="flex h-11 w-11 items-center justify-center text-white"
                      aria-label="Decrease quantity"
                      onClick={handleDecrement}
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span
                      className="min-w-[2rem] text-center font-semibold text-white"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--b-text-sub)' }}
                    >
                      {cartLine.quantity}
                    </span>
                    <button
                      type="button"
                      className="flex h-11 w-11 items-center justify-center text-white"
                      aria-label="Increase quantity"
                      onClick={handleIncrement}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleAddToCart}
                    className="flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-5 font-semibold text-white"
                    style={{ background: 'var(--teal-500)', fontSize: 'var(--b-text-label)' }}
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    {hiddenPriceEnquiry ? 'Add to Enquiry' : 'Add to Cart'}
                  </button>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* Product Details accordion */}
        <div className="pb-4 md:pb-0">
          <div className="md:hidden">
            <button
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              className="flex w-full items-center justify-between py-2 text-left"
              aria-expanded={detailsOpen}
              disabled={productLoading}
            >
              <span className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                Product Details
              </span>
              {detailsOpen ? (
                <ChevronUp className="h-5 w-5 shrink-0" style={{ color: 'var(--fg-3)' }} />
              ) : (
                <ChevronDown className="h-5 w-5 shrink-0" style={{ color: 'var(--fg-3)' }} />
              )}
            </button>
          </div>
          {(detailsOpen || productLoading) ? (
            <div className={`overflow-hidden md:border md:border-[var(--border-1)] md:bg-[var(--bg-surface)] ${BUYER_CARD_RADIUS_CLASS}`}>
              <div className="border-b border-[var(--border-1)] px-4 py-2.5 md:px-5 md:py-3">
                <span className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                  Product Details
                </span>
              </div>
              {productLoading || !item ? (
                <>
                  <SpecRowSkeleton />
                  <SpecRowSkeleton />
                  <SpecRowSkeleton />
                  <SpecRowSkeleton />
                  <SpecRowSkeleton isLast />
                </>
              ) : (
                <>
                  <SpecRow label="SKU" value={item.internal_sku} mono />
                  {item.brand_name ? <SpecRow label="Brand" value={item.brand_name} /> : null}
                  {item.category_name ? <SpecRow label="Category" value={item.category_name} /> : null}
                  <SpecRow label="Tax" value={taxLabel} isLast={!stockVisible} />
                  {stockVisible ? <SpecRow label="Stock" value={stockLabel} isLast /> : null}
                </>
              )}
            </div>
          ) : null}
        </div>
            </div>
          </div>
        </div>

        {/* Reco rail — title + skeleton while loading; hide after settle if empty.
            "Frequently Bought Together" (co_order) was dropped to cut a reco widget
            off the PDP's data/compute path — see recommendations route. */}
        <div ref={recoRailRef}>
          <RecoSection
            title={categoryRecoTitle}
            widget="same_category"
            items={recos.same_category}
            sourceProductId={tenantProductId}
            isLoading={isRecosLoading}
            sectionClassName="px-3 pb-3"
            scrollClassName="gap-3 px-3"
            priceReveal={priceReveal}
          />
        </div>
      </BuyerDetailShell>

      {/* Sticky footer — price + Add / qty stepper (mobile only; desktop uses inline CTA above) */}
      <BuyerFixedFooter
        className="left-1/2 w-full -translate-x-1/2 px-3 py-3 md:hidden"
        style={{
          maxWidth: BUYER_PREVIEW_MAX_WIDTH,
          paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
          background: 'rgba(253,251,247,0.96)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderTop: '1px solid var(--border-1)',
        }}
      >
        <div className="flex items-center justify-between gap-4">
          {productLoading || !item ? (
            <>
              <div className="flex flex-col items-end gap-1">
                <div className="h-7 w-20 animate-pulse rounded bg-cream-200" />
                <div className="h-4 w-14 animate-pulse rounded bg-cream-200" />
              </div>
              <div className="h-11 min-w-[7rem] animate-pulse rounded-xl bg-cream-200" />
            </>
          ) : (
            <>
              <div className="flex flex-col items-end">
                {hiddenPriceEnquiry ? (
                  <span className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                    Price on enquiry
                  </span>
                ) : item.price == null ? (
                  priceReveal === 'login_cta' ? (
                    <button
                      type="button"
                      onClick={openLogin}
                      className="inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-xs border border-cream-300 bg-white px-2.5 py-1 font-medium text-cream-600"
                      style={{ fontSize: 'var(--b-text-sub)' }}
                    >
                      Login for Price
                    </button>
                  ) : (
                    <span className="inline-block h-5 w-20 rounded-md bg-cream-300" aria-label="Price hidden" />
                  )
                ) : (
                  <span className="font-semibold" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--b-text-price)', color: 'var(--fg-1)' }}>
                    {formatNumberValue(item.price, 'CURRENCY_EXACT')}
                  </span>
                )}
                {showCampaignPrice ? (
                  <span className="line-through text-[var(--fg-3)]" style={{ fontSize: 'var(--b-text-eyebrow)' }}>
                    {formatNumberValue(item.resolved_price, 'CURRENCY_EXACT')}
                  </span>
                ) : null}
              </div>
              {cartLine ? (
                <div
                  className="flex min-h-11 items-center overflow-hidden rounded-xl"
                  style={{ background: 'var(--teal-500)' }}
                >
                  <button
                    type="button"
                    className="flex h-11 w-11 items-center justify-center text-white"
                    aria-label="Decrease quantity"
                    onClick={handleDecrement}
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span
                    className="min-w-[2rem] text-center text-sm font-semibold text-white"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {cartLine.quantity}
                  </span>
                  <button
                    type="button"
                    className="flex h-11 w-11 items-center justify-center text-white"
                    aria-label="Increase quantity"
                    onClick={handleIncrement}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleAddToCart}
                  className="flex min-h-11 min-w-[7rem] items-center justify-center gap-1.5 rounded-xl px-5 text-sm font-semibold text-white"
                  style={{ background: 'var(--teal-500)' }}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {hiddenPriceEnquiry ? 'Enquire' : 'Add'}
                </button>
              )}
            </>
          )}
        </div>
      </BuyerFixedFooter>
    </div>
  );
}

function ProductHeroStockLabel({ status }: { status: 'limited' | 'out_of_stock' }) {
  const isLimited = status === 'limited';
  return (
    <span
      className={cn(
        'absolute right-3 top-3 z-[2] rounded-full border px-3 py-1 font-semibold uppercase tracking-[0.08em] shadow-sm',
        isLimited
          ? 'border-[var(--warning-50)] bg-[var(--warning-50)] text-[var(--warning-500)]'
          : 'border-[var(--danger-50)] bg-[var(--danger-50)] text-[var(--danger-500)]',
      )}
      style={{ fontSize: 'var(--b-text-label)' }}
    >
      {isLimited ? 'Low stock' : 'Out of stock'}
    </span>
  );
}

function CurrencyTargetRateInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex h-10 overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-white focus-within:border-[var(--teal-500)]">
      <span className="flex h-full items-center border-r border-[var(--border-1)] bg-cream-100 px-2.5 text-sm font-semibold text-cream-700">
        ₹
      </span>
      <input
        value={value}
        onChange={(event) => onChange(formatNumberInput(event.target.value, 'CURRENCY_EXACT'))}
        inputMode="decimal"
        className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
        placeholder={placeholder}
      />
    </div>
  );
}

function SpecRow({
  label,
  value,
  mono,
  isLast,
}: {
  label: string;
  value: string;
  mono?: boolean;
  isLast?: boolean;
}) {
  return (
    <div
      className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-4 px-4 py-2.5 md:px-5 md:py-3"
      style={{ borderBottom: isLast ? undefined : '1px solid var(--border-1)' }}
    >
      <span style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>
        {label}
      </span>
      <span
        className="text-right font-medium md:text-left"
        style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-1)', fontFamily: mono ? 'var(--font-mono)' : undefined }}
      >
        {value}
      </span>
    </div>
  );
}

function SpecRowSkeleton({ isLast }: { isLast?: boolean }) {
  return (
    <div
      className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-4 px-4 py-2.5 md:px-5 md:py-3"
      style={{ borderBottom: isLast ? undefined : '1px solid var(--border-1)' }}
    >
      <div className="h-4 w-16 animate-pulse rounded bg-cream-200" />
      <div className="ml-auto h-4 w-24 animate-pulse rounded bg-cream-200 md:ml-0" />
    </div>
  );
}
