'use client';

import { Suspense } from 'react';

import { DemandSignalsSection } from '../PulseDashboardClient';
import { PulseActNow } from './PulseActNow';
import { PulseFunnel } from './PulseFunnel';
import { PulseInsights } from './PulseInsights';
import { PulsePeriodBar } from './PulsePeriodBar';
import { PulseScorecard } from './PulseScorecard';
import { usePulsePeriod } from './usePulsePeriod';

function PulseV2Body() {
  const { input, resolved, query, setInput } = usePulsePeriod();

  return (
    <div className="mx-auto w-full max-w-[1920px] px-8 py-6">
      <header className="mb-5">
        <p className="eyebrow text-cream-600">Pulse</p>
        <h1 className="font-display text-[var(--b-text-page-sm)] font-semibold leading-[0.96] text-cream-900 md:text-xl md:font-extrabold md:leading-[1]">
          Pulse
        </h1>
        <p className="mt-2 max-w-[68ch] text-md leading-6 text-cream-700">
          How your customers are using the app, what it is bringing in, and who to follow up with next.
        </p>
      </header>
      <PulsePeriodBar period={resolved.ok ? resolved.period : null} input={input} error={resolved.ok ? null : resolved.error} onChange={setInput} />
      {resolved.ok ? (
        <div className="space-y-5">
          <PulseInsights query={query} />
          <PulseScorecard query={query} />
          <PulseActNow query={query} />
          <PulseFunnel query={query} />
          <DemandSignalsSection />
        </div>
      ) : null}
    </div>
  );
}

export function PulseV2Client() {
  // useSearchParams needs a Suspense boundary; the fallback mirrors the page header height.
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-[1920px] px-8 py-6" />}>
      <PulseV2Body />
    </Suspense>
  );
}
