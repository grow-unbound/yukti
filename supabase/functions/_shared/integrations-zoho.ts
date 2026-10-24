import {
  normalizeIntegrationSinceDate,
  type IntegrationProgressCursor,
  type IntegrationSyncScope,
  type ZohoCredentialsInput,
  type ZohoIntegrationTypeId,
} from '../../../src/lib/integrations/contracts.ts';
import { logCheckpoint, startTimer } from './sync-log.ts';

export interface IntegrationSyncPhaseDefinition {
  id: string;
  label: string;
  entityType: string;
  path: string;
  itemKey: string;
  perPage?: number;
  extraParams?: Record<string, string>;
}

export interface ZohoPhasePage {
  records: Record<string, unknown>[];
  nextCursor: IntegrationProgressCursor | null;
  page: number;
  perPage: number;
  hasMore: boolean;
}

export interface ZohoConnectionMeta {
  organization_id: string;
  organization_name: string | null;
  module: 'books' | 'inventory';
  api_base_url: string;
  accounts_base_url: string;
}

/**
 * Zoho's contact-scoped contact-person endpoint omits `contact_id` from each
 * item. Preserve a provider-supplied value, but otherwise attach the parent
 * already known from `/contacts/{contactId}/contactpersons`.
 */
export function attachParentContactId(
  records: Record<string, unknown>[],
  contactId: string,
): Record<string, unknown>[] {
  return records.map((record) => ({
    ...record,
    contact_id: record.contact_id ?? contactId,
  }));
}

export class ZohoApiError extends Error {
  status: number;
  code?: string | number;
  payload?: unknown;

  constructor(message: string, status = 500, code?: string | number, payload?: unknown) {
    super(message);
    this.name = 'ZohoApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export interface ZohoTokenCacheProvider {
  read(): Promise<string | null>;
  write(token: string, expiresAt: Date): Promise<void>;
}

interface ZohoPageContext {
  page?: number;
  per_page?: number;
  has_more_page?: boolean;
}

interface ZohoRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  baseUrl?: string;
  /** 'bulk' = tighter per-attempt timeout/retry budget for a per-item call
   * inside a concurrent batch (see ZOHO_BULK_DETAIL_* constants) — one
   * stubborn item shouldn't be able to stall the whole batch on the
   * standard 30s x 3 budget. Defaults to 'standard'. */
  retryBudget?: 'standard' | 'bulk';
}

interface NormalizedZohoCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizationId: string;
  accountsBaseUrl: string;
  apiBaseUrl: string;
  warehouseApiBaseUrl: string;
  module: 'books' | 'inventory';
}

const DEFAULT_PER_PAGE = 200;
const DEFAULT_REGION = 'in';

const TRANSACTIONAL_ENTITY_TYPES = new Set(['estimates', 'orders', 'invoices', 'customer_payments']);
// Zoho supports last_modified_time filter on these endpoints; locations and pricelists always do full fetch
const LAST_MODIFIED_SUPPORTED_TYPES = new Set(['products', 'customers', 'estimates', 'orders', 'invoices']);
const PRICE_LIST_RESPONSE_KEYS = ['pricebooks', 'pricelists'] as const;
const ZOHO_REQUEST_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const ZOHO_REQUEST_MAX_ATTEMPTS = 3;
const ZOHO_REQUEST_TIMEOUT_MS = 30_000;

// Per-item detail fetches inside a concurrent bulk sweep (inventory's
// item-location lookups, transaction line-item hydration) run
// Promise.allSettled over a batch — one item stuck on the standard budget
// (30s timeout x 3 attempts + backoff ~= 90-100s) blocks the ENTIRE batch
// that long, which alone can exceed the caller's DISPATCH_TIMEOUT_MS (140s)
// with zero heartbeat in between. A bulk sweep should skip a stubborn item
// and move on, not burn most of its dispatch budget retrying one record.
// Worst case per item here: ~15s + backoff + 15s =~ 31s, so one bad item in
// a batch of ZOHO_DETAIL_FETCH_CONCURRENCY no longer threatens the whole
// dispatch window.
const ZOHO_BULK_DETAIL_MAX_ATTEMPTS = 2;
const ZOHO_BULK_DETAIL_TIMEOUT_MS = 15_000;

// Zoho Books/Inventory API limits (confirmed via Zoho's own docs, July 2026):
// 10 concurrent API calls per org (soft limit, 429 above it), 100 requests
// per minute per org (hard cap, does not scale with plan). Any caller doing
// many individual per-record detail fetches (item-location lookups,
// estimate/order/invoice line-item hydration) should batch at this
// concurrency and pace batches at this interval — 10 req / 6s sustains
// <=100/min while still using the full concurrent allowance per batch.
export const ZOHO_DETAIL_FETCH_CONCURRENCY = 10;
export const ZOHO_DETAIL_FETCH_BATCH_PACE_MS = 6_000;

// Indian Financial Year starts April 1. For transactional data we load from:
//   Apr–Jun (early in FY)  → Jan 1 of this calendar year (extra context quarter)
//   Jul–Dec (mid/late FY)  → Apr 1 of this calendar year (FY start)
//   Jan–Mar (FY Q4)        → Apr 1 of previous calendar year (FY start)
function financialYearStart(): string {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-based
  const year = now.getFullYear();

  if (month >= 4 && month <= 6) {
    return `${year}-01-01`;
  }
  if (month >= 7) {
    return `${year}-04-01`;
  }
  // January–March: FY started April of last year
  return `${year - 1}-04-01`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildZohoDomain(region: string | null): string {
  const normalized = (region ?? DEFAULT_REGION).trim().toLowerCase();
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized.replace(/\/+$/, '');
  }
  return `https://www.zohoapis.${normalized}`;
}

function buildAccountsDomain(region: string | null): string {
  const normalized = (region ?? DEFAULT_REGION).trim().toLowerCase();
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized.replace(/\/+$/, '');
  }
  return `https://accounts.zoho.${normalized}`;
}

export function normalizeZohoCredentials(
  integrationTypeId: ZohoIntegrationTypeId,
  raw: Record<string, unknown>,
): NormalizedZohoCredentials {
  const clientId = asString(raw.client_id);
  const clientSecret = asString(raw.client_secret);
  const refreshToken = asString(raw.refresh_token);
  const organizationId = asString(raw.organization_id) ?? asString(raw.org_id);

  if (!clientId || !clientSecret || !refreshToken || !organizationId) {
    throw new ZohoApiError(
      'Zoho credentials require client_id, client_secret, refresh_token, and organization_id.',
      400,
    );
  }

  const module = integrationTypeId === 'zoho_inventory' ? 'inventory' : 'books';
  const region = asString(raw.region) ?? asString(raw.dc);
  const accountsBaseUrl = asString(raw.accounts_base_url) ?? buildAccountsDomain(region);
  const apiBaseUrl = asString(raw.api_base_url)
    ?? `${buildZohoDomain(region)}/${module === 'inventory' ? 'inventory/v1' : 'books/v3'}`;
  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
  const warehouseApiBaseUrl = normalizedApiBaseUrl.includes('/inventory/v1')
    ? normalizedApiBaseUrl
    : normalizedApiBaseUrl.includes('/books/v3')
      ? normalizedApiBaseUrl.replace(/\/books\/v3$/, '/inventory/v1')
      : `${buildZohoDomain(region)}/inventory/v1`;

  return {
    clientId,
    clientSecret,
    refreshToken,
    organizationId,
    accountsBaseUrl,
    apiBaseUrl: normalizedApiBaseUrl,
    warehouseApiBaseUrl,
    module,
  };
}

export function extractZohoDcFromAccountsBaseUrl(accountsBaseUrl: string): string {
  const match = accountsBaseUrl.trim().match(/accounts\.zoho\.([a-z.]+)$/i);
  return match?.[1]?.toLowerCase() ?? DEFAULT_REGION;
}

function collectOrganizations(payload: Record<string, unknown>): Record<string, unknown>[] {
  const organizations = payload.organizations;
  return Array.isArray(organizations)
    ? organizations.filter((value): value is Record<string, unknown> => isRecord(value))
    : [];
}

async function parseZohoResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  let payload: Record<string, unknown> = {};
  if (!response.ok) {
    // Non-ok responses only ever surface as a generic statusText (e.g. "Bad
    // Request") to callers/sync_jobs.error_log — log the raw body here since
    // it's the only place that ever sees what Zoho actually said.
    const rawText = await response.text().catch(() => '');
    const parsed = isJson ? (() => { try { return JSON.parse(rawText); } catch { return null; } })() : null;
    payload = isRecord(parsed) ? parsed : {};
    console.error(`[zoho] ${response.status} ${response.statusText} on ${response.url}`, rawText ? rawText.slice(0, 2000) : '(empty body)');
    throw new ZohoApiError(
      (asString(payload.message) ?? response.statusText ?? 'Zoho request failed'),
      response.status,
      typeof payload.code === 'string' || typeof payload.code === 'number' ? payload.code : undefined,
      payload,
    );
  }

  const parsed = isJson ? await response.json().catch(() => null) : null;
  payload = isRecord(parsed) ? parsed : {};

  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new ZohoApiError(
      asString(payload.message) ?? 'Zoho request failed',
      response.status || 400,
      payload.code,
      payload,
    );
  }

  return payload;
}

function isRetryableZohoRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('http2 error')
    || message.includes('sendrequest')
    || message.includes('connection error')
    || message.includes('fetch failed')
    || message.includes('network error')
    || message.includes('aborted')
    || message.includes('timeout')
  );
}

function isRetryableZohoResponseStatus(status: number): boolean {
  return ZOHO_REQUEST_RETRYABLE_STATUSES.has(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bulk retryBudget's whole point is fail-fast-and-skip (see
// ZOHO_BULK_DETAIL_* comment): a batch of ZOHO_DETAIL_FETCH_CONCURRENCY
// concurrent items only ever waits on its slowest item, so honouring a
// standard-length Retry-After here (up to 30s) turns one 429'd item into a
// ~60s batch (15s attempt + 30s wait + 15s attempt) — blows past callers'
// BATCH_DEADLINE_RESERVATION_MS (35s) and the coordinator's 140s dispatch
// timeout. Cap bulk's 429 wait well under its own per-attempt timeout
// (ZOHO_BULK_DETAIL_TIMEOUT_MS=15s) so worst case per item stays ~31s.
const ZOHO_BULK_RETRY_DELAY_CAP_MS = 5_000;

function retryDelayMs(attempt: number, retryBudget: 'standard' | 'bulk', response?: Response): number {
  const cap = retryBudget === 'bulk' ? ZOHO_BULK_RETRY_DELAY_CAP_MS : 30_000;
  // On 429 rate-limit: honour Retry-After header when present (value is seconds)
  if (response?.status === 429) {
    const header = response.headers.get('Retry-After');
    const seconds = header ? parseFloat(header) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, cap);
  }
  // Exponential backoff with ±200ms jitter for all other retryable errors
  return Math.min(1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200), cap);
}

// Lowest-level chokepoint for every outbound Zoho call (token refresh, list
// pages, per-item detail fetches). Logs each attempt's start/end so a stall
// anywhere upstream (a page fetch, a batch of item-detail lookups) can be
// traced down to exactly which attempt on which URL never returned, and
// whether it was a real network hang (no :done at all — the 30s
// AbortController itself would then also be suspect) vs. a slow-but-completing
// call vs. a retry loop chewing through backoff on repeated 429/5xx.
async function fetchZohoResponse(
  url: string,
  init: RequestInit,
  retryLabel: string,
  onKeepAlive?: () => void,
  retryBudget: 'standard' | 'bulk' = 'standard',
): Promise<Response> {
  let lastError: unknown = null;
  const maxAttempts = retryBudget === 'bulk' ? ZOHO_BULK_DETAIL_MAX_ATTEMPTS : ZOHO_REQUEST_MAX_ATTEMPTS;
  const timeoutMs = retryBudget === 'bulk' ? ZOHO_BULK_DETAIL_TIMEOUT_MS : ZOHO_REQUEST_TIMEOUT_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      logCheckpoint(null, 'zoho-request', `${retryLabel}:attempt${attempt}:abort`, { reason: 'timeout', timeoutMs });
      controller.abort(new Error(`Zoho ${retryLabel} request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const attemptDone = startTimer(null, 'zoho-request', `${retryLabel}:attempt${attempt}`);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      attemptDone({ status: response.status });
      // Touch on every completed call, not just retries — callers making many
      // sequential Zoho requests per page (e.g. per-item detail lookups in
      // fetchAndPersistMissingItemLocations) can run for minutes on genuine,
      // successful, non-retried calls with no other write in between. Without
      // this, that looks identical to a dead worker to anything checking
      // heartbeat_at.
      onKeepAlive?.();
      if (attempt < maxAttempts && isRetryableZohoResponseStatus(response.status)) {
        const delayMs = retryDelayMs(attempt, retryBudget, response);
        logCheckpoint(null, 'zoho-request', `${retryLabel}:retrying`, { attempt, status: response.status, delayMs });
        await delay(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      attemptDone({ error: error instanceof Error ? error.message : String(error) });
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableZohoRequestError(error)) {
        throw error;
      }
      onKeepAlive?.();
      const delayMs = retryDelayMs(attempt, retryBudget);
      logCheckpoint(null, 'zoho-request', `${retryLabel}:retrying`, { attempt, error: error instanceof Error ? error.message : String(error), delayMs });
      await delay(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Zoho ${retryLabel} request failed.`);
}

function getPageContext(payload: Record<string, unknown>): ZohoPageContext | null {
  return isRecord(payload.page_context) ? (payload.page_context as ZohoPageContext) : null;
}

function getRecordArray(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
}

function nextCursorFromPage(
  phase: IntegrationSyncPhaseDefinition,
  page: number,
  perPage: number,
  pageContext: ZohoPageContext | null,
  recordCount: number,
  since: string | null,
): IntegrationProgressCursor | null {
  const hasMore = typeof pageContext?.has_more_page === 'boolean'
    ? pageContext.has_more_page
    : recordCount >= perPage;

  if (!hasMore) return null;

  return {
    phase: phase.id,
    entity_type: phase.entityType,
    page: (typeof pageContext?.page === 'number' ? pageContext.page : page) + 1,
    per_page: typeof pageContext?.per_page === 'number' ? pageContext.per_page : perPage,
    has_more: true,
    since,
  };
}

export function getZohoPhasePlan(
  integrationTypeId: ZohoIntegrationTypeId,
  scope: IntegrationSyncScope,
): IntegrationSyncPhaseDefinition[] {
  const referencePhases: Record<ZohoIntegrationTypeId, IntegrationSyncPhaseDefinition[]> = {
    zoho_books: [
      { id: 'locations', label: 'Importing locations from Zoho Books', entityType: 'locations', path: '/locations', itemKey: 'locations' },
      { id: 'products', label: 'Importing products from Zoho Books', entityType: 'products', path: '/items', itemKey: 'items' },
      { id: 'pricelists', label: 'Importing pricelists from Zoho Books', entityType: 'pricelists', path: '/pricebooks', itemKey: 'pricebooks' },
      { id: 'customers', label: 'Importing customers from Zoho Books', entityType: 'customers', path: '/contacts', itemKey: 'contacts' },
    ],
    zoho_inventory: [
      { id: 'warehouses', label: 'Importing warehouses from Zoho Inventory', entityType: 'warehouses', path: '/settings/warehouses', itemKey: 'warehouses' },
      { id: 'products', label: 'Importing products from Zoho Inventory', entityType: 'products', path: '/items', itemKey: 'items' },
      { id: 'pricelists', label: 'Importing pricelists from Zoho Inventory', entityType: 'pricelists', path: '/pricebooks', itemKey: 'pricebooks' },
      { id: 'customers', label: 'Importing customers from Zoho Inventory', entityType: 'customers', path: '/contacts', itemKey: 'contacts' },
    ],
  };

  const transactionalPhases: Record<ZohoIntegrationTypeId, IntegrationSyncPhaseDefinition[]> = {
    zoho_books: [
      { id: 'estimates', label: 'Importing estimates from Zoho Books', entityType: 'estimates', path: '/estimates', itemKey: 'estimates' },
      { id: 'orders', label: 'Importing sales orders from Zoho Books', entityType: 'orders', path: '/salesorders', itemKey: 'salesorders' },
      { id: 'invoices', label: 'Importing invoices from Zoho Books', entityType: 'invoices', path: '/invoices', itemKey: 'invoices' },
      { id: 'invoices_outstanding', label: 'Re-fetching outstanding invoices from Zoho Books', entityType: 'invoices_outstanding', path: '/invoices', itemKey: 'invoices', extraParams: { filter_by: 'Status.Outstanding' } },
      { id: 'customer_payments', label: 'Importing customer payments from Zoho Books', entityType: 'customer_payments', path: '/customerpayments', itemKey: 'customerpayments' },
    ],
    zoho_inventory: [
      { id: 'estimates', label: 'Importing estimates from Zoho Inventory', entityType: 'estimates', path: '/estimates', itemKey: 'estimates' },
      { id: 'orders', label: 'Importing sales orders from Zoho Inventory', entityType: 'orders', path: '/salesorders', itemKey: 'salesorders' },
      { id: 'invoices', label: 'Importing invoices from Zoho Inventory', entityType: 'invoices', path: '/invoices', itemKey: 'invoices' },
      { id: 'invoices_outstanding', label: 'Re-fetching outstanding invoices from Zoho Inventory', entityType: 'invoices_outstanding', path: '/invoices', itemKey: 'invoices', extraParams: { filter_by: 'Status.Outstanding' } },
      { id: 'customer_payments', label: 'Importing customer payments from Zoho Inventory', entityType: 'customer_payments', path: '/customerpayments', itemKey: 'customerpayments' },
    ],
  };

  if (scope === 'reference') return referencePhases[integrationTypeId];
  if (scope === 'transactional') return transactionalPhases[integrationTypeId];
  return [...referencePhases[integrationTypeId], ...transactionalPhases[integrationTypeId]];
}

export function sampleExternalIds(records: Record<string, unknown>[]): string[] {
  const keys = [
    'location_id', 'warehouse_id',
    'contact_id', 'contact_person_id',
    'item_id',
    'estimate_id', 'salesorder_id', 'invoice_id', 'payment_id',
    'organization_id', 'id',
  ];
  const samples: string[] = [];

  for (const record of records) {
    for (const key of keys) {
      const value = asString(record[key]);
      if (value) {
        samples.push(value);
        break;
      }
    }

    if (samples.length >= 5) break;
  }

  return samples;
}

export function createZohoAdapter(
  integrationTypeId: ZohoIntegrationTypeId,
  rawCredentials: Record<string, unknown>,
  tokenCache?: ZohoTokenCacheProvider,
  onKeepAlive?: () => void,
) {
  const credentials = normalizeZohoCredentials(integrationTypeId, rawCredentials);
  let cachedToken: string | null = null;

  async function refreshAccessToken(): Promise<string> {
    // Check persistent cache first (avoids token refresh on every Edge Function cold-start)
    if (tokenCache) {
      const persisted = await tokenCache.read().catch(() => null);
      if (persisted) {
        cachedToken = persisted;
        return persisted;
      }
    }

    const url = new URL('/oauth/v2/token', credentials.accountsBaseUrl);
    url.searchParams.set('grant_type', 'refresh_token');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('client_secret', credentials.clientSecret);
    url.searchParams.set('refresh_token', credentials.refreshToken);

    const response = await fetchZohoResponse(url.toString(), { method: 'POST' }, 'token refresh', onKeepAlive);
    const payload = await parseZohoResponse(response);
    const accessToken = asString(payload.access_token);

    if (!accessToken) {
      throw new ZohoApiError('Zoho refresh response did not include an access_token.', response.status, undefined, payload);
    }

    cachedToken = accessToken;
    // Zoho access tokens expire in 3600s — cache with 120s buffer so we never use a near-expired token
    if (tokenCache) {
      const expiresAt = new Date(Date.now() + (3600 - 120) * 1000);
      tokenCache.write(accessToken, expiresAt).catch(() => {});
    }
    return accessToken;
  }

  async function request<T extends Record<string, unknown> = Record<string, unknown>>(
    init: ZohoRequestInit,
    retryOnUnauthorized = true,
  ): Promise<T> {
    const token = cachedToken ?? await refreshAccessToken();
    const baseUrl = (init.baseUrl ?? credentials.apiBaseUrl).replace(/\/+$/, '');
    const url = new URL(init.path.replace(/^\/+/, ''), `${baseUrl}/`);
    const query = init.query ?? {};

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    if (!url.searchParams.has('organization_id')) {
      url.searchParams.set('organization_id', credentials.organizationId);
    }

    const response = await fetchZohoResponse(url.toString(), {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, init.path, onKeepAlive, init.retryBudget ?? 'standard');

    if (response.status === 401 && retryOnUnauthorized) {
      cachedToken = null;
      // Evict persisted cache so next call forces a real refresh
      if (tokenCache) tokenCache.write('', new Date(0)).catch(() => {});
      await refreshAccessToken();
      return request<T>(init, false);
    }

    return await parseZohoResponse(response) as T;
  }

  async function testConnection(): Promise<ZohoConnectionMeta> {
    const payload = await request({ path: '/organizations' });
    const organizations = collectOrganizations(payload);
    const matched = organizations.find((organization) => {
      const id = asString(organization.organization_id);
      return id === credentials.organizationId;
    }) ?? organizations[0] ?? null;

    return {
      organization_id: credentials.organizationId,
      organization_name: matched ? asString(matched.name) ?? asString(matched.organization_name) : null,
      module: credentials.module,
      api_base_url: credentials.apiBaseUrl,
      accounts_base_url: credentials.accountsBaseUrl,
    };
  }

  async function fetchPhasePage(
    phase: IntegrationSyncPhaseDefinition,
    cursor: IntegrationProgressCursor | null,
    since: string | null,
    jobType?: string,
  ): Promise<ZohoPhasePage> {
    const page = cursor?.page ?? 1;
    const perPage = cursor?.per_page ?? phase.perPage ?? DEFAULT_PER_PAGE;

    // Apply time filters based on entity type and Zoho API support:
    // - Transactional (estimates/orders/invoices): always use date_start
    // - Reference data (products/customers): last_modified_time only on incremental cron jobs;
    //   manual and initial syncs always do a full fetch so reference data is complete
    // - Locations, pricelists, warehouses: always full fetch (Zoho doesn't support these filters)
    const isIncremental = jobType === 'incremental';
    const normalizedSince = normalizeIntegrationSinceDate(since);
    const dateStart = TRANSACTIONAL_ENTITY_TYPES.has(phase.entityType)
      ? (normalizedSince ?? financialYearStart())
      : undefined;
    const lastModifiedDate = !TRANSACTIONAL_ENTITY_TYPES.has(phase.entityType) &&
      LAST_MODIFIED_SUPPORTED_TYPES.has(phase.entityType) &&
      normalizedSince != null &&
      isIncremental
      ? normalizedSince
      : undefined;
    // Zoho requires last_modified_time as "YYYY-MM-DDTHH:mm:ss+0530" (IST) — not a bare date
    const lastModified = lastModifiedDate ? `${lastModifiedDate}T00:00:00+0530` : undefined;

    const query = {
      page,
      per_page: perPage,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(lastModified ? { last_modified_time: lastModified } : {}),
      ...(phase.extraParams ?? {}),
    };
    const baseUrl = phase.entityType === 'warehouses'
      ? credentials.warehouseApiBaseUrl
      : credentials.apiBaseUrl;
    let payload: Record<string, unknown>;
    if (phase.id === 'pricelists') {
      payload = await requestPricelistsPage(query);
    } else {
      payload = await request({
        path: phase.path,
        query,
        baseUrl,
      });
    }

    const records = phase.id === 'pricelists'
      ? getPriceListRecords(payload)
      : getRecordArray(payload, phase.itemKey);
    const pageContext = getPageContext(payload);
    const nextCursor = nextCursorFromPage(phase, page, perPage, pageContext, records.length, since);

    return {
      records,
      nextCursor,
      page,
      perPage,
      hasMore: nextCursor !== null,
    };
  }

  /** @deprecated Zoho contact detail includes contact_persons — use fetchContactById instead. */
  async function fetchContactPersons(contactId: string): Promise<Record<string, unknown>[]> {
    const payload = await request({
      path: `/contacts/${contactId}/contactpersons`,
    });
    return getRecordArray(payload, 'contact_persons');
  }

  /** Single contact fetch — response embeds contact_persons, custom_fields, and pricebook_id. */
  async function fetchContactById(contactId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/contacts/${contactId}` });
      const contact = payload.contact;
      return isRecord(contact) ? contact : null;
    } catch {
      return null;
    }
  }

  async function fetchItemById(itemId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/items/${itemId}` });
      const item = payload.item;
      return isRecord(item) ? item : null;
    } catch {
      return null;
    }
  }

  async function fetchLocationById(locationId: string): Promise<Record<string, unknown> | null> {
    try {
      const path = credentials.module === 'inventory'
        ? `/settings/warehouses/${locationId}`
        : `/locations/${locationId}`;
      const payload = await request({
        path,
        baseUrl: credentials.module === 'inventory' ? credentials.warehouseApiBaseUrl : credentials.apiBaseUrl,
      });
      const location = payload.warehouse ?? payload.location;
      return isRecord(location) ? location : null;
    } catch {
      return null;
    }
  }

  async function fetchCustomerPaymentDetail(paymentId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/customerpayments/${paymentId}` });
      const payment = payload.payment;
      return isRecord(payment) ? payment : null;
    } catch (error) {
      console.warn(`[fetchCustomerPaymentDetail] skipping payment ${paymentId}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async function fetchPricebookDetail(pricebookId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/pricebooks/${pricebookId}` });
      const book = payload.pricebook;
      return isRecord(book) ? book : null;
    } catch (error) {
      // Raw Zoho response body is already logged by parseZohoResponse — this just
      // ties the failure to which pricebook got skipped (see stale-item-deletion
      // guard in integrations-persist.ts, which relies on detail fetches failing
      // loudly rather than silently here).
      console.warn(`[fetchPricebookDetail] skipping pricebook ${pricebookId}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  // fetchEstimateById/fetchSalesOrderById/fetchInvoiceById are only ever
  // called from sync-transaction-line-items's concurrent per-item batch
  // sweep — bulk retry budget applies (see ZOHO_BULK_DETAIL_* constants).
  async function fetchEstimateById(estimateId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/estimates/${estimateId}`, retryBudget: 'bulk' });
      const estimate = payload.estimate;
      return isRecord(estimate) ? estimate : null;
    } catch (error) {
      if (error instanceof ZohoApiError && error.status !== 404) throw error;
      return null;
    }
  }

  async function fetchSalesOrderById(salesOrderId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/salesorders/${salesOrderId}`, retryBudget: 'bulk' });
      const salesOrder = payload.salesorder;
      return isRecord(salesOrder) ? salesOrder : null;
    } catch (error) {
      if (error instanceof ZohoApiError && error.status !== 404) throw error;
      return null;
    }
  }

  async function fetchInvoiceById(invoiceId: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = await request({ path: `/invoices/${invoiceId}`, retryBudget: 'bulk' });
      const invoice = payload.invoice;
      return isRecord(invoice) ? invoice : null;
    } catch (error) {
      if (error instanceof ZohoApiError && error.status !== 404) throw error;
      return null;
    }
  }

  async function fetchUsers(): Promise<Record<string, unknown>[]> {
    const allUsers: Record<string, unknown>[] = [];
    let page = 1;
    const perPage = 200;

    while (true) {
      const payload = await request({
        path: '/users',
        query: {
          page,
          per_page: perPage,
          filter_by: 'Status.All',
        },
      });

      const users = getRecordArray(payload, 'users');
      allUsers.push(...users);

      const pageContext = getPageContext(payload);
      const hasMore = typeof pageContext?.has_more_page === 'boolean'
        ? pageContext.has_more_page
        : users.length >= perPage;
      if (!hasMore) break;

      page = (typeof pageContext?.page === 'number' ? pageContext.page : page) + 1;
    }

    return allUsers;
  }

  async function requestPricelistsPage(
    query: Record<string, string | number | boolean | undefined | null>,
  ): Promise<Record<string, unknown>> {
    try {
      return await request({
        path: '/pricebooks',
        query,
      });
    } catch (error) {
      if (!(error instanceof ZohoApiError) || error.status < 400) {
        throw error;
      }
      return await request({
        path: '/pricelists',
        query,
      });
    }
  }

  function getPriceListRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
    for (const key of PRICE_LIST_RESPONSE_KEYS) {
      const rows = getRecordArray(payload, key);
      if (rows.length > 0) return rows;
    }
    return [];
  }

  async function fetchPricelists(): Promise<Record<string, unknown>[]> {
    const allPricelists: Record<string, unknown>[] = [];
    let page = 1;
    const perPage = DEFAULT_PER_PAGE;

    while (true) {
      const payload = await requestPricelistsPage({ page, per_page: perPage });
      const rows = getPriceListRecords(payload);
      allPricelists.push(...rows);

      const pageContext = getPageContext(payload);
      const hasMore = typeof pageContext?.has_more_page === 'boolean'
        ? pageContext.has_more_page
        : rows.length >= perPage;
      if (!hasMore) break;

      page = (typeof pageContext?.page === 'number' ? pageContext.page : page) + 1;
    }

    return allPricelists;
  }

  return {
    provider: 'zoho' as const,
    integrationTypeId,
    credentials,
    testConnection,
    fetchPhasePage,
    fetchContactPersons,
    fetchContactById,
    fetchItemById,
    fetchLocationById,
    fetchPricebookDetail,
    fetchCustomerPaymentDetail,
    fetchEstimateById,
    fetchSalesOrderById,
    fetchInvoiceById,
    fetchPricelists,
    fetchUsers,
    request,
  };
}

export async function refreshZohoAccessToken(
  integrationTypeId: ZohoIntegrationTypeId,
  rawCredentials: Record<string, unknown>,
): Promise<{ accessToken: string; credentials: NormalizedZohoCredentials }> {
  const credentials = normalizeZohoCredentials(integrationTypeId, rawCredentials);
  const url = new URL('/oauth/v2/token', credentials.accountsBaseUrl);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('client_secret', credentials.clientSecret);
  url.searchParams.set('refresh_token', credentials.refreshToken);

  const response = await fetch(url.toString(), { method: 'POST' });
  const payload = await parseZohoResponse(response);
  const accessToken = asString(payload.access_token);

  if (!accessToken) {
    throw new ZohoApiError('Zoho refresh response did not include an access_token.', response.status, undefined, payload);
  }

  return { accessToken, credentials };
}

export type ZohoAdapter = ReturnType<typeof createZohoAdapter>;
export type { ZohoCredentialsInput };
