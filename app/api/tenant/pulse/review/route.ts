import { NextRequest } from 'next/server';

import { addDays, type PulseWindow } from '@/lib/pulse/period';
import { buildInsights } from '@/lib/pulse/insights';
import { renderReviewHtml, type PulseReviewData } from '@/lib/pulse/review';
import { pulseV2Context } from '@/lib/server/pulse-v2';
import type {
  PulseActNowResponse,
  PulseCustomersResponse,
  PulseFunnelResponse,
  PulsePatternsResponse,
  PulseScorecardResponse,
  PulseSellThroughResponse,
} from '@/types/pulse-v2';

export const dynamic = 'force-dynamic';

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const range = (w: PulseWindow) => (w.toExcl === addDays(w.from, 1) ? fmt(w.from) : `${fmt(w.from)} – ${fmt(addDays(w.toExcl, -1))}`);

/**
 * Printable business review for the selected period (?period=&from=&to=&cmp=). Same RPCs and insight engine as the
 * Pulse bands. `download=1` sends it as an attachment; otherwise it opens inline so the browser can print or save PDF.
 * Bands that fail are left out of the review rather than failing the whole export.
 */
export async function GET(request: NextRequest) {
  const guard = await pulseV2Context(request, 'pulse_review_api');
  if (!guard.ok) return guard.response;
  const { tenantId, period, json, db } = guard.ctx;
  const app = db.schema('app');
  const w = { p_tenant_id: tenantId, p_from: period.window.from, p_to_excl: period.window.toExcl };
  const meta = { period: { key: period.key, label: period.label, thin: period.thin } };
  const ok = async <T,>(call: PromiseLike<{ data: unknown; error: unknown }>, label: string): Promise<T | null> => {
    const { data, error } = await call;
    if (error) {
      console.error(`[GET /api/tenant/pulse/review] ${label} failed`, error);
      return null;
    }
    return { ...meta, ...(data as object) } as T;
  };

  const [scorecard, actNow, funnel, categories, brands, customers, patterns, tenant] = await Promise.all([
    ok<PulseScorecardResponse>(app.rpc('get_pulse_scorecard', { ...w, p_cmp_from: period.compare?.from ?? null, p_cmp_to_excl: period.compare?.toExcl ?? null }), 'scorecard'),
    ok<PulseActNowResponse>(app.rpc('get_pulse_act_now', w), 'act_now'),
    period.activityCapped ? Promise.resolve(null) : ok<PulseFunnelResponse>(app.rpc('get_pulse_funnel', w), 'funnel'),
    period.activityCapped ? Promise.resolve(null) : ok<PulseSellThroughResponse>(app.rpc('get_pulse_sellthrough', { ...w, p_dimension: 'category', p_limit: 5 }), 'categories'),
    period.activityCapped ? Promise.resolve(null) : ok<PulseSellThroughResponse>(app.rpc('get_pulse_sellthrough', { ...w, p_dimension: 'brand', p_limit: 5 }), 'brands'),
    ok<PulseCustomersResponse>(app.rpc('get_pulse_customers', { ...w, p_limit: 5 }), 'customers'),
    ok<PulsePatternsResponse>(app.rpc('get_pulse_patterns', w), 'patterns'),
    db.schema('app').from('tenants').select('business_name').eq('id', tenantId).maybeSingle(),
  ]);

  if (!scorecard) return json({ error: 'Failed to build the review' }, { status: 500 });

  const generatedAt = new Date();
  const data: PulseReviewData = {
    businessName: tenant.data?.business_name ?? 'Your business',
    periodLabel: period.label,
    rangeLabel: range(period.window),
    compareLabel: period.compare && !period.thin ? range(period.compare) : null,
    generatedAt,
    scorecard,
    insights: buildInsights({ scorecard, actNow, funnel, brands, patterns, now: generatedAt }),
    actNow,
    funnel,
    categories,
    brands,
    customers,
  };

  const download = request.nextUrl.searchParams.get('download') === '1';
  return new Response(renderReviewHtml(data), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      ...(download ? { 'Content-Disposition': `attachment; filename="app-review-${period.window.from}.html"` } : {}),
    },
  });
}
