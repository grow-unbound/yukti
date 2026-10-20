'use client';

import { ChevronDown } from 'lucide-react';

import { usePulsePatterns } from '@/hooks/usePulseV2';
import { formatNumberValue } from '@/lib/utils';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekday pattern of quotes; collapsed by default (assessment §4 "Rhythm"). */
export function PulseRhythm({ query }: { query: string }) {
  const q = usePulsePatterns(query);
  const days = q.data?.weekdays ?? [];
  const total = days.reduce((n, d) => n + d.quotes, 0);
  const max = Math.max(1, ...days.map((d) => d.quotes));
  if (q.isError || (q.data && total === 0)) return null;

  return (
    <details className="group rounded-[14px] border border-cream-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
        <span>
          <span className="block font-display text-lg font-semibold text-cream-950">When customers order</span>
          <span className="mt-1 block text-sm text-cream-700">Quotes by day of the week in this period.</span>
        </span>
        <ChevronDown size={18} className="shrink-0 text-cream-600 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="px-5 pb-5">
        <div className="flex h-28 items-end gap-2" role="img" aria-label="Quotes by day of the week">
          {days.map((d) => (
            <div key={d.dow} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${DAYS[d.dow - 1]}: ${d.quotes} quotes`}>
              <span className="text-xs text-cream-700">{formatNumberValue(d.quotes, 'COUNT')}</span>
              <div className="w-full rounded-t bg-teal-600/80" style={{ height: `${Math.max(d.quotes > 0 ? 4 : 1, Math.round((d.quotes / max) * 80))}%` }} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2 text-center text-xs font-medium text-cream-700">
          {days.map((d) => <span key={d.dow} className="flex-1">{DAYS[d.dow - 1]}</span>)}
        </div>
      </div>
    </details>
  );
}
