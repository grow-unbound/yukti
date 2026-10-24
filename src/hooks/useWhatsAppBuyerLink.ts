'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, apiPost } from '@/lib/api-fetch';
import { NAVIGATION_QUERY_GC_TIME, NAVIGATION_QUERY_STALE_TIME } from '@/lib/query-navigation';

export interface WhatsAppAmbiguousCandidate {
  buyer_id: string;
  business_name: string;
  role: string | null;
}

export interface WhatsAppBuyerSearchResult {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
}

interface CandidatesPayload {
  ambiguous: WhatsAppAmbiguousCandidate[];
  results: WhatsAppBuyerSearchResult[];
}

/** The email inbox reuses these hooks; only the route segment differs. */
export type BuyerLinkChannel = 'whatsapp' | 'email';

export function useWhatsAppBuyerCandidates(entryId: string, search: string, enabled: boolean, channel: BuyerLinkChannel = 'whatsapp') {
  return useQuery({
    queryKey: [`inbox-${channel}-buyer-candidates`, entryId, search],
    enabled,
    queryFn: async () => {
      const res = await apiFetch(
        `/api/tenant/entries/${entryId}/${channel}-buyer-candidates?q=${encodeURIComponent(search)}`,
        { fresh: true },
      );
      if (!res.ok) throw new Error('Failed to load buyers');
      return ((await res.json()) as { data: CandidatesPayload }).data;
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
    placeholderData: keepPreviousData,
  });
}

export function useLinkWhatsAppBuyer(channel: BuyerLinkChannel = 'whatsapp') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, buyerId }: { entryId: string; buyerId: string }) => {
      const res = await apiPost(`/api/tenant/entries/${entryId}/${channel}-buyer`, { buyer_id: buyerId });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to link buyer');
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
    },
  });
}
