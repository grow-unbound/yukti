'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Bot, Mail, MessageCircle, Phone, Smartphone, UserRound, Workflow } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/ui/empty-state';
import { CountChip } from '@/components/ui/badge';
import { PageHeader } from '@/components/seller/layout/PageHeader';
import { PageWrap } from '@/components/seller/layout/PageWrap';
import { StickyListHeader } from '@/components/seller/layout/StickyListHeader';
import { SellerMobileList, SellerMobileListSkeleton, type SellerMobileListItem } from '@/components/seller/mobile/SellerMobileList';
import { useApplyGenericEntryAction, useEnquiryTriageByIds, useInboxEntries } from '@/hooks/useInboxEntries';
import { useFlagState } from '@/hooks/useFeatureFlag';
import { useInfiniteScroll, getSentinelInsertIndex } from '@/hooks/useInfiniteScroll';
import { useTenantSettings } from '@/hooks/useTenantSettings';
import { SELLER_INFINITE_SCROLL_RATIO } from '@/lib/seller-ui';
import { groupEntriesByDateAndCustomer } from '@/lib/inbox/inbox-grouping';
import { TIME_BUCKET_LABEL, type InboxEntryType, type InboxGroupedBuyer } from '@/lib/inbox/inbox-types';
import { buildListSupportingLine } from '@/lib/inbox/inbox-entry-copy';
import { buildEnquiryPreviewLine, enquiryHasAtRiskLine } from '@/lib/inbox/inbox-list-entry-copy';
import type { EnquiryTriagePayload } from '@/lib/inbox/enquiry-triage';
import { sourceChannelForEntries, type InboxChannel } from '@/lib/inbox/inbox-detail-groups';
import { TODAY_LAST_OPENED_COOKIE, TODAY_VIEWPORT_COOKIE, writeClientCookie } from '@/lib/inbox/inbox-default-buyer';
import { InboxEmptyState } from './InboxEmptyState';

type InboxFeatureKey = 'approvals' | 'enquiries' | 'orders' | 'collections';

const FILTER_CHIPS: Array<{ label: string; types: InboxEntryType[]; feature: InboxFeatureKey }> = [
  { label: 'Approvals', types: ['business_approval', 'new_user_login'], feature: 'approvals' },
  { label: 'Enquiries', types: ['new_enquiry'], feature: 'enquiries' },
  { label: 'Orders', types: ['new_order_confirmation', 'order_dispatch_needed'], feature: 'orders' },
  { label: 'Collections', types: ['invoice_due', 'invoice_overdue', 'credit_limit_breach'], feature: 'collections' },
];

function entryFeature(entryType: InboxEntryType): InboxFeatureKey | 'messages' {
  if (entryType === 'business_approval' || entryType === 'new_user_login') return 'approvals';
  if (entryType === 'new_enquiry') return 'enquiries';
  if (entryType === 'new_order_confirmation' || entryType === 'order_dispatch_needed') return 'orders';
  if (entryType === 'invoice_due' || entryType === 'invoice_overdue' || entryType === 'credit_limit_breach') return 'collections';
  return 'messages';
}

function visibleEntry(entryType: InboxEntryType, availability: Record<InboxFeatureKey, boolean>): boolean {
  const feature = entryFeature(entryType);
  return feature === 'messages' || availability[feature];
}

const CHANNEL_ICON: Record<InboxChannel, typeof Smartphone> = {
  storefront: Smartphone,
  backend: Workflow,
  manual: UserRound,
  whatsapp: MessageCircle,
  email: Mail,
  phone: Phone,
  unknown: Bot,
};

function ChannelBadge({ channel }: { channel: InboxChannel }) {
  const Icon = CHANNEL_ICON[channel] ?? Bot;
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-cream-300 bg-white text-cream-700" title={channel}>
      <Icon className="h-4 w-4" strokeWidth={1.85} aria-hidden />
    </span>
  );
}

function buyerListItem(
  buyer: InboxGroupedBuyer,
  activeId: string | undefined,
  enquiryByEntryId: Map<string, EnquiryTriagePayload>,
  reviewedEntryIds: Set<string>,
  onReviewBuyer: (buyer: InboxGroupedBuyer) => void,
): SellerMobileListItem {
  // entries is ordered pinned-first, then newest -- entries[0] is what the row's
  // summary should describe, same "primary entry" convention buildListSupportingLine
  // already uses.
  const primary = buyer.entries[0];
  const enquiry = primary?.entry_type === 'new_enquiry' ? enquiryByEntryId.get(primary.id) : undefined;
  const atRisk = enquiry ? enquiryHasAtRiskLine(enquiry.lines) : false;
  const hasUnreadNewEntry = buyer.entries.some((entry) => entry.status === 'new' && !reviewedEntryIds.has(entry.id));

  return {
    id: buyer.buyerKey,
    href: `/inbox/${buyer.buyerId ?? buyer.buyerKey}`,
    leading: <ChannelBadge channel={sourceChannelForEntries(buyer.entries)} />,
    eyebrow: enquiry ? enquiry.estimateNumber : undefined,
    primary: buyer.buyerName,
    supporting: enquiry ? buildEnquiryPreviewLine(enquiry.lines, enquiry.totalAmount) : buildListSupportingLine(buyer.entries),
    trailing: buyer.totalCount > 1 ? <CountChip>{buyer.totalCount}</CountChip> : undefined,
    status: atRisk
      ? { label: 'Stock gap', tone: 'warning' }
      : primary?.entry_type === 'business_approval'
        ? { label: 'Business', tone: 'info' }
        : undefined,
    badge: hasUnreadNewEntry ? 'new' : undefined,
    selected: activeId === buyer.buyerId || activeId === buyer.buyerKey,
    onClick: () => {
      writeClientCookie(TODAY_LAST_OPENED_COOKIE, buyer.buyerKey);
      onReviewBuyer(buyer);
    },
  };
}

export function InboxListClient() {
  const params = useParams<{ id?: string }>();
  const { data: tenantSettings } = useTenantSettings();
  const estimatesFlag = useFlagState('ESTIMATES');
  const salesOrdersFlag = useFlagState('SALES_ORDERS');
  const invoicesFlag = useFlagState('INVOICES');
  const [tab, setTab] = useState<'active' | 'resolved'>('active');
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [reviewedEntryIds, setReviewedEntryIds] = useState<Set<string>>(() => new Set());
  const markOpen = useApplyGenericEntryAction();
  const orderFeatures = tenantSettings?.modules.orders.features;
  const featureAvailability = useMemo<Record<InboxFeatureKey, boolean>>(() => ({
    approvals: true,
    enquiries: estimatesFlag !== false && orderFeatures?.enquiries !== false,
    orders: salesOrdersFlag !== false && orderFeatures?.sales_orders !== false,
    collections: invoicesFlag !== false && orderFeatures?.invoices !== false,
  }), [estimatesFlag, invoicesFlag, orderFeatures, salesOrdersFlag]);
  const visibleFilterChips = useMemo(
    () => FILTER_CHIPS.filter((chip) => featureAvailability[chip.feature]),
    [featureAvailability],
  );

  const chipTypes = activeChip ? visibleFilterChips.find((c) => c.label === activeChip)?.types : undefined;
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInboxEntries(tab, chipTypes);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const unfiltered = useInboxEntries(tab);
  const visibleUnfilteredEntries = useMemo(
    () => (unfiltered.data?.entries ?? []).filter((entry) => visibleEntry(entry.entry_type, featureAvailability)),
    [featureAvailability, unfiltered.data?.entries],
  );
  const visibleFilteredEntries = useMemo(
    () => (data?.entries ?? []).filter((entry) => visibleEntry(entry.entry_type, featureAvailability)),
    [data?.entries, featureAvailability],
  );
  // Counts cover the pages loaded so far; a trailing "+" flags that more remain.
  const countSuffix = unfiltered.hasNextPage ? '+' : '';
  const totalCount = visibleUnfilteredEntries.length;
  const chipCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const chip of visibleFilterChips) {
      counts[chip.label] = visibleUnfilteredEntries.filter((e) => chip.types.includes(e.entry_type)).length;
    }
    return counts;
  }, [visibleFilterChips, visibleUnfilteredEntries]);

  const sections = useMemo(
    () => groupEntriesByDateAndCustomer(visibleFilteredEntries),
    [visibleFilteredEntries],
  );

  const { sentinelRef } = useInfiniteScroll({
    hasMore: hasNextPage ?? false,
    isLoading: isFetchingNextPage,
    rootRef: scrollRef,
    rootMargin: '0px',
    onLoadMore: fetchNextPage,
  });
  // The sentinel sits ~75% down the flattened buyer rows (the app-wide prefetch
  // ratio) so the next page loads before the user reaches the bottom.
  const sentinelGlobalIndex = useMemo(
    () => getSentinelInsertIndex(sections.reduce((n, section) => n + section.buyers.length, 0), SELLER_INFINITE_SCROLL_RATIO),
    [sections],
  );

  const primaryEnquiryEntryIds = useMemo(
    () => sections
      .flatMap((section) => section.buyers)
      .map((buyer) => buyer.entries[0])
      .filter((entry): entry is NonNullable<typeof entry> => entry?.entry_type === 'new_enquiry')
      .map((entry) => entry.id),
    [sections],
  );
  const enquiryByEntryId = useEnquiryTriageByIds(primaryEnquiryEntryIds);

  const reviewBuyer = useCallback(
    (buyer: InboxGroupedBuyer) => {
      const newEntryIds = buyer.entries.filter((entry) => entry.status === 'new').map((entry) => entry.id);
      if (newEntryIds.length > 0) {
        setReviewedEntryIds((prev) => {
          const next = new Set(prev);
          newEntryIds.forEach((entryId) => next.add(entryId));
          return next;
        });
      }
      for (const entry of buyer.entries) {
        if (entry.status === 'new') {
          markOpen.mutate({ entryId: entry.id, action: 'open' });
        }
      }
    },
    [markOpen],
  );

  useEffect(() => {
    if (activeChip && !visibleFilterChips.some((chip) => chip.label === activeChip)) {
      setActiveChip(null);
    }
  }, [activeChip, visibleFilterChips]);

  // Lets the server-side /inbox default-buyer redirect know the real viewport
  // (it otherwise only has the user-agent) so a narrowed desktop window stays on the list.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const sync = () => writeClientCookie(TODAY_VIEWPORT_COOKIE, query.matches ? 'desktop' : 'mobile');
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return (
    <PageWrap className="flex h-full min-h-0 flex-col">
      <StickyListHeader>
        <PageHeader
          eyebrow="Inbox"
          title={tab === 'active' ? `${totalCount}${countSuffix} need${totalCount === 1 && !countSuffix ? 's' : ''} your attention` : 'Resolved'}
          subtitle={
            tab === 'active'
              ? 'Approvals and work items waiting on you'
              : 'Items you have already handled'
          }
          horizon=""
          showHorizonControl={false}
        />
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'active' | 'resolved')}>
          <TabsList className="flex w-full">
            <TabsTrigger value="active">Needs attention</TabsTrigger>
            <TabsTrigger value="resolved">Resolved</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap gap-2 py-4">
          {visibleFilterChips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => setActiveChip((prev) => (prev === chip.label ? null : chip.label))}
              className={[
                'rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
                activeChip === chip.label
                  ? 'border-ember-300 bg-ember-50 text-ember-700'
                  : 'border-cream-300 text-cream-700 hover:bg-cream-100',
              ].join(' ')}
            >
              {chip.label}
              {chipCounts[chip.label] ? <span className="ml-1.5 font-mono tabular-nums text-cream-500">{chipCounts[chip.label]}{countSuffix}</span> : null}
            </button>
          ))}
        </div>
      </StickyListHeader>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-6">
        {isLoading ? (
          <div className="pt-4">
            <SellerMobileListSkeleton forceVisible showLeading />
          </div>
        ) : isError ? (
          <ErrorState
            heading="Couldn't load Inbox"
            description="There was a problem fetching your Inbox entries."
            onRetry={() => refetch()}
          />
        ) : sections.length === 0 ? (
          <InboxEmptyState tab={tab} />
        ) : (
          sections.map(({ bucket, buyers }, sectionIndex) => {
            const offset = sections.slice(0, sectionIndex).reduce((n, section) => n + section.buyers.length, 0);
            const localSentinel = sentinelGlobalIndex - offset;
            return (
              <div key={bucket} className="pt-6">
                <p className="px-3.5 pb-2 text-xs font-medium uppercase tracking-[0.08em] text-cream-500">
                  {TIME_BUCKET_LABEL[bucket]}
                </p>
                <SellerMobileList
                  forceVisible
                  density="roomy"
                  items={buyers.map((buyer) => buyerListItem(buyer, params.id, enquiryByEntryId, reviewedEntryIds, reviewBuyer))}
                  sentinelIndex={localSentinel >= 0 && localSentinel < buyers.length ? localSentinel : undefined}
                  sentinelRef={sentinelRef}
                />
              </div>
            );
          })
        )}
      </div>
    </PageWrap>
  );
}
