'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api-fetch';
import { NAVIGATION_QUERY_GC_TIME, NAVIGATION_QUERY_STALE_TIME } from '@/lib/query-navigation';
import type { PulseDemandSignalKind, PulseDemandSignalsResponse } from '@/types/pulse';
import type {
  PulseActBuyersPage,
  PulseActGroupId,
  PulseActNowResponse,
  PulseCustomersResponse,
  PulseFunnelResponse,
  PulsePatternsResponse,
  PulseScorecardResponse,
  PulseSellDimension,
  PulseSellThroughResponse,
} from '@/types/pulse-v2';

// `query` is the period query string from pulsePeriodQuery() (period, from, to, cmp). Keys include it so each
// period is cached separately; keepPreviousData keeps the old numbers on screen while a new period loads.
async function getJson<T>(path: string, query: string, label: string): Promise<T> {
  const response = await apiFetch(`${path}${query ? `?${query}` : ''}`);
  if (!response.ok) throw new Error(`Failed to load Pulse ${label}`);
  return response.json() as Promise<T>;
}

const base = { staleTime: NAVIGATION_QUERY_STALE_TIME, gcTime: NAVIGATION_QUERY_GC_TIME, placeholderData: keepPreviousData } as const;

export function usePulseScorecard(query: string) {
  return useQuery<PulseScorecardResponse>({
    queryKey: ['pulse-v2', 'scorecard', query],
    queryFn: () => getJson('/api/tenant/pulse/scorecard', query, 'scorecard'),
    ...base,
  });
}

export function usePulseActNow(query: string) {
  return useQuery<PulseActNowResponse>({
    queryKey: ['pulse-v2', 'act-now', query],
    queryFn: () => getJson('/api/tenant/pulse/act-now', query, 'opportunities'),
    ...base,
  });
}

export function usePulseFunnel(query: string, enabled = true) {
  return useQuery<PulseFunnelResponse>({
    queryKey: ['pulse-v2', 'funnel', query],
    queryFn: () => getJson('/api/tenant/pulse/funnel', query, 'funnel'),
    enabled,
    ...base,
  });
}

export function usePulseSellThrough(query: string, by: PulseSellDimension, enabled = true) {
  return useQuery<PulseSellThroughResponse>({
    queryKey: ['pulse-v2', 'sellthrough', by, query],
    queryFn: () => getJson('/api/tenant/pulse/sellthrough', `${query}${query ? '&' : ''}by=${by}`, 'sell-through'),
    enabled,
    ...base,
  });
}

export function usePulseCustomers(query: string, enabled = true) {
  return useQuery<PulseCustomersResponse>({
    queryKey: ['pulse-v2', 'customers', query],
    queryFn: () => getJson('/api/tenant/pulse/customers', query, 'customers'),
    enabled,
    ...base,
  });
}

export function usePulsePatterns(query: string, enabled = true) {
  return useQuery<PulsePatternsResponse>({
    queryKey: ['pulse-v2', 'patterns', query],
    queryFn: () => getJson('/api/tenant/pulse/patterns', query, 'patterns'),
    enabled,
    ...base,
  });
}

export function usePulseActBuyers(group: PulseActGroupId | null, query: string) {
  return useInfiniteQuery<PulseActBuyersPage>({
    queryKey: ['pulse-v2', 'act-buyers', group, query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query);
      params.set('limit', '25');
      params.set('offset', String(pageParam ?? 0));
      return getJson(`/api/tenant/pulse/act-now/${group}`, params.toString(), 'customers');
    },
    enabled: Boolean(group),
    initialPageParam: 0 as number,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    ...base,
  });
}

// Demand signals come from the daily storefront snapshot, not the selected period: they keep their own window.
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
