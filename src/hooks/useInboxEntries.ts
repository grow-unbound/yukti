'use client';

import { useQuery, useQueries, useInfiniteQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch, apiPatch, apiPost } from '@/lib/api-fetch';
import {
  NAVIGATION_QUERY_STALE_TIME,
  NAVIGATION_QUERY_GC_TIME,
  REFERENCE_QUERY_STALE_TIME,
  REFERENCE_QUERY_GC_TIME,
} from '@/lib/query-navigation';
import { dedupeApprovalEntries } from '@/lib/inbox/inbox-grouping';
import type { OutstandingInvoice } from '@/lib/inbox/inbox-detail-groups';
import type { InboxEntry } from '@/lib/inbox/inbox-types';
import type { EnquiryTriagePayload } from '@/lib/inbox/enquiry-triage';

export interface EntryHistoryEvent {
  id: string;
  entry_id: string;
  entry_type: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_id: string | null;
  created_at: string;
}

export function inboxEntriesQueryKey(status: 'active' | 'resolved', entryTypes?: string[]) {
  return ['inbox-entries', status, (entryTypes ?? []).join(',')] as const;
}

interface InboxEntriesPage {
  entries: InboxEntry[];
  nextCursor: string | null;
}

/**
 * Cursor-paginated Inbox list. `data` is the flattened `{ entries }` of every
 * page fetched so far; the list client fetches the next page via
 * `fetchNextPage` when the scroll sentinel comes into view.
 */
export function useInboxEntries(status: 'active' | 'resolved', entryTypes?: string[]) {
  return useInfiniteQuery({
    queryKey: inboxEntriesQueryKey(status, entryTypes),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ status });
      if (entryTypes && entryTypes.length > 0) params.set('type', entryTypes.join(','));
      if (pageParam) params.set('cursor', pageParam);
      const res = await apiFetch(`/api/tenant/entries?${params.toString()}`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load Inbox entries');
      return (await res.json()) as InboxEntriesPage;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    select: (data) => ({
      entries: dedupeApprovalEntries(data.pages.flatMap((page) => page.entries)),
      nextCursor: data.pages[data.pages.length - 1]?.nextCursor ?? null,
    }),
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
    placeholderData: keepPreviousData,
  });
}

export function useBuyerOutstandingInvoices(buyerId: string | null) {
  return useQuery({
    queryKey: ['inbox-buyer-outstanding-invoices', buyerId],
    enabled: buyerId != null,
    queryFn: async () => {
      const res = await apiFetch(`/api/tenant/customers/${buyerId}/outstanding-invoices`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load outstanding invoices');
      return (await res.json()) as { invoices: OutstandingInvoice[] };
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

interface GenericActionInput {
  entryId: string;
  action: 'open' | 'remind_later' | 'add_note' | 'dismiss' | 'reopen';
  note?: string;
  remind_at?: string;
}

export function useApplyGenericEntryAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, ...body }: GenericActionInput) => {
      const res = await apiPost(`/api/tenant/entries/${entryId}/actions`, body);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to update entry');
      }
      const payload = (await res.json()) as { data: InboxEntry };
      return payload.data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
    },
  });
}

export function useSendWhatsAppInboxReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, body }: { entryId: string; body: string }) => {
      const res = await apiPost(`/api/tenant/entries/${entryId}/whatsapp-reply`, { body });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to send WhatsApp reply');
      }
      return (await res.json()) as { data: { message_id: string; enqueued: boolean } };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
    },
  });
}

export interface EntryDocument {
  id: string;
  doc_type: 'shop_image' | 'gst_certificate';
  subject_scope: 'personal' | 'business';
  uploaded_at: string;
  verified: boolean;
}

export function useEntryDocuments(entryId: string) {
  return useQuery({
    queryKey: ['inbox-entry-documents', entryId],
    queryFn: async () => {
      const res = await apiFetch(`/api/tenant/entries/${entryId}/documents`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load documents');
      return (await res.json()) as { documents: EntryDocument[] };
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

/**
 * Mints a fresh signed download URL for one document. Deliberately not a
 * cached query — the URL is short-lived, so this is called imperatively
 * right when the seller opens the preview dialog or clicks Download, never
 * prefetched or reused (Yukti_Public-Signup_Frontend-Spec_v1.md §6/§1.2).
 */
export async function fetchDocumentSignedUrl(
  entryId: string,
  docId: string,
): Promise<{ url: string; doc_type: string }> {
  const res = await apiFetch(`/api/tenant/entries/${entryId}/documents/${docId}/signed-url`, { fresh: true });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? 'Failed to load document');
  }
  return (await res.json()) as { url: string; doc_type: string };
}

interface ApprovalActionInput {
  entryId: string;
  action: 'approve' | 'decline' | 'request_more_info';
  note?: string;
  metadata?: Record<string, unknown>;
  /** approve only: confirmed customer group (null = explicit "No group - use default pricing"). */
  cohort_id?: string | null;
  /** approve only: optional buyer-level price list override. */
  price_list_id?: string | null;
  /** approve only: must be true - the seller has confirmed the group / price list choice. */
  assignment_confirmed?: boolean;
}

export interface ApprovalCohortOption {
  id: string;
  name: string;
  membership_mode: 'manual' | 'automatic';
  eligible: boolean;
  member_count: number;
  ineligible_reason: string | null;
}

export interface ApprovalPriceListOption {
  id: string;
  name: string;
  priority: number | null;
  has_zoho_pricebook: boolean;
}

export interface ApprovalAssignmentOptions {
  cohorts: ApprovalCohortOption[];
  price_lists: ApprovalPriceListOption[];
  default_cohort_id: string | null;
  zoho_active: boolean;
}

export interface ApprovalPriceSource {
  tier: number;
  source: 'buyer' | 'group' | 'all_buyers';
  price_list_id: string;
  name: string;
  priority: number | null;
}

export interface ApprovalPricePreview {
  headline: ApprovalPriceSource | null;
  applicable: ApprovalPriceSource[];
}

export function useApprovalAssignmentOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['inbox-approval-options'],
    enabled,
    queryFn: async () => {
      const res = await apiFetch('/api/tenant/entries/approval-options', { fresh: true });
      if (!res.ok) throw new Error('Failed to load customer groups and price lists');
      return (await res.json()) as ApprovalAssignmentOptions;
    },
    staleTime: REFERENCE_QUERY_STALE_TIME,
    gcTime: REFERENCE_QUERY_GC_TIME,
  });
}

export function useApprovalPricePreview(cohortId: string | null, priceListId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['inbox-approval-price-preview', cohortId, priceListId],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cohortId) params.set('cohort_id', cohortId);
      if (priceListId) params.set('price_list_id', priceListId);
      const res = await apiFetch(`/api/tenant/entries/approval-price-preview?${params.toString()}`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load price preview');
      return (await res.json()) as ApprovalPricePreview;
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
    placeholderData: keepPreviousData,
  });
}

export function useRetryZohoSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await apiPost(`/api/tenant/entries/${entryId}/actions`, { action: 'retry_zoho_sync' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to retry Zoho sync');
      }
      return (await res.json()) as { data: InboxEntry };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
    },
  });
}

interface CollectionReminderInput {
  buyerId: string;
  entryIds: string[];
  note?: string;
}

/**
 * Approve / decline / request-more-info on a `business_approval` /
 * `new_user_login` entry — calls the same POST .../actions route as the
 * generic mutation above, but for the approval-specific action set that
 * requires richer client-side UI (document review, a missing-fields
 * checklist, a decline confirmation) rather than the bare one-click generic
 * actions.
 */
export function useApplyApprovalEntryAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, ...body }: ApprovalActionInput) => {
      const res = await apiPost(`/api/tenant/entries/${entryId}/actions`, body);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to update entry');
      }
      const payload = (await res.json()) as { data: InboxEntry };
      return payload.data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-approval-options'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
    },
  });
}

export function useSendCollectionReminder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CollectionReminderInput) => {
      const res = await apiPost('/api/tenant/entries/collections/remind', {
        buyer_id: body.buyerId,
        entry_ids: body.entryIds,
        note: body.note,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to send reminder');
      }
      return (await res.json()) as {
        data: {
          entry_ids: string[];
          last_reminder_at: string;
          recipient_phone: string;
          message: string;
        };
      };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
      queryClient.invalidateQueries({ queryKey: ['tenant-invoices'] });
    },
  });
}

export function useEntryHistory(buyerId: string | null) {
  return useQuery({
    queryKey: ['inbox-entry-history', buyerId],
    queryFn: async () => {
      const res = await apiFetch(`/api/tenant/entries/buyer/${buyerId}/events`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load history');
      return (await res.json()) as { events: EntryHistoryEvent[] };
    },
    enabled: buyerId != null,
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

export function useInboxActiveCount() {
  return useQuery({
    queryKey: ['inbox-active-count'],
    queryFn: async () => {
      const res = await apiFetch('/api/tenant/entries/count', { fresh: true });
      if (!res.ok) throw new Error('Failed to load count');
      return (await res.json()) as { count: number };
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

export function useEnquiryTriage(entryId: string, enabled = true) {
  return useQuery({
    queryKey: ['inbox-entry-enquiry', entryId],
    enabled,
    queryFn: async () => {
      const res = await apiFetch(`/api/tenant/entries/${entryId}/enquiry`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load enquiry');
      return (await res.json()) as EnquiryTriagePayload;
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

/**
 * Batch variant of `useEnquiryTriage` for the Today list row -- one row per
 * buyer, so enriching a handful of rows (this list is bounded to "today's"
 * open items, not a paginated catalog) with item count / at-risk needs the
 * same triage payload each row's own detail screen will reuse. Shares the
 * exact query key `useEnquiryTriage` uses, so opening a row afterwards is an
 * instant cache hit, not a second fetch.
 */
export function useEnquiryTriageByIds(entryIds: string[]) {
  const results = useQueries({
    queries: entryIds.map((entryId) => ({
      queryKey: ['inbox-entry-enquiry', entryId],
      queryFn: async () => {
        const res = await apiFetch(`/api/tenant/entries/${entryId}/enquiry`, { fresh: true });
        if (!res.ok) throw new Error('Failed to load enquiry');
        return (await res.json()) as EnquiryTriagePayload;
      },
      staleTime: NAVIGATION_QUERY_STALE_TIME,
      gcTime: NAVIGATION_QUERY_GC_TIME,
    })),
  });

  const byEntryId = new Map<string, EnquiryTriagePayload>();
  entryIds.forEach((entryId, index) => {
    const data = results[index]?.data;
    if (data) byEntryId.set(entryId, data);
  });
  return byEntryId;
}

export function useSubstituteEnquiryLine(entryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ estimateId, lineId, tenantProductId }: { estimateId: string; lineId: string; tenantProductId: string }) => {
      const res = await apiPatch(`/api/tenant/estimates/${estimateId}/items/${lineId}/substitute`, {
        tenant_product_id: tenantProductId,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to substitute product');
      }
      return (await res.json()) as { data: { ok: true } };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-enquiry', entryId] });
    },
  });
}
