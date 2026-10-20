'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api-fetch';
import { NAVIGATION_QUERY_GC_TIME, NAVIGATION_QUERY_STALE_TIME } from '@/lib/query-navigation';
import type {
  PulseContributionResponse,
  PulseDemandSignalKind,
  PulseDemandSignalsResponse,
  PulseOpportunityBuyerPage,
  PulseOpportunityGroup,
  PulseOpportunitiesResponse,
} from '@/types/pulse';

export function usePulseContribution() {
  return useQuery<PulseContributionResponse>({
    queryKey: ['pulse', 'contribution'],
    queryFn: async () => {
      const response = await apiFetch('/api/tenant/pulse/contribution');
      if (!response.ok) throw new Error('Failed to load Pulse contribution');
      return response.json() as Promise<PulseContributionResponse>;
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

export function usePulseOpportunities() {
  return useQuery<PulseOpportunitiesResponse>({
    queryKey: ['pulse', 'opportunities'],
    queryFn: async () => {
      const response = await apiFetch('/api/tenant/pulse/opportunities');
      if (!response.ok) throw new Error('Failed to load Pulse opportunities');
      return response.json() as Promise<PulseOpportunitiesResponse>;
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

async function fetchPulseDemandSignals() {
  const response = await apiFetch('/api/tenant/pulse/demand-signals');
  if (!response.ok) throw new Error('Failed to load Pulse demand signals');
  return response.json() as Promise<PulseDemandSignalsResponse>;
}

export function usePulseDemandSignal(kind: PulseDemandSignalKind) {
  return useQuery<PulseDemandSignalsResponse>({
    queryKey: ['pulse', 'demand-signals', kind],
    queryFn: fetchPulseDemandSignals,
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}

export function usePulseOpportunityBuyers(id: PulseOpportunityGroup['id'] | null, enabled: boolean) {
  return useInfiniteQuery<PulseOpportunityBuyerPage>({
    queryKey: ['pulse', 'opportunity-buyers', id],
    queryFn: async ({ pageParam }) => {
      if (!id) throw new Error('Missing Pulse opportunity id');
      const params = new URLSearchParams();
      params.set('limit', '20');
      if (pageParam) params.set('cursor', String(pageParam));
      const response = await apiFetch(`/api/tenant/pulse/opportunities/${id}/buyers?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to load Pulse opportunity buyers');
      return response.json() as Promise<PulseOpportunityBuyerPage>;
    },
    enabled: enabled && Boolean(id),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
  });
}
