'use client';

import Link from 'next/link';
import { ArrowRight, Lightbulb } from 'lucide-react';

import { insightText } from '@/lib/pulse/insight-copy';

import { usePulseInsights } from './usePulseInsights';

const ACTION_LABELS: Record<string, string> = {
  'pulse.action.open_inbox': 'Open Inbox',
  'pulse.action.see_customers': 'See customers',
  'pulse.action.see_funnel': 'See the breakdown',
  'pulse.action.see_sales': 'See what sells',
};

/** Rules-based read-outs fed by the same data as the bands below (React Query dedupes the requests). */
export function PulseInsights({ query }: { query: string }) {
  const { insights } = usePulseInsights(query);
  if (insights.length === 0) return null;

  return (
    <section aria-label="Worth knowing">
      <ul className="space-y-2">
        {insights.map((insight) => (
          <li key={insight.id} className="flex items-start gap-3 rounded-[8px] border border-cream-200 bg-cream-50 px-4 py-3">
            <Lightbulb size={16} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm leading-5 text-cream-900">{insightText(insight)}</p>
            <Link href={insight.action.href} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-teal-700 no-underline hover:text-teal-800">
              {ACTION_LABELS[insight.action.labelKey] ?? 'Open'}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
