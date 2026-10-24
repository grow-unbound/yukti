#!/usr/bin/env -S npx tsx
// READ-ONLY diff: find active Yukti buyers whose Zoho contact no longer exists.
//
// Why: between 2026-09-27 and 2026-10-24 Zoho posted contact.deleted events to
// deactivated webhook endpoints, so the delete never reached app.buyers (no
// other sync path soft-deletes buyers). The dropped events carried no contact
// ids, so we diff the full Zoho contact-id set against active buyers instead.
//
// What it does (nothing is written to Zoho or to the database):
//   1. Pages through every Zoho contact id (GET /contacts).
//   2. Pages through active buyers with an external_ref for the tenant.
//   3. Buyers whose external_ref is absent from the Zoho list are candidates.
//   4. Each candidate is confirmed with GET /contacts/{id}: HTTP 404 means gone,
//      HTTP 200 means it still exists (list/paging quirk or inactive contact).
//
// The integration's Zoho credentials are read through the same service-role RPC
// the other ops scripts use, kept in memory, and never printed or written.
//
// Usage:
//   npx tsx scripts/zoho-contacts-delete-diff.ts <tenant_integration_id> \
//     --expect-ref <supabase project ref> [--env <path to .env.local>] \
//     [--out <file.json>] [--pause-ms 600] [--max-checks 300] \
//     [--filter-by Status.All] [--no-names]
//
// --expect-ref is required: the script aborts before any read unless the
// SUPABASE_URL in the loaded env belongs to that project, so a stale or wrong
// .env.local can never silently point it at the wrong database.
//
// The output file defaults to the OS temp dir (it contains business names;
// never commit it — this repo is public).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

type JsonRecord = Record<string, unknown>;

function usage(): never {
  console.error(
    'Usage: npx tsx scripts/zoho-contacts-delete-diff.ts <tenant_integration_id> --expect-ref <project ref> ' +
      '[--env <path>] [--out <file.json>] [--pause-ms 600] [--max-checks 300] ' +
      '[--filter-by Status.All] [--no-names]',
  );
  process.exit(1);
}

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flagValue(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) usage();
  return parsed;
}

if (process.argv.includes('--help')) usage();
const tenantIntegrationId = process.argv[2];
if (!tenantIntegrationId || tenantIntegrationId.startsWith('--')) usage();

const EXPECT_REF = flagValue('--expect-ref');
if (!EXPECT_REF) usage();
const PAUSE_MS = numberFlag('--pause-ms', 600);
const MAX_CHECKS = numberFlag('--max-checks', 300);
const FILTER_BY = flagValue('--filter-by') ?? 'Status.All';
const INCLUDE_NAMES = !process.argv.includes('--no-names');
const OUT_PATH =
  flagValue('--out') ?? path.join(os.tmpdir(), `zoho-contacts-delete-diff-${Date.now()}.json`);

function loadEnvFile(envPath: string) {
  if (!existsSync(envPath)) return false;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// A worktree has no .env.local; pass --env <main checkout>/.env.local there.
loadEnvFile(flagValue('--env') ?? path.join(repoRoot, '.env.local'));

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing (use --env <path to .env.local>)');
}

const supabaseRef = new URL(SUPABASE_URL).hostname.split('.')[0];
if (supabaseRef !== EXPECT_REF) {
  throw new Error(`SUPABASE_URL points at project "${supabaseRef}", expected "${EXPECT_REF}"; aborting before any read`);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function toRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDc(config: JsonRecord) {
  const transport = toRecord(config.transport);
  const accountsBaseUrl = typeof transport.accounts_base_url === 'string' ? transport.accounts_base_url : null;
  const match = accountsBaseUrl?.match(/accounts\.zoho\.([a-z.]+)$/i);
  if (match?.[1]) return match[1].toLowerCase();
  const dc = typeof config.region === 'string' ? config.region : typeof config.dc === 'string' ? config.dc : 'in';
  return dc.toLowerCase();
}

interface ZohoSecret {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  org_id?: string;
  organization_id?: string;
  api_base_url?: string;
}

async function refreshAccessToken(secret: ZohoSecret, dc: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: secret.refresh_token,
    client_id: secret.client_id,
    client_secret: secret.client_secret,
  });
  const response = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, { method: 'POST', body });
  const json = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; message?: string };
  if (!response.ok || !json.access_token) {
    throw new Error(json.error ?? json.message ?? 'Zoho token refresh failed');
  }
  return json.access_token;
}

interface ZohoResponse {
  status: number;
  json: JsonRecord;
}

// GET with 429/5xx backoff. Token is only ever placed in the Authorization header.
async function zohoGet(url: URL, accessToken: string): Promise<ZohoResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 5) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      console.error(`[diff] Zoho ${response.status}; retrying in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    const json = toRecord(await response.json().catch(() => ({})));
    return { status: response.status, json };
  }
}

async function fetchAllZohoContactIds(apiBaseUrl: string, orgId: string, accessToken: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const MAX_PAGES = 400;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`${apiBaseUrl}/contacts`);
    url.searchParams.set('organization_id', orgId);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '200');
    url.searchParams.set('filter_by', FILTER_BY);
    const { status, json } = await zohoGet(url, accessToken);
    if (status !== 200 || json.code !== 0) {
      throw new Error(`Zoho contacts list failed on page ${page}: HTTP ${status} code=${String(json.code)} ${String(json.message ?? '')}`);
    }
    const contacts = Array.isArray(json.contacts) ? (json.contacts as JsonRecord[]) : [];
    for (const contact of contacts) {
      if (typeof contact.contact_id === 'string') ids.add(contact.contact_id);
    }
    if (page % 10 === 0) console.log(`[diff] zoho contacts: page ${page}, ${ids.size} ids so far`);
    if (toRecord(json.page_context).has_more_page !== true) {
      console.log(`[diff] zoho contacts: ${ids.size} ids over ${page} page(s)`);
      return ids;
    }
    await sleep(PAUSE_MS);
  }
  throw new Error(`Zoho contacts list did not end within ${MAX_PAGES} pages`);
}

interface BuyerRow {
  id: string;
  external_ref: string;
  business_name: string | null;
  updated_at: string | null;
}

// Keyset pagination on id, small pages, paced — prod is sensitive to load.
async function fetchActiveBuyers(tenantId: string): Promise<BuyerRow[]> {
  const rows: BuyerRow[] = [];
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { data, error } = await db
      .schema('app')
      .from('buyers')
      .select('id, external_ref, business_name, updated_at')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .not('external_ref', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(1000);
    if (error) throw error;
    const page = (data ?? []) as BuyerRow[];
    if (page.length === 0) break;
    rows.push(...page);
    lastId = page[page.length - 1].id;
    if (page.length < 1000) break;
    await sleep(200);
  }
  console.log(`[diff] active buyers with external_ref: ${rows.length}`);
  return rows;
}

type Verdict = 'not_found_in_zoho' | 'exists_in_zoho' | 'unclear';

interface CandidateResult {
  buyer_id: string;
  external_ref: string;
  business_name?: string | null;
  buyer_updated_at: string | null;
  verdict: Verdict;
  http_status: number | null;
  zoho_code: unknown;
  zoho_message: string | null;
  zoho_contact_status: string | null;
}

async function checkCandidate(
  buyer: BuyerRow,
  apiBaseUrl: string,
  orgId: string,
  accessToken: string,
): Promise<CandidateResult> {
  const url = new URL(`${apiBaseUrl}/contacts/${encodeURIComponent(buyer.external_ref)}`);
  url.searchParams.set('organization_id', orgId);
  const { status, json } = await zohoGet(url, accessToken);
  const contact = toRecord(json.contact);
  const verdict: Verdict = status === 404 ? 'not_found_in_zoho' : status === 200 && json.code === 0 ? 'exists_in_zoho' : 'unclear';
  return {
    buyer_id: buyer.id,
    external_ref: buyer.external_ref,
    ...(INCLUDE_NAMES ? { business_name: buyer.business_name } : {}),
    buyer_updated_at: buyer.updated_at,
    verdict,
    http_status: status,
    zoho_code: json.code ?? null,
    zoho_message: typeof json.message === 'string' ? json.message : null,
    zoho_contact_status: typeof contact.status === 'string' ? contact.status : null,
  };
}

async function main() {
  const { data: integration, error: integrationError } = await db
    .schema('app')
    .from('tenant_integrations')
    .select('id, tenant_id, integration_type_id, config, deleted_at')
    .eq('id', tenantIntegrationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (integrationError || !integration) throw integrationError ?? new Error('Tenant integration not found');
  if (!['zoho_books', 'zoho_inventory'].includes(integration.integration_type_id)) {
    throw new Error('Only Zoho integrations are supported');
  }

  const projectRef = supabaseRef;
  console.log(`[diff] project_ref=${projectRef} integration=${integration.id} type=${integration.integration_type_id} (read-only)`);

  const { data: secretData, error: secretError } = await db.schema('app').rpc('get_tenant_integration_runtime_secret', {
    p_tenant_integration_id: integration.id,
    p_expected_integration_type_id: integration.integration_type_id,
  });
  if (secretError) throw secretError;
  const secret = toRecord(secretData) as unknown as ZohoSecret;
  const config = toRecord(integration.config);
  const orgId =
    typeof secret.org_id === 'string'
      ? secret.org_id
      : typeof secret.organization_id === 'string'
        ? secret.organization_id
        : typeof config.org_id === 'string'
          ? String(config.org_id)
          : null;
  if (!orgId) throw new Error('Zoho organization_id missing from this integration');

  const dc = resolveDc(config);
  const modulePath = integration.integration_type_id === 'zoho_inventory' ? 'inventory/v1' : 'books/v3';
  const apiBaseUrl = (
    typeof secret.api_base_url === 'string' && secret.api_base_url ? secret.api_base_url : `https://www.zohoapis.${dc}/${modulePath}`
  ).replace(/\/+$/, '');
  const accessToken = await refreshAccessToken(secret, dc);

  const zohoIds = await fetchAllZohoContactIds(apiBaseUrl, orgId, accessToken);
  if (zohoIds.size === 0) {
    throw new Error('Zoho returned 0 contacts; refusing to treat every buyer as deleted');
  }

  // A wrong org id or API base would 404 every detail call and make every buyer
  // look deleted. Prove 404 is meaningful first: a contact from the list must be 200.
  const probeId = zohoIds.values().next().value as string;
  const probeUrl = new URL(`${apiBaseUrl}/contacts/${encodeURIComponent(probeId)}`);
  probeUrl.searchParams.set('organization_id', orgId);
  const probe = await zohoGet(probeUrl, accessToken);
  if (probe.status !== 200 || probe.json.code !== 0) {
    throw new Error(`Detail-endpoint probe for a listed contact returned HTTP ${probe.status}; 404s would be untrustworthy, aborting`);
  }

  const buyers = await fetchActiveBuyers(integration.tenant_id as string);
  const candidates = buyers.filter((buyer) => !zohoIds.has(buyer.external_ref));
  const buyerRefs = new Set(buyers.map((buyer) => buyer.external_ref));
  const zohoOnly = [...zohoIds].filter((id) => !buyerRefs.has(id)).length;
  console.log(`[diff] candidates (active buyer, not in Zoho list): ${candidates.length}; zoho ids with no active buyer: ${zohoOnly}`);

  const summary: JsonRecord = {
    generated_at: new Date().toISOString(),
    project_ref: projectRef,
    tenant_integration_id: integration.id,
    filter_by: FILTER_BY,
    zoho_contact_ids: zohoIds.size,
    active_buyers_with_external_ref: buyers.length,
    zoho_ids_without_active_buyer: zohoOnly,
    candidates: candidates.length,
  };

  if (candidates.length > MAX_CHECKS) {
    const unconfirmed = candidates.map((buyer) => ({
      buyer_id: buyer.id,
      external_ref: buyer.external_ref,
      ...(INCLUDE_NAMES ? { business_name: buyer.business_name } : {}),
    }));
    writeFileSync(OUT_PATH, JSON.stringify({ summary, aborted: 'too_many_candidates', unconfirmed }, null, 2), { mode: 0o600 });
    console.error(
      `[diff] ${candidates.length} candidates exceeds --max-checks ${MAX_CHECKS}; not hitting Zoho per-contact. ` +
        `Unconfirmed list written to ${OUT_PATH} (contains business names; do not commit). ` +
        'Check --filter-by / the contacts list before raising the cap.',
    );
    process.exitCode = 2;
    return;
  }

  const results: CandidateResult[] = [];
  for (const [index, buyer] of candidates.entries()) {
    results.push(await checkCandidate(buyer, apiBaseUrl, orgId, accessToken));
    if ((index + 1) % 10 === 0) console.log(`[diff] confirmed ${index + 1}/${candidates.length}`);
    await sleep(PAUSE_MS);
  }

  const counts = {
    not_found_in_zoho: results.filter((r) => r.verdict === 'not_found_in_zoho').length,
    exists_in_zoho: results.filter((r) => r.verdict === 'exists_in_zoho').length,
    unclear: results.filter((r) => r.verdict === 'unclear').length,
  };
  writeFileSync(OUT_PATH, JSON.stringify({ summary: { ...summary, ...counts }, results }, null, 2), { mode: 0o600 });

  console.log(`[diff] verdicts: ${JSON.stringify(counts)}`);
  console.log('[diff] confirmed deleted in Zoho (buyer_id  external_ref):');
  for (const row of results.filter((r) => r.verdict === 'not_found_in_zoho')) {
    console.log(`  ${row.buyer_id}  ${row.external_ref}`);
  }
  console.log(`[diff] full results (includes business names, do not commit): ${OUT_PATH}`);
}

main().catch((error) => {
  console.error('[diff] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
