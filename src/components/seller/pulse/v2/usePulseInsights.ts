'use client';

import { useMemo } from 'react';

import { usePulseActNow, usePulseFunnel, usePulsePatterns, usePulseScorecard, usePulseSellThrough } from '@/hooks/usePulseV2';
import { buildInsights } from '@/lib/pulse/insights';

/** Insights for the selected period from the same cached band queries (React Query dedupes the requests). */
export function usePulseInsights(query: string) {
  const scorecard = usePulseScorecard(query).data ?? null;
  const actNow = usePulseActNow(query).data ?? null;
  const funnel = usePulseFunnel(query).data ?? null;
  const brands = usePulseSellThrough(query, 'brand').data ?? null;
  const patterns = usePulsePatterns(query).data ?? null;
  const insights = useMemo(() => buildInsights({ scorecard, actNow, funnel, brands, patterns }), [scorecard, actNow, funnel, brands, patterns]);
  return { insights, scorecard };
}
