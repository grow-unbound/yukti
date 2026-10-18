'use client';

import { useState } from 'react';
import { Download, MessageCircle, Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-fetch';
import { addDays, type PulsePeriod } from '@/lib/pulse/period';
import { buildReviewText } from '@/lib/pulse/review';

import { usePulseInsights } from './usePulseInsights';

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const rangeLabel = (period: PulsePeriod) =>
  period.window.toExcl === addDays(period.window.from, 1) ? fmt(period.window.from) : `${fmt(period.window.from)} – ${fmt(addDays(period.window.toExcl, -1))}`;

/** Share the review for the selected period: print / save as PDF, download, or send a short summary on WhatsApp. */
export function PulseShareMenu({ query, period }: { query: string; period: PulsePeriod }) {
  const { insights, scorecard } = usePulseInsights(query);
  const [busy, setBusy] = useState<'print' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchReview(download: boolean): Promise<Blob> {
    const params = new URLSearchParams(query);
    if (download) params.set('download', '1');
    const response = await apiFetch(`/api/tenant/pulse/review?${params.toString()}`);
    if (!response.ok) throw new Error('review failed');
    return new Blob([await response.text()], { type: 'text/html;charset=utf-8' });
  }

  async function printReview() {
    setError(null);
    setBusy('print');
    // Open the tab inside the click so popup blockers allow it, then point it at the report.
    const tab = window.open('', '_blank');
    try {
      const blob = await fetchReview(false);
      if (tab) tab.location.href = URL.createObjectURL(blob);
    } catch {
      tab?.close();
      setError('The review could not be prepared. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  }

  async function downloadReview() {
    setError(null);
    setBusy('download');
    try {
      const blob = await fetchReview(true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `app-review-${period.window.from}.html`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('The review could not be prepared. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  }

  function shareOnWhatsApp() {
    if (!scorecard) return;
    const text = buildReviewText({ periodLabel: period.label, rangeLabel: rangeLabel(period), scorecard, insights });
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 md:w-auto" role="group" aria-label="Share this review">
      <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={printReview}>
        <Printer size={16} aria-hidden="true" />
        Print or PDF
      </Button>
      <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={downloadReview}>
        <Download size={16} aria-hidden="true" />
        Download
      </Button>
      <Button type="button" size="sm" variant="secondary" disabled={!scorecard} onClick={shareOnWhatsApp}>
        <MessageCircle size={16} aria-hidden="true" />
        Share on WhatsApp
      </Button>
      {error ? <p className="w-full text-sm text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
