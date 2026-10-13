#!/usr/bin/env node
// Generates docs/db/*.md — a compact, agent-readable map of the app/catalog schemas — from
//   1) a catalog snapshot (scripts/sql/db-map/catalog.sql, metadata only) and
//   2) supabase/migrations (provenance + "why does this exist" header comments).
//
//   node scripts/db-map.mjs --catalog /tmp/db-catalog.json            # write docs/db
//   node scripts/db-map.mjs --catalog /tmp/db-catalog.json --check    # exit 1 if docs/db is stale
//
// Generated files carry a banner; hand-written files (recipes.md, README.md) are never touched.
// No dependencies. Run it against a DEV snapshot — schema metadata is the same shape as prod.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const CHECK = args.includes('--check');
const catalogPath = opt('catalog');
const migrationsDir = resolve(opt('migrations', 'supabase/migrations'));
const outDir = resolve(opt('out', 'docs/db'));
if (!catalogPath) {
  console.error('usage: node scripts/db-map.mjs --catalog <catalog.json> [--migrations dir] [--out dir] [--check]');
  process.exit(2);
}

let raw = JSON.parse(readFileSync(catalogPath, 'utf8'));
// Accept the CLI/MCP row wrapper shapes: {catalog}, [{catalog}], {rows:[{catalog}]}
if (Array.isArray(raw)) raw = raw[0];
if (raw?.rows) raw = raw.rows[0];
const catalog = raw.catalog ?? raw;
const { tables = [], functions = [], cron = [], enums = [] } = catalog;

// Hand-written one-liners (docs/db/purposes.json). Precedence: DB COMMENT > purposes.json > migration header.
const purposesPath = join(resolve(opt('out', 'docs/db')), 'purposes.json');
const handPurposes = existsSync(purposesPath) ? JSON.parse(readFileSync(purposesPath, 'utf8')) : {};

// ── provenance from migrations ────────────────────────────────────────────────
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const tableOrigin = new Map(); // 'app.buyers' -> { file, intent }
const fnLatest = new Map(); //    'app.resolve_price' -> { file, intent }
const RE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(app|catalog)\.)?"?([a-z0-9_]+)"?/gi;
const RE_FN = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(app|catalog)\.([a-z0-9_]+)/gi;

function headerIntent(sql) {
  const lines = [];
  for (const line of sql.split('\n')) {
    const m = line.match(/^\s*--\s?(.*)$/);
    if (!m) {
      if (lines.length || line.trim()) break;
      continue;
    }
    const text = m[1].trim();
    if (text) lines.push(text);
    if (lines.join(' ').length > 220) break;
  }
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  const firstSentence = joined.split(/(?<=[.!?])\s/)[0] ?? joined;
  return firstSentence.length > 170 ? `${firstSentence.slice(0, 167)}...` : firstSentence;
}

for (const file of migrationFiles) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const intent = headerIntent(sql);
  for (const m of sql.matchAll(RE_TABLE)) {
    const key = `${m[1] ?? 'app'}.${m[2].toLowerCase()}`;
    if (!tableOrigin.has(key)) tableOrigin.set(key, { file, intent });
  }
  for (const m of sql.matchAll(RE_FN)) {
    fnLatest.set(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`, { file, intent });
  }
}

// ── domains ───────────────────────────────────────────────────────────────────
const DOMAINS = [
  ['metrics', /^metrics_|_summary$|^ops_|^kpi_/],
  ['membership', /^membership_|^cohort|^campaign_buyer_members|^price_list_assignments/],
  ['whatsapp', /whatsapp|broadcast|^tenant_broadcast/],
  ['pricing-campaigns', /^price_list|^campaign|^catalogs?$|^catalog_exclusions|^pricing_|^scheme/],
  ['inbox', /^entries$|^entry_|^inbox_/],
  ['buyers', /^buyer|^customer|^locations$|^location_/],
  ['sales-docs', /^(estimate|order|invoice|credit_note|quote|payment|dispatch|delivery)/],
  ['integrations', /^integration_|^zoho|^sync_|^import_|^tenant_integration/],
  ['auth-identity', /otp|auth_|^tenant_users|^user_|^role|^invitation|^invite|^ip_challenge|^email_verification|_signin_/],
  ['catalog-products', /^(tenant_)?(products?|brands?|categor|product_famil|inventory|stock|uom|attribute)|^products$|^brands$|^categories$/],
  ['recommendations', /^reco_|^recommend/],
  ['tenancy-settings', /^tenants?$|^tenant_|^settings|^feature_|^flags?$|^plans?$|^subscription/],
  ['platform-ops', /^audit_|^prod_guard|^cron|^realtime_|^public_edge|^rate_limit|^ops_/],
];
const domainOf = (name) => (DOMAINS.find(([, re]) => re.test(name)) ?? ['misc'])[0];
const fnDomainOf = (name) => {
  const probes = [
    ['metrics', /^metrics_|^get_.*(landing|pulse|kpi)|^compute_ops|_landing_|summary/],
    ['membership', /^membership_|^evaluate_|^refresh_(cohort|campaign|price_list)|^flush_buyer|cohort/],
    ['whatsapp', /whatsapp|broadcast/],
    ['pricing-campaigns', /price|campaign|catalog_publish|scheme/],
    ['inbox', /entry|entries|inbox|approve_buyer|request_buyer_app_access|submit_buyer_intake/],
    ['buyers', /buyer|customer|location/],
    ['sales-docs', /estimate|order|invoice|credit_note|payment|dispatch/],
    ['integrations', /zoho|integration|sync_|webhook|push_|import_/],
    ['auth-identity', /otp|login|auth|signin|tenant_user|invite|role/],
    ['catalog-products', /product|brand|categor|inventory|stock/],
    ['recommendations', /reco/],
    ['platform-ops', /prune|vacuum|guard|cron|audit|realtime|storage_maintenance|heartbeat/],
    ['tenancy-settings', /tenant|setting|flag|plan/],
  ];
  return (probes.find(([, re]) => re.test(name)) ?? ['misc'])[0];
};

// ── formatting helpers ────────────────────────────────────────────────────────
const SHORT_TYPES = [
  [/^timestamp with time zone$/, 'ts'], [/^timestamp without time zone$/, 'ts-naive'],
  [/^character varying(\(\d+\))?$/, 'text'], [/^text\[\]$/, 'text[]'], [/^uuid\[\]$/, 'uuid[]'],
  [/^integer$/, 'int'], [/^bigint$/, 'bigint'], [/^numeric(\(.+\))?$/, 'num'], [/^boolean$/, 'bool'],
  [/^double precision$/, 'float'], [/^jsonb$/, 'jsonb'], [/^date$/, 'date'],
];
const shortType = (t) => (SHORT_TYPES.find(([re]) => re.test(t)) ?? [null, t])[1];
const AUDIT = ['created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'external_ref'];
const VOL = { i: 'immutable', s: 'stable', v: 'volatile' };
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');
const oneLine = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function tablePurpose(t) {
  const key = `${t.schema}.${t.name}`;
  if (t.comment) return { text: oneLine(t.comment), src: 'db comment' };
  if (handPurposes.tables?.[key]) return { text: handPurposes.tables[key], src: 'db comment' };
  const o = tableOrigin.get(key);
  if (o?.intent) return { text: `~ ${o.intent}`, src: o.file };
  return { text: '', src: '' };
}
function fnPurpose(f) {
  if (f.comment) return { text: oneLine(f.comment), src: 'db comment' };
  if (handPurposes.functions?.[`${f.schema}.${f.name}`]) return { text: handPurposes.functions[`${f.schema}.${f.name}`], src: 'db comment' };
  const o = fnLatest.get(`${f.schema}.${f.name}`);
  if (o?.intent) return { text: `~ ${o.intent}`, src: o.file };
  return { text: '', src: '' };
}

function renderTable(t) {
  const p = tablePurpose(t);
  const colNames = new Set(t.columns.map((c) => c.n));
  const hasAudit = AUDIT.every((a) => colNames.has(a));
  const cols = t.columns
    .filter((c) => !(hasAudit && AUDIT.includes(c.n)))
    .map((c) => `${c.n}:${shortType(c.t)}${c.nn ? '!' : ''}${c.c ? `(${clip(oneLine(c.c), 40)})` : ''}`);
  const fks = t.fks.map((f) => `${(f.cols ?? []).join(',')}→${f.ref}`);
  const trg = t.triggers.map((x) => `${x.name}→${x.fn}`);
  const kind = t.kind === 'v' ? 'view' : t.kind === 'm' ? 'matview' : 'table';
  const lines = [`### ${t.schema}.${t.name}`];
  lines.push(
    `${kind} · RLS ${t.rls ? `on (${t.policies} policies)` : 'OFF'} · ~${Number(t.est_rows) < 0 ? '?' : t.est_rows} rows` +
      (p.text ? ` · ${p.text}` : '') + (p.src && p.src !== 'db comment' ? ` _(${p.src})_` : ''),
  );
  if (t.pk.length) lines.push(`- pk: ${t.pk.join(', ')}${hasAudit ? ' · +std audit cols (created_at/updated_at/created_by/updated_by/deleted_at/external_ref)' : ''}`);
  lines.push(`- cols: ${cols.join(', ')}`);
  if (fks.length) lines.push(`- fk: ${fks.join('; ')}`);
  if (trg.length) lines.push(`- triggers: ${trg.join('; ')}`);
  return lines.join('\n');
}

function renderFn(f) {
  const p = fnPurpose(f);
  const flags = [VOL[f.volatility] ?? f.volatility, f.definer ? 'definer' : null, f.lang === 'sql' ? 'sql' : null].filter(Boolean).join(',');
  const args = clip(oneLine(f.args), 150);
  const ret = clip(oneLine(f.returns ?? ''), 80);
  return `- \`${f.schema}.${f.name}(${args})\`${ret ? ` → ${ret}` : ''} [${flags}]${p.text ? ` — ${p.text}` : ''}${p.src && p.src !== 'db comment' ? ` _(${p.src})_` : ''}`;
}

// ── build ─────────────────────────────────────────────────────────────────────
const banner = (title) =>
  `<!-- GENERATED by scripts/db-map.mjs from a catalog snapshot (${String(catalog.generated_at ?? '').slice(0, 10)}) + supabase/migrations. Do not edit; edit COMMENT ON in a migration or recipes.md. -->\n# ${title}\n`;

const byDomain = new Map();
const slot = (d) => {
  if (!byDomain.has(d)) byDomain.set(d, { tables: [], fns: [] });
  return byDomain.get(d);
};
for (const t of tables) slot(domainOf(t.name)).tables.push(t);
for (const f of functions) slot(fnDomainOf(f.name)).fns.push(f);

const files = new Map();
const domainNames = [...byDomain.keys()].sort();
for (const d of domainNames) {
  const { tables: ts, fns } = byDomain.get(d);
  const body = [banner(`DB map — ${d}`)];
  body.push(`> ${ts.length} tables, ${fns.length} functions. Legend: \`col:type!\` ! = NOT NULL; purpose prefixed \`~\` is inferred from the creating/latest migration header (verify), unprefixed = DB COMMENT.\n`);
  if (ts.length) body.push('## Tables\n', ts.map(renderTable).join('\n\n'), '');
  if (fns.length) body.push('## Functions\n', fns.map(renderFn).join('\n'), '');
  files.set(`${d}.md`, body.join('\n'));
}

// allowlist for .claude/hooks/prod_sql_guard.py: schema -> function names whose EVERY overload is
// STABLE/IMMUTABLE (Postgres forbids those from writing). Anything else is treated as side-effecting.
const safeFns = { app: new Set(), catalog: new Set() };
const unsafeFns = new Set();
for (const f of functions) if (f.volatility === 'v') unsafeFns.add(`${f.schema}.${f.name}`);
for (const f of functions) {
  if (f.volatility !== 'v' && !unsafeFns.has(`${f.schema}.${f.name}`) && safeFns[f.schema]) safeFns[f.schema].add(f.name);
}
const safeJson = `${JSON.stringify(Object.fromEntries(Object.entries(safeFns).map(([k, v]) => [k, [...v].sort()])), null, 1)}\n`;
const safePath = resolve('.claude/hooks/safe_functions.json');

// cron
const cronLines = cron.map(
  (j) => `- \`${j.name}\` \`${j.schedule}\` UTC ${j.active ? '' : '**INACTIVE** '}— \`${clip(oneLine(j.command), 120)}\``,
);
files.set('cron.md', `${banner('DB map — pg_cron jobs')}\n${cronLines.join('\n')}\n`);

// index
const idx = [banner('DB map — INDEX (start here)')];
idx.push(
  [
    'How to use: find the table/function below, open its domain file (one `Read`), then query. Do not `list_tables`/guess column names against prod.',
    'Hand-written knowledge: [recipes.md](recipes.md) (proven joins + gotchas). Regenerate: `node scripts/db-map.mjs --catalog <snapshot.json>` (see [README.md](README.md)).',
    '',
    '## Domains',
    ...domainNames.map((d) => {
      const x = byDomain.get(d);
      return `- [${d}](${d}.md) — ${x.tables.length} tables, ${x.fns.length} functions`;
    }),
    '- [cron](cron.md) — scheduled jobs',
    '',
    '## Table finder',
    ...tables
      .map((t) => {
        const p = tablePurpose(t);
        return `- \`${t.schema}.${t.name}\` → ${domainOf(t.name)}${p.text ? ` — ${clip(p.text.replace(/^~ /, ''), 90)}` : ''}`;
      })
      .sort(),
    '',
    `## Enums\n${enums.length ? enums.map((e) => `- ${e.schema}.${e.name}: ${e.values.join(' | ')}`).join('\n') : '- none (status/type columns are text; see recipes.md for the value sets that matter)'}`,
  ].join('\n'),
);
files.set('INDEX.md', `${idx.join('\n')}\n`);

// ── write / check ─────────────────────────────────────────────────────────────
// ignore the generation date when checking so --check only fails on real schema drift
const stable = (s) => s.replace(/\(\d{4}-\d{2}-\d{2}\)/, '(date)');
if (CHECK) {
  let stale = false;
  if (!existsSync(safePath) || readFileSync(safePath, 'utf8') !== safeJson) {
    console.error('stale: .claude/hooks/safe_functions.json');
    stale = true;
  }
  for (const [name, content] of files) {
    const p = join(outDir, name);
    if (!existsSync(p) || stable(readFileSync(p, 'utf8')) !== stable(content)) {
      console.error(`stale: docs/db/${name}`);
      stale = true;
    }
  }
  process.exit(stale ? 1 : 0);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(safePath, safeJson);
for (const [name, content] of files) writeFileSync(join(outDir, name), content);
const totals = [...files.values()].reduce((n, c) => n + c.length, 0);
console.log(`wrote ${files.size} files to ${outDir} (${tables.length} tables, ${functions.length} functions, ~${Math.round(totals / 4)} tokens total)`);
for (const [name, content] of files) console.log(`  ${name.padEnd(26)} ~${Math.round(content.length / 4)} tokens`);
