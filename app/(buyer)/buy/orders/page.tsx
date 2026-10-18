'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { useFlagState } from '@/hooks/useFeatureFlag';
import { useRouteScrollRestoration, useRouteSnapshot } from '@/hooks/useRouteSnapshot';
import { useBuyerScrollCollapse } from '@/hooks/useBuyerScrollCollapse';
import { BuyerTransactionFilterChips } from '@/components/buyer/orders/BuyerTransactionFilterChips';
import { OrdersLandingSkeleton } from '@/components/buyer/orders/OrdersLandingSkeleton';
import { OrdersTab } from '@/components/buyer/orders/OrdersTab';
import { EnquiriesTab } from '@/components/buyer/orders/EnquiriesTab';
import { InvoicesTab } from '@/components/buyer/orders/InvoicesTab';
import { DesktopTransactionDetailPane } from '@/components/buyer/orders/DesktopTransactionDetailPane';
import { useBuyerRealtimeContext } from '@/contexts/BuyerRealtimeContext';
import { useBuyerScrollRoot } from '@/contexts/BuyerScrollContext';
import { apiFetch } from '@/lib/api-fetch';
import {
  BUYER_ESTIMATE_STATUS_CHIPS,
  BUYER_INVOICE_STATUS_CHIPS,
  BUYER_ORDER_STATUS_CHIPS,
  type BuyerEstimateStatusChip,
  type BuyerInvoiceStatusChip,
  type BuyerOrderStatusChip,
} from '@/lib/buyer-transaction-filters';
import type { BuyerHomeMetricsV4 } from '@/lib/buyer-home-types';
import {
  BUYER_ORDERS_DEFAULT_TAB,
  isBuyerOrdersTabId,
  resolveBuyerOrdersDefaultTab,
  resolveBuyerOrdersTabVisibility,
  type BuyerOrdersTabId,
} from '@/lib/buyer-orders-tabs';
import { BUYER_QUERY_GC_TIME, BUYER_QUERY_STALE_TIME } from '@/lib/query-navigation';
import { effectiveInvoiceStatus } from '@/lib/invoice-status';
import {
  buyerHomeDemandCountLabel,
  buyerHomeDemandTitle,
} from '@/lib/buyer-home-kpi';
import { formatNumberValue } from '@/lib/utils';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import type { DocType, TransactionDoc } from '@/components/buyer/documents/TransactionDetailPage';

type TabId = BuyerOrdersTabId;

interface OrdersTabMeta {
  id: TabId;
  label: string;
  enabled: boolean;
}

interface OrdersDetailConfig {
  endpoint: string;
  docType: DocType;
  respectBusinessPolicyTotals?: boolean;
  pickDoc: (payload: any) => TransactionDoc | null;
}

function parseInvoiceStatusFromUrl(status: string | null): BuyerInvoiceStatusChip {
  if (status === 'Due' || status === 'Overdue' || status === 'Paid' || status === 'Void') {
    return status;
  }
  return 'All';
}

function PreviewPlaceholder({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="px-4 pt-3">
      <div className="rounded-[12px] border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-5 text-center">
        <div className="mb-2 text-[28px]">{icon}</div>
        <p className="text-[var(--b-text-body)] font-semibold text-[var(--cream-800)]">{title}</p>
        <p className="mt-1 text-[var(--b-text-sub)] text-[var(--cream-600)]">{description}</p>
      </div>
    </div>
  );
}

async function fetchBuyerHomeMetrics(): Promise<BuyerHomeMetricsV4> {
  const response = await apiFetch('/api/buyer/home/metrics');
  if (!response.ok) throw new Error('Failed to fetch buyer metrics');
  return response.json() as Promise<BuyerHomeMetricsV4>;
}

function OrdersKpiGrid({ metrics }: { metrics?: BuyerHomeMetricsV4 }) {
  const demandKind = metrics?.demand_kind;
  const cards = [
    { label: 'Spend this quarter', value: formatNumberValue(metrics?.spend_qtd ?? 0, 'CURRENCY_EXACT'), sub: `${metrics?.invoice_count_qtd ?? 0} invoices` },
    {
      label: buyerHomeDemandTitle(typeof demandKind === 'string' ? demandKind : undefined),
      value: formatNumberValue(metrics?.demand_qtd ?? 0, 'CURRENCY_EXACT'),
      sub: buyerHomeDemandCountLabel(typeof demandKind === 'string' ? demandKind : undefined, metrics?.demand_document_count_qtd ?? 0),
    },
    {
      label: 'Outstanding',
      value: formatNumberValue(metrics?.outstanding ?? 0, 'CURRENCY_EXACT'),
      sub: `${formatNumberValue(metrics?.overdue ?? 0, 'CURRENCY_EXACT')} overdue`,
    },
    {
      label: 'Available credit',
      value: formatNumberValue(metrics?.available_credit ?? 0, 'CURRENCY_EXACT'),
      sub: `of ${formatNumberValue(metrics?.credit_limit ?? 0, 'CURRENCY_EXACT')} limit`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-4">
      {cards.map((card) => (
        <article
          key={card.label}
          className="rounded-[18px] border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-4 md:rounded-[14px] md:border-cream-300 md:px-[18px] md:py-[16px]"
        >
          <p className="font-semibold uppercase tracking-[0.14em] text-cream-500 md:text-cream-600" style={{ fontSize: 'var(--b-text-eyebrow)' }}>
            {card.label}
          </p>
          <p
            className="mt-3 text-[length:var(--b-text-header)] leading-none text-cream-950 md:mt-2 md:text-xl md:font-medium"
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              letterSpacing: '-0.025em',
            }}
          >
            {card.value}
          </p>
          <p
            className="mt-3 font-medium text-[var(--b-text-sub)] text-cream-600 md:mt-2 md:text-sm md:text-cream-700"
          >
            {card.sub}
          </p>
        </article>
      ))}
    </div>
  );
}

function OrdersMobileKpiRibbon({
  activeTab,
  metrics,
}: {
  activeTab: TabId;
  metrics?: BuyerHomeMetricsV4;
}) {
  if (activeTab === 'invoices') {
    return (
      <div className="px-4 pt-3">
        <section className="rounded-[18px] border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <p className="font-semibold uppercase tracking-[0.14em] text-cream-500" style={{ fontSize: 'var(--b-text-eyebrow)' }}>
                Spend this quarter
              </p>
              <p
                className="mt-2 leading-none text-cream-950"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--b-text-header)',
                  fontWeight: 600,
                  letterSpacing: '-0.025em',
                }}
              >
                {formatNumberValue(metrics?.spend_qtd ?? 0, 'CURRENCY_EXACT')}
              </p>
            </div>
            <div className="min-w-0">
              <p className="font-semibold uppercase tracking-[0.14em] text-cream-500" style={{ fontSize: 'var(--b-text-eyebrow)' }}>
                Invoices this quarter
              </p>
              <p
                className="mt-2 leading-none text-cream-950"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--b-text-header)',
                  fontWeight: 600,
                  letterSpacing: '-0.025em',
                }}
              >
                {metrics?.invoice_count_qtd ?? 0}
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-cream-200 pt-3">
            <div className="min-w-0">
              <p className="text-[var(--b-text-sub)] font-medium text-cream-600">Outstanding dues</p>
              <p className="mt-1 font-semibold text-cream-900">{formatNumberValue(metrics?.outstanding ?? 0, 'CURRENCY_EXACT')}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[var(--b-text-sub)] font-medium text-cream-600">Overdue amount</p>
              <p className="mt-1 font-semibold text-cream-900">{formatNumberValue(metrics?.overdue ?? 0, 'CURRENCY_EXACT')}</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const noun = activeTab === 'orders' ? 'Orders' : 'Estimates';

  return (
    <div className="px-4 pt-3">
      <section className="rounded-[18px] border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0">
            <p className="font-semibold uppercase tracking-[0.14em] text-cream-500" style={{ fontSize: 'var(--b-text-eyebrow)' }}>
              {noun} value this quarter
            </p>
            <p
              className="mt-2 leading-none text-cream-950"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'var(--b-text-header)',
                fontWeight: 600,
                letterSpacing: '-0.025em',
              }}
            >
              {formatNumberValue(metrics?.demand_qtd ?? 0, 'CURRENCY_EXACT')}
            </p>
          </div>
          <div className="min-w-0">
            <p className="font-semibold uppercase tracking-[0.14em] text-cream-500" style={{ fontSize: 'var(--b-text-eyebrow)' }}>
              {noun} this quarter
            </p>
            <p
              className="mt-2 leading-none text-cream-950"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'var(--b-text-header)',
                fontWeight: 600,
                letterSpacing: '-0.025em',
              }}
            >
              {metrics?.demand_document_count_qtd ?? 0}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function OrdersTabButtons({
  tabs,
  activeTab,
  onChange,
  desktop = false,
}: {
  tabs: OrdersTabMeta[];
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  desktop?: boolean;
}) {
  if (tabs.length <= 1) return null;

  if (desktop) {
    return (
      <div
        className="mx-0 mt-6 flex items-end gap-0 border-b border-cream-300 bg-transparent p-0"
        role="tablist"
        aria-orientation="horizontal"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={`flex-none rounded-none border-b-2 px-5 py-3.5 text-base font-medium transition-colors ${
                isActive
                  ? 'border-ember-500 text-cream-950'
                  : 'border-transparent text-cream-700 hover:text-cream-900'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="px-4 pb-3 pt-3">
      <div className="flex rounded-[10px] bg-[var(--bg-page)] p-[3px]" role="tablist" aria-orientation="horizontal">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className="flex h-8 flex-1 items-center justify-center rounded-lg border-none px-2 transition"
              style={{
                background: isActive ? 'var(--bg-surface)' : 'transparent',
                boxShadow: isActive ? '0 1px 2px rgba(31,58,52,0.06)' : 'none',
              }}
            >
              <span
                className="text-[length:var(--b-text-sub)] font-medium"
                style={{ color: isActive ? 'var(--teal-500)' : 'var(--cream-700)' }}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrdersSearchField({
  value,
  onChange,
  placeholder,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-[12px] border border-cream-300 bg-[var(--bg-surface)] px-3.5 ${compact ? 'py-2.5' : 'py-3'}`}
    >
      <Search className="h-4 w-4 text-cream-600" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="flex-1 border-none bg-transparent text-[length:var(--b-text-body)] text-[var(--cream-900)] outline-none"
      />
    </div>
  );
}

function OrdersMobileStickyChrome({
  tabs,
  activeTab,
  onTabChange,
  search,
  onSearchChange,
  searchPlaceholder,
  filterRow,
}: {
  tabs: OrdersTabMeta[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  filterRow: React.ReactNode;
}) {
  const { collapsed, sentinelRef } = useBuyerScrollCollapse();

  return (
    <>
      <header
        className={`sticky top-0 z-[15] border-b border-[var(--border-1)] bg-[var(--bg-base)] transition-shadow ${collapsed ? 'shadow-sm' : ''}`}
      >
        <div className="px-5 pb-2 pt-4">
          {!collapsed ? (
            <p
              className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--cream-700)]"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              Activity
            </p>
          ) : null}
          <h1
            className="mt-0.5 text-[var(--cream-900)] leading-tight"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: collapsed ? 'var(--b-text-header)' : 'var(--b-text-page)',
              fontWeight: 600,
              letterSpacing: collapsed ? '-0.01em' : '-0.025em',
            }}
          >
            {collapsed ? 'Orders' : 'Your orders'}
          </h1>
        </div>
        <OrdersTabButtons tabs={tabs} activeTab={activeTab} onChange={onTabChange} />
        <div className="border-t border-cream-200 px-4 py-3">
          <OrdersSearchField value={search} onChange={onSearchChange} placeholder={searchPlaceholder} compact />
        </div>
        <div className="border-t border-cream-200 bg-[var(--bg-base)]">{filterRow}</div>
      </header>
      <div ref={sentinelRef} className="h-px w-full shrink-0" aria-hidden />
    </>
  );
}

function OrdersPageInner() {
  const searchParams = useSearchParams();
  const tabParamRaw = searchParams.get('tab');
  const tabParamNormalized = tabParamRaw === 'inquiries' ? 'enquiries' : tabParamRaw;
  const tabParam = isBuyerOrdersTabId(tabParamNormalized) ? tabParamNormalized : null;
  const { data: buyerMe } = useBuyerMe();
  const salesOrdersFlag = useFlagState('SALES_ORDERS');
  const estimatesFlag = useFlagState('ESTIMATES');
  const invoicesFlag = useFlagState('INVOICES');
  const visibility = resolveBuyerOrdersTabVisibility({
    orderFeatures: buyerMe?.order_features,
    salesOrdersFlag,
    estimatesFlag,
    invoicesFlag,
  });
  const highlightId = searchParams.get('highlight');
  const statusParam = searchParams.get('status');
  const sellerPreview = buyerMe?.seller_preview === true;
  const hasUrlTab = Boolean(tabParam);
  const hasDeepLink = hasUrlTab || Boolean(statusParam);
  const scrollContext = useBuyerScrollRoot();
  const metricsQuery = useQuery({
    queryKey: ['buyer-home-metrics'],
    queryFn: fetchBuyerHomeMetrics,
    staleTime: BUYER_QUERY_STALE_TIME,
    gcTime: BUYER_QUERY_GC_TIME,
  });

  const [search, setSearch] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<BuyerOrderStatusChip>('All');
  const [estimateStatusFilter, setEstimateStatusFilter] = useState<BuyerEstimateStatusChip>('All');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<BuyerInvoiceStatusChip>(() => (
    tabParam === 'invoices' || (!tabParam && BUYER_ORDERS_DEFAULT_TAB === 'invoices')
      ? parseInvoiceStatusFromUrl(statusParam)
      : 'All'
  ));
  const [desktopOrderId, setDesktopOrderId] = useState<string | null>(null);
  const [desktopEstimateId, setDesktopEstimateId] = useState<string | null>(null);
  const [desktopInvoiceId, setDesktopInvoiceId] = useState<string | null>(null);
  const { updatedEntityIds, markSeen } = useBuyerRealtimeContext();

  const { state: snapshotTab, setState: setSnapshotTab } = useRouteSnapshot<TabId>({
    storageKey: 'buyer-orders-page-tab',
    initialState: tabParam ?? BUYER_ORDERS_DEFAULT_TAB,
    enabled: !hasUrlTab,
  });

  const [urlDrivenTab, setUrlDrivenTab] = useState<TabId>(tabParam ?? BUYER_ORDERS_DEFAULT_TAB);
  const requestedTab = hasUrlTab ? urlDrivenTab : snapshotTab;

  const setActiveTab = (tab: TabId) => {
    if (hasUrlTab) setUrlDrivenTab(tab);
    setSnapshotTab(tab);
  };

  const fallbackTab = resolveBuyerOrdersDefaultTab(visibility, BUYER_ORDERS_DEFAULT_TAB);
  const activeTab: TabId =
    visibility.ready && visibility[requestedTab]
      ? requestedTab
      : (fallbackTab ?? BUYER_ORDERS_DEFAULT_TAB);

  useRouteScrollRestoration({
    storageKey: 'buyer-orders-page-tab',
    ready: true,
    enabled: !hasDeepLink,
  });

  useEffect(() => {
    if (!hasDeepLink) return;
    const root = scrollContext?.scrollRoot;
    if (root) root.scrollTo({ top: 0, behavior: 'auto' });
    else if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' });
  }, [hasDeepLink, scrollContext?.scrollRoot, statusParam, tabParam]);

  useEffect(() => {
    if (tabParam) {
      setUrlDrivenTab(tabParam);
      setSnapshotTab(tabParam);
    }
  }, [setSnapshotTab, tabParam]);

  useEffect(() => {
    if (!visibility.ready) return;
    if (visibility[requestedTab]) return;
    if (fallbackTab && fallbackTab !== requestedTab) setActiveTab(fallbackTab);
  }, [visibility.ready, visibility.orders, visibility.enquiries, visibility.invoices, requestedTab, fallbackTab]);

  useEffect(() => {
    if (activeTab !== 'invoices') return;
    if (tabParam === 'invoices' || (!tabParam && statusParam)) {
      setInvoiceStatusFilter(parseInvoiceStatusFromUrl(statusParam));
    }
  }, [statusParam, tabParam, activeTab]);

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<string | null>(null);

  useEffect(() => {
    if (!highlightId || activeTab !== 'enquiries') return;
    const delay = setTimeout(() => {
      setActiveHighlight(highlightId);
      highlightTimerRef.current = setTimeout(() => setActiveHighlight(null), 1500);
    }, 300);
    return () => {
      clearTimeout(delay);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [highlightId, activeTab]);

  const allTabs: OrdersTabMeta[] = [
    { id: 'orders', label: 'Orders', enabled: visibility.orders },
    { id: 'enquiries', label: 'Enquiries', enabled: visibility.enquiries },
    { id: 'invoices', label: 'Invoices', enabled: visibility.invoices },
  ];
  const tabs = allTabs.filter((tab) => tab.enabled);

  const searchPlaceholder =
    activeTab === 'orders' ? 'Search orders…'
      : activeTab === 'enquiries' ? 'Search enquiries…'
        : 'Search invoices…';

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    setSearch('');
    setOrderStatusFilter('All');
    setEstimateStatusFilter('All');
    setInvoiceStatusFilter('All');
  }

  const tabsReady = visibility.ready;

  const filterRow =
    activeTab === 'orders' && !sellerPreview ? (
      <BuyerTransactionFilterChips
        chips={BUYER_ORDER_STATUS_CHIPS}
        active={orderStatusFilter}
        onChange={setOrderStatusFilter}
        className="px-4 pb-3 pt-3 md:px-0 md:pb-0 md:pt-0"
      />
    ) : activeTab === 'enquiries' && !sellerPreview ? (
      <BuyerTransactionFilterChips
        chips={BUYER_ESTIMATE_STATUS_CHIPS}
        active={estimateStatusFilter}
        onChange={setEstimateStatusFilter}
        className="px-4 pb-3 pt-3 md:px-0 md:pb-0 md:pt-0"
      />
    ) : activeTab === 'invoices' && !sellerPreview ? (
      <BuyerTransactionFilterChips
        chips={BUYER_INVOICE_STATUS_CHIPS}
        active={invoiceStatusFilter}
        onChange={setInvoiceStatusFilter}
        className="px-4 pb-3 pt-3 md:px-0 md:pb-0 md:pt-0"
      />
    ) : null;

  function isPreviewTab(): boolean {
    return (
      (activeTab === 'orders' || activeTab === 'enquiries' || activeTab === 'invoices')
      && sellerPreview
    );
  }

  function previewContent() {
    if (activeTab === 'orders') {
      return (
        <PreviewPlaceholder
          icon="📦"
          title="Order history"
          description="When a buyer logs in, their complete order history appears here — with real-time status tracking, filters, and search."
        />
      );
    }
    if (activeTab === 'enquiries') {
      return (
        <PreviewPlaceholder
          icon="📋"
          title="Enquiries"
          description="Buyers can raise enquiries for custom pricing or bulk orders. Their enquiries and status updates appear here."
        />
      );
    }
    return (
      <PreviewPlaceholder
        icon="🧾"
        title="Invoices"
        description="Invoices generated for delivered orders appear here, with payment status and due dates."
      />
    );
  }

  function renderActiveTab(desktop = false) {
    if (isPreviewTab()) return previewContent();

    if (activeTab === 'orders') {
      return (
        <OrdersTab
          search={search}
          statusFilter={orderStatusFilter}
          updatedEntityIds={updatedEntityIds}
          onMarkSeen={markSeen}
          desktopSelectedId={desktop ? desktopOrderId : undefined}
          onDesktopSelect={desktop ? setDesktopOrderId : undefined}
          desktopMode={desktop}
        />
      );
    }

    if (activeTab === 'enquiries') {
      return (
        <EnquiriesTab
          search={search}
          statusFilter={estimateStatusFilter}
          highlightId={activeHighlight}
          desktopSelectedId={desktop ? desktopEstimateId : undefined}
          onDesktopSelect={desktop ? setDesktopEstimateId : undefined}
          desktopMode={desktop}
        />
      );
    }

    return (
      <InvoicesTab
        search={search}
        statusFilter={invoiceStatusFilter}
        desktopSelectedId={desktop ? desktopInvoiceId : undefined}
        onDesktopSelect={desktop ? setDesktopInvoiceId : undefined}
        desktopMode={desktop}
      />
    );
  }

  function desktopDetailConfig(): OrdersDetailConfig | null {
    if (isPreviewTab()) return null;

    if (activeTab === 'orders' && desktopOrderId) {
      return {
        endpoint: `/api/buyer/orders/${desktopOrderId}`,
        docType: 'order',
        respectBusinessPolicyTotals: true,
        pickDoc: (payload: any) => {
          const order = payload?.order;
          if (!order) return null;
          return {
            docNumber: order.order_number,
            status: order.status,
            primaryDate: order.placed_at,
            secondaryDate: null,
            notes: order.notes ?? null,
            placeOfSupply: order.place_of_supply ?? null,
            subtotal: order.subtotal,
            tax_total: order.tax_total,
            total_amount: order.total_amount,
            items: order.items ?? [],
          };
        },
      };
    }

    if (activeTab === 'enquiries' && desktopEstimateId) {
      return {
        endpoint: `/api/buyer/estimates/${desktopEstimateId}`,
        docType: 'estimate',
        respectBusinessPolicyTotals: true,
        pickDoc: (payload: any) => {
          const estimate = payload?.estimate;
          if (!estimate) return null;
          return {
            docNumber: estimate.estimate_number ?? `ENQ-${estimate.id.slice(0, 6).toUpperCase()}`,
            status: estimate.status,
            primaryDate: estimate.created_at,
            secondaryDate: estimate.valid_until ?? null,
            notes: estimate.notes ?? null,
            placeOfSupply: estimate.place_of_supply ?? null,
            subtotal: estimate.subtotal,
            tax_total: estimate.tax_total,
            total_amount: estimate.total_amount,
            items: estimate.items ?? [],
          };
        },
      };
    }

    if (activeTab === 'invoices' && desktopInvoiceId) {
      return {
        endpoint: `/api/buyer/invoices/${desktopInvoiceId}`,
        docType: 'invoice',
        respectBusinessPolicyTotals: true,
        pickDoc: (payload: any) => {
          const invoice = payload?.invoice;
          if (!invoice) return null;
          return {
            docNumber: invoice.invoice_number,
            status: effectiveInvoiceStatus({ status: invoice.status, due_date: invoice.due_date }),
            primaryDate: invoice.invoice_date,
            secondaryDate: invoice.due_date ?? null,
            notes: null,
            placeOfSupply: invoice.place_of_supply ?? null,
            subtotal: invoice.subtotal,
            tax_total: invoice.tax_total,
            total_amount: invoice.total_amount,
            outstandingBalance: invoice.outstanding_balance,
            discount_flat: invoice.discount_flat ?? 0,
            freight: invoice.freight ?? 0,
            round_off: invoice.round_off ?? 0,
            items: invoice.items ?? [],
          };
        },
      };
    }

    return null;
  }

  const detailConfig = desktopDetailConfig();

  return (
    <div className="flex h-full min-h-full flex-col">
      <div className="md:hidden">
        {!tabsReady ? (
          <OrdersLandingSkeleton />
        ) : tabs.length === 0 ? (
          <>
            <OrdersMobileStickyChrome
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              search={search}
              onSearchChange={setSearch}
              searchPlaceholder={searchPlaceholder}
              filterRow={null}
            />
            <div className="px-4 pt-6">
              <div className="rounded-[12px] border border-[var(--border-1)] bg-[var(--bg-surface)] px-4 py-5 text-center">
                <p className="text-[var(--b-text-body)] font-semibold text-[var(--cream-800)]">Orders are unavailable</p>
                <p className="mt-1 text-[var(--b-text-sub)] text-[var(--cream-600)]">
                  Your distributor has not enabled document tracking for this account yet.
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            <OrdersMobileStickyChrome
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              search={search}
              onSearchChange={setSearch}
              searchPlaceholder={searchPlaceholder}
              filterRow={filterRow}
            />
            <OrdersMobileKpiRibbon activeTab={activeTab} metrics={metricsQuery.data} />
            <div className="min-h-0 flex-1">{renderActiveTab(false)}</div>
          </>
        )}
      </div>

      <div className="hidden min-h-0 flex-1 flex-col md:flex">
        {!tabsReady ? (
          <OrdersLandingSkeleton />
        ) : tabs.length === 0 ? (
          <div className="px-6 py-6 xl:px-8">
            <div className="rounded-[20px] border border-[var(--border-1)] bg-[var(--bg-surface)] px-5 py-6 text-center">
              <p className="text-base font-semibold text-cream-800">Orders are unavailable</p>
              <p className="mt-2 text-sm text-cream-600">Your distributor has not enabled document tracking for this account yet.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-6 pt-6 xl:px-8">
              <OrdersKpiGrid metrics={metricsQuery.data} />
            </div>

            <div className="px-6 pt-1 xl:px-8">
              <OrdersTabButtons tabs={tabs} activeTab={activeTab} onChange={handleTabChange} desktop />
            </div>

            {isPreviewTab() ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 xl:px-8">
                {previewContent()}
              </div>
            ) : (
              <div className="min-h-0 flex-1 px-6 pb-6 xl:px-8">
                <ResizablePanelGroup direction="horizontal" autoSaveId="buyer-orders-split-pane" className="h-full">
                  <ResizablePanel defaultSize={30} minSize={24} className="h-full min-h-0">
                    <div className="flex h-full min-h-0 flex-col pr-4">
                      <div className="flex-none space-y-3 py-4">
                        <OrdersSearchField value={search} onChange={setSearch} placeholder={searchPlaceholder} />
                        <div className="min-w-0">{filterRow}</div>
                      </div>
                      <div className="min-h-0 flex-1">{renderActiveTab(true)}</div>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={70} minSize={46} className="h-full min-h-0">
                    <div className="h-full min-h-0 pl-4">
                      {detailConfig ? (
                        <DesktopTransactionDetailPane
                          endpoint={detailConfig.endpoint}
                          emptyLabel="Select a transaction to inspect its details."
                          docType={detailConfig.docType}
                          respectBusinessPolicyTotals={detailConfig.respectBusinessPolicyTotals}
                          pickDoc={detailConfig.pickDoc}
                        />
                      ) : (
                        <div className="flex h-full min-h-0 items-center justify-center rounded-[20px] border border-cream-200 bg-[var(--bg-surface)] px-6 text-center text-sm text-cream-600">
                          Select a transaction to inspect its details.
                        </div>
                      )}
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<OrdersLandingSkeleton />}>
      <OrdersPageInner />
    </Suspense>
  );
}
