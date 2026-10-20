// Shareable business review (assessment §4.7): rendered from the same payloads and the same insight engine as the
// Pulse page, so the page and the export cannot disagree. Pure functions; the route fetches the data.
import { ACT_GROUP_COPY } from '@/lib/pulse/act-copy';
import { insightText } from '@/lib/pulse/insight-copy';
import type { Insight } from '@/lib/pulse/insights';
import { buildScorecardTiles } from '@/lib/pulse/scorecard-tiles';
import { formatNumberValue } from '@/lib/utils';
import type {
  PulseActNowResponse,
  PulseCustomersResponse,
  PulseFunnelResponse,
  PulseScorecardResponse,
  PulseSellThroughResponse,
} from '@/types/pulse-v2';

export interface PulseReviewData {
  businessName: string;
  periodLabel: string;
  /** Human range, e.g. "1 Oct – 17 Oct". */
  rangeLabel: string;
  compareLabel: string | null;
  generatedAt: Date;
  scorecard: PulseScorecardResponse;
  insights: Insight[];
  actNow: PulseActNowResponse | null;
  funnel: PulseFunnelResponse | null;
  categories: PulseSellThroughResponse | null;
  brands: PulseSellThroughResponse | null;
  customers: PulseCustomersResponse | null;
}

const money = (n: number) => formatNumberValue(n, 'CURRENCY_THRESHOLD');
const count = (n: number) => formatNumberValue(n, 'COUNT');

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Plain-text summary for sharing in a chat message. Only numbers from the payloads; no claims beyond them. */
export function buildReviewText(data: Pick<PulseReviewData, 'periodLabel' | 'rangeLabel' | 'scorecard' | 'insights'> & { businessName?: string }): string {
  const tiles = buildScorecardTiles(data.scorecard);
  const lines = [`${data.businessName ? `${data.businessName}: a` : 'A'}pp review, ${data.periodLabel} (${data.rangeLabel})`, ''];
  for (const t of tiles) lines.push(`${t.label}: ${t.value}${t.delta ? ` (${t.delta})` : ''}`);
  if (data.insights.length > 0) {
    lines.push('', 'Worth knowing:');
    for (const i of data.insights) lines.push(`- ${insightText(i)}`);
  }
  return lines.join('\n');
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="muted">Nothing to show for this period.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

/** Self-contained printable HTML (inline CSS, no scripts, no external requests). */
export function renderReviewHtml(data: PulseReviewData): string {
  const tiles = buildScorecardTiles(data.scorecard, data.generatedAt);
  const sections: string[] = [];

  sections.push(
    `<section><h2>Headline</h2><div class="tiles">${tiles
      .map(
        (t) =>
          `<div class="tile"><p class="label">${escapeHtml(t.label)}</p><p class="value">${escapeHtml(t.value)}</p>${
            t.sub ? `<p class="sub">${escapeHtml(t.sub)}</p>` : ''
          }${t.delta ? `<p class="delta">${escapeHtml(t.delta)}</p>` : ''}</div>`,
      )
      .join('')}</div></section>`,
  );

  if (data.insights.length > 0) {
    sections.push(`<section><h2>Worth knowing</h2><ul>${data.insights.map((i) => `<li>${escapeHtml(insightText(i))}</li>`).join('')}</ul></section>`);
  }

  if (data.actNow && data.actNow.groups.length > 0) {
    sections.push(
      `<section><h2>Who to follow up with</h2>${data.actNow.groups
        .map((g) => {
          const copy = ACT_GROUP_COPY[g.id];
          return `<h3>${escapeHtml(copy.title)}</h3><p class="muted">${escapeHtml(copy.evidence(g))}</p>${table(
            ['Customer', 'Detail'],
            g.previews.slice(0, 5).map((r) => [r.name, copy.rowMeta(r)]),
          )}`;
        })
        .join('')}</section>`,
    );
  }

  if (data.funnel?.funnel) {
    const f = data.funnel.funnel;
    sections.push(
      `<section><h2>From browsing to invoice</h2>${table(
        ['Step', 'Customers'],
        [
          ['Used the app', count(f.users)],
          ['Browsed the catalogue', count(f.browsed)],
          ['Sent a quote or order', count(f.quoted)],
          ['Were invoiced', count(f.invoiced)],
        ],
      )}</section>`,
    );
  }

  for (const [title, d] of [
    ['Top categories', data.categories],
    ['Top brands', data.brands],
  ] as const) {
    if (d && !d.capped && d.rows.length > 0) {
      sections.push(
        `<section><h2>${title}</h2>${table(
          ['Name', 'Quoted', 'Invoiced'],
          d.rows.slice(0, 5).map((r) => [r.name, money(r.quoted_value), money(r.invoiced_value)]),
        )}</section>`,
      );
    }
  }

  if (data.customers && data.customers.top.length > 0) {
    sections.push(
      `<section><h2>Top customers</h2>${table(
        ['Customer', 'Invoiced', 'Quoted'],
        data.customers.top.slice(0, 5).map((r) => [r.name, money(r.invoiced_value), money(r.quoted_value)]),
      )}</section>`,
    );
  }

  const generated = data.generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.businessName)}: app review, ${escapeHtml(data.periodLabel)}</title>
<style>
:root{color-scheme:light}
body{margin:0;background:#fff;color:#1f2933;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0;font-size:24px}h2{margin:28px 0 8px;font-size:18px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}h3{margin:16px 0 4px;font-size:15px}
.muted{color:#6b7280;margin:2px 0 8px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.tile{border:1px solid #e5e7eb;border-radius:10px;padding:12px}.label{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280}
.value{margin:6px 0 0;font-size:22px;font-weight:600}.sub,.delta{margin:4px 0 0;font-size:13px;color:#4b5563}
table{width:100%;border-collapse:collapse;margin:4px 0 8px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:14px}
th{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}td.num{text-align:right}
footer{margin-top:32px;font-size:12px;color:#6b7280}
@media print{main{padding:0}section{break-inside:avoid}}
</style></head><body><main>
<h1>${escapeHtml(data.businessName)}</h1>
<p class="muted">App review: ${escapeHtml(data.periodLabel)}, ${escapeHtml(data.rangeLabel)}${data.compareLabel ? `. Compared with ${escapeHtml(data.compareLabel)}` : ''}</p>
${sections.join('\n')}
<footer>Prepared ${escapeHtml(generated)} from your Yukti orders, quotes and invoices. Quote and invoice figures cover documents created through the customer app.</footer>
</main></body></html>`;
}
