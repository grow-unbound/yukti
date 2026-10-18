'use client';

import { ErrorState } from '@/components/ui/empty-state';
import { InsightStrip4 } from '@/components/seller/layout';
import { usePulseScorecard } from '@/hooks/usePulseV2';
import { buildScorecardTiles } from '@/lib/pulse/scorecard-tiles';

import { PulseBandShell } from './PulseBandShell';

export function PulseScorecardSkeleton() {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-3 xl:grid-cols-5">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="min-h-[132px] animate-pulse rounded-[14px] border border-cream-200 bg-cream-100 px-[18px] py-[16px]">
          <div className="h-3 w-24 rounded bg-cream-200" />
          <div className="mt-5 h-7 w-28 rounded bg-cream-200" />
          <div className="mt-4 h-3 w-36 rounded bg-cream-200" />
        </div>
      ))}
    </div>
  );
}

export function PulseScorecard({ query }: { query: string }) {
  const q = usePulseScorecard(query);
  return (
    <PulseBandShell
      title="How the app is doing"
      subtitle="Orders and quotes your customers sent through the app, what became invoices, and how much of your sales it carries."
      isFetching={q.isFetching && !q.isLoading}
    >
      {q.isLoading ? <PulseScorecardSkeleton /> : null}
      {q.isError ? (
        <div className="mt-4">
          <ErrorState heading="This summary could not load" description="The rest of Pulse remains available. Try again in a moment." />
        </div>
      ) : null}
      {q.data ? (
        <InsightStrip4
          className="md:grid-cols-3 xl:grid-cols-5"
          tiles={buildScorecardTiles(q.data).map(({ label, value, sub, delta, deltaTone, tone }) => ({ label, value, sub, delta, deltaTone, tone }))}
        />
      ) : null}
    </PulseBandShell>
  );
}
