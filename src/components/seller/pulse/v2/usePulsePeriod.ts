'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { pulsePeriodInputFromSearch, pulsePeriodQuery, resolvePulsePeriod, type PulsePeriodInput } from '@/lib/pulse/period';

/** Period state lives in the URL (?period=&from=&to=&cmp=) so it is shareable and survives reloads. */
export function usePulsePeriod() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const input = useMemo(() => pulsePeriodInputFromSearch(new URLSearchParams(search.toString())), [search]);
  const resolved = useMemo(() => resolvePulsePeriod(input), [input]);
  const query = useMemo(() => pulsePeriodQuery({ ...input, period: resolved.ok ? resolved.period.key : 'mtd' }), [input, resolved]);

  const setInput = useCallback(
    (next: PulsePeriodInput) => {
      const q = pulsePeriodQuery(next);
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  return { input, resolved, query, setInput };
}
