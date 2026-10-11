'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Minus, Package, Plus } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';

import { BuyerDetailShell } from '@/components/buyer/layout/BuyerDetailShell';
import { BuyerFixedFooter } from '@/components/buyer/layout/BuyerFixedFooter';
import { RecoSection } from '@/components/buyer/catalog/RecoSection';
import { useCart } from '@/contexts/BuyerCartContext';
import { useStorefrontLogin } from '@/contexts/StorefrontLoginContext';
import { navigateBuyerBack } from '@/hooks/useBuyerNavigationDirection';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { useBuyerProductFamilyDetail, useBuyerProductRecommendations } from '@/hooks/useBuyerProducts';
import { useInViewOnce } from '@/hooks/useInViewOnce';
import { useBuyerAnalyticsIds } from '@/lib/analytics-identity';
import { BUYER_CARD_RADIUS_CLASS, getBuyerProductPrimaryImageUrl, guestPriceReveal, hasVisibleBuyerPrice, isHiddenPriceEnquiryMode } from '@/lib/buyer-ui';
import { BUYER_PREVIEW_MAX_WIDTH } from '@/lib/buyer-preview';
import { cn, formatNumberInput, formatNumberValue, parseNumberInput } from '@/lib/utils';
import type { BuyerFamilySkuOption } from '@/types/buyer';

interface BuyerProductFamilyDetailClientProps {
  productFamilyId: string;
}

type Selection = Record<string, string>;

export function BuyerProductFamilyDetailClient({ productFamilyId }: BuyerProductFamilyDetailClientProps): React.ReactNode {
  const router = useRouter();
  const posthog = usePostHog();
  const analyticsIds = useBuyerAnalyticsIds();
  const { detail, family, isLoading, isError } = useBuyerProductFamilyDetail(productFamilyId);
  const { addItem, updateQty, items: cartItems, campaignId } = useCart();
  const { data: meData } = useBuyerMe();
  const { openLogin } = useStorefrontLogin();
  const isGuest = meData?.mode !== 'buyer' && meData?.mode !== 'preview';
  // Prefer the family's own same-request-fresh catalog_pricing_mode over
  // meData.guest_pricing_mode, which is a 15-min-stale reference query and
  // can drift out of sync with the catalog's actual current pricing mode.
  // Fall back to /me only before the family has loaded.
  const priceReveal = isGuest
    ? guestPriceReveal(family ? family.catalog_pricing_mode : meData?.guest_pricing_mode)
    : 'amount';
  const stockVisible = meData?.stock_visibility?.enabled ?? false;
  const [selection, setSelection] = React.useState<Selection>({});
  const [imgError, setImgError] = React.useState(false);
  const [targetMin, setTargetMin] = React.useState('');
  const [targetMax, setTargetMax] = React.useState('');
  const [desiredQuantity, setDesiredQuantity] = React.useState(1);

  const axes = detail?.variant_axes ?? [];
  const skus = detail?.skus ?? [];
  const axisKeys = React.useMemo(() => axes.map((axis) => axis.key), [axes]);
  const selectedSku = React.useMemo(() => resolveSelectedSku(skus, axisKeys, selection), [skus, axisKeys, selection]);
  const cartLine = selectedSku ? cartItems.find((item) => item.tenant_product_id === selectedSku.tenant_product_id) : undefined;
  const hiddenPriceEnquiry = family ? isHiddenPriceEnquiryMode(family.catalog_pricing_mode) : false;
  const collectTargetRange = hiddenPriceEnquiry && family?.collect_target_unit_price_range === true;
  const activeImage = family && !imgError ? (family.image_url_large ?? getBuyerProductPrimaryImageUrl(family)) : null;
  const hasRequiredSelection = axes.length === 0 || axes.every((axis) => selection[axis.key]);
  const canAddResolvedSku = Boolean(selectedSku && (hiddenPriceEnquiry || hasVisibleBuyerPrice(selectedSku.price)));
  const canClickResolvedSku = Boolean(selectedSku && (canAddResolvedSku || isGuest || priceReveal === 'login_cta'));
  const displayedPrice = selectedSku?.price ?? family?.price_summary?.min_price ?? family?.price ?? null;
  const recoProductId = selectedSku?.tenant_product_id ?? family?.tenant_product_id ?? '';
  const [recoRailRef, recoRailNear] = useInViewOnce();
  const recosQuery = useBuyerProductRecommendations(recoProductId, { enabled: recoRailNear });
  const categoryRecoTitle = family?.category_name ? `More in ${family.category_name}` : 'More in this category';
  const taxLabel = selectedSku?.gst_rate != null
    ? `${selectedSku.gst_rate}% GST`
    : family?.gst_rate != null
      ? `${family.gst_rate}% GST`
      : '—';
  const selectedStockLabel = selectedSku ? stockLabel(selectedSku) : 'Select a variant';

  React.useEffect(() => {
    if (!family) return;
    posthog?.capture('product_family_viewed', {
      ...analyticsIds,
      product_family_id: family.product_family_id ?? family.id,
      child_sku_count: family.child_sku_count ?? skus.length,
      brand: family.brand_name ?? null,
      category: family.category_name ?? null,
    });
  }, [analyticsIds, family, posthog, skus.length]);

  React.useEffect(() => {
    if (axes.length === 0 || Object.keys(selection).length > 0) return;
    const singleValueSelection = axes.reduce<Selection>((next, axis) => {
      if (axis.values.length === 1) next[axis.key] = axis.values[0]!;
      return next;
    }, {});
    if (Object.keys(singleValueSelection).length > 0) setSelection(singleValueSelection);
  }, [axes, selection]);

  React.useEffect(() => {
    setDesiredQuantity(cartLine?.quantity ?? 1);
  }, [cartLine?.quantity, selectedSku?.tenant_product_id]);

  function handleBack(): void {
    navigateBuyerBack(router);
  }

  function optionPossible(axisKey: string, value: string): boolean {
    const axisIndex = axisKeys.indexOf(axisKey);
    return skus.some((sku) => axisKeys.every((key, index) => {
      if (key === axisKey) return sku.attributes[key] === value;
      if (index >= axisIndex) return true;
      const selectedValue = selection[key];
      return !selectedValue || sku.attributes[key] === selectedValue;
    }));
  }

  function handleSelect(axisKey: string, value: string): void {
    setSelection((current) => {
      const next = { ...current, [axisKey]: current[axisKey] === value ? '' : value };
      for (const key of axisKeys) {
        if (key === axisKey) continue;
        if (!next[key]) continue;
        const candidate = { ...next };
        if (!skus.some((sku) => Object.entries(candidate).every(([candidateKey, selectedValue]) => !selectedValue || sku.attributes[candidateKey] === selectedValue))) {
          next[key] = '';
        }
      }
      return next;
    });
  }

  function handleAdd(): void {
    if (!family || !selectedSku) return;
    if (isGuest || !canAddResolvedSku) {
      openLogin();
      return;
    }
    const quantity = Math.max(1, desiredQuantity);
    addItem({
      tenant_product_id: selectedSku.tenant_product_id,
      name: family.display_name,
      brand: family.brand_name ?? undefined,
      internal_sku: selectedSku.internal_sku,
      image_url: getBuyerProductPrimaryImageUrl(family) ?? undefined,
      unit_price: hiddenPriceEnquiry ? null : (selectedSku.price ?? 0),
      resolved_price: selectedSku.resolved_price,
      has_campaign_price: selectedSku.has_campaign_price,
      gst_rate: selectedSku.gst_rate ?? null,
      unit: selectedSku.default_uom ?? undefined,
      quantity,
      line_total: hiddenPriceEnquiry ? 0 : (selectedSku.price ?? 0) * quantity,
      cart_mode: hiddenPriceEnquiry ? 'hidden_price_enquiry' : 'priced',
      collect_target_unit_price_range: family.collect_target_unit_price_range === true,
      buyer_target_unit_price_min: parseNumberInput(targetMin, 'CURRENCY_EXACT'),
      buyer_target_unit_price_max: parseNumberInput(targetMax, 'CURRENCY_EXACT'),
      tenant_category_id: family.category_id ?? undefined,
      stock_status: selectedSku.stock_status,
      on_hand: selectedSku.on_hand,
    }, family.campaign_id ?? campaignId, { source_surface: 'product_family_detail' });
    posthog?.capture('reco_add_to_cart', {
      ...analyticsIds,
      widget: 'product_family_detail',
      product_id: selectedSku.tenant_product_id,
      product_family_id: family.product_family_id ?? family.id,
      source_product_id: null,
    });
  }

  function handleDecrement(): void {
    if (!selectedSku) return;
    if (cartLine) {
      updateQty(selectedSku.tenant_product_id, cartLine.quantity - 1);
      return;
    }
    setDesiredQuantity((qty) => Math.max(1, qty - 1));
  }

  function handleIncrement(): void {
    if (!selectedSku) return;
    if (cartLine) {
      updateQty(selectedSku.tenant_product_id, cartLine.quantity + 1);
      return;
    }
    setDesiredQuantity((qty) => qty + 1);
  }

  if (isError && !isLoading) {
    return (
      <div className="flex min-h-[50dvh] flex-col" style={{ background: 'var(--bg-base)' }}>
        <BuyerDetailShell title="Product" hideSearchOnDesktop>
          <div className="flex flex-col gap-4 px-3 py-8">
            <p className="text-sm" style={{ color: 'var(--fg-2)' }}>Product family not found or unavailable.</p>
            <button type="button" onClick={handleBack} className="w-fit rounded-full border px-4 py-2 text-sm font-semibold" style={{ borderColor: 'var(--border-1)', color: 'var(--fg-2)' }}>
              Go back
            </button>
          </div>
        </BuyerDetailShell>
      </div>
    );
  }

  return (
    <div className="flex min-h-[50dvh] flex-col pb-[calc(8.5rem+env(safe-area-inset-bottom,0px))] md:pb-10" style={{ background: 'var(--bg-base)' }}>
      <BuyerDetailShell title="Product" hideDesktopHeader>
        <div className="px-3 pb-4 md:px-6 md:pb-6 md:pt-6">
          <div className="grid gap-5 md:grid-cols-[minmax(340px,0.95fr)_minmax(0,1.05fr)] md:items-start">
            <div className={cn('relative aspect-square w-full overflow-hidden border border-[var(--border-1)] bg-[var(--bg-surface)] md:sticky md:top-6', BUYER_CARD_RADIUS_CLASS)}>
              {isLoading ? (
                <div className="absolute inset-0 animate-pulse bg-cream-100" />
              ) : activeImage ? (
                <Image
                  src={activeImage}
                  alt={family?.display_name ?? 'Product'}
                  fill
                  className="object-contain p-3.5 md:p-5"
                  sizes="(min-width: 768px) 42vw, 100vw"
                  onError={() => setImgError(true)}
                  unoptimized
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Package className="h-16 w-16" style={{ color: 'var(--fg-3)' }} />
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-4 md:space-y-5">
              <div className="space-y-4 py-4 md:rounded-[12px] md:border md:border-[var(--border-1)] md:bg-[var(--bg-surface)] md:px-5 md:py-5">
                {isLoading || !family ? (
                  <>
                    <div className="h-3 w-20 animate-pulse rounded bg-cream-200" />
                    <div className="min-h-[2.5rem] w-full animate-pulse rounded bg-cream-200" />
                    <div className="h-7 w-28 animate-pulse rounded bg-cream-200" />
                  </>
                ) : (
                  <>
                    {family.brand_name ? <p className="font-semibold uppercase tracking-wide" style={{ fontSize: 'var(--b-text-eyebrow)', color: 'var(--fg-3)' }}>{family.brand_name}</p> : null}
                    <h2 className="w-full font-semibold leading-snug [text-wrap:wrap]" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--b-text-section)', color: 'var(--fg-1)' }}>
                      {family.display_name}
                    </h2>
                    <FamilyPrice
                      hiddenPriceEnquiry={hiddenPriceEnquiry}
                      priceReveal={priceReveal}
                      price={displayedPrice}
                      summaryDisplay={family.price_summary?.display}
                      openLogin={openLogin}
                    />
                    <div className="space-y-3 rounded-[10px] border border-[var(--border-1)] bg-[var(--bg-base)] p-3">
                      <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>Choose variant</p>
                      {axes.map((axis) => (
                        <div key={axis.key} className="space-y-2">
                          <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>{axis.label}</p>
                          <div className="flex flex-wrap gap-2">
                            {axis.values.map((value) => {
                              const active = selection[axis.key] === value;
                              const disabled = !active && !optionPossible(axis.key, value);
                              return (
                                <button
                                  key={value}
                                  type="button"
                                  disabled={disabled}
                                  onClick={() => handleSelect(axis.key, value)}
                                  className={cn(
                                    'min-h-10 rounded-[8px] border px-3 py-2 text-sm font-semibold transition-colors',
                                    active ? 'border-[var(--teal-500)] bg-[var(--teal-50)] text-[var(--teal-700)]' : 'border-[var(--border-1)] bg-white text-[var(--fg-2)]',
                                    disabled && 'cursor-not-allowed opacity-40',
                                  )}
                                >
                                  {value}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    {collectTargetRange ? (
                      <TargetRangeInputs targetMin={targetMin} targetMax={targetMax} setTargetMin={setTargetMin} setTargetMax={setTargetMax} unit={selectedSku?.default_uom ?? family.default_uom} />
                    ) : null}
                    <div className="rounded-[10px] border border-[var(--border-1)] bg-[var(--bg-base)] p-3">
                      <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                        {selectedSku ? 'Variant selected' : hasRequiredSelection ? 'Combination unavailable' : 'Select options'}
                      </p>
                      <p className="mt-1" style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>
                        {selectedSku
                          ? `${stockVisible ? stockLabel(selectedSku) : 'Ready to add'}${selectedSku.default_uom ? ` · ${selectedSku.default_uom}` : ''}`
                          : 'Choose one value from each option to resolve the final SKU.'}
                      </p>
                    </div>
                    <div className="hidden pt-1 md:flex">
                      <FamilyActionButton
                        cartLineQty={cartLine?.quantity}
                        desiredQuantity={desiredQuantity}
                        hiddenPriceEnquiry={hiddenPriceEnquiry}
                        disabled={!canClickResolvedSku}
                        onAdd={handleAdd}
                        onIncrement={handleIncrement}
                        onDecrement={handleDecrement}
                      />
                    </div>
                  </>
                )}
              </div>
              <div className={`overflow-hidden md:border md:border-[var(--border-1)] md:bg-[var(--bg-surface)] ${BUYER_CARD_RADIUS_CLASS}`}>
                <div className="border-b border-[var(--border-1)] px-4 py-2.5 md:px-5 md:py-3">
                  <span className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                    Product Details
                  </span>
                </div>
                {isLoading || !family ? (
                  <>
                    <SpecRowSkeleton />
                    <SpecRowSkeleton />
                    <SpecRowSkeleton />
                    <SpecRowSkeleton isLast />
                  </>
                ) : (
                  <>
                    <SpecRow label="SKU" value={selectedSku?.internal_sku ?? 'Select a variant'} mono />
                    {family.brand_name ? <SpecRow label="Brand" value={family.brand_name} /> : null}
                    {family.category_name ? <SpecRow label="Category" value={family.category_name} /> : null}
                    <SpecRow label="Tax" value={taxLabel} isLast={!stockVisible} />
                    {stockVisible ? <SpecRow label="Stock" value={selectedStockLabel} isLast /> : null}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div ref={recoRailRef}>
          <RecoSection
            title={categoryRecoTitle}
            widget="same_category"
            items={recosQuery.data?.same_category ?? []}
            sourceProductId={recoProductId}
            isLoading={Boolean(recoProductId) && recosQuery.isPending}
            sectionClassName="px-3 pb-3"
            scrollClassName="gap-3 px-3"
            priceReveal={priceReveal}
          />
        </div>
      </BuyerDetailShell>

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
        <div className="space-y-3">
          {axes.length > 0 ? (
            <div className="min-w-0">
              <div className="min-w-0">
                <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>
                  {selectedSku ? selectedSku.internal_sku : 'Select options'}
                </p>
                <p className="mt-0.5 line-clamp-2" style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>
                  {selectedSku
                    ? selectedVariantSummary(selectedSku, axisKeys)
                    : missingVariantSummary(axes, selection)}
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              {hiddenPriceEnquiry ? (
                <span className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>Price on enquiry</span>
              ) : displayedPrice == null ? (
                <span className="inline-block h-5 w-20 rounded-md bg-cream-300" aria-label="Price hidden" />
              ) : (
                <span className="font-semibold" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--b-text-price)', color: 'var(--fg-1)' }}>{formatNumberValue(displayedPrice, 'CURRENCY_EXACT')}</span>
              )}
            </div>
            <FamilyActionButton
              cartLineQty={cartLine?.quantity}
              desiredQuantity={desiredQuantity}
              hiddenPriceEnquiry={hiddenPriceEnquiry}
              disabled={!canClickResolvedSku}
              onAdd={handleAdd}
              onIncrement={handleIncrement}
              onDecrement={handleDecrement}
            />
          </div>
        </div>
      </BuyerFixedFooter>
    </div>
  );
}

function resolveSelectedSku(skus: BuyerFamilySkuOption[], axisKeys: string[], selection: Selection): BuyerFamilySkuOption | null {
  if (skus.length === 1 && axisKeys.length === 0) return skus[0] ?? null;
  if (!axisKeys.every((key) => selection[key])) return null;
  return skus.find((sku) => axisKeys.every((key) => sku.attributes[key] === selection[key])) ?? null;
}

function stockLabel(sku: BuyerFamilySkuOption): string {
  if (sku.stock_status === 'out_of_stock') return '0 units';
  if (sku.on_hand > 0) return `${sku.on_hand} units`;
  return sku.stock_status === 'limited' ? 'Limited stock' : 'Available';
}

function selectedVariantSummary(sku: BuyerFamilySkuOption, axisKeys: string[]): string {
  const values = axisKeys.map((key) => sku.attributes[key]).filter(Boolean);
  return values.length > 0 ? values.join(' · ') : sku.display_name;
}

function missingVariantSummary(axes: Array<{ key: string; label: string }>, selection: Selection): string {
  const missing = axes.filter((axis) => !selection[axis.key]).map((axis) => axis.label);
  return missing.length > 0 ? `Choose ${missing.join(', ')}` : 'Combination unavailable';
}

function FamilyPrice({ hiddenPriceEnquiry, priceReveal, price, summaryDisplay, openLogin }: { hiddenPriceEnquiry: boolean; priceReveal: string; price: number | null; summaryDisplay?: string; openLogin: () => void }) {
  if (hiddenPriceEnquiry) {
    return <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>Price on enquiry</p>;
  }
  if (price == null) {
    if (priceReveal === 'login_cta') {
      return (
        <button type="button" onClick={openLogin} className="inline-flex w-fit rounded-xs border border-cream-300 bg-white px-3 py-1.5 font-medium text-cream-600" style={{ fontSize: 'var(--b-text-label)' }}>
          Login for Price
        </button>
      );
    }
    return <span className="inline-block h-7 w-28 rounded-md bg-cream-300" aria-label="Price hidden" />;
  }
  return (
    <p className="font-semibold" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--b-text-price-lg)', color: 'var(--fg-1)' }}>
      {summaryDisplay === 'from' ? 'From ' : null}{formatNumberValue(price, 'CURRENCY_EXACT')}
    </p>
  );
}

function TargetRangeInputs({ targetMin, targetMax, setTargetMin, setTargetMax, unit }: { targetMin: string; targetMax: string; setTargetMin: (value: string) => void; setTargetMax: (value: string) => void; unit?: string | null }) {
  return (
    <div className="space-y-2 rounded-[10px] border border-[var(--border-1)] bg-[var(--bg-base)] p-3">
      <p className="font-semibold" style={{ fontSize: 'var(--b-text-label)', color: 'var(--fg-1)' }}>Target buying price per unit</p>
      <div className="grid grid-cols-2 gap-2">
        <CurrencyTargetRateInput value={targetMin} onChange={setTargetMin} placeholder="Min" />
        <CurrencyTargetRateInput value={targetMax} onChange={setTargetMax} placeholder="Max" />
      </div>
      {unit ? <p style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>Per {unit}</p> : null}
    </div>
  );
}

function CurrencyTargetRateInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="flex h-10 overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-white focus-within:border-[var(--teal-500)]">
      <span className="flex h-full items-center border-r border-[var(--border-1)] bg-cream-100 px-2.5 text-sm font-semibold text-cream-700">₹</span>
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

function SpecRow({ label, value, mono, isLast }: { label: string; value: string; mono?: boolean; isLast?: boolean }) {
  return (
    <div
      className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-4 px-4 py-2.5 md:px-5 md:py-3"
      style={{ borderBottom: isLast ? undefined : '1px solid var(--border-1)' }}
    >
      <span style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-3)' }}>{label}</span>
      <span className="text-right font-medium md:text-left" style={{ fontSize: 'var(--b-text-sub)', color: 'var(--fg-1)', fontFamily: mono ? 'var(--font-mono)' : undefined }}>
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

function FamilyActionButton({ cartLineQty, desiredQuantity, hiddenPriceEnquiry, disabled, onAdd, onIncrement, onDecrement }: { cartLineQty?: number; desiredQuantity: number; hiddenPriceEnquiry: boolean; disabled: boolean; onAdd: () => void; onIncrement: () => void; onDecrement: () => void }) {
  if (cartLineQty != null) {
    return (
      <div className="flex min-h-11 w-40 items-center justify-between overflow-hidden rounded-xl" style={{ background: 'var(--teal-500)' }}>
        <button type="button" className="flex h-11 w-11 items-center justify-center text-white" aria-label="Decrease quantity" onClick={onDecrement}><Minus className="h-4 w-4" /></button>
        <span className="min-w-[2rem] text-center text-sm font-semibold text-white" style={{ fontFamily: 'var(--font-mono)' }}>{cartLineQty}</span>
        <button type="button" className="flex h-11 w-11 items-center justify-center text-white" aria-label="Increase quantity" onClick={onIncrement}><Plus className="h-4 w-4" /></button>
      </div>
    );
  }
  return (
    <button type="button" disabled={disabled} onClick={onAdd} className="flex min-h-11 w-40 items-center justify-center gap-1.5 rounded-xl px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{ background: 'var(--teal-500)' }}>
      <Plus className="h-4 w-4" aria-hidden />
      {hiddenPriceEnquiry ? 'Add to Enquiry' : `Add ${desiredQuantity}`}
    </button>
  );
}
