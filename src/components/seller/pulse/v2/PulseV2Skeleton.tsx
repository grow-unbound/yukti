import { PulseActNowSkeleton } from './PulseActNow';
import { PulseCustomersSkeleton } from './PulseCustomers';
import { PulseFunnelSkeleton } from './PulseFunnel';
import { PulseScorecardSkeleton } from './PulseScorecard';
import { PulseSellThroughSkeleton } from './PulseSellThrough';

function SectionHead({ titleWidth, subWidth }: { titleWidth: string; subWidth: string }) {
  return (
    <div className="mb-2">
      <div className={`h-6 animate-pulse rounded bg-cream-200 ${titleWidth}`} />
      <div className={`mt-2 h-4 max-w-full animate-pulse rounded bg-cream-200 ${subWidth}`} />
    </div>
  );
}

/** Mirrors PulseV2Client: header, period bar, then the scorecard, act-now, funnel, what-sells and customers bands. */
export function PulseV2Skeleton() {
  return (
    <div className="mx-auto w-full max-w-[1920px] px-8 py-6">
      <div className="mb-5">
        <div className="h-3 w-20 animate-pulse rounded bg-cream-200" />
        <div className="mt-3 h-10 w-40 animate-pulse rounded bg-cream-200" />
        <div className="mt-3 h-5 w-[36rem] max-w-full animate-pulse rounded bg-cream-200" />
      </div>
      <div className="mb-5 space-y-3">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-8 w-24 animate-pulse rounded-[8px] bg-cream-200" />)}
        </div>
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-cream-200" />
      </div>
      <div className="space-y-5">
        <section><SectionHead titleWidth="w-56" subWidth="w-[34rem]" /><PulseScorecardSkeleton /></section>
        <section><SectionHead titleWidth="w-32" subWidth="w-[38rem]" /><PulseActNowSkeleton /></section>
        <section><SectionHead titleWidth="w-60" subWidth="w-[36rem]" /><PulseFunnelSkeleton /></section>
        <section><SectionHead titleWidth="w-44" subWidth="w-[36rem]" /><PulseSellThroughSkeleton /></section>
        <section><SectionHead titleWidth="w-36" subWidth="w-[36rem]" /><PulseCustomersSkeleton /></section>
      </div>
    </div>
  );
}
