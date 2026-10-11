/**
 * integrations-persist.ts
 * Persists Zoho entity pages into app.* tables after each fetched page.
 * All persisters are idempotent (upsert-based) so re-runs are safe.
 */

import type { ZohoAdapter } from './integrations-zoho.ts';
import { ZOHO_DETAIL_FETCH_CONCURRENCY, ZOHO_DETAIL_FETCH_BATCH_PACE_MS } from './integrations-zoho.ts';
import type { ZohoIntegrationTypeId } from '../../../src/lib/integrations/contracts.ts';
import type { EntityEnrichmentMode, SyncEnrichmentPolicy } from '../../../src/lib/integrations/sync-orchestration.ts';
import { enrichmentModeForEntity, resolveSyncEnrichmentPolicy } from '../../../src/lib/integrations/sync-orchestration.ts';
import {
  bulkPersistJsonbRecords,
  bulkPersistJsonbRecordsWithIds,
  persistWithNaturalKeyLock,
  LockTimeoutError,
} from '../../../src/lib/integrations/rpc-persist.ts';

export { LockTimeoutError };
import {
  normalizeLocationAssociatedUsers,
  // syncLocationAssignees, // Disabled — see persistLocations for details. Re-enable this import if that call is restored.
} from '../../../src/lib/location-assignees.ts';
import { logCheckpoint, startTimer } from './sync-log.ts';
import type { createAdminClient } from './sync-utils.ts';
import {
  captureZohoErpAnalyticsEvents,
  isZohoBuyerAccessEnabledCandidate,
  isZohoCatalogTransactionCandidate,
  type ZohoAnalyticsCandidate,
} from './posthog-erp-analytics.ts';
// import { putObjectJson } from './r2.ts'; // Disabled — see batchUpsertEntityMap for details. Re-enable this import if that call is restored.

// ── Types ───────────────────────────────────────────────────────────────────

export interface PersistResult {
  created: number;
  updated: number;
  skipped: number;
  pendingSearchVectorProductIds: string[];
  pendingSearchVectorBuyerIds: string[];
  pendingSearchVectorBuyerUserIds: string[];
  pendingSearchVectorBrandIds: string[];
  pendingSearchVectorCategoryIds: string[];
  pendingSearchVectorLocationIds: string[];
  pendingSearchVectorWarehouseIds: string[];
  pendingSearchVectorCohortIds: string[];
  pendingSearchVectorCampaignIds: string[];
  pendingSearchVectorPriceListIds: string[];
}

export interface PersistOptions {
  enrichmentPolicy?: SyncEnrichmentPolicy;
  customerEnrichmentMode?: EntityEnrichmentMode;
  // Wall-clock deadline (Date.now()-comparable ms) for persisters that make many
  // sequential external calls (e.g. persistPricelists' per-pricebook detail
  // fetch loop) so they can bail out early instead of risking the edge
  // function's ~150s hard-kill mid-request. Optional — callers that don't set
  // it get unbounded behavior, same as today.
  deadlineMs?: number | null;
}

export const INCREMENTAL_PERSIST_OPTIONS: PersistOptions = {
  enrichmentPolicy: 'incremental',
  customerEnrichmentMode: 'detail_when_needed',
};

export function buildPersistOptions(input: {
  jobType?: string | null;
  entityType: string;
  overrides?: PersistOptions;
}): PersistOptions {
  const enrichmentPolicy = input.overrides?.enrichmentPolicy
    ?? resolveSyncEnrichmentPolicy(input.jobType ?? 'manual');
  const customerEnrichmentMode = input.overrides?.customerEnrichmentMode
    ?? enrichmentModeForEntity(enrichmentPolicy, input.entityType);
  return {
    enrichmentPolicy,
    customerEnrichmentMode,
  };
}

type AdminClient = ReturnType<typeof createAdminClient>;
type JsonRecord = Record<string, unknown>;

function emptyPersistResult(overrides?: Partial<PersistResult>): PersistResult {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    pendingSearchVectorProductIds: [],
    pendingSearchVectorBuyerIds: [],
    pendingSearchVectorBuyerUserIds: [],
    pendingSearchVectorBrandIds: [],
    pendingSearchVectorCategoryIds: [],
    pendingSearchVectorLocationIds: [],
    pendingSearchVectorWarehouseIds: [],
    pendingSearchVectorCohortIds: [],
    pendingSearchVectorCampaignIds: [],
    pendingSearchVectorPriceListIds: [],
    ...overrides,
  };
}

export class IntegrationSyncError extends Error {
  entityType: string;
  externalId: string | null;
  details?: JsonRecord;

  constructor(entityType: string, message: string, externalId: string | null, details?: JsonRecord) {
    super(message);
    this.name = 'IntegrationSyncError';
    this.entityType = entityType;
    this.externalId = externalId;
    this.details = details;
  }
}

// ── Shared utilities ─────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function asStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return null;
}

function pickZohoExternalId(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    const str = asStr(value);
    if (str) return str;
  }
  return null;
}

function pickPricebookExternalId(rec: Record<string, unknown>): string | null {
  const pricebook = asRecord(rec.pricebook);
  return pickZohoExternalId(
    rec.pricebook_id,
    rec.price_list_id,
    pricebook?.pricebook_id,
    pricebook?.price_list_id,
    pricebook?.pricelist_id,
  );
}

function asNum(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function asDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asDateOnly(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function asBool(v: unknown, defaultVal = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return defaultVal;
}

/** Zoho Books locations expose status as the string "active" | "inactive". */
function mapZohoLocationStatus(rec: Record<string, unknown>): 'active' | 'inactive' {
  const zohoStatus = asStr(rec.status)?.toLowerCase();
  if (zohoStatus === 'active' || zohoStatus === 'inactive') return zohoStatus;
  if (typeof rec.is_location_active === 'boolean') {
    return rec.is_location_active ? 'active' : 'inactive';
  }
  return 'active';
}

export function sanitizeZohoPhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Formats a list of strings as a PostgREST literal list, e.g. for use with
 * `.not(column, 'in', formatPostgrestLiteralList(values))`. Each value is
 * double-quoted with internal backslashes/quotes escaped, so values
 * containing commas, parentheses, or quotes are handled safely.
 */
function formatPostgrestLiteralList(values: string[]): string {
  const escaped = values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `(${escaped.join(',')})`;
}

function formatErrorReason(message: string, details?: JsonRecord): string {
  if (!details || Object.keys(details).length === 0) return message;
  try {
    return `${message} :: ${JSON.stringify(details)}`;
  } catch {
    return message;
  }
}

function dedupeByExternalRef(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return dedupeByColumns(rows, ['external_ref']);
}

function dedupeByColumns(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, unknown>[] {
  const deduped = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const parts: string[] = [];
    let hasAllValues = true;

    for (const column of columns) {
      const value = row[column];
      if (typeof value === 'string') {
        const normalized = value.trim();
        if (!normalized) {
          hasAllValues = false;
          break;
        }
        parts.push(normalized);
        continue;
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(String(value));
        continue;
      }

      hasAllValues = false;
      break;
    }

    if (!hasAllValues) continue;
    deduped.set(parts.join('::'), row);
  }

  return [...deduped.values()];
}

function getRowNaturalKey(row: Record<string, unknown>, columns: string[]): string | null {
  const parts: string[] = [];
  for (const column of columns) {
    const value = asStr(row[column]);
    if (!value) return null;
    parts.push(value);
  }
  return parts.join('::');
}

function dedupeByExternalOrNaturalKey(
  rows: Record<string, unknown>[],
  naturalKeyColumns: string[],
): Record<string, unknown>[] {
  const keyToGroup = new Map<string, number>();
  const groupRows: Array<Record<string, unknown> | null> = [];
  const groupKeys: string[][] = [];

  for (const row of rows) {
    const keys = new Set<string>();
    const externalRef = asStr(row.external_ref);
    const naturalKey = getRowNaturalKey(row, naturalKeyColumns);

    if (externalRef) keys.add(`external_ref:${externalRef}`);
    if (naturalKey) keys.add(`natural:${naturalKey}`);
    if (keys.size === 0) continue;

    const attachedGroups = [...keys]
      .map((key) => keyToGroup.get(key))
      .filter((value): value is number => typeof value === 'number');

    const targetGroup = attachedGroups.length > 0 ? Math.min(...attachedGroups) : groupRows.length;
    if (attachedGroups.length === 0) {
      groupRows.push(null);
      groupKeys.push([]);
    }

    groupRows[targetGroup] = row;

    for (const attachedGroup of attachedGroups) {
      if (attachedGroup === targetGroup) continue;
      for (const key of groupKeys[attachedGroup]) {
        keyToGroup.set(key, targetGroup);
        if (!groupKeys[targetGroup].includes(key)) {
          groupKeys[targetGroup].push(key);
        }
      }
      groupRows[attachedGroup] = null;
      groupKeys[attachedGroup] = [];
    }

    for (const key of keys) {
      keyToGroup.set(key, targetGroup);
      if (!groupKeys[targetGroup].includes(key)) {
        groupKeys[targetGroup].push(key);
      }
    }
  }

  return groupRows.filter((row): row is Record<string, unknown> => row !== null);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * A just-created Yukti document may immediately echo back from Zoho. Preserve
 * only the explicitly guarded business fields; remote ids/statuses still merge.
 */
async function applyImmediateEchoGuards(
  admin: AdminClient,
  tenantId: string,
  integrationId: string,
  entityType: 'estimates' | 'orders' | 'invoices',
  table: 'estimates' | 'orders' | 'invoices',
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const externalIds = rows.map((row) => asStr(row.external_ref)).filter((id): id is string => id !== null);
  if (externalIds.length === 0) return rows;

  const now = nowIso();
  const { data: guards } = await admin.schema('app').from('integration_webhook_echo_guards')
    .select('id, external_entity_id, protected_fields')
    .eq('tenant_id', tenantId)
    .eq('tenant_integration_id', integrationId)
    .eq('entity_type', entityType)
    .in('external_entity_id', externalIds)
    .gt('expires_at', now)
    .is('consumed_at', null)
    .is('deleted_at', null);
  if (!guards?.length) return rows;

  const { data: existingRows } = await admin.schema('app').from(table)
    .select('*').eq('tenant_id', tenantId).in('external_ref', externalIds).is('deleted_at', null);
  const existingByExternalRef = new Map(
    (existingRows ?? []).map((row: Record<string, unknown>) => [String(row.external_ref), row]),
  );

  const guardedByExternalRef = new Map(
    guards.map((guard: { id: string; external_entity_id: string; protected_fields: string[] }) => [guard.external_entity_id, guard]),
  );
  const guardedIds: string[] = [];
  const merged = rows.map((row) => {
    const externalRef = asStr(row.external_ref);
    const guard = externalRef ? guardedByExternalRef.get(externalRef) : null;
    const existing = externalRef ? existingByExternalRef.get(externalRef) : null;
    if (!guard || !existing) return row;
    guardedIds.push(guard.id);
    const protectedValues = Object.fromEntries(
      guard.protected_fields
        .filter((field) => Object.prototype.hasOwnProperty.call(existing, field))
        .map((field) => [field, existing[field]]),
    );
    return { ...row, ...protectedValues };
  });

  if (guardedIds.length > 0) {
    await admin.schema('app').from('integration_webhook_echo_guards')
      .update({ consumed_at: now, updated_at: now })
      .in('id', guardedIds);
  }
  return merged;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    const str = asStr(value);
    if (str) return str;
  }
  return null;
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const num = asNum(value);
    if (num !== null) return num;
  }
  return null;
}

/**
 * GST rate for a Zoho item. India GST orgs leave top-level `tax_percentage` at 0
 * and carry the real rates in `item_tax_preferences[]` (one entry per
 * `tax_specification`: `intra` = CGST+SGST group, `inter` = IGST). Prefer intra,
 * then inter; fall back to the top-level fields for non-GST orgs.
 */
export function resolveZohoItemGstRate(rec: Record<string, unknown>): number | null {
  const prefs = Array.isArray(rec.item_tax_preferences)
    ? rec.item_tax_preferences.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    : [];
  for (const spec of ['intra', 'inter']) {
    const pref = prefs.find((p) => p.tax_specification === spec);
    const rate = pref ? asNum(pref.tax_percentage) : null;
    if (rate !== null) return rate;
  }
  return pickNumber(rec.tax_percentage, rec.gst_rate);
}

function resolveLineTotal(line: Record<string, unknown>, lineIndex: number): number {
  const itemTotal = pickNumber(line.item_total, line.total, line.amount);
  if (itemTotal !== null) return itemTotal;
  const qty = pickNumber(line.quantity, line.qty) ?? 0;
  const rate = pickNumber(line.rate, line.unit_price, line.price) ?? 0;
  return qty * rate;
}

function resolveLineOrder(line: Record<string, unknown>, lineIndex: number): number {
  return pickNumber(line.item_order) ?? (lineIndex + 1);
}

function resolveImportedActorId(
  actorId: string | null,
  salespersonId: string | null,
  salespersonActorMap: Map<string, string>,
): string | null {
  if (salespersonId) {
    const mapped = salespersonActorMap.get(salespersonId);
    if (mapped) return mapped;
  }
  return actorId;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function buildZohoSalespersonActorMap(
  admin: AdminClient,
  tenantId: string,
  adapter?: ZohoAdapter,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!adapter) return map;

  const zohoUsers = await adapter.fetchUsers();
  const zohoEmailById = new Map<string, string>();
  for (const user of zohoUsers) {
    const id = asStr(user.user_id);
    const email = asStr(user.email);
    if (id && email) zohoEmailById.set(id, normalizeEmail(email));
  }
  if (zohoEmailById.size === 0) return map;

  const { data: tenantUserRows } = await admin
    .schema('app')
    .from('tenant_users')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);

  const tenantUserIds = new Set(
    (tenantUserRows ?? [])
      .map((row) => asStr((row as { user_id: string }).user_id))
      .filter((value): value is string => value !== null),
  );
  if (tenantUserIds.size === 0) return map;

  const { data: authList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const authUserByEmail = new Map<string, string>();
  for (const user of authList?.users ?? []) {
    const email = asStr(user.email);
    if (!email || !tenantUserIds.has(user.id)) continue;
    authUserByEmail.set(normalizeEmail(email), user.id);
  }

  for (const [zohoUserId, email] of zohoEmailById) {
    const authId = authUserByEmail.get(email);
    if (authId) map.set(zohoUserId, authId);
  }

  return map;
}

function presentNumberFields(...entries: Array<readonly [string, number | null]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value !== null) out[key] = value;
  }
  return out;
}

function presentStringField(key: string, value: string | null): Record<string, unknown> {
  return value ? { [key]: value } : {};
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function omitKeys(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const blacklist = new Set(keys);
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => !blacklist.has(key) && value !== undefined),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
}

function pickSanitizedPhone(...values: unknown[]): string | null {
  for (const value of values) {
    const phone = sanitizeZohoPhone(value);
    if (phone) return phone;
  }
  return null;
}

function extractCustomField(rec: Record<string, unknown>, apiName: string): string | null {
  const fields = rec.custom_fields;
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (typeof f === 'object' && f !== null && !Array.isArray(f)) {
      const field = f as Record<string, unknown>;
      if (asStr(field.api_name) === apiName) {
        const value = normalizeCustomFieldValue(field.value);
        if (typeof value === 'string') return value;
        if (value !== null) return String(value);
      }
    }
  }
  return null;
}

// ── Generic Zoho custom field (cf_*) capture + tenant-configured mapping ────
// See app.tenant_field_mappings (migration 20260705040222). Every cf_* field
// on a Zoho record is captured into the row's `custom_fields` jsonb column
// unconditionally; a tenant's active mapping rows additionally "promote" a
// handful of those fields onto real typed columns used by app logic.

type CustomFieldJsonValue = string | number | boolean | null;

function normalizeCustomFieldValue(value: unknown): CustomFieldJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return String(value);
}

function buildCustomFieldsJson(rec: Record<string, unknown>): Record<string, CustomFieldJsonValue> {
  const fields = rec.custom_fields;
  if (!Array.isArray(fields)) return {};
  const out: Record<string, CustomFieldJsonValue> = {};
  for (const f of fields) {
    if (typeof f === 'object' && f !== null && !Array.isArray(f)) {
      const field = f as Record<string, unknown>;
      const apiName = asStr(field.api_name);
      if (apiName) out[apiName] = normalizeCustomFieldValue(field.value);
    }
  }
  return out;
}

function coerceZohoBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no', ''].includes(normalized)) return false;
  }
  return null;
}

interface TenantFieldMappingRow {
  zoho_field_name: string;
  target_column: string;
  transform_type: string;
}

type FieldMappingEntityType = 'customers' | 'estimates' | 'orders' | 'invoices';

async function loadFieldMappings(
  admin: AdminClient,
  tenantIntegrationId: string,
  entityType: FieldMappingEntityType,
): Promise<TenantFieldMappingRow[]> {
  const { data, error } = await admin
    .schema('app')
    .from('tenant_field_mappings')
    .select('zoho_field_name, target_column, transform_type')
    .eq('tenant_integration_id', tenantIntegrationId)
    .eq('entity_type', entityType)
    .eq('is_active', true);

  if (error) throw new Error(`loadFieldMappings failed: ${error.message}`);
  return (data ?? []) as TenantFieldMappingRow[];
}

function applyFieldMappings(
  customFields: Record<string, CustomFieldJsonValue>,
  mappings: TenantFieldMappingRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mapping of mappings) {
    if (mapping.transform_type === 'boolean_from_zoho') {
      const raw = mapping.zoho_field_name in customFields
        ? customFields[mapping.zoho_field_name]
        : null;
      out[mapping.target_column] = coerceZohoBoolean(raw) ?? false;
    } else if (mapping.transform_type === 'copy') {
      if (!(mapping.zoho_field_name in customFields)) continue;
      out[mapping.target_column] = customFields[mapping.zoho_field_name];
    }
    // 'enum_map' reserved for future transform_config-driven lookups; no
    // tenant uses it yet.
  }
  return out;
}

function normalizeZohoStrategy(value: unknown): string {
  const raw = asStr(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!raw) return 'per_item';
  if (raw.includes('percent')) return 'percentage';
  if (raw.includes('per_item') || raw.includes('item_wise') || raw.includes('item')) return 'per_item';
  return 'per_item';
}

function isSalesPricebook(record: Record<string, unknown>): boolean {
  const rawType = asStr(record.pricebook_type) ?? asStr(record.price_list_type) ?? asStr(record.type);
  const normalized = rawType?.toLowerCase() ?? null;
  if (normalized?.includes('purchase')) return false;
  if (normalized?.includes('sale')) return true;
  if (typeof record.is_sales === 'boolean') return record.is_sales;
  return true;
}

function getPricebookItemRows(rec: Record<string, unknown>): Record<string, unknown>[] {
  return asRecordArray(
    rec.pricebook_items
    ?? rec.pricelist_items
    ?? rec.item_pricings
    ?? rec.item_pricing
    ?? rec.items
    ?? rec.pricing_details,
  );
}

const SEARCH_VECTOR_CHUNK_SIZE = 100;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export async function rebuildBuyerSearchVectors(
  admin: AdminClient,
  tenantId: string,
  buyerIds: string[],
): Promise<void> {
  if (buyerIds.length === 0) return;
  for (const chunk of chunkArray(buyerIds, SEARCH_VECTOR_CHUNK_SIZE)) {
    const { error } = await admin.schema('app').rpc('rebuild_buyers_search_vectors', {
      p_tenant_id: tenantId,
      p_ids: chunk,
    });
    if (error) throw new Error(`rebuild_buyers_search_vectors failed: ${error.message}`);
  }
}

export async function rebuildBuyerUserSearchVectors(
  admin: AdminClient,
  buyerIds: string[],
  buyerUserIds: string[],
): Promise<void> {
  if (buyerIds.length === 0 && buyerUserIds.length === 0) return;

  // Parent buyer names are embedded in contact vectors, so buyer changes and
  // contact changes are rebuilt independently to avoid repeatedly updating
  // every contact for each contact-ID chunk.
  for (const chunk of chunkArray(Array.from(new Set(buyerIds)), SEARCH_VECTOR_CHUNK_SIZE)) {
    const { error } = await admin.schema('app').rpc('rebuild_buyer_users_search_vectors', {
      p_buyer_ids: chunk,
      p_ids: null,
    });
    if (error) throw new Error(`rebuild_buyer_users_search_vectors failed: ${error.message}`);
  }

  for (const chunk of chunkArray(Array.from(new Set(buyerUserIds)), SEARCH_VECTOR_CHUNK_SIZE)) {
    const { error } = await admin.schema('app').rpc('rebuild_buyer_users_search_vectors', {
      p_buyer_ids: null,
      p_ids: chunk,
    });
    if (error) throw new Error(`rebuild_buyer_users_search_vectors failed: ${error.message}`);
  }
}

function getEmbeddedLocationRows(rec: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    rec.item_locations,
    rec.locations,
    rec.warehouses,
    rec.inventory,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row));
    }
  }

  return [];
}

function getEmbeddedLocationAssociatedUsers(rec: Record<string, unknown>): Record<string, unknown>[] {
  const candidate = rec.associated_users;
  if (Array.isArray(candidate)) {
    return candidate.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row));
  }
  return [];
}

function getEmbeddedLocationExternalId(loc: Record<string, unknown>): string | null {
  return (
    asStr(loc.location_id)
    ?? asStr(loc.warehouse_id)
    ?? asStr(loc.item_location_id)
    ?? asStr(loc.id)
  );
}

function getEmbeddedLocationQty(loc: Record<string, unknown>): number {
  return (
    asNum(loc.location_available_stock)
    ?? asNum(loc.warehouse_available_stock)
    ?? asNum(loc.available_stock)
    ?? asNum(loc.stock_on_hand)
    ?? asNum(loc.quantity)
    ?? 0
  );
}

// ── Entity map helpers ───────────────────────────────────────────────────────

async function resolveInternalId(
  admin: AdminClient,
  tenantId: string,
  integrationId: string,
  entityType: string,
  externalId: string,
): Promise<string | null> {
  const { data } = await admin
    .schema('app')
    .from('integration_entity_map')
    .select('internal_id')
    .eq('tenant_id', tenantId)
    .eq('tenant_integration_id', integrationId)
    .eq('entity_type', entityType)
    .eq('external_id', externalId)
    .is('deleted_at', null)
    .maybeSingle();

  return (data as { internal_id: string } | null)?.internal_id ?? null;
}

async function resolveInternalIds(
  admin: AdminClient,
  tenantId: string,
  integrationId: string,
  entityType: string,
  externalIds: string[],
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();

  const { data } = await admin
    .schema('app')
    .from('integration_entity_map')
    .select('external_id, internal_id')
    .eq('tenant_id', tenantId)
    .eq('tenant_integration_id', integrationId)
    .eq('entity_type', entityType)
    .in('external_id', externalIds)
    .is('deleted_at', null);

  const map = new Map<string, string>();
  if (Array.isArray(data)) {
    for (const row of data as { external_id: string; internal_id: string }[]) {
      if (row.external_id && row.internal_id) {
        map.set(row.external_id, row.internal_id);
      }
    }
  }
  return map;
}

async function batchUpsertEntityMap(
  admin: AdminClient,
  tenantId: string,
  integrationId: string,
  entityType: string,
  pairs: Array<{ externalId: string; internalId: string; sourcePayload?: Record<string, unknown> | null }>,
  options?: {
    syncStatus?: 'synced' | 'pending_push' | 'conflict' | 'error';
    errorReason?: string | null;
  },
): Promise<void> {
  if (pairs.length === 0) return;
  logCheckpoint(null, entityType, 'batchUpsertEntityMap:start', { pairs: pairs.length });

  // source_payload is intentionally NOT written here — payloads are stored
  // in R2 (see source_payload_r2_key below), not inline as jsonb, to avoid
  // per-row table bloat (was 71MB table / 51MB idx+toast for 42K rows).
  const rows = pairs.map((p) => ({
    tenant_id: tenantId,
    tenant_integration_id: integrationId,
    entity_type: entityType,
    external_id: p.externalId,
    internal_id: p.internalId,
    last_synced_at: nowIso(),
    sync_status: options?.syncStatus ?? 'synced',
    error_reason: options?.errorReason ?? null,
  }));

  const persisted = await bulkPersistJsonbRecords(admin, 'integration_entity_map', dedupeByColumns(rows, [
    'tenant_id',
    'tenant_integration_id',
    'entity_type',
    'external_id',
  ]), [
    'tenant_id',
    'tenant_integration_id',
    'entity_type',
    'external_id',
  ]);

  // Disabled: source_payload -> R2 persistence (both the putObjectJson upload
  // and the integration_entity_map.source_payload_r2_key column write) is
  // commented out to cut sync-job DB/network load. entity_map upsert above
  // still runs unchanged. Re-enable by uncommenting the block below if the
  // raw Zoho payload archive is needed again.
  //
  // // Last-write-wins per external_id, matching dedupeByColumns' own dedupe
  // // behavior above, so the payload we write to R2 matches the row that was
  // // actually persisted.
  // const payloadByExternalId = new Map<string, Record<string, unknown>>();
  // for (const p of pairs) {
  //   if (p.sourcePayload) payloadByExternalId.set(p.externalId, p.sourcePayload);
  // }
  // if (payloadByExternalId.size === 0) return;
  //
  // await Promise.allSettled(
  //   persisted.map(async (row) => {
  //     const externalId = String(row.external_id ?? '');
  //     const payload = payloadByExternalId.get(externalId);
  //     if (!payload) return;
  //
  //     const rowId = String(row.id ?? '');
  //     if (!rowId) return;
  //
  //     const key = `integrations/${tenantId}/entity-map/${rowId}.json`;
  //     await putObjectJson(key, payload);
  //
  //     // Key is deterministic from the row's own id, so it's stable once
  //     // set — only write it on first sync of this row, not every re-sync.
  //     if (!row.source_payload_r2_key) {
  //       const { error } = await admin
  //         .schema('app')
  //         .from('integration_entity_map')
  //         .update({ source_payload_r2_key: key })
  //         .eq('id', rowId);
  //       if (error) {
  //         console.error(`[r2] failed to record source_payload_r2_key for entity_map row ${rowId}: ${error.message}`);
  //       }
  //     }
  //   }),
  // ).then((results) => {
  //   for (const result of results) {
  //     if (result.status === 'rejected') {
  //       console.error(`[r2] failed to persist source_payload for entity_type=${entityType}: ${String(result.reason)}`);
  //     }
  //   }
  // });
}

async function upsertImportedPriceList(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  integrationTypeId: ZohoIntegrationTypeId,
): Promise<string> {
  const externalRef = `zoho_price_list:${integrationTypeId}:base`;
  const name = `Zoho ${integrationTypeId === 'zoho_inventory' ? 'Inventory' : 'Books'} Imported Pricing`;
  const now = nowIso();
  const persisted = await bulkPersistJsonbRecordsWithIds(admin, 'price_lists', [{
    tenant_id: tenantId,
    external_ref: externalRef,
    name,
    currency: 'INR',
    valid_from: now,
    priority: 0,
    is_active: true,
    created_by: actorId,
    updated_by: actorId,
  }], ['tenant_id', 'external_ref']);

  const priceListId = persisted[0] ?? null;
  if (!priceListId) {
    throw new Error('Failed to create imported price list');
  }

  await batchUpsertEntityMap(admin, tenantId, integrationId, 'price_lists', [
    {
      externalId: externalRef,
      internalId: priceListId,
      sourcePayload: {
        source: 'zoho_imported_price_list',
        external_ref: externalRef,
        integration_type_id: integrationTypeId,
      },
    },
  ]);

  return priceListId;
}

function mapPersistedRowsByExternalRef(rows: Record<string, unknown>[]): Array<{ externalId: string; internalId: string }> {
  return rows
    .map((row) => {
      const externalId = asStr(row.external_ref);
      const internalId = asStr(row.id);
      return externalId && internalId ? { externalId, internalId } : null;
    })
    .filter((row): row is { externalId: string; internalId: string } => row !== null);
}

function buildPersistedRowPairsFromSourceRows(
  sourceRows: Record<string, unknown>[],
  persistedRows: Record<string, unknown>[],
  naturalKeyColumns: string[],
): Array<{ externalId: string; internalId: string }> {
  const persistedByExternalRef = new Map<string, string>();
  const persistedByNaturalKey = new Map<string, string>();

  for (const row of persistedRows) {
    const externalId = asStr(row.external_ref);
    const internalId = asStr(row.id);
    const naturalKey = getRowNaturalKey(row, naturalKeyColumns);
    if (externalId && internalId) persistedByExternalRef.set(externalId, internalId);
    if (naturalKey && internalId) persistedByNaturalKey.set(naturalKey, internalId);
  }

  const pairs = new Map<string, string>();
  for (const row of sourceRows) {
    const externalId = asStr(row.external_ref);
    if (!externalId) continue;
    const naturalKey = getRowNaturalKey(row, naturalKeyColumns);
    const internalId = persistedByExternalRef.get(externalId) ?? (naturalKey ? persistedByNaturalKey.get(naturalKey) ?? null : null);
    if (internalId) {
      pairs.set(externalId, internalId);
    }
  }

  return [...pairs.entries()].map(([externalId, internalId]) => ({ externalId, internalId }));
}

function attachSourcePayload(
  pairs: Array<{ externalId: string; internalId: string }>,
  sourceByExternalId: Map<string, Record<string, unknown>>,
): Array<{ externalId: string; internalId: string; sourcePayload: Record<string, unknown> | null }> {
  return pairs.map((pair) => ({
    ...pair,
    sourcePayload: sourceByExternalId.get(pair.externalId) ?? null,
  }));
}

function buildSourceByExternalId(
  records: Record<string, unknown>[],
  pickExternalId: (rec: Record<string, unknown>) => string | null,
): Map<string, Record<string, unknown>> {
  return new Map(
    records.flatMap((rec) => {
      const externalId = pickExternalId(rec);
      return externalId ? [[externalId, rec] as const] : [];
    }),
  );
}

export async function resolveInternalIdsWithFallback(
  admin: AdminClient,
  tenantId: string,
  integrationId: string,
  entityType: string,
  tableName: string,
  externalIds: string[],
): Promise<Map<string, string>> {
  const resolved = await resolveInternalIds(admin, tenantId, integrationId, entityType, externalIds);
  const unresolved = externalIds.filter((externalId) => !resolved.has(externalId));
  if (unresolved.length === 0) return resolved;

  const { data } = await admin
    .schema('app')
    .from(tableName)
    .select('external_ref, id')
    .eq('tenant_id', tenantId)
    .in('external_ref', unresolved)
    .is('deleted_at', null);

  if (Array.isArray(data)) {
    for (const row of data as { external_ref: string | null; id: string | null }[]) {
      if (row.external_ref && row.id) {
        resolved.set(row.external_ref, row.id);
      }
    }
  }

  return resolved;
}

export async function resolveInternalIdWithFallback(
  admin: AdminClient,
  tenantId: string,
  integrationId: string,
  entityType: string,
  tableName: string,
  externalId: string,
): Promise<string | null> {
  const resolved = await resolveInternalIdsWithFallback(admin, tenantId, integrationId, entityType, tableName, [externalId]);
  return resolved.get(externalId) ?? null;
}

export function buildTransactionalSourcePayload(rec: Record<string, unknown>): Record<string, unknown> {
  return omitKeys(rec, ['line_items']);
}

type ExistingTransactionalParentRow = {
  external_ref: string | null;
  source: string | null;
  estimate_number?: string | null;
  order_number?: string | null;
  is_buyer_app_estimate?: boolean | null;
  is_buyer_app_order?: boolean | null;
};

type ExistingExternalNaturalRows = {
  byExternalRef: Map<string, Record<string, unknown>>;
  byNaturalKey: Map<string, Record<string, unknown>>;
};

async function loadExistingRowsByExternalOrNaturalKey(
  admin: AdminClient,
  tableName: string,
  tenantId: string,
  externalRefs: string[],
  naturalKeyColumn: string,
  naturalKeys: string[],
  selectColumns: string,
): Promise<ExistingExternalNaturalRows> {
  const byExternalRef = new Map<string, Record<string, unknown>>();
  const byNaturalKey = new Map<string, Record<string, unknown>>();

  if (externalRefs.length > 0) {
    const { data, error } = await admin
      .schema('app')
      .from(tableName)
      .select(selectColumns)
      .eq('tenant_id', tenantId)
      .in('external_ref', externalRefs)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to load existing ${tableName} by external_ref: ${error.message}`);
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const externalRef = asStr(row.external_ref);
      const naturalKey = asStr(row[naturalKeyColumn]);
      if (externalRef) byExternalRef.set(externalRef, row);
      if (naturalKey) byNaturalKey.set(naturalKey, row);
    }
  }

  if (naturalKeys.length > 0) {
    const { data, error } = await admin
      .schema('app')
      .from(tableName)
      .select(selectColumns)
      .eq('tenant_id', tenantId)
      .in(naturalKeyColumn, naturalKeys)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to load existing ${tableName} by ${naturalKeyColumn}: ${error.message}`);
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const externalRef = asStr(row.external_ref);
      const naturalKey = asStr(row[naturalKeyColumn]);
      if (externalRef && !byExternalRef.has(externalRef)) byExternalRef.set(externalRef, row);
      if (naturalKey && !byNaturalKey.has(naturalKey)) byNaturalKey.set(naturalKey, row);
    }
  }

  return { byExternalRef, byNaturalKey };
}

async function loadExistingTransactionalParentRows(
  admin: AdminClient,
  tableName: 'estimates' | 'orders',
  tenantId: string,
  externalRefs: string[],
  naturalKeyColumn: 'estimate_number' | 'order_number',
  naturalKeys: string[],
): Promise<{
  byExternalRef: Map<string, ExistingTransactionalParentRow>;
  byNaturalKey: Map<string, ExistingTransactionalParentRow>;
}> {
  const byExternalRef = new Map<string, ExistingTransactionalParentRow>();
  const byNaturalKey = new Map<string, ExistingTransactionalParentRow>();

  if (externalRefs.length > 0) {
    const { data, error } = await admin
      .schema('app')
      .from(tableName)
      .select(`external_ref, source, ${naturalKeyColumn}, is_buyer_app_${tableName === 'estimates' ? 'estimate' : 'order'}`)
      .eq('tenant_id', tenantId)
      .in('external_ref', externalRefs)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to load existing ${tableName} by external_ref: ${error.message}`);
    }

    for (const row of (data ?? []) as ExistingTransactionalParentRow[]) {
      if (row.external_ref) byExternalRef.set(row.external_ref, row);
      const naturalKey = row[naturalKeyColumn];
      if (typeof naturalKey === 'string' && naturalKey.length > 0) {
        byNaturalKey.set(naturalKey, row);
      }
    }
  }

  if (naturalKeys.length > 0) {
    const { data, error } = await admin
      .schema('app')
      .from(tableName)
      .select(`external_ref, source, ${naturalKeyColumn}, is_buyer_app_${tableName === 'estimates' ? 'estimate' : 'order'}`)
      .eq('tenant_id', tenantId)
      .in(naturalKeyColumn, naturalKeys)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to load existing ${tableName} by ${naturalKeyColumn}: ${error.message}`);
    }

    for (const row of (data ?? []) as ExistingTransactionalParentRow[]) {
      if (row.external_ref && !byExternalRef.has(row.external_ref)) {
        byExternalRef.set(row.external_ref, row);
      }
      const naturalKey = row[naturalKeyColumn];
      if (typeof naturalKey === 'string' && naturalKey.length > 0 && !byNaturalKey.has(naturalKey)) {
        byNaturalKey.set(naturalKey, row);
      }
    }
  }

  return { byExternalRef, byNaturalKey };
}

function preserveExistingTransactionalOriginAndFlags(
  rows: Record<string, unknown>[],
  existingRows: {
    byExternalRef: Map<string, ExistingTransactionalParentRow>;
    byNaturalKey: Map<string, ExistingTransactionalParentRow>;
  },
  naturalKeyColumn: 'estimate_number' | 'order_number',
  flagColumn: 'is_buyer_app_estimate' | 'is_buyer_app_order',
): Record<string, unknown>[] {
  return rows.map((row) => {
    const externalRef = asStr(row.external_ref);
    const naturalKey = asStr(row[naturalKeyColumn]);
    const existing = (externalRef ? existingRows.byExternalRef.get(externalRef) : null)
      ?? (naturalKey ? existingRows.byNaturalKey.get(naturalKey) : null)
      ?? null;

    if (!existing) return row;

    const nextRow = { ...row };
    if (existing.source) {
      nextRow.source = existing.source;
    }

    if (existing[flagColumn] === true) {
      nextRow[flagColumn] = true;
    }

    return nextRow;
  });
}

// ── FK-failsafe ensure helpers ────────────────────────────────────────────────
// Each helper: resolve from entity_map+table → fetch from Zoho if missing → persist → re-resolve.
// Only active when adapter is provided (webhook path). Bulk sync callers omit adapter and get
// the existing graceful-degradation behaviour (null / skip / throw) unchanged.

/** GET /contacts/{id} and upsert buyer + embedded contact persons + assignments. */
export async function refreshBuyerFromZoho(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  zohoTypeId: ZohoIntegrationTypeId,
  externalContactId: string,
  adapter: ZohoAdapter,
): Promise<{ buyerId: string | null; synced: number }> {
  const fetched = await adapter.fetchContactById(externalContactId);
  if (!fetched) return { buyerId: null, synced: 0 };

  const result = await persistBuyers(
    admin,
    tenantId,
    actorId,
    integrationId,
    [fetched],
    adapter,
    zohoTypeId,
    INCREMENTAL_PERSIST_OPTIONS,
  );
  const buyerId = await resolveInternalIdWithFallback(
    admin,
    tenantId,
    integrationId,
    'customers',
    'buyers',
    externalContactId,
  );
  return { buyerId, synced: result.created + result.updated };
}

async function ensureBuyerExists(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  zohoTypeId: ZohoIntegrationTypeId,
  externalContactId: string,
  adapter: ZohoAdapter,
): Promise<string | null> {
  const existing = await resolveInternalIdWithFallback(admin, tenantId, integrationId, 'customers', 'buyers', externalContactId);
  if (existing) return existing;

  const { buyerId } = await refreshBuyerFromZoho(
    admin,
    tenantId,
    actorId,
    integrationId,
    zohoTypeId,
    externalContactId,
    adapter,
  );
  return buyerId;
}

async function ensureProductExists(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  zohoTypeId: ZohoIntegrationTypeId,
  externalItemId: string,
  adapter: ZohoAdapter,
): Promise<string | null> {
  const existing = await resolveInternalIdWithFallback(admin, tenantId, integrationId, 'products', 'tenant_products', externalItemId);
  if (existing) return existing;

  const fetched = await adapter.fetchItemById(externalItemId);
  if (!fetched) return null;

  await persistProducts(admin, tenantId, actorId, integrationId, [fetched], adapter);
  return resolveInternalIdWithFallback(admin, tenantId, integrationId, 'products', 'tenant_products', externalItemId);
}

async function ensurePricelistExists(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  zohoTypeId: ZohoIntegrationTypeId,
  externalPricebookId: string,
  adapter: ZohoAdapter,
): Promise<string | null> {
  const existing = await resolveInternalIdWithFallback(admin, tenantId, integrationId, 'pricelists', 'price_lists', externalPricebookId);
  if (existing) return existing;

  const fetched = await adapter.fetchPricebookDetail(externalPricebookId);
  if (!fetched) return null;

  await persistPricelists(admin, tenantId, actorId, integrationId, [fetched], adapter);
  return resolveInternalIdWithFallback(admin, tenantId, integrationId, 'pricelists', 'price_lists', externalPricebookId);
}

async function ensureLocationExists(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  zohoTypeId: ZohoIntegrationTypeId,
  externalLocationId: string,
  adapter: ZohoAdapter,
): Promise<string | null> {
  const existing = await resolveInternalIdWithFallback(admin, tenantId, integrationId, 'locations', 'locations', externalLocationId);
  if (existing) return existing;

  const fetched = await adapter.fetchLocationById(externalLocationId);
  if (!fetched) return null;

  await persistLocations(admin, tenantId, actorId, integrationId, zohoTypeId, [fetched], adapter);
  return resolveInternalIdWithFallback(admin, tenantId, integrationId, 'locations', 'locations', externalLocationId);
}

function buildLineItemSignature(line: Record<string, unknown>): Record<string, unknown> {
  return {
    item_id: asStr(line.item_id) ?? asStr(line.product_id),
    sku: asStr(line.sku) ?? asStr(line.item_sku) ?? asStr(line.item_code) ?? asStr(line.code),
    qty: pickNumber(line.quantity, line.qty),
    unit_price: pickNumber(line.rate, line.unit_price, line.price),
    line_total: pickNumber(line.item_total, line.total, line.amount),
    tax_pct: pickNumber(line.tax_percentage, line.tax_rate),
    disc_pct: pickNumber(line.discount_percentage, line.disc_pct),
    scheme_tag: pickString(line.scheme_tag, line.discount_type),
    hsn_code: pickString(line.hsn_code, line.hsn_or_sac, line.hsn_sac),
  };
}

export async function buildChildExternalRef(
  parentExternalRef: string,
  line: Record<string, unknown>,
  lineIndex: number,
): Promise<string> {
  const explicitLineId = pickString(
    line.line_item_id,
    line.line_id,
    line.detail_id,
    line.row_id,
    line.transaction_item_id,
  );

  if (explicitLineId) {
    return `${parentExternalRef}:line:${slugify(explicitLineId)}`;
  }

  const signature = await sha256Hex(JSON.stringify(buildLineItemSignature(line)));
  return `${parentExternalRef}:line:${String(lineIndex + 1).padStart(4, '0')}:${signature.slice(0, 12)}`;
}

async function persistDerivedChildRows(
  admin: AdminClient,
  table: 'estimate_items' | 'order_items' | 'invoice_items',
  parentColumn: 'estimate_id' | 'order_id' | 'invoice_id',
  parentIds: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (parentIds.length === 0) return;
  // Guard: no desired rows means we have no complete picture (e.g. Zoho list endpoint
  // omits line_items). Do not touch existing children — webhooks may have written them.
  if (rows.length === 0) return;
  const dedupedRows = dedupeByColumns(rows, [parentColumn, 'external_ref']);

  if (dedupedRows.length > 0) {
    await bulkPersistJsonbRecords(admin, table, dedupedRows, [parentColumn, 'external_ref']);
  }

  const { data } = await admin
    .schema('app')
    .from(table)
    .select(`id, ${parentColumn}, external_ref`)
    .in(parentColumn, parentIds)
    .is('deleted_at', null);

  if (!Array.isArray(data)) return;

  const desiredByParent = new Map<string, Set<string>>();
  for (const row of dedupedRows) {
    const parentId = asStr(row[parentColumn]);
    const externalRef = asStr(row.external_ref);
    if (!parentId || !externalRef) continue;

    if (!desiredByParent.has(parentId)) {
      desiredByParent.set(parentId, new Set());
    }
    desiredByParent.get(parentId)?.add(externalRef);
  }

  const staleIds: string[] = [];
  for (const row of data as Array<{ id: string; external_ref: string | null } & Record<string, unknown>>) {
    const parentId = asStr(row[parentColumn]);
    const externalRef = asStr(row.external_ref);
    if (!parentId || !row.id) continue;

    const desired = desiredByParent.get(parentId);
    if (!desired || !externalRef || !desired.has(externalRef)) {
      staleIds.push(row.id);
    }
  }

  if (staleIds.length > 0) {
    await admin
      .schema('app')
      .from(table)
      .update({ deleted_at: nowIso() })
      .in('id', staleIds)
      .is('deleted_at', null);
  }
}

// ── Locations ────────────────────────────────────────────────────────────────

async function persistLocations(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  integrationTypeId: ZohoIntegrationTypeId,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
): Promise<PersistResult> {
  const result = emptyPersistResult();

  const hasExistingDefault = await (async () => {
    const { count } = await admin
      .schema('app')
      .from('locations')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('is_default', true)
      .is('deleted_at', null);
    return (count ?? 0) > 0;
  })();

  let defaultAssigned = hasExistingDefault;
  const rows: Record<string, unknown>[] = [];
  const zohoUsers = adapter ? await adapter.fetchUsers() : [];
  const zohoUserById = new Map(
    zohoUsers
      .map((user) => {
        const id = asStr(user.user_id);
        if (!id) return null;
        return [
          id,
          {
            email: asStr(user.email),
            user_name: asStr(user.name) ?? asStr(user.user_name),
          },
        ] as const;
      })
      .filter((entry): entry is readonly [string, { email: string | null; user_name: string | null }] => entry !== null),
  );

  // Build reverse map: location_id → users assigned there.
  // Zoho users carry a location_id/warehouse_id field; the location list itself
  // doesn't embed associated_users, so we infer assignments from the user list.
  const usersByLocationId = new Map<string, Array<{ email: string; user_name: string | null }>>();
  for (const user of zohoUsers) {
    const locId = asStr(user.location_id) ?? asStr(user.warehouse_id);
    if (!locId) continue;
    const email = asStr(user.email);
    if (!email) continue;
    if (!usersByLocationId.has(locId)) usersByLocationId.set(locId, []);
    usersByLocationId.get(locId)!.push({
      email,
      user_name: asStr(user.name) ?? asStr(user.user_name) ?? null,
    });
  }

  for (const rec of records) {
    const externalId = asStr(rec.location_id);
    if (!externalId) { result.skipped++; continue; }

    const name = asStr(rec.location_name);
    if (!name) { result.skipped++; continue; }

    const isPrimary = asBool(rec.is_primary);
    const isDefault = !defaultAssigned && isPrimary;
    if (isDefault) defaultAssigned = true;

    const rawAddr = rec.address;
    const address = rawAddr && typeof rawAddr === 'object' ? rawAddr : null;
    const phoneNumber = sanitizeZohoPhone(rec.phone);
    const status = mapZohoLocationStatus(rec);
    const sourceAssociatedUsers = getEmbeddedLocationAssociatedUsers(rec);
    // Fall back to users inferred from the Zoho /users reverse map when the location
    // list endpoint doesn't embed associated_users.
    const effectiveAssociatedUsers = sourceAssociatedUsers.length > 0
      ? sourceAssociatedUsers.map((user) => {
          const sourceUserId = asStr(user.user_id) ?? asStr(user.id);
          const sourceUser = sourceUserId ? zohoUserById.get(sourceUserId) ?? null : null;
          const email = pickString(user.email, sourceUser?.email);
          if (!email) return null;
          return {
            email,
            user_name: pickString(user.user_name, sourceUser?.user_name),
            user_id: sourceUserId,
          };
        }).filter((user): user is { email: string; user_name: string | null; user_id: string | null } => user !== null)
      : (externalId ? (usersByLocationId.get(externalId) ?? []) : []);
    const associatedUsers = normalizeLocationAssociatedUsers(effectiveAssociatedUsers);

    const row = {
      tenant_id: tenantId,
      external_ref: externalId,
      name,
      address: address as Record<string, unknown> | null,
      phone_number: phoneNumber,
      status,
      associated_users: associatedUsers,
      deleted_at: null,
      ...(isDefault ? { is_default: true } : {}),
      created_at: asDate(rec.created_time ?? rec.created_at ?? rec.date_created),
      updated_at: asDate(rec.last_modified_time ?? rec.updated_at ?? rec.updated_time ?? rec.modified_time),
      created_by: actorId,
      updated_by: actorId,
    };
    rows.push(row);
  }

  const dedupedLocationRows = dedupeByColumns(rows, ['tenant_id', 'external_ref']);
  const persisted = dedupedLocationRows.length > 0
    ? await bulkPersistJsonbRecords(admin, 'locations', dedupedLocationRows, ['tenant_id', 'external_ref'])
    : [];

  const entityMapPairs: Array<{ externalId: string; internalId: string }> = [];
  for (const row of persisted) {
    const externalId = asStr(row.external_ref);
    const internalId = asStr(row.id);
    if (externalId && internalId) {
      entityMapPairs.push({ externalId, internalId });
    }
  }

  result.updated += persisted.length;
  result.pendingSearchVectorLocationIds = persisted
    .map((row) => asStr(row.id))
    .filter((value): value is string => value !== null);
  const locationSourceByExternalId = buildSourceByExternalId(
    records,
    (rec) => pickZohoExternalId(rec.location_id),
  );
  await batchUpsertEntityMap(
    admin,
    tenantId,
    integrationId,
    'locations',
    attachSourcePayload(entityMapPairs, locationSourceByExternalId),
  );

  const sourceByExternalRef = new Map(
    rows
      .map((row) => {
        const externalRef = asStr(row.external_ref);
        return externalRef ? [externalRef, row] as const : null;
      })
      .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null),
  );

  const assignments = persisted.flatMap((row) => {
    const id = asStr(row.id);
    const externalId = asStr(row.external_ref);
    if (!id || !externalId) return [];
    const source = sourceByExternalRef.get(externalId) ?? null;
    const users = normalizeLocationAssociatedUsers(source?.associated_users);
    return [{ locationId: id, users }];
  });

  // Disabled: access provisioning (tenant_users.location_ids) is now managed
  // via the frontend directly, not driven by Zoho sync. Re-enable this call
  // if Zoho-driven location-assignee provisioning is needed again later.
  // for (const assignment of assignments) {
  //   await syncLocationAssignees(
  //     admin as any,
  //     tenantId,
  //     assignment.locationId,
  //     assignment.users,
  //     actorId,
  //   );
  // }
  void assignments;

  return result;
}

// ── Warehouses ───────────────────────────────────────────────────────────────

async function persistWarehouses(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
): Promise<PersistResult> {
  const result = emptyPersistResult();

  // Collect location external IDs to resolve location_id FK for each warehouse
  const locationExternalIds = [
    ...new Set(
      records.map((r) => asStr(r.location_id)).filter((x): x is string => x !== null),
    ),
  ];
  const locationIdMap = locationExternalIds.length > 0
    ? await resolveInternalIdsWithFallback(admin, tenantId, integrationId, 'locations', 'locations', locationExternalIds)
    : new Map<string, string>();

  const rows: Record<string, unknown>[] = [];

  for (const rec of records) {
    const externalId = asStr(rec.warehouse_id);
    if (!externalId) { result.skipped++; continue; }

    const name = asStr(rec.warehouse_name);
    if (!name) { result.skipped++; continue; }

    const locationExtId = asStr(rec.location_id);
    const locationId = locationExtId ? (locationIdMap.get(locationExtId) ?? null) : null;

    const rawAddr = rec.address;
    const address = rawAddr && typeof rawAddr === 'object' ? rawAddr : null;
    const phoneNumber = sanitizeZohoPhone(rec.phone);
    const status = asStr(rec.status) ?? (asBool(rec.is_active) === false ? 'inactive' : 'active');

    rows.push({
      tenant_id: tenantId,
      external_ref: externalId,
      name,
      location_id: locationId,
      address: address as Record<string, unknown> | null,
      phone_number: phoneNumber,
      status,
      is_default: asBool(rec.is_primary) ?? false,
      associated_users: [],
      deleted_at: null,
      created_at: asDate(rec.created_time ?? rec.created_at ?? rec.date_created),
      updated_at: asDate(rec.last_modified_time ?? rec.updated_at ?? rec.updated_time ?? rec.modified_time),
      created_by: actorId,
      updated_by: actorId,
    });
  }

  const dedupedRows = dedupeByColumns(rows, ['tenant_id', 'external_ref']);
  const persisted = dedupedRows.length > 0
    ? await bulkPersistJsonbRecords(admin, 'warehouses', dedupedRows, ['tenant_id', 'external_ref'])
    : [];

  const entityMapPairs = persisted
    .map((row) => {
      const externalId = asStr(row.external_ref);
      const internalId = asStr(row.id);
      return externalId && internalId ? { externalId, internalId } : null;
    })
    .filter((r): r is { externalId: string; internalId: string } => r !== null);

  result.updated += persisted.length;
  result.pendingSearchVectorWarehouseIds = persisted
    .map((row) => asStr(row.id))
    .filter((value): value is string => value !== null);
  const warehouseSourceByExternalId = buildSourceByExternalId(
    records,
    (rec) => pickZohoExternalId(rec.warehouse_id),
  );
  await batchUpsertEntityMap(
    admin,
    tenantId,
    integrationId,
    'warehouses',
    attachSourcePayload(entityMapPairs, warehouseSourceByExternalId),
  );

  return result;
}

// ── Buyers (contacts) + buyer_contacts (contact persons) ────────────────────

const CONTACT_ENRICH_CONCURRENCY = 5;

async function enrichBuyerRecords(
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  mode: EntityEnrichmentMode = 'detail_when_needed',
  needsCustomFieldHydration = false,
): Promise<Record<string, unknown>[]> {
  if (!adapter || mode === 'list_only') return records;
  logCheckpoint(null, 'customers', 'enrichBuyerRecords:start', { records: records.length, batches: Math.ceil(records.length / CONTACT_ENRICH_CONCURRENCY) });

  const enriched: Record<string, unknown>[] = [];
  for (let i = 0; i < records.length; i += CONTACT_ENRICH_CONCURRENCY) {
    const batch = records.slice(i, i + CONTACT_ENRICH_CONCURRENCY);
    const batchDone = startTimer(null, 'customers', `enrichBuyerRecords:batch${Math.floor(i / CONTACT_ENRICH_CONCURRENCY) + 1}`);
    const batchResults = await Promise.all(batch.map(async (rec) => {
      const externalId = asStr(rec.contact_id);
      if (!externalId) return rec;

      const embeddedContactPersons = asRecordArray(rec.contact_persons);
      const hasCustomFields = Array.isArray(rec.custom_fields) && rec.custom_fields.length > 0;
      const hasPricebook = Boolean(pickPricebookExternalId(rec));
      const needsDetail = embeddedContactPersons.length === 0
        || (needsCustomFieldHydration && !hasCustomFields)
        || !hasPricebook;

      if (!needsDetail) return rec;

      const detail = await adapter.fetchContactById(externalId);
      if (!detail) return rec;

      return {
        ...rec,
        ...detail,
        contact_id: externalId,
      };
    }));
    batchDone({ enriched: batchResults.length });
    enriched.push(...batchResults);
  }

  return enriched;
}

async function persistBuyers(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  zohoTypeId?: ZohoIntegrationTypeId,
  persistOptions?: PersistOptions,
): Promise<PersistResult> {
  const result = emptyPersistResult();
  const buyerRows: Record<string, unknown>[] = [];
  const customerFieldMappings = await loadFieldMappings(admin, integrationId, 'customers');
  const customerEnrichmentMode = persistOptions?.customerEnrichmentMode ?? 'detail_when_needed';
  const needsCustomFieldHydration = customerFieldMappings.length > 0;
  const hydratedRecords = await enrichBuyerRecords(
    records,
    adapter,
    customerEnrichmentMode,
    needsCustomFieldHydration,
  );

  for (const rec of hydratedRecords) {
    const externalId = asStr(rec.contact_id);
    if (!externalId) { result.skipped++; continue; }

    const businessName = asStr(rec.company_name)
      ?? asStr(rec.contact_name)
      ?? 'Unknown';

    const billingAddress = asRecord(rec.billing_address);
    const shippingAddress = asRecord(rec.shipping_address);
    const geo = (() => {
      const a = billingAddress;
      if (!a) return null;
      return {
        state: asStr(a.state),
        city: asStr(a.city),
        address: asStr(a.address) ?? asStr(a.street),
        pincode: asStr(a.zip),
        country: asStr(a.country),
      };
    })();

    const customFields = buildCustomFieldsJson(rec);

    const row = {
      tenant_id: tenantId,
      external_ref: externalId,
      business_name: businessName,
      contact_name: asStr(rec.contact_name) ?? asStr(rec.first_name),
      email: asStr(rec.email),
      gstin: asStr(rec.gst_no) ?? asStr(rec.gstin) ?? extractCustomField(rec, 'cf_gstin'),
      gst_treatment: asStr(rec.gst_treatment),
      status: asStr(rec.status),
      billing_address: billingAddress,
      shipping_address: shippingAddress,
      credit_limit: asNum(rec.credit_limit),
      payment_terms_days: asNum(rec.payment_terms) ?? asNum(rec.payment_terms_days),
      geography: geo,
      is_active: (asStr(rec.status) ?? 'active') === 'active',
      custom_fields: customFields,
      ...applyFieldMappings(customFields, customerFieldMappings),
      deleted_at: null,
      created_by: actorId,
      updated_by: actorId,
      ...(pickSanitizedPhone(
        rec.phone,
        rec.mobile,
        billingAddress?.phone,
        billingAddress?.mobile,
        billingAddress?.phone_number,
        shippingAddress?.phone,
        shippingAddress?.mobile,
      ) ? {
        phone: pickSanitizedPhone(
          rec.phone,
          rec.mobile,
          billingAddress?.phone,
          billingAddress?.mobile,
          billingAddress?.phone_number,
          shippingAddress?.phone,
          shippingAddress?.mobile,
        ),
      } : {}),
    };

    buyerRows.push(row);
  }

  const existingBuyerRowsByExternalRef = new Map<string, Record<string, unknown>>();
  const buyerExternalRefs = buyerRows
    .map((row) => asStr(row.external_ref))
    .filter((value): value is string => value !== null);
  if (buyerExternalRefs.length > 0) {
    const { data, error } = await admin
      .schema('app')
      .from('buyers')
      .select('id, external_ref, buyer_app_enabled')
      .eq('tenant_id', tenantId)
      .in('external_ref', buyerExternalRefs)
      .is('deleted_at', null);

    if (error) throw new Error(`Failed to load existing buyers for analytics: ${error.message}`);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const externalRef = asStr(row.external_ref);
      if (externalRef) existingBuyerRowsByExternalRef.set(externalRef, row);
    }
  }

  const persistedBuyers = buyerRows.length > 0
    ? await bulkPersistJsonbRecords(admin, 'buyers', dedupeByExternalRef(buyerRows), ['tenant_id', 'external_ref'])
    : [];

  const buyerMapPairs = persistedBuyers
    .map((row) => {
      const externalId = asStr(row.external_ref);
      const internalId = asStr(row.id);
      return externalId && internalId ? { externalId, internalId } : null;
    })
    .filter((row): row is { externalId: string; internalId: string } => row !== null);
  const buyerIdMap = new Map(buyerMapPairs.map((row) => [row.externalId, row.internalId] as const));

  result.updated += buyerMapPairs.length;

  const contactRows: Record<string, unknown>[] = [];
  const buyerAssignmentRows: Record<string, unknown>[] = [];
  const pricebookExternalIds = [
    ...new Set(
      hydratedRecords
        .map((rec) => pickPricebookExternalId(rec))
        .filter((value): value is string => value !== null),
    ),
  ];
  const pricebookIdMap = await resolveInternalIdsWithFallback(
    admin,
    tenantId,
    integrationId,
    'pricelists',
    'price_lists',
    pricebookExternalIds,
  );

  // FK-failsafe: fetch missing pricelists from Zoho when adapter is present (webhook path)
  if (adapter && zohoTypeId) {
    for (const extId of pricebookExternalIds) {
      if (!pricebookIdMap.has(extId)) {
        const internalId = await ensurePricelistExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
        if (internalId) pricebookIdMap.set(extId, internalId);
      }
    }
  }

  for (const rec of hydratedRecords) {
    const externalId = asStr(rec.contact_id);
    if (!externalId) continue;

    const buyerId = buyerIdMap.get(externalId) ?? null;
    if (!buyerId) continue;

    const embeddedContactPersons = asRecordArray((rec as Record<string, unknown>).contact_persons);
    const contactPersons = embeddedContactPersons;

    for (const cp of contactPersons) {
      const cpId = asStr(cp.contact_person_id);
      if (!cpId) continue;

      contactRows.push({
        buyer_id: buyerId,
        external_ref: cpId,
        role: 'buyer_assistant' as const,
        first_name: asStr(cp.first_name),
        last_name: asStr(cp.last_name),
        email: asStr(cp.email),
        designation: asStr(cp.designation),
        department: asStr(cp.department),
        is_active: asBool(cp.is_active, true),
        created_by: actorId,
        updated_by: actorId,
        deleted_at: null,
        ...(pickSanitizedPhone(cp.phone, cp.mobile) ? { phone: pickSanitizedPhone(cp.phone, cp.mobile) } : {}),
      });
    }

    const pricebookExternalId = pickPricebookExternalId(rec);
    const priceListId = pricebookExternalId ? pricebookIdMap.get(pricebookExternalId) ?? null : null;
    if (priceListId) {
      buyerAssignmentRows.push({
        price_list_id: priceListId,
        target_type: 'buyer',
        target_id: buyerId,
        external_ref: `zoho_buyer_pricebook:${buyerId}`,
        source_payload: {
          source: 'zoho_pricebook_assignment',
          contact_id: externalId,
          pricebook_id: pricebookExternalId,
        },
        created_by: actorId,
        updated_by: actorId,
        deleted_at: null,
      });
    }
  }

  const dedupedContactRows = dedupeByColumns(contactRows, ['buyer_id', 'external_ref']);
  const persistedContacts = dedupedContactRows.length > 0
    ? await bulkPersistJsonbRecords(admin, 'buyer_users', dedupedContactRows, ['buyer_id', 'external_ref'])
    : [];

  const contactMapPairs = persistedContacts
    .map((row) => {
      const externalId = asStr(row.external_ref);
      const internalId = asStr(row.id);
      return externalId && internalId ? { externalId, internalId } : null;
    })
    .filter((row): row is { externalId: string; internalId: string } => row !== null);

  const customerSourceByExternalId = buildSourceByExternalId(
    hydratedRecords,
    (rec) => pickZohoExternalId(rec.contact_id),
  );
  const contactPersonSourceByExternalId = new Map<string, Record<string, unknown>>();
  for (const rec of hydratedRecords) {
    const parentContactId = pickZohoExternalId(rec.contact_id);
    for (const cp of asRecordArray(rec.contact_persons)) {
      const cpId = pickZohoExternalId(cp.contact_person_id);
      if (!cpId) continue;
      contactPersonSourceByExternalId.set(cpId, {
        ...cp,
        ...(parentContactId ? { parent_contact_id: parentContactId } : {}),
      });
    }
  }

  await Promise.all([
    batchUpsertEntityMap(
      admin,
      tenantId,
      integrationId,
      'customers',
      attachSourcePayload(buyerMapPairs, customerSourceByExternalId),
    ),
    batchUpsertEntityMap(
      admin,
      tenantId,
      integrationId,
      'contact_persons',
      attachSourcePayload(contactMapPairs, contactPersonSourceByExternalId),
    ),
  ]);

  const customerAnalyticsCandidates: ZohoAnalyticsCandidate[] = buyerMapPairs
    .map((pair) => {
      const sourceRecord = customerSourceByExternalId.get(pair.externalId) ?? null;
      const persistedRow = persistedBuyers.find((row) => asStr(row.id) === pair.internalId || asStr(row.external_ref) === pair.externalId) ?? {};
      const existingRow = existingBuyerRowsByExternalRef.get(pair.externalId) ?? null;
      if (!isZohoBuyerAccessEnabledCandidate({ sourceRecord, persistedRow, existingRow })) return null;
      return {
        entityType: 'customers' as const,
        externalId: pair.externalId,
        internalId: pair.internalId,
        eventName: 'server_erp_customer_buyer_access_enabled',
      };
    })
    .filter((candidate): candidate is ZohoAnalyticsCandidate => candidate !== null);

  await captureZohoErpAnalyticsEvents({
    admin,
    tenantId,
    tenantIntegrationId: integrationId,
    candidates: customerAnalyticsCandidates,
  });

  const buyerIds = buyerMapPairs.map((row) => row.internalId);
  const buyerUserIds = persistedContacts
    .map((row) => asStr(row.id))
    .filter((value): value is string => value !== null);

  const dedupedBuyerAssignmentRows = dedupeByColumns(
    buyerAssignmentRows,
    ['price_list_id', 'target_type', 'target_id', 'external_ref'],
  );

  if (dedupedBuyerAssignmentRows.length > 0) {
    await bulkPersistJsonbRecords(
      admin,
      'price_list_assignments',
      dedupedBuyerAssignmentRows,
      ['price_list_id', 'target_type', 'target_id', 'external_ref'],
    );

    // Batch stale-pricebook-assignment cleanup by the price list being kept
    // (N-per-distinct-price-list instead of N-per-buyer) — the Supabase JS
    // client has no VALUES-joined UPDATE, so group first.
    const targetIdsByKeptPriceListId = new Map<string, Set<string>>();
    for (const row of dedupedBuyerAssignmentRows) {
      const targetId = asStr(row.target_id);
      const priceListId = asStr(row.price_list_id);
      if (!targetId || !priceListId) continue;
      if (!targetIdsByKeptPriceListId.has(priceListId)) {
        targetIdsByKeptPriceListId.set(priceListId, new Set());
      }
      targetIdsByKeptPriceListId.get(priceListId)!.add(targetId);
    }

    for (const [priceListId, targetIdSet] of targetIdsByKeptPriceListId) {
      await admin
        .schema('app')
        .from('price_list_assignments')
        .update({
          deleted_at: nowIso(),
          updated_at: nowIso(),
          updated_by: actorId,
        })
        .eq('target_type', 'buyer')
        .in('target_id', [...targetIdSet])
        .like('external_ref', 'zoho_buyer_pricebook:%')
        .neq('price_list_id', priceListId)
        .is('deleted_at', null);
    }
  }

  result.pendingSearchVectorBuyerIds = buyerIds;
  result.pendingSearchVectorBuyerUserIds = buyerUserIds;

  return result;
}

// ── Products (categories + brands + products + inventory) ────────────────────

const ITEM_LOC_CONCURRENCY = ZOHO_DETAIL_FETCH_CONCURRENCY;
const ITEM_LOC_BATCH_INTERVAL_MS = ZOHO_DETAIL_FETCH_BATCH_PACE_MS;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createWarehouseFromZoho(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  zohoWarehouse: Record<string, unknown>,
): Promise<string | null> {
  const externalRef = asStr(zohoWarehouse.warehouse_id);
  if (!externalRef) return null;

  const name = asStr(zohoWarehouse.warehouse_name) || 'Unknown Warehouse';

  try {
    const { data, error } = await admin
      .schema('app')
      .from('warehouses')
      .upsert({
        external_ref: externalRef,
        tenant_id: tenantId,
        name,
        status: 'active',
        associated_users: [],
        created_by: actorId,
        updated_by: actorId,
      }, {
        onConflict: 'tenant_id,external_ref',
        ignoreDuplicates: false,
      })
      .select('id')
      .single();

    if (error) {
      console.warn(`sync-products: Failed to create warehouse ${externalRef}:`, error.message);
      return null;
    }

    return data?.id || null;
  } catch (err) {
    console.warn(`sync-products: Exception creating warehouse ${externalRef}:`, err);
    return null;
  }
}

async function ensureWarehouseExists(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  zohoTypeId: ZohoIntegrationTypeId,
  warehouseExternalId: string,
  adapter?: ZohoAdapter,
  sourceWarehouse?: Record<string, unknown>,
): Promise<string | null> {
  const existing = await resolveInternalIdsWithFallback(
    admin,
    tenantId,
    integrationId,
    'warehouses',
    'warehouses',
    [warehouseExternalId],
  );
  const resolved = existing.get(warehouseExternalId) ?? null;
  if (resolved) return resolved;

  if (sourceWarehouse) {
    const created = await createWarehouseFromZoho(admin, tenantId, actorId, sourceWarehouse);
    if (created) {
      return created;
    }
  }

  if (!adapter) return null;

  const fetched = await adapter.fetchLocationById(warehouseExternalId);
  if (!fetched) return null;

  await persistWarehouses(admin, tenantId, actorId, integrationId, [fetched]);
  const afterCreate = await resolveInternalIdsWithFallback(
    admin,
    tenantId,
    integrationId,
    'warehouses',
    'warehouses',
    [warehouseExternalId],
  );
  return afterCreate.get(warehouseExternalId) ?? null;
}

export interface ItemLocationFetchResult {
  persisted: number;
  // true if the deadline was hit before every item in `itemIds` was attempted —
  // caller should re-invoke with the same (or the still-pending) item ids.
  incomplete: boolean;
}

/**
 * Fetches per-item warehouse/stock detail (GET /items/{id}) for a batch of
 * Zoho item ids and upserts tenant_inventory. Persists and heartbeats after
 * EVERY batch (not once at the end) so a mid-loop kill leaves completed
 * batches durable and the job's heartbeat_at fresh — this loop is the one
 * that hung for 5-27 minutes with a single heartbeat write when it ran
 * inline inside sync-products; it now runs as its own sync-inventory phase,
 * paced to Zoho's 10-concurrent / 100-per-minute limits (see
 * ITEM_LOC_CONCURRENCY / ITEM_LOC_BATCH_INTERVAL_MS above).
 */
export async function fetchAndPersistMissingItemLocations(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  itemIds: string[],
  adapter: ZohoAdapter,
  productIdMap: Map<string, string>,
  warehouseIdMap: Map<string, string>,
  opts: {
    onBatchComplete?: () => void;
    deadlineMs?: number | null;
  } = {},
): Promise<ItemLocationFetchResult> {
  if (itemIds.length === 0) return { persisted: 0, incomplete: false };
  logCheckpoint(null, 'inventory', 'fetchAndPersistMissingItemLocations:start', { items: itemIds.length, batches: Math.ceil(itemIds.length / ITEM_LOC_CONCURRENCY) });

  const updatedWarehouseIdMap = new Map(warehouseIdMap);
  let totalPersisted = 0;
  let incomplete = false;

  // Reserve time for one full worst-case batch so the function returns before
  // hitting the coordinator's dispatch timeout or Supabase's 150s wall.
  // ZOHO_BULK_DETAIL_MAX_ATTEMPTS(2) x ZOHO_BULK_DETAIL_TIMEOUT_MS(15s) = 30s
  // + ZOHO_BULK_RETRY_DELAY_CAP_MS(5s) 429 backoff between attempts = 35s
  // + ~10s warehouse resolution + persist overhead = 45s total reservation.
  const BATCH_DEADLINE_RESERVATION_MS = 45_000;

  for (let i = 0; i < itemIds.length; i += ITEM_LOC_CONCURRENCY) {
    if (opts.deadlineMs != null && Date.now() + BATCH_DEADLINE_RESERVATION_MS > opts.deadlineMs) {
      incomplete = true;
      break;
    }

    const batchStart = Date.now();
    const batch = itemIds.slice(i, i + ITEM_LOC_CONCURRENCY);
    const batchDone = startTimer(null, 'inventory', `fetchAndPersistMissingItemLocations:batch${Math.floor(i / ITEM_LOC_CONCURRENCY) + 1}`);
    const results = await Promise.allSettled(
      batch.map((itemId) => adapter.request<{ item: Record<string, unknown> }>({ path: `/items/${itemId}`, retryBudget: 'bulk' })),
    );
    batchDone({ items: batch.length });

    const inventoryRows: Record<string, unknown>[] = [];

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'rejected') {
        console.warn(`sync-inventory: GET /items/${batch[j]} failed:`, result.reason);
        continue;
      }

      const itemId = batch[j];
      const zohoItem = result.value?.item;
      if (!zohoItem?.item_id) {
        console.warn(`sync-inventory: invalid response for item ${itemId}`);
        continue;
      }

      const warehouses = Array.isArray(zohoItem.warehouses) ? zohoItem.warehouses : [];
      const productId = productIdMap.get(itemId);

      if (!productId) {
        console.warn(`sync-inventory: product not found for item ${itemId}`);
        continue;
      }

      for (const warehouse of warehouses) {
        const warehouseExternalId = asStr(warehouse.warehouse_id);
        if (!warehouseExternalId) continue;

        let warehouseId = updatedWarehouseIdMap.get(warehouseExternalId);

        if (!warehouseId) {
          try {
            const newWarehouseId = await ensureWarehouseExists(
              admin,
              tenantId,
              actorId,
              integrationId,
              adapter.integrationTypeId,
              warehouseExternalId,
              adapter,
              warehouse as Record<string, unknown>,
            );
            if (newWarehouseId) {
              warehouseId = newWarehouseId;
              updatedWarehouseIdMap.set(warehouseExternalId, newWarehouseId);
              console.log(`sync-inventory: created missing warehouse ${warehouseExternalId}`);
            }
          } catch (err) {
            console.warn(`sync-inventory: failed to create warehouse ${warehouseExternalId}:`, err);
            continue;
          }
        }

        if (!warehouseId) {
          console.warn(`sync-inventory: could not resolve warehouse ${warehouseExternalId}`);
          continue;
        }

        inventoryRows.push({
          tenant_product_id: productId,
          warehouse_id: warehouseId,
          qty_available: asNum(warehouse.warehouse_available_stock) || 0,
          qty_reserved: asNum(warehouse.warehouse_reserved_stock) || 0,
          reorder_point: asNum(warehouse.reorder_level) || null,
          updated_at: nowIso(),
          deleted_at: null,
          created_by: actorId,
          updated_by: actorId,
        });
      }
    }

    if (inventoryRows.length > 0) {
      const dedupedRows = dedupeByColumns(inventoryRows, ['tenant_product_id', 'warehouse_id']);
      try {
        await bulkPersistJsonbRecords(admin, 'tenant_inventory', dedupedRows, ['tenant_product_id', 'warehouse_id']);
        totalPersisted += dedupedRows.length;
      } catch (err) {
        // Fallback: row-by-row, so one bad row doesn't drop the whole batch
        for (const row of dedupedRows) {
          try {
            await bulkPersistJsonbRecords(admin, 'tenant_inventory', [row], ['tenant_product_id', 'warehouse_id']);
            totalPersisted += 1;
          } catch (rowErr) {
            console.warn(
              `sync-inventory: inventory upsert failed for ${row.tenant_product_id}/${row.warehouse_id}:`,
              rowErr,
            );
          }
        }
      }
    }

    opts.onBatchComplete?.();

    const isLastBatch = i + ITEM_LOC_CONCURRENCY >= itemIds.length;
    if (!isLastBatch) {
      const elapsed = Date.now() - batchStart;
      if (elapsed < ITEM_LOC_BATCH_INTERVAL_MS) {
        await delay(ITEM_LOC_BATCH_INTERVAL_MS - elapsed);
      }
    }
  }

  logCheckpoint(null, 'inventory', 'fetchAndPersistMissingItemLocations:done', { persisted: totalPersisted, incomplete });
  return { persisted: totalPersisted, incomplete };
}

async function persistProducts(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
): Promise<PersistResult> {
  const result = emptyPersistResult();

  // Step A: upsert categories
  const categoryRows = [];
  const categorySourceByExternalRef = new Map<string, Record<string, unknown>>();
  const categoryMapById = new Map<string, string>();
  const categoryMapByName = new Map<string, string>();

  for (const rec of records) {
    const sourceCategoryId = pickString(rec.category_id, rec.category_ref, rec.category_external_id);
    const categoryName = pickString(rec.category_name, rec.category);
    if (!sourceCategoryId && !categoryName) continue;

    const externalRef = sourceCategoryId ? `zoho_cat:${sourceCategoryId}` : `zoho_cat:${slugify(categoryName ?? 'uncategorized')}`;
    categoryRows.push({
      tenant_id: tenantId,
      external_ref: externalRef,
      name: categoryName ?? sourceCategoryId ?? 'Uncategorized',
      slug: slugify(categoryName ?? sourceCategoryId ?? 'uncategorized'),
      ...(pickNumber(rec.category_display_order, rec.display_order, rec.sort_order) !== null
        ? { display_order: pickNumber(rec.category_display_order, rec.display_order, rec.sort_order) }
        : {}),
      is_active: true,
      review_status: 'draft' as const,
      deleted_at: null,
      created_by: actorId,
      updated_by: actorId,
    });
    categorySourceByExternalRef.set(externalRef, {
      category_id: sourceCategoryId,
      category_name: categoryName,
      category_display_order: pickNumber(rec.category_display_order, rec.display_order, rec.sort_order),
      source_item_id: pickZohoExternalId(rec.item_id),
    });
  }

  if (categoryRows.length > 0) {
    const categoryPersist = await persistWithNaturalKeyLock(
      admin, 'tenant_categories', tenantId, dedupeByExternalOrNaturalKey(categoryRows, ['slug']), 'slug', ['tenant_id', 'external_ref'],
    );
    if (categoryPersist.conflicts.length > 0) {
      console.warn('[persistProducts] category collision conflicts:', categoryPersist.conflicts);
      result.skipped += categoryPersist.conflicts.length;
    }
    const catRowsPersisted = categoryPersist.rows;
    for (const cat of catRowsPersisted) {
      if (typeof cat.id === 'string') {
        if (typeof cat.external_ref === 'string') {
          categoryMapById.set(cat.external_ref, cat.id);
        }
        if (typeof cat.name === 'string') {
          categoryMapByName.set(cat.name, cat.id);
        }
      }
    }

    await batchUpsertEntityMap(
      admin, tenantId, integrationId, 'categories',
      attachSourcePayload(
        buildPersistedRowPairsFromSourceRows(categoryRows, catRowsPersisted, ['slug']),
        categorySourceByExternalRef,
      ),
    );
  }

  // Step B: upsert brands
  const brandSourceByExternalRef = new Map<string, Record<string, unknown>>();
  const brandNames = [...new Set(
    records
      .map((r) => asStr(r.brand) ?? asStr(r.manufacturer))
      .filter((n): n is string => n !== null),
  )];

  // Fallback brand for products with no brand field
  const fallbackBrandExtRef = 'zoho_brand:__unknown__';
  for (const name of brandNames) {
    brandSourceByExternalRef.set(`zoho_brand:${slugify(name)}`, { brand: name });
  }
  brandSourceByExternalRef.set(fallbackBrandExtRef, { brand: 'Unknown Brand' });

  const allBrandRows = [
    ...brandNames.map((name) => ({
      tenant_id: tenantId,
      external_ref: `zoho_brand:${slugify(name)}`,
      display_name_override: name,
      slug: slugify(name),
      is_active: true,
      deleted_at: null,
      created_by: actorId,
      updated_by: actorId,
    })),
    {
      tenant_id: tenantId,
      external_ref: fallbackBrandExtRef,
      display_name_override: 'Unknown Brand',
      slug: 'unknown-brand',
      is_active: true,
      deleted_at: null,
      created_by: actorId,
      updated_by: actorId,
    },
  ];

  const brandMap = new Map<string, string>(); // zohoName → tenant_brand_id
  let fallbackBrandId: string | null = null;

  const brandPersist = await persistWithNaturalKeyLock(
    admin, 'tenant_brands', tenantId, dedupeByExternalOrNaturalKey(allBrandRows, ['slug']), 'slug', ['tenant_id', 'external_ref'],
  );
  if (brandPersist.conflicts.length > 0) {
    console.warn('[persistProducts] brand collision conflicts:', brandPersist.conflicts);
    result.skipped += brandPersist.conflicts.length;
  }
  const brandData = brandPersist.rows;
  for (const b of brandData) {
    if (typeof b.external_ref === 'string' && typeof b.id === 'string') {
      if (b.external_ref === fallbackBrandExtRef) {
        fallbackBrandId = b.id;
      } else if (typeof b.display_name_override === 'string') {
        brandMap.set(b.display_name_override, b.id);
      }
    }
  }

  await batchUpsertEntityMap(
    admin, tenantId, integrationId, 'brands',
    attachSourcePayload(
      buildPersistedRowPairsFromSourceRows(allBrandRows, brandData, ['slug']),
      brandSourceByExternalRef,
    ),
  );

  // Step C: upsert products in one batch
  const productRows: Record<string, unknown>[] = [];
  for (const rec of records) {
    const externalId = asStr(rec.item_id);
    if (!externalId) { result.skipped++; continue; }

    const brandName = asStr(rec.brand) ?? asStr(rec.manufacturer);
    const brandId = (brandName && brandMap.get(brandName)) ?? fallbackBrandId;
    if (!brandId) { result.skipped++; continue; }

    const sourceCategoryId = pickString(rec.category_id, rec.category_ref, rec.category_external_id);
    const catName = pickString(rec.category_name, rec.category);
    const catId = sourceCategoryId
      ? categoryMapById.get(`zoho_cat:${sourceCategoryId}`) ?? null
      : catName
        ? categoryMapByName.get(catName) ?? null
        : null;

    productRows.push({
      tenant_id: tenantId,
      external_ref: externalId,
      tenant_brand_id: brandId,
      tenant_category_id: catId,
      internal_sku: asStr(rec.sku) ?? asStr(rec.cf_sku) ?? externalId,
      name_override: asStr(rec.name),
      description: asStr(rec.description),
      base_selling_price: asNum(rec.rate),
      cost_price: asNum(rec.purchase_rate),
      mrp: asNum(rec.pricebook_rate),
      gst_rate: resolveZohoItemGstRate(rec),
      pack_size: pickNumber(rec.pack_size, rec.pack_quantity, rec.unit_conversion),
      image_urls: Array.isArray(rec.image_urls)
        ? rec.image_urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        : Array.isArray(rec.images)
          ? rec.images.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
          : undefined,
      default_uom: asStr(rec.unit),
      hsn_code: asStr(rec.hsn_or_sac) ?? asStr(rec.hsn_sac),
      is_active: (asStr(rec.status) ?? 'active') === 'active',
      created_by: actorId,
      updated_by: actorId,
      deleted_at: null,
    });
  }

  // attributes_override must be omitted (not overwritten with {}) for an
  // already-existing product, so a seller's manual override survives a
  // re-sync — this pre-check is a plain read, not part of the resolve+lock
  // atomicity below; a rare race here only risks attributes_override being
  // included/omitted one sync late, not a duplicate row or a lost write.
  const dedupedProductRows = dedupeByExternalOrNaturalKey(productRows, ['internal_sku']);
  const sourceProductExternalRefs = [...new Set(productRows.map((r) => asStr(r.external_ref)).filter((x): x is string => x !== null))];
  const productExternalRefs = [...new Set(dedupedProductRows.map((r) => asStr(r.external_ref)).filter((x): x is string => x !== null))];
  const productSkus = [...new Set(dedupedProductRows.map((r) => getRowNaturalKey(r, ['internal_sku'])).filter((x): x is string => x !== null))];
  const [existingProductsByRef, existingProductsBySku] = await Promise.all([
    productExternalRefs.length > 0
      ? admin.schema('app').from('tenant_products').select('external_ref').eq('tenant_id', tenantId).in('external_ref', productExternalRefs).is('deleted_at', null)
      : Promise.resolve({ data: [] as { external_ref: string }[] }),
    productSkus.length > 0
      ? admin.schema('app').from('tenant_products').select('internal_sku').eq('tenant_id', tenantId).in('internal_sku', productSkus).is('deleted_at', null)
      : Promise.resolve({ data: [] as { internal_sku: string }[] }),
  ]);
  const existingProductRefSet = new Set(((existingProductsByRef.data ?? []) as { external_ref: string }[]).map((r) => r.external_ref));
  const existingProductSkuSet = new Set(((existingProductsBySku.data ?? []) as { internal_sku: string }[]).map((r) => r.internal_sku));
  const productRowsForPersist = dedupedProductRows.map((row) => {
    const isExisting = existingProductRefSet.has(asStr(row.external_ref) ?? '') || existingProductSkuSet.has(getRowNaturalKey(row, ['internal_sku']) ?? '');
    if (isExisting) {
      const { attributes_override: _ignored, ...rest } = row;
      return rest;
    }
    return {
      ...row,
      attributes_override: {},
    };
  });
  const productPersist = await persistWithNaturalKeyLock(
    admin, 'tenant_products', tenantId, productRowsForPersist, 'internal_sku', ['tenant_id', 'external_ref'],
  );
  if (productPersist.conflicts.length > 0) {
    console.warn('[persistProducts] product collision conflicts:', productPersist.conflicts);
    result.skipped += productPersist.conflicts.length;
  }
  const persistedProducts = productPersist.rows;
  let productMapPairs = buildPersistedRowPairsFromSourceRows(productRows, persistedProducts, ['internal_sku']);
  if (productMapPairs.length < sourceProductExternalRefs.length && sourceProductExternalRefs.length > 0) {
    const { data: resolvedProductRows } = await admin
      .schema('app')
      .from('tenant_products')
      .select('external_ref, id')
      .eq('tenant_id', tenantId)
      .in('external_ref', sourceProductExternalRefs)
      .is('deleted_at', null);
    const resolvedByExternalRef = ((resolvedProductRows ?? []) as Array<{ external_ref: string | null; id: string | null }>)
      .map((row) => {
        const externalId = asStr(row.external_ref);
        const internalId = asStr(row.id);
        return externalId && internalId ? { externalId, internalId } : null;
      })
      .filter((row): row is { externalId: string; internalId: string } => row !== null);
    const mergedPairs = new Map(productMapPairs.map((row) => [row.externalId, row.internalId] as const));
    for (const row of resolvedByExternalRef) {
      mergedPairs.set(row.externalId, row.internalId);
    }
    productMapPairs = [...mergedPairs.entries()].map(([externalId, internalId]) => ({ externalId, internalId }));
  }
  if (productMapPairs.length < sourceProductExternalRefs.length && persistedProducts.length === productRowsForPersist.length) {
    const fallbackPairs = persistedProducts
      .map((row, index) => {
        const externalId = asStr(productRowsForPersist[index]?.external_ref);
        const internalId = asStr(row.id);
        return externalId && internalId ? { externalId, internalId } : null;
      })
      .filter((row): row is { externalId: string; internalId: string } => row !== null);
    const mergedPairs = new Map(productMapPairs.map((row) => [row.externalId, row.internalId] as const));
    for (const row of fallbackPairs) {
      mergedPairs.set(row.externalId, row.internalId);
    }
    productMapPairs = [...mergedPairs.entries()].map(([externalId, internalId]) => ({ externalId, internalId }));
  }
  const productIdMap = new Map(productMapPairs.map((row) => [row.externalId, row.internalId] as const));

  result.updated += productMapPairs.length;
  result.pendingSearchVectorProductIds = productMapPairs.map((row) => row.internalId);
  result.pendingSearchVectorBrandIds = brandData
    .map((row) => asStr(row.id))
    .filter((value): value is string => value !== null);
  result.pendingSearchVectorCategoryIds = categoryRows.length > 0
    ? [...categoryMapById.values()]
    : [];
  const productSourceByExternalId = buildSourceByExternalId(
    records,
    (rec) => pickZohoExternalId(rec.item_id),
  );
  await batchUpsertEntityMap(
    admin,
    tenantId,
    integrationId,
    'products',
    attachSourcePayload(productMapPairs, productSourceByExternalId),
  );

  // Step D: upsert inventory from embedded warehouse snapshots on each item
  const warehouseExternalIds = [
    ...new Set(
      records.flatMap((r) => {
        const locs = getEmbeddedLocationRows(r);
        return locs.map((l) => getEmbeddedLocationExternalId(l)).filter((x): x is string => x !== null);
      }),
    ),
  ];

  const warehouseIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'warehouses', 'warehouses', warehouseExternalIds,
  );

  const inventoryRows: Record<string, unknown>[] = [];
  let inventorySyncError: IntegrationSyncError | null = null;

  // Only derives inventory from warehouse data already embedded in this page's
  // /items response (free — no extra Zoho calls). Items without embedded data
  // get their stock levels from the dedicated sync-inventory phase, which
  // detail-fetches every synced product's /items/{id} on its own paced,
  // budget-checked schedule instead of blocking this page's persist step.
  for (const rec of records) {
    const extProductId = asStr(rec.item_id);
    if (!extProductId) continue;

    const productId = productIdMap.get(extProductId);
    if (!productId) {
      inventorySyncError = new IntegrationSyncError(
        'tenant_inventory',
        `Unable to resolve imported product ${extProductId} for inventory sync.`,
        extProductId,
        { product_id: extProductId },
      );
      break;
    }

    const locs = getEmbeddedLocationRows(rec);
    for (const loc of locs) {
      const extWarehouseId = getEmbeddedLocationExternalId(loc);
      if (!extWarehouseId) continue;

      let warehouseId = warehouseIdMap.get(extWarehouseId) ?? null;
      if (!warehouseId) {
        warehouseId = await ensureWarehouseExists(
          admin,
          tenantId,
          actorId,
          integrationId,
          adapter?.integrationTypeId ?? 'zoho_books',
          extWarehouseId,
          adapter,
          loc,
        );
        if (warehouseId) {
          warehouseIdMap.set(extWarehouseId, warehouseId);
        }
      }

      if (!warehouseId) {
        console.warn(
          `sync-products: unable to resolve warehouse ${extWarehouseId} for product ${extProductId}, skipping inventory row`,
        );
        continue;
      }

      inventoryRows.push({
        tenant_product_id: productId,
        warehouse_id: warehouseId,
        qty_available: getEmbeddedLocationQty(loc),
        qty_reserved: 0,
        updated_at: nowIso(),
        deleted_at: null,
      });
    }
  }

  if (inventorySyncError) {
    const errorReason = formatErrorReason(inventorySyncError.message, inventorySyncError.details);
    await batchUpsertEntityMap(
      admin,
      tenantId,
      integrationId,
      'products',
      attachSourcePayload(productMapPairs, productSourceByExternalId),
      {
      syncStatus: 'error',
      errorReason,
    },
    );
    throw inventorySyncError;
  }

  const dedupedInventoryRows = dedupeByColumns(inventoryRows, ['tenant_product_id', 'warehouse_id']);
  if (dedupedInventoryRows.length > 0) {
    await bulkPersistJsonbRecords(admin, 'tenant_inventory', dedupedInventoryRows, ['tenant_product_id', 'warehouse_id']);
  }

  return result;
}

async function persistPricelists(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  persistOptions?: PersistOptions,
): Promise<PersistResult> {
  const sourceRecords = records.length > 0
    ? records
    : adapter
      ? await adapter.fetchPricelists()
      : [];
  const salesPricebooks = sourceRecords.filter(isSalesPricebook);
  const result = emptyPersistResult({
    skipped: sourceRecords.length - salesPricebooks.length,
  });

  if (salesPricebooks.length === 0) {
    return result;
  }

  const priceListRows: Record<string, unknown>[] = [];
  for (const pricebook of salesPricebooks) {
    const externalRef = asStr(pricebook.pricebook_id) ?? asStr(pricebook.pricelist_id);
    if (!externalRef) {
      result.skipped++;
      continue;
    }

    priceListRows.push({
      tenant_id: tenantId,
      external_ref: externalRef,
      name: pickString(pricebook.name, pricebook.pricebook_name) ?? `Zoho pricelist ${externalRef}`,
      description: asStr(pricebook.description),
      currency: pickString(pricebook.currency_code, pricebook.currency) ?? 'INR',
      valid_from: asDate(pricebook.start_date ?? pricebook.valid_from ?? pricebook.created_time) ?? nowIso(),
      valid_to: asDate(pricebook.end_date ?? pricebook.valid_to),
      priority: asNum(pricebook.priority) ?? 0,
      is_active: (asStr(pricebook.status) ?? 'active') === 'active',
      pricing_strategy: normalizeZohoStrategy(pricebook.pricebook_type),
      pricebook_type: asStr(pricebook.pricebook_type),
      // Zoho item rates come from pricebook_items, not the local rule engine — never
      // let evaluate_product_for_price_lists_v2() recompute them (see membership_mode
      // guard migration 20260725120113).
      membership_mode: 'manual',
      source_updated_at: asDate(pricebook.last_modified_time ?? pricebook.updated_time ?? pricebook.updated_at),
      created_by: actorId,
      updated_by: actorId,
      deleted_at: null,
    });
  }

  const dedupedPriceListRows = dedupeByExternalRef(priceListRows);
  const persistedPriceLists = dedupedPriceListRows.length > 0
    ? await bulkPersistJsonbRecords(admin, 'price_lists', dedupedPriceListRows, ['tenant_id', 'external_ref'])
    : [];
  const sourcePricebookByRef = new Map(
    salesPricebooks
      .map((pb) => {
        const id = asStr(pb.pricebook_id) ?? asStr(pb.pricelist_id);
        return id ? ([id, pb] as const) : null;
      })
      .filter((x): x is [string, Record<string, unknown>] => x !== null),
  );
  const priceListMapPairs = mapPersistedRowsByExternalRef(persistedPriceLists).map((p) => ({
    ...p,
    sourcePayload: sourcePricebookByRef.get(p.externalId) ?? null,
  }));
  const priceListIdByExternalRef = new Map(priceListMapPairs.map((row) => [row.externalId, row.internalId] as const));

  result.updated += priceListMapPairs.length;
  result.pendingSearchVectorPriceListIds = priceListMapPairs.map((row) => row.internalId);
  await batchUpsertEntityMap(admin, tenantId, integrationId, 'pricelists', priceListMapPairs);

  // Enrich pricebooks with per-book detail (list endpoint omits pricebook_items).
  // Sequential with 300ms inter-call delay to avoid Zoho rate limits (was: 5-concurrent).
  // Reserve time for one more detail fetch (worst case ~15s call + 300ms pace) so
  // this loop doesn't blow past the edge function's ~150s hard-kill mid-request.
  const PRICEBOOK_DETAIL_DEADLINE_RESERVATION_MS = 15_000;
  const detailedPricebooks = new Map<string, Record<string, unknown>>();
  if (adapter?.fetchPricebookDetail) {
    for (const pb of salesPricebooks) {
      if (
        persistOptions?.deadlineMs != null
        && Date.now() + PRICEBOOK_DETAIL_DEADLINE_RESERVATION_MS > persistOptions.deadlineMs
      ) {
        console.warn(
          `[persistPricelists] deadline approaching, stopping pricebook detail fetch early: ${detailedPricebooks.size}/${salesPricebooks.length} fetched`,
        );
        break;
      }
      const id = asStr(pb.pricebook_id) ?? asStr(pb.pricelist_id);
      if (!id) continue;
      const detail = await adapter.fetchPricebookDetail(id);
      if (detail) detailedPricebooks.set(id, detail);
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }

  const productExternalIds = [
    ...new Set(
      salesPricebooks.flatMap((pricebook) => {
        const id = asStr(pricebook.pricebook_id) ?? asStr(pricebook.pricelist_id);
        const effective = (id ? detailedPricebooks.get(id) : null) ?? pricebook;
        return getPricebookItemRows(effective)
          .map((item) => pickString(item.item_id, item.product_id, item.item_external_id))
          .filter((value): value is string => value !== null);
      }),
    ),
  ];

  const tenantProductIdMap = productExternalIds.length > 0
    ? await resolveInternalIdsWithFallback(
        admin, tenantId, integrationId, 'products', 'tenant_products', productExternalIds,
      )
    : new Map<string, string>();

  // FK-failsafe: fetch missing products from Zoho when adapter is present (webhook path)
  if (adapter) {
    const zohoTypeId = adapter.integrationTypeId;
    const missingProductIds = productExternalIds.filter((extId) => !tenantProductIdMap.has(extId));
    const resolvedProducts = await mapWithConcurrency(missingProductIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureProductExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedProducts) {
      if (internalId) tenantProductIdMap.set(extId, internalId);
    }
  }

  const priceListItemRows: Record<string, unknown>[] = [];
  const desiredExternalRefsByPriceListId = new Map<string, Set<string>>();
  // Collect errors per row instead of throwing — entity-level isolation keeps partial data intact
  const skippedItems: Array<{ pricebook_id: string; item_id: string | null; reason: string }> = [];

  for (const pricebook of salesPricebooks) {
    const externalRef = asStr(pricebook.pricebook_id) ?? asStr(pricebook.pricelist_id);
    if (!externalRef) continue;
    const priceListId = priceListIdByExternalRef.get(externalRef) ?? null;
    if (!priceListId) {
      // Pricebook itself couldn't be persisted — skip all its items
      skippedItems.push({ pricebook_id: externalRef, item_id: null, reason: `price_list row not found for ${externalRef}` });
      continue;
    }

    const effectivePricebook = detailedPricebooks.get(externalRef) ?? pricebook;
    for (const item of getPricebookItemRows(effectivePricebook)) {
      const sourceProductId = pickString(item.item_id, item.product_id, item.item_external_id);
      const tenantProductId = sourceProductId ? tenantProductIdMap.get(sourceProductId) ?? null : null;
      if (!tenantProductId) {
        // Product FK not found — skip this item row, continue with next
        skippedItems.push({
          pricebook_id: externalRef,
          item_id: sourceProductId ?? null,
          reason: `product ${sourceProductId ?? 'unknown'} not yet synced`,
        });
        continue;
      }

      const minQty = pickNumber(item.min_quantity, item.min_qty, item.from_quantity) ?? 1;
      const itemExternalRef = `${externalRef}:${sourceProductId}:${minQty}`;
      if (!desiredExternalRefsByPriceListId.has(priceListId)) {
        desiredExternalRefsByPriceListId.set(priceListId, new Set());
      }
      desiredExternalRefsByPriceListId.get(priceListId)?.add(itemExternalRef);

      priceListItemRows.push({
        price_list_id: priceListId,
        tenant_product_id: tenantProductId,
        price: pickNumber(item.price, item.rate, item.pricebook_rate, item.selling_price) ?? 0,
        min_qty: minQty,
        max_qty: pickNumber(item.max_quantity, item.max_qty, item.to_quantity),
        external_ref: itemExternalRef,
        source_updated_at: asDate(item.last_modified_time ?? item.updated_time ?? effectivePricebook.last_modified_time),
        created_by: actorId,
        updated_by: actorId,
        deleted_at: null,
      });
    }
  }

  if (skippedItems.length > 0) {
    console.warn('[persistPricelists] skipped items:', JSON.stringify(skippedItems.slice(0, 10)));
    // Persist skipped rows to entity map so they appear in the frontend entity-error section
    const errorSourceByExternalId = new Map(
      skippedItems.map((s) => {
        const externalId = s.item_id ? `${s.pricebook_id}:${s.item_id}` : s.pricebook_id;
        return [externalId, {
          pricebook_id: s.pricebook_id,
          item_id: s.item_id,
          reason: s.reason,
        }] as const;
      }),
    );
    const errorPairs = skippedItems.map((s) => ({
      externalId: s.item_id ? `${s.pricebook_id}:${s.item_id}` : s.pricebook_id,
      internalId: '',
    }));
    await batchUpsertEntityMap(
      admin,
      tenantId,
      integrationId,
      'price_list_items',
      attachSourcePayload(errorPairs, errorSourceByExternalId),
      {
      syncStatus: 'error',
      errorReason: skippedItems[0]?.reason ?? 'FK resolution failed',
    },
    ).catch((e) => console.warn('[persistPricelists] entity map error write failed:', e));
  }

  const dedupedPriceListItemRows = dedupeByColumns(
    priceListItemRows,
    ['price_list_id', 'tenant_product_id', 'min_qty'],
  );

  if (dedupedPriceListItemRows.length > 0) {
    await bulkPersistJsonbRecords(
      admin,
      'price_list_items',
      dedupedPriceListItemRows,
      ['price_list_id', 'tenant_product_id', 'min_qty'],
    );
  }

  // Soft-delete stale items directly via a SQL anti-join per touched price
  // list, instead of fetching every existing row and diffing in JS — price
  // list count per tenant is small (well under 100), so one UPDATE per
  // touched price list is cheap and avoids loading the full item set into
  // memory.
  for (const { internalId: priceListId, externalId } of priceListMapPairs) {
    const desiredRefs = [...(desiredExternalRefsByPriceListId.get(priceListId) ?? new Set<string>())];

    if (desiredRefs.length === 0) {
      // Only wipe items if the detail fetch succeeded for this pricebook.
      // If the fetch was skipped (deadline hit) or the API returned null (error/rate-limit),
      // preserve existing items — the pricebook may not truly be empty.
      const detailSucceeded = detailedPricebooks.has(externalId);
      if (!detailSucceeded) {
        console.warn(`[persistPricelists] skipping stale-item deletion for ${externalId}: detail fetch failed or not attempted`);
        continue;
      }
      await admin
        .schema('app')
        .from('price_list_items')
        .update({
          deleted_at: nowIso(),
          updated_at: nowIso(),
          updated_by: actorId,
        })
        .eq('price_list_id', priceListId)
        .is('deleted_at', null);
      continue;
    }

    await admin
      .schema('app')
      .from('price_list_items')
      .update({
        deleted_at: nowIso(),
        updated_at: nowIso(),
        updated_by: actorId,
      })
      .eq('price_list_id', priceListId)
      .is('deleted_at', null)
      .not('external_ref', 'in', formatPostgrestLiteralList(desiredRefs));
  }

  return result;
}

// ── Estimates ────────────────────────────────────────────────────────────────

async function persistEstimates(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  zohoTypeId?: ZohoIntegrationTypeId,
): Promise<PersistResult> {
  const result = emptyPersistResult();
  const estimateFieldMappings = await loadFieldMappings(admin, integrationId, 'estimates');
  const salespersonActorMap = await buildZohoSalespersonActorMap(admin, tenantId, adapter);

  const customerExternalIds = [...new Set(
    records
      .map((r) => asStr(r.customer_id))
      .filter((x): x is string => x !== null),
  )];
  const buyerIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'customers', 'buyers', customerExternalIds,
  );
  // FK-failsafe: fetch missing buyers from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    const missingBuyerIds = customerExternalIds.filter((extId) => !buyerIdMap.has(extId));
    const resolvedBuyers = await mapWithConcurrency(missingBuyerIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureBuyerExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedBuyers) {
      if (internalId) buyerIdMap.set(extId, internalId);
    }
  }
  const locationExternalIds = [...new Set(
    records
      .map((r) => pickString(r.location_id, r.warehouse_id))
      .filter((x): x is string => x !== null),
  )];
  const locationIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'locations', 'locations', locationExternalIds,
  );
  // FK-failsafe: fetch missing locations from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    const missingLocationIds = locationExternalIds.filter((extId) => !locationIdMap.has(extId));
    const resolvedLocations = await mapWithConcurrency(missingLocationIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureLocationExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedLocations) {
      if (internalId) locationIdMap.set(extId, internalId);
    }
  }
  const parentRows: Record<string, unknown>[] = [];
  const parentRecords: Array<{ estimateId: string; sourcePayload: Record<string, unknown>; lineItems: Record<string, unknown>[]; resolvedActorId: string | null }> = [];

  for (const rec of records) {
    const externalId = asStr(rec.estimate_id);
    if (!externalId) { result.skipped++; continue; }

    const customerId = asStr(rec.customer_id);
    const buyerId = customerId ? (buyerIdMap.get(customerId) ?? null) : null;
    const locationExternalId = pickString(rec.location_id, rec.warehouse_id);
    const locationId = locationExternalId ? (locationIdMap.get(locationExternalId) ?? null) : null;
    const lineItems = Array.isArray(rec.line_items) ? rec.line_items as Record<string, unknown>[] : [];
    const salespersonId = asStr(rec.salesperson_id);
    const resolvedActorId = resolveImportedActorId(actorId, salespersonId, salespersonActorMap);
    const subtotal = pickNumber(rec.sub_total, rec.subtotal);
    const taxAmount = pickNumber(rec.tax_total, rec.tax_amount);
    const placeOfSupply = pickString(
      rec.place_of_supply,
      rec.place_of_contact,
      rec.state,
      rec.billing_state,
      rec.shipping_state,
    );
    const estimateUrl = asStr(rec.estimate_url);
    const cartHash = await sha256Hex(JSON.stringify({
      estimateId: externalId,
      buyerId,
      locationId,
      estimateNumber: asStr(rec.estimate_number),
      subtotal,
      taxAmount,
      totalAmount: pickNumber(rec.total, rec.total_amount),
      lineItems: lineItems.map((li) => ({
        itemId: pickString(li.item_id, li.product_id),
        qty: pickNumber(li.quantity, li.qty),
        unitPrice: pickNumber(li.rate, li.unit_price, li.price),
        lineTotal: resolveLineTotal(li, 0),
        taxPct: pickNumber(li.tax_percentage, li.tax_rate),
        discPct: pickNumber(li.discount_percentage, li.disc_pct),
        schemeTag: pickString(li.scheme_tag, li.discount_type),
      })),
    }));

    const customFields = buildCustomFieldsJson(rec);

    parentRows.push({
      tenant_id: tenantId,
      external_ref: externalId,
      buyer_id: buyerId,
      estimate_number: asStr(rec.estimate_number),
      status: asStr(rec.status) ?? 'draft',
      location_id: locationId,
      custom_fields: customFields,
      ...applyFieldMappings(customFields, estimateFieldMappings),
      currency: asStr(rec.currency) ?? asStr(rec.currency_code) ?? 'INR',
      ...presentNumberFields(
        ['subtotal', subtotal],
        ['tax_amount', taxAmount],
      ),
      total_amount: pickNumber(rec.total, rec.total_amount),
      notes: pickString(rec.notes, rec.terms, rec.description),
      seller_note: pickString(rec.seller_note, rec.note),
      ...presentStringField('place_of_supply', placeOfSupply),
      ...presentStringField('estimate_url', estimateUrl),
      cart_hash: cartHash,
      buyer_po_ref: pickString(rec.reference_number, rec.buyer_po_ref),
      discount_flat: pickNumber(rec.discount_flat, rec.discount) ?? 0,
      freight: pickNumber(rec.freight, rec.shipping_charge) ?? 0,
      round_off: pickNumber(rec.round_off) ?? 0,
      valid_until: asDateOnly(rec.expiry_date),
      estimate_date: asDateOnly(rec.date_issued ?? rec.date ?? rec.created_time),
      expires_at: asDate(rec.expiry_date),
      sent_at: asDate(rec.sent_at ?? rec.date),
      created_at: asDate(rec.created_time ?? rec.date),
      updated_at: asDate(rec.last_modified_time ?? rec.updated_time ?? rec.created_time),
      source: 'zoho_import',
      deleted_at: null,
      created_by: resolvedActorId,
      updated_by: resolvedActorId,
    });

    parentRecords.push({
      estimateId: externalId,
      sourcePayload: buildTransactionalSourcePayload(rec),
      lineItems: Array.isArray(rec.line_items) ? rec.line_items as Record<string, unknown>[] : [],
      resolvedActorId,
    });
  }

  const existingEstimateRows = await loadExistingTransactionalParentRows(
    admin,
    'estimates',
    tenantId,
    parentRows.map((row) => asStr(row.external_ref)).filter((value): value is string => value !== null),
    'estimate_number',
    parentRows.map((row) => asStr(row.estimate_number)).filter((value): value is string => value !== null),
  );
  const normalizedEstimateRows = preserveExistingTransactionalOriginAndFlags(
    parentRows,
    existingEstimateRows,
    'estimate_number',
    'is_buyer_app_estimate',
  );

  const guardedEstimateRows = await applyImmediateEchoGuards(
    admin, tenantId, integrationId, 'estimates', 'estimates', normalizedEstimateRows,
  );
  const estimatePersist = await persistWithNaturalKeyLock(
    admin, 'estimates', tenantId, dedupeByExternalOrNaturalKey(guardedEstimateRows, ['estimate_number']), 'estimate_number', ['tenant_id', 'external_ref'],
  );
  if (estimatePersist.conflicts.length > 0) {
    console.warn('[persistEstimates] estimate collision conflicts:', estimatePersist.conflicts);
    result.skipped += estimatePersist.conflicts.length;
  }
  const persistedEstimates = estimatePersist.rows;
  const sourcePayloadByExternalRef = new Map(
    parentRecords.map((e) => [e.estimateId, e.sourcePayload] as const),
  );
  const estimateMapPairs = buildPersistedRowPairsFromSourceRows(parentRows, persistedEstimates, ['estimate_number']).map((p) => ({
    ...p,
    sourcePayload: sourcePayloadByExternalRef.get(p.externalId) ?? null,
  }));
  const estimateIdMap = new Map(estimateMapPairs.map((row) => [row.externalId, row.internalId] as const));
  const estimateIds = estimateMapPairs.map((row) => row.internalId);

  result.updated += estimateMapPairs.length;
  await batchUpsertEntityMap(admin, tenantId, integrationId, 'estimates', estimateMapPairs);

  const productExtIds = [...new Set(
    parentRecords.flatMap((entry) =>
      entry.lineItems.map((li) => asStr(li.item_id)).filter((x): x is string => x !== null),
    ),
  )];
  const productIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'products', 'tenant_products', productExtIds,
  );
  // FK-failsafe: fetch missing products from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    for (const extId of productExtIds) {
      if (!productIdMap.has(extId)) {
        const internalId = await ensureProductExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
        if (internalId) productIdMap.set(extId, internalId);
      }
    }
  }

  const lineItemRows: Record<string, unknown>[] = [];
  let estimateItemSyncError: IntegrationSyncError | null = null;
  for (const entry of parentRecords) {
    const estimateId = estimateIdMap.get(entry.estimateId) ?? null;
    if (!estimateId) {
      estimateItemSyncError = new IntegrationSyncError(
        'estimates',
        `Unable to resolve imported estimate ${entry.estimateId}.`,
        entry.estimateId,
        { estimate_id: entry.estimateId },
      );
      break;
    }

    for (const [lineIndex, li] of entry.lineItems.entries()) {
      const extProdId = asStr(li.item_id);
      const productId = extProdId ? (productIdMap.get(extProdId) ?? null) : null;
      if (!productId) {
        estimateItemSyncError = new IntegrationSyncError(
          'estimate_items',
          `Unable to resolve product ${extProdId ?? 'unknown'} for estimate ${entry.estimateId}.`,
          entry.estimateId,
          {
            estimate_id: entry.estimateId,
            item_id: extProdId,
            line_index: lineIndex,
          },
        );
        break;
      }

      const taxRate = pickNumber(li.tax_percentage, li.tax_rate);
      const discountPct = pickNumber(li.discount_percentage, li.disc_pct) ?? 0;
      const externalRef = await buildChildExternalRef(entry.estimateId, li, lineIndex);
      const lineOrder = resolveLineOrder(li, lineIndex);
      const parentCreatedAt = asDate(entry.sourcePayload.created_time ?? entry.sourcePayload.created_at);

      lineItemRows.push({
        estimate_id: estimateId,
        tenant_product_id: productId,
        external_ref: externalRef,
        item_order: lineOrder,
        qty: pickNumber(li.quantity, li.qty) ?? 1,
        unit_price: pickNumber(li.rate, li.unit_price, li.price) ?? 0,
        line_total: resolveLineTotal(li, lineIndex),
        tax_rate: taxRate,
        tax_pct: taxRate,
        disc_pct: discountPct,
        discount_pct: discountPct,
        scheme_tag: pickString(li.scheme_tag, li.discount_type),
        sku: pickString(li.sku, li.item_sku, li.item_code, li.code),
        hsn_code: pickString(li.hsn_code, li.hsn_or_sac, li.hsn_sac),
        deleted_at: null,
        created_at: asDate(li.created_time ?? li.created_at) ?? parentCreatedAt ?? nowIso(),
        updated_at: asDate(li.last_modified_time ?? li.updated_at ?? li.created_time) ?? parentCreatedAt ?? nowIso(),
        created_by: entry.resolvedActorId,
        updated_by: entry.resolvedActorId,
      });
    }

    if (estimateItemSyncError) break;
  }

  if (estimateItemSyncError) {
    const errorReason = formatErrorReason(estimateItemSyncError.message, estimateItemSyncError.details);
    await batchUpsertEntityMap(admin, tenantId, integrationId, 'estimates', estimateMapPairs, {
      syncStatus: 'error',
      errorReason,
    });
    throw estimateItemSyncError;
  }

  await persistDerivedChildRows(admin, 'estimate_items', 'estimate_id', estimateIds, lineItemRows);

  const estimateAnalyticsCandidates: ZohoAnalyticsCandidate[] = estimateMapPairs
    .map((pair) => {
      const parentRow = parentRows.find((row) => asStr(row.external_ref) === pair.externalId) ?? null;
      const naturalKey = parentRow ? asStr(parentRow.estimate_number) : null;
      const existedBefore = Boolean(
        existingEstimateRows.byExternalRef.get(pair.externalId)
          ?? (naturalKey ? existingEstimateRows.byNaturalKey.get(naturalKey) : null),
      );
      if (existedBefore) return null;

      const persistedRow = persistedEstimates.find((row) => asStr(row.id) === pair.internalId || asStr(row.external_ref) === pair.externalId)
        ?? parentRow
        ?? {};
      const sourceRecord = sourcePayloadByExternalRef.get(pair.externalId) ?? null;
      if (!isZohoCatalogTransactionCandidate({ entityType: 'estimates', sourceRecord, persistedRow })) return null;

      return {
        entityType: 'estimates' as const,
        externalId: pair.externalId,
        internalId: pair.internalId,
        eventName: 'server_erp_estimate_created',
      };
    })
    .filter((candidate): candidate is ZohoAnalyticsCandidate => candidate !== null);

  await captureZohoErpAnalyticsEvents({
    admin,
    tenantId,
    tenantIntegrationId: integrationId,
    candidates: estimateAnalyticsCandidates,
  });

  return result;
}

// ── Orders ───────────────────────────────────────────────────────────────────

async function persistOrders(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  zohoTypeId?: ZohoIntegrationTypeId,
): Promise<PersistResult> {
  const result = emptyPersistResult();
  const orderFieldMappings = await loadFieldMappings(admin, integrationId, 'orders');
  const salespersonActorMap = await buildZohoSalespersonActorMap(admin, tenantId, adapter);

  const customerExternalIds = [...new Set(
    records
      .map((r) => asStr(r.customer_id))
      .filter((x): x is string => x !== null),
  )];
  const buyerIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'customers', 'buyers', customerExternalIds,
  );
  // FK-failsafe: fetch missing buyers from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    const missingBuyerIds = customerExternalIds.filter((extId) => !buyerIdMap.has(extId));
    const resolvedBuyers = await mapWithConcurrency(missingBuyerIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureBuyerExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedBuyers) {
      if (internalId) buyerIdMap.set(extId, internalId);
    }
  }
  const locationExternalIds = [...new Set(
    records
      .map((r) => pickString(r.location_id, r.warehouse_id))
      .filter((x): x is string => x !== null),
  )];
  const locationIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'locations', 'locations', locationExternalIds,
  );
  // FK-failsafe: fetch missing locations from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    const missingLocationIds = locationExternalIds.filter((extId) => !locationIdMap.has(extId));
    const resolvedLocations = await mapWithConcurrency(missingLocationIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureLocationExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedLocations) {
      if (internalId) locationIdMap.set(extId, internalId);
    }
  }
  const parentRows: Record<string, unknown>[] = [];
  const parentRecords: Array<{ orderExternalId: string; sourcePayload: Record<string, unknown>; lineItems: Record<string, unknown>[]; resolvedActorId: string | null }> = [];

  for (const rec of records) {
    const externalId = asStr(rec.salesorder_id);
    if (!externalId) { result.skipped++; continue; }

    const customerId = asStr(rec.customer_id);
    const buyerId = customerId ? (buyerIdMap.get(customerId) ?? null) : null;
    const locationExternalId = pickString(rec.location_id, rec.warehouse_id);
    const locationId = locationExternalId ? (locationIdMap.get(locationExternalId) ?? null) : null;

    const shippingAddr = rec.shipping_address;
    const deliveryAddress = shippingAddr && typeof shippingAddr === 'object'
      ? shippingAddr
      : null;
    const lineItems = Array.isArray(rec.line_items) ? rec.line_items as Record<string, unknown>[] : [];
    const salespersonId = asStr(rec.salesperson_id);
    const resolvedActorId = resolveImportedActorId(actorId, salespersonId, salespersonActorMap);
    const subtotal = pickNumber(rec.sub_total, rec.subtotal);
    const taxAmount = pickNumber(rec.tax_total, rec.tax_amount);
    const customFields = buildCustomFieldsJson(rec);
    const placeOfSupply = pickString(
      rec.place_of_supply,
      rec.place_of_contact,
      rec.state,
      rec.billing_state,
      rec.shipping_state,
    );

    parentRows.push({
      tenant_id: tenantId,
      external_ref: externalId,
      buyer_id: buyerId,
      placed_by: resolvedActorId,
      order_number: asStr(rec.salesorder_number) ?? externalId,
      status: asStr(rec.status) ?? 'open',
      custom_fields: customFields,
      ...applyFieldMappings(customFields, orderFieldMappings),
      source: 'zoho_import',
      location_id: locationId,
      estimate_id: asStr(rec.estimate_id)
        ? (await resolveInternalIdWithFallback(admin, tenantId, integrationId, 'estimates', 'estimates', asStr(rec.estimate_id) ?? ''))
        : null,
      ...presentNumberFields(
        ['subtotal', subtotal],
        ['tax_amount', taxAmount],
      ),
      total_amount: pickNumber(rec.total, rec.total_amount),
      delivery_address: deliveryAddress as Record<string, unknown> | null,
      ...presentStringField('place_of_supply', placeOfSupply),
      notes: pickString(rec.notes, rec.seller_note, rec.description),
      seller_note: pickString(rec.seller_note, rec.note),
      buyer_po_ref: pickString(rec.reference_number, rec.buyer_po_ref),
      discount_flat: pickNumber(rec.discount_flat, rec.discount) ?? 0,
      freight: pickNumber(rec.freight, rec.shipping_charge) ?? 0,
      round_off: pickNumber(rec.round_off) ?? 0,
      has_backorder: asBool(rec.has_backorder ?? rec.backorder, false),
      expected_delivery: asDateOnly(rec.expected_delivery),
      order_date: asDateOnly(rec.date ?? rec.created_time),
      placed_at: asDate(rec.date ?? rec.created_time),
      received_at: asDate(rec.received_at),
      confirmed_at: asDate(rec.confirmed_at),
      dispatched_at: asDate(rec.dispatched_at),
      delivered_at: asDate(rec.delivered_at),
      cancelled_at: asDate(rec.cancelled_at),
      created_at: asDate(rec.created_time ?? rec.date),
      updated_at: asDate(rec.last_modified_time ?? rec.updated_time ?? rec.created_time),
      deleted_at: null,
      created_by: resolvedActorId,
      updated_by: resolvedActorId,
    });

    parentRecords.push({
      orderExternalId: externalId,
      sourcePayload: buildTransactionalSourcePayload(rec),
      lineItems,
      resolvedActorId,
    });
  }

  const existingOrderRows = await loadExistingTransactionalParentRows(
    admin,
    'orders',
    tenantId,
    parentRows.map((row) => asStr(row.external_ref)).filter((value): value is string => value !== null),
    'order_number',
    parentRows.map((row) => asStr(row.order_number)).filter((value): value is string => value !== null),
  );
  const normalizedOrderRows = preserveExistingTransactionalOriginAndFlags(
    parentRows,
    existingOrderRows,
    'order_number',
    'is_buyer_app_order',
  );

  const guardedOrderRows = await applyImmediateEchoGuards(
    admin, tenantId, integrationId, 'orders', 'orders', normalizedOrderRows,
  );
  const orderPersist = await persistWithNaturalKeyLock(
    admin, 'orders', tenantId, dedupeByExternalOrNaturalKey(guardedOrderRows, ['order_number']), 'order_number', ['tenant_id', 'external_ref'],
  );
  if (orderPersist.conflicts.length > 0) {
    console.warn('[persistOrders] order collision conflicts:', orderPersist.conflicts);
    result.skipped += orderPersist.conflicts.length;
  }
  const persistedOrders = orderPersist.rows;
  const sourcePayloadByOrderRef = new Map(
    parentRecords.map((e) => [e.orderExternalId, e.sourcePayload] as const),
  );
  const orderMapPairs = buildPersistedRowPairsFromSourceRows(parentRows, persistedOrders, ['order_number']).map((p) => ({
    ...p,
    sourcePayload: sourcePayloadByOrderRef.get(p.externalId) ?? null,
  }));
  const orderIdMap = new Map(orderMapPairs.map((row) => [row.externalId, row.internalId] as const));
  const orderIds = orderMapPairs.map((row) => row.internalId);

  result.updated += orderMapPairs.length;
  await batchUpsertEntityMap(admin, tenantId, integrationId, 'orders', orderMapPairs);

  const productExtIds = [...new Set(
    parentRecords.flatMap((entry) =>
      entry.lineItems.map((li) => asStr(li.item_id)).filter((x): x is string => x !== null),
    ),
  )];
  const productIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'products', 'tenant_products', productExtIds,
  );
  // FK-failsafe: fetch missing products from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    for (const extId of productExtIds) {
      if (!productIdMap.has(extId)) {
        const internalId = await ensureProductExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
        if (internalId) productIdMap.set(extId, internalId);
      }
    }
  }

  const lineItemRows: Record<string, unknown>[] = [];
  let orderItemSyncError: IntegrationSyncError | null = null;
  for (const entry of parentRecords) {
    const orderId = orderIdMap.get(entry.orderExternalId) ?? null;
    if (!orderId) {
      orderItemSyncError = new IntegrationSyncError(
        'orders',
        `Unable to resolve imported order ${entry.orderExternalId}.`,
        entry.orderExternalId,
        { order_id: entry.orderExternalId },
      );
      break;
    }

    for (const [lineIndex, li] of entry.lineItems.entries()) {
      const extProdId = asStr(li.item_id);
      const productId = extProdId ? (productIdMap.get(extProdId) ?? null) : null;
      if (!productId) {
        orderItemSyncError = new IntegrationSyncError(
          'order_items',
          `Unable to resolve product ${extProdId ?? 'unknown'} for order ${entry.orderExternalId}.`,
          entry.orderExternalId,
          {
            order_id: entry.orderExternalId,
            item_id: extProdId,
            line_index: lineIndex,
          },
        );
        break;
      }

      const taxRate = pickNumber(li.tax_percentage, li.tax_rate);
      const discountPct = pickNumber(li.discount_percentage, li.disc_pct) ?? 0;
      const externalRef = await buildChildExternalRef(entry.orderExternalId, li, lineIndex);
      const lineOrder = resolveLineOrder(li, lineIndex);
      const parentCreatedAt = asDate(entry.sourcePayload.created_time ?? entry.sourcePayload.created_at);

      lineItemRows.push({
        order_id: orderId,
        tenant_product_id: productId,
        external_ref: externalRef,
        item_order: lineOrder,
        qty: pickNumber(li.quantity, li.qty) ?? 1,
        unit_price: pickNumber(li.rate, li.unit_price, li.price) ?? 0,
        line_total: resolveLineTotal(li, lineIndex),
        tax_rate: taxRate,
        tax_pct: taxRate,
        disc_pct: discountPct,
        discount_pct: discountPct,
        scheme_tag: pickString(li.scheme_tag, li.discount_type),
        on_hand_at_confirm: pickNumber(li.on_hand_at_confirm, li.on_hand, li.available_stock),
        sku: pickString(li.sku, li.item_sku, li.item_code, li.code),
        hsn_code: pickString(li.hsn_code, li.hsn_or_sac, li.hsn_sac),
        deleted_at: null,
        created_at: asDate(li.created_time ?? li.created_at) ?? parentCreatedAt ?? nowIso(),
        updated_at: asDate(li.last_modified_time ?? li.updated_at ?? li.created_time) ?? parentCreatedAt ?? nowIso(),
        created_by: entry.resolvedActorId,
        updated_by: entry.resolvedActorId,
      });
    }

    if (orderItemSyncError) break;
  }

  if (orderItemSyncError) {
    const errorReason = formatErrorReason(orderItemSyncError.message, orderItemSyncError.details);
    await batchUpsertEntityMap(admin, tenantId, integrationId, 'orders', orderMapPairs, {
      syncStatus: 'error',
      errorReason,
    });
    throw orderItemSyncError;
  }

  await persistDerivedChildRows(admin, 'order_items', 'order_id', orderIds, lineItemRows);

  const orderAnalyticsCandidates: ZohoAnalyticsCandidate[] = orderMapPairs
    .map((pair) => {
      const parentRow = parentRows.find((row) => asStr(row.external_ref) === pair.externalId) ?? null;
      const naturalKey = parentRow ? asStr(parentRow.order_number) : null;
      const existedBefore = Boolean(
        existingOrderRows.byExternalRef.get(pair.externalId)
          ?? (naturalKey ? existingOrderRows.byNaturalKey.get(naturalKey) : null),
      );
      if (existedBefore) return null;

      const persistedRow = persistedOrders.find((row) => asStr(row.id) === pair.internalId || asStr(row.external_ref) === pair.externalId)
        ?? parentRow
        ?? {};
      const sourceRecord = sourcePayloadByOrderRef.get(pair.externalId) ?? null;
      if (!isZohoCatalogTransactionCandidate({ entityType: 'orders', sourceRecord, persistedRow })) return null;

      return {
        entityType: 'orders' as const,
        externalId: pair.externalId,
        internalId: pair.internalId,
        eventName: 'server_erp_order_created',
      };
    })
    .filter((candidate): candidate is ZohoAnalyticsCandidate => candidate !== null);

  await captureZohoErpAnalyticsEvents({
    admin,
    tenantId,
    tenantIntegrationId: integrationId,
    candidates: orderAnalyticsCandidates,
  });

  return result;
}

// ── Invoices ─────────────────────────────────────────────────────────────────

async function persistInvoices(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  zohoTypeId?: ZohoIntegrationTypeId,
): Promise<PersistResult> {
  const result = emptyPersistResult();
  const invoiceFieldMappings = await loadFieldMappings(admin, integrationId, 'invoices');
  const salespersonActorMap = await buildZohoSalespersonActorMap(admin, tenantId, adapter);

  const customerExternalIds = [...new Set(
    records
      .map((r) => asStr(r.customer_id))
      .filter((x): x is string => x !== null),
  )];
  const buyerIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'customers', 'buyers', customerExternalIds,
  );
  // FK-failsafe: fetch missing buyers from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    const missingBuyerIds = customerExternalIds.filter((extId) => !buyerIdMap.has(extId));
    const resolvedBuyers = await mapWithConcurrency(missingBuyerIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureBuyerExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedBuyers) {
      if (internalId) buyerIdMap.set(extId, internalId);
    }
  }
  const locationExternalIds = [...new Set(
    records
      .map((r) => pickString(r.location_id, r.warehouse_id))
      .filter((x): x is string => x !== null),
  )];
  const locationIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'locations', 'locations', locationExternalIds,
  );
  // FK-failsafe: fetch missing locations from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    const missingLocationIds = locationExternalIds.filter((extId) => !locationIdMap.has(extId));
    const resolvedLocations = await mapWithConcurrency(missingLocationIds, ZOHO_DETAIL_FETCH_CONCURRENCY, async (extId) => {
      const internalId = await ensureLocationExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
      return { extId, internalId };
    });
    for (const { extId, internalId } of resolvedLocations) {
      if (internalId) locationIdMap.set(extId, internalId);
    }
  }
  const orderExternalIds = [...new Set(
    records
      .map((r) => pickString(r.salesorder_id, r.order_id))
      .filter((x): x is string => x !== null),
  )];
  const orderIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'orders', 'orders', orderExternalIds,
  );
  const estimateExternalIds = [...new Set(
    records
      .map((r) => asStr(r.estimate_id))
      .filter((x): x is string => x !== null),
  )];
  const estimateIdMap = estimateExternalIds.length > 0
    ? await resolveInternalIdsWithFallback(
        admin, tenantId, integrationId, 'estimates', 'estimates', estimateExternalIds,
      )
    : new Map<string, string>();
  const parentRows: Record<string, unknown>[] = [];
  const parentRecords: Array<{ invoiceExternalId: string; sourcePayload: Record<string, unknown>; lineItems: Record<string, unknown>[]; resolvedActorId: string | null }> = [];

  for (const rec of records) {
    const externalId = asStr(rec.invoice_id);
    if (!externalId) { result.skipped++; continue; }

    const invoiceDate = asDate(rec.date) ?? nowIso();

    const customerId = asStr(rec.customer_id);
    const buyerId = customerId ? (buyerIdMap.get(customerId) ?? null) : null;
    const locationExternalId = pickString(rec.location_id, rec.warehouse_id);
    const locationId = locationExternalId ? (locationIdMap.get(locationExternalId) ?? null) : null;
    const orderExternalId = pickString(rec.salesorder_id, rec.order_id);
    const orderId = orderExternalId ? (orderIdMap.get(orderExternalId) ?? null) : null;
    const estimateExternalId = asStr(rec.estimate_id);
    const estimateId = estimateExternalId ? (estimateIdMap.get(estimateExternalId) ?? null) : null;

    const shippingAddr = rec.shipping_address;
    const deliveryAddress = shippingAddr && typeof shippingAddr === 'object'
      ? shippingAddr
      : null;
    const lineItems = Array.isArray(rec.line_items) ? rec.line_items as Record<string, unknown>[] : [];
    const salespersonId = asStr(rec.salesperson_id);
    const resolvedActorId = resolveImportedActorId(actorId, salespersonId, salespersonActorMap);
    const subtotal = pickNumber(rec.sub_total, rec.subtotal);
    const taxAmount = pickNumber(rec.tax_total, rec.tax_amount);
    const placeOfSupply = pickString(
      rec.place_of_supply,
      rec.place_of_contact,
      rec.state,
      rec.billing_state,
      rec.shipping_state,
    );

    const total = asNum(rec.total) ?? 0;
    const balance = asNum(rec.balance) ?? 0;
    const amountPaid = asNum(rec.payment_made) ?? (total - balance);
    const customFields = buildCustomFieldsJson(rec);

    parentRows.push({
      tenant_id: tenantId,
      external_ref: externalId,
      buyer_id: buyerId,
      location_id: locationId,
      order_id: orderId,
      custom_fields: customFields,
      ...applyFieldMappings(customFields, invoiceFieldMappings),
      invoice_number: asStr(rec.invoice_number) ?? externalId,
      invoice_date: invoiceDate,
      status: asStr(rec.status) ?? 'sent',
      ...presentNumberFields(
        ['subtotal', subtotal],
        ['tax_amount', taxAmount],
      ),
      total_amount: total,
      outstanding_balance: balance,
      amount_paid: amountPaid,
      delivery_address: deliveryAddress as Record<string, unknown> | null,
      ...presentStringField('place_of_supply', placeOfSupply),
      notes: pickString(rec.notes, rec.seller_note),
      notes_for_buyer: pickString(rec.notes_for_buyer, rec.notes),
      seller_note: pickString(rec.seller_note),
      buyer_po_ref: pickString(rec.reference_number, rec.buyer_po_ref),
      discount_flat: pickNumber(rec.discount_flat, rec.discount) ?? 0,
      freight: pickNumber(rec.freight, rec.shipping_charge) ?? 0,
      round_off: pickNumber(rec.round_off) ?? 0,
      estimate_id: estimateId,
      due_date: asDateOnly(rec.due_date),
      paid_at: asDate(rec.payment_date ?? rec.paid_at),
      payment_reference: pickString(rec.payment_reference, rec.reference_number),
      sent_at: asDate(rec.sent_at ?? rec.date),
      sent_channel: pickString(rec.sent_channel, rec.channel),
      created_at: asDate(rec.created_time ?? rec.date),
      updated_at: asDate(rec.last_modified_time ?? rec.updated_time ?? rec.created_time),
      deleted_at: null,
      created_by: resolvedActorId,
      updated_by: resolvedActorId,
    });

    parentRecords.push({
      invoiceExternalId: externalId,
      sourcePayload: buildTransactionalSourcePayload(rec),
      lineItems,
      resolvedActorId,
    });
  }

  const existingInvoiceRows = await loadExistingRowsByExternalOrNaturalKey(
    admin,
    'invoices',
    tenantId,
    parentRows.map((row) => asStr(row.external_ref)).filter((value): value is string => value !== null),
    'invoice_number',
    parentRows.map((row) => asStr(row.invoice_number)).filter((value): value is string => value !== null),
    'external_ref, invoice_number',
  );

  const guardedInvoiceRows = await applyImmediateEchoGuards(
    admin, tenantId, integrationId, 'invoices', 'invoices', parentRows,
  );
  const invoicePersist = await persistWithNaturalKeyLock(
    admin, 'invoices', tenantId, dedupeByExternalOrNaturalKey(guardedInvoiceRows, ['invoice_number']), 'invoice_number', ['tenant_id', 'external_ref'],
  );
  if (invoicePersist.conflicts.length > 0) {
    console.warn('[persistInvoices] invoice collision conflicts:', invoicePersist.conflicts);
    result.skipped += invoicePersist.conflicts.length;
  }
  const persistedInvoices = invoicePersist.rows;
  const sourcePayloadByInvoiceRef = new Map(
    parentRecords.map((e) => [e.invoiceExternalId, e.sourcePayload] as const),
  );
  const invoiceMapPairs = buildPersistedRowPairsFromSourceRows(parentRows, persistedInvoices, ['invoice_number']).map((p) => ({
    ...p,
    sourcePayload: sourcePayloadByInvoiceRef.get(p.externalId) ?? null,
  }));
  const invoiceIdMap = new Map(invoiceMapPairs.map((row) => [row.externalId, row.internalId] as const));
  const invoiceIds = invoiceMapPairs.map((row) => row.internalId);

  result.updated += invoiceMapPairs.length;
  await batchUpsertEntityMap(admin, tenantId, integrationId, 'invoices', invoiceMapPairs);

  const productExtIds = [...new Set(
    parentRecords.flatMap((entry) =>
      entry.lineItems.map((li) => asStr(li.item_id)).filter((x): x is string => x !== null),
    ),
  )];
  const productIdMap = await resolveInternalIdsWithFallback(
    admin, tenantId, integrationId, 'products', 'tenant_products', productExtIds,
  );
  // FK-failsafe: fetch missing products from Zoho when adapter is present
  if (adapter && zohoTypeId) {
    for (const extId of productExtIds) {
      if (!productIdMap.has(extId)) {
        const internalId = await ensureProductExists(admin, tenantId, actorId, integrationId, zohoTypeId, extId, adapter);
        if (internalId) productIdMap.set(extId, internalId);
      }
    }
  }

  const lineItemRows: Record<string, unknown>[] = [];
  let invoiceItemSyncError: IntegrationSyncError | null = null;
  for (const entry of parentRecords) {
    const invoiceId = invoiceIdMap.get(entry.invoiceExternalId) ?? null;
    if (!invoiceId) {
      invoiceItemSyncError = new IntegrationSyncError(
        'invoices',
        `Unable to resolve imported invoice ${entry.invoiceExternalId}.`,
        entry.invoiceExternalId,
        { invoice_id: entry.invoiceExternalId },
      );
      break;
    }

    for (const [lineIndex, li] of entry.lineItems.entries()) {
      const extProdId = asStr(li.item_id);
      const productId = extProdId ? (productIdMap.get(extProdId) ?? null) : null;
      if (!productId) {
        invoiceItemSyncError = new IntegrationSyncError(
          'invoice_items',
          `Unable to resolve product ${extProdId ?? 'unknown'} for invoice ${entry.invoiceExternalId}.`,
          entry.invoiceExternalId,
          {
            invoice_id: entry.invoiceExternalId,
            item_id: extProdId,
            line_index: lineIndex,
          },
        );
        break;
      }

      const taxRate = pickNumber(li.tax_percentage, li.tax_rate);
      const discountPct = pickNumber(li.discount_percentage, li.disc_pct) ?? 0;
      const externalRef = await buildChildExternalRef(entry.invoiceExternalId, li, lineIndex);
      const lineOrder = resolveLineOrder(li, lineIndex);
      const parentCreatedAt = asDate(entry.sourcePayload.created_time ?? entry.sourcePayload.created_at);

      lineItemRows.push({
        invoice_id: invoiceId,
        tenant_product_id: productId,
        external_ref: externalRef,
        item_order: lineOrder,
        qty: pickNumber(li.quantity, li.qty) ?? 1,
        unit_price: pickNumber(li.rate, li.unit_price, li.price) ?? 0,
        line_total: resolveLineTotal(li, lineIndex),
        tax_rate: taxRate,
        tax_pct: taxRate,
        disc_pct: discountPct,
        discount_pct: discountPct,
        sku: pickString(li.sku, li.item_sku, li.item_code, li.code),
        hsn_code: pickString(li.hsn_code, li.hsn_or_sac, li.hsn_sac),
        scheme_tag: pickString(li.scheme_tag, li.discount_type),
        deleted_at: null,
        created_at: asDate(li.created_time ?? li.created_at) ?? parentCreatedAt ?? nowIso(),
        updated_at: asDate(li.last_modified_time ?? li.updated_at ?? li.created_time) ?? parentCreatedAt ?? nowIso(),
        created_by: entry.resolvedActorId,
        updated_by: entry.resolvedActorId,
      });
    }

    if (invoiceItemSyncError) break;
  }

  if (invoiceItemSyncError) {
    const errorReason = formatErrorReason(invoiceItemSyncError.message, invoiceItemSyncError.details);
    await batchUpsertEntityMap(admin, tenantId, integrationId, 'invoices', invoiceMapPairs, {
      syncStatus: 'error',
      errorReason,
    });
    throw invoiceItemSyncError;
  }

  await persistDerivedChildRows(admin, 'invoice_items', 'invoice_id', invoiceIds, lineItemRows);

  const invoiceAnalyticsCandidates: ZohoAnalyticsCandidate[] = invoiceMapPairs
    .map((pair) => {
      const parentRow = parentRows.find((row) => asStr(row.external_ref) === pair.externalId) ?? null;
      const naturalKey = parentRow ? asStr(parentRow.invoice_number) : null;
      const existedBefore = Boolean(
        existingInvoiceRows.byExternalRef.get(pair.externalId)
          ?? (naturalKey ? existingInvoiceRows.byNaturalKey.get(naturalKey) : null),
      );
      if (existedBefore) return null;

      const persistedRow = persistedInvoices.find((row) => asStr(row.id) === pair.internalId || asStr(row.external_ref) === pair.externalId)
        ?? parentRow
        ?? {};
      const sourceRecord = sourcePayloadByInvoiceRef.get(pair.externalId) ?? null;
      if (!isZohoCatalogTransactionCandidate({ entityType: 'invoices', sourceRecord, persistedRow })) return null;

      return {
        entityType: 'invoices' as const,
        externalId: pair.externalId,
        internalId: pair.internalId,
        eventName: 'server_erp_invoice_created',
      };
    })
    .filter((candidate): candidate is ZohoAnalyticsCandidate => candidate !== null);

  await captureZohoErpAnalyticsEvents({
    admin,
    tenantId,
    tenantIntegrationId: integrationId,
    candidates: invoiceAnalyticsCandidates,
  });

  return result;
}

// ── Router ───────────────────────────────────────────────────────────────────

// ── Contact persons (dedicated list sweep) ───────────────────────────────────
// Called from sync-customers step=contact_persons after contacts are fully synced.
// Uses GET /contacts/contactpersons which returns all contact persons paginated,
// each record carrying contact_id (parent) and contact_person_id.
async function persistContactPersonsPage(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: JsonRecord[],
): Promise<PersistResult> {
  const result = emptyPersistResult();

  if (records.length === 0) return result;

  // Gather all unique contact_ids present in this page
  const contactIds = [...new Set(
    records.map((r) => asStr(r.contact_id)).filter((id): id is string => id !== null),
  )];

  if (contactIds.length === 0) {
    result.skipped = records.length;
    return result;
  }

  // Batch-resolve buyer_ids from the entity map written by the customers phase
  const { data: entityRows, error: entityError } = await admin
    .schema('app')
    .from('integration_entity_map')
    .select('external_id, internal_id')
    .eq('tenant_id', tenantId)
    .eq('tenant_integration_id', integrationId)
    .eq('entity_type', 'customers')
    .in('external_id', contactIds);

  if (entityError) throw new Error(`Entity map lookup failed: ${entityError.message}`);

  const buyerIdMap = new Map<string, string>(
    (entityRows ?? []).map((r) => [r.external_id as string, r.internal_id as string]),
  );

  const contactRows: JsonRecord[] = [];

  for (const rec of records) {
    const cpId = asStr(rec.contact_person_id);
    const contactId = asStr(rec.contact_id);

    if (!cpId || !contactId) {
      result.skipped++;
      continue;
    }

    const buyerId = buyerIdMap.get(contactId);
    if (!buyerId) {
      // Parent contact not yet in entity map — contacts phase must run first
      result.skipped++;
      continue;
    }

    contactRows.push({
      buyer_id: buyerId,
      external_ref: cpId,
      role: 'buyer_assistant' as const,
      first_name: asStr(rec.first_name),
      last_name: asStr(rec.last_name),
      email: asStr(rec.email),
      designation: asStr(rec.designation),
      department: asStr(rec.department),
      is_active: true, // list endpoint only returns active contact persons
      created_by: actorId,
      updated_by: actorId,
      deleted_at: null,
      ...(pickSanitizedPhone(rec.phone, rec.mobile) ? { phone: pickSanitizedPhone(rec.phone, rec.mobile) } : {}),
    });
  }

  const dedupedRows = dedupeByColumns(contactRows, ['buyer_id', 'external_ref']);

  if (dedupedRows.length === 0) return result;

  const persisted = await bulkPersistJsonbRecords(
    admin,
    'buyer_users',
    dedupedRows,
    ['buyer_id', 'external_ref'],
  );

  const mapPairs = persisted
    .map((row) => {
      const externalId = asStr(row.external_ref);
      const internalId = asStr(row.id);
      return externalId && internalId ? { externalId, internalId, sourcePayload: null } : null;
    })
    .filter((r): r is { externalId: string; internalId: string; sourcePayload: null } => r !== null);

  await batchUpsertEntityMap(admin, tenantId, integrationId, 'contact_persons', mapPairs);

  result.created = persisted.length;
  result.pendingSearchVectorBuyerIds = Array.from(new Set(
    dedupedRows
      .map((row) => asStr(row.buyer_id))
      .filter((id): id is string => id !== null),
  ));
  result.pendingSearchVectorBuyerUserIds = persisted
    .map((row) => asStr(row.id))
    .filter((id): id is string => id !== null);

  return result;
}

// ── Customer Payments ────────────────────────────────────────────────────────

// Reserve time for one detail fetch (worst case ~30s call + 300ms pace) so the
// loop doesn't blow past the edge function's ~150s hard-kill mid-request.
const PAYMENT_DETAIL_DEADLINE_RESERVATION_MS = 35_000;

async function persistCustomerPayments(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
): Promise<PersistResult> {
  const result = emptyPersistResult();
  if (records.length === 0) return result;

  // 1. Resolve buyer_ids from customer_id external refs (same pattern as invoices)
  const customerExternalIds = [...new Set(
    records.map((r) => asStr(r.customer_id)).filter((x): x is string => x !== null),
  )];
  const buyerIdMap = customerExternalIds.length > 0
    ? await resolveInternalIdsWithFallback(admin, tenantId, integrationId, 'customers', 'buyers', customerExternalIds)
    : new Map<string, string>();

  // 2. Upsert payment headers from list records
  const paymentRows: Record<string, unknown>[] = [];
  for (const rec of records) {
    const externalRef = asStr(rec.payment_id);
    if (!externalRef) { result.skipped++; continue; }
    const customerId = asStr(rec.customer_id);
    const buyerId = customerId ? (buyerIdMap.get(customerId) ?? null) : null;
    const zohoStatus = asStr(rec.status);
    const status = zohoStatus === 'success' ? 'cleared' : zohoStatus === 'failure' ? 'failed' : 'recorded';
    paymentRows.push({
      tenant_id:           tenantId,
      external_ref:        externalRef,
      buyer_id:            buyerId,
      amount:              asNum(rec.amount) ?? 0,
      paid_at:             asDate(rec.date) ?? nowIso(),
      mode:                asStr(rec.payment_mode),
      status,
      payment_number:      asStr(rec.payment_number),
      reference_number:    asStr(rec.reference_number),
      bank_charges:        asNum(rec.bank_charges) ?? 0,
      tax_amount_withheld: asNum(rec.tax_amount_withheld) ?? 0,
      currency_code:       asStr(rec.currency_code) ?? 'INR',
      description:         asStr(rec.description),
      excess_amount:       asNum(rec.balance) ?? 0,
      zoho_customer_id:    customerId,
      created_by:          actorId,
      updated_by:          actorId,
      deleted_at:          null,
    });
  }

  if (paymentRows.length > 0) {
    const { error, count } = await admin
      .schema('app')
      .from('payments')
      .upsert(paymentRows, { onConflict: 'tenant_id,external_ref', count: 'exact' });
    if (error) {
      console.error('[persistCustomerPayments] payment upsert error:', error.message);
    } else {
      result.updated += count ?? paymentRows.length;
    }
  }

  // 3. Fetch per-payment detail to get invoices[] array, then upsert payment_applications
  if (!adapter?.fetchCustomerPaymentDetail) return result;

  // Resolve payment UUIDs for the rows we just upserted
  const externalRefs = paymentRows.map((r) => asStr(r.external_ref)).filter((x): x is string => x !== null);
  const { data: paymentIdRows } = await admin
    .schema('app')
    .from('payments')
    .select('id, external_ref')
    .eq('tenant_id', tenantId)
    .in('external_ref', externalRefs)
    .is('deleted_at', null);

  const paymentUuidByExternalRef = new Map<string, string>(
    (paymentIdRows ?? []).map((r: { id: string; external_ref: string }) => [r.external_ref, r.id] as const),
  );

  for (const rec of records) {
    const externalRef = asStr(rec.payment_id);
    if (!externalRef) continue;
    const paymentId = paymentUuidByExternalRef.get(externalRef);
    if (!paymentId) continue;

    if (
      PAYMENT_DETAIL_DEADLINE_RESERVATION_MS != null
      && adapter?.fetchCustomerPaymentDetail
      // persistOptions.deadlineMs isn't threaded into this path; use a fixed 20s from now as a soft guard
      // (the coordinator's DISPATCH_TIMEOUT_MS=140s hard-stops the entire edge function call externally)
    ) {
      // no deadline check here — see comment above; the outer coordinator timeout is the hard boundary
    }

    // Webhook payloads include full payment detail (invoices[]) inline.
    // List payloads typically omit it — fetch detail only when not present on the record.
    let invoiceEntries: Record<string, unknown>[] = [];
    if (Array.isArray(rec.invoices) && rec.invoices.length > 0) {
      invoiceEntries = rec.invoices as Record<string, unknown>[];
    } else {
      const detail = await adapter.fetchCustomerPaymentDetail(externalRef);
      if (!detail) {
        await new Promise<void>((r) => setTimeout(r, 300));
        continue;
      }
      invoiceEntries = Array.isArray(detail.invoices) ? detail.invoices as Record<string, unknown>[] : [];
    }

    if (invoiceEntries.length === 0) {
      await new Promise<void>((r) => setTimeout(r, 300));
      continue;
    }

    // Resolve invoice UUIDs from Zoho invoice_id external refs
    const invoiceExternalIds = invoiceEntries
      .map((inv) => asStr(inv.invoice_id))
      .filter((x): x is string => x !== null);

    const { data: invoiceIdRows } = await admin
      .schema('app')
      .from('invoices')
      .select('id, external_ref')
      .eq('tenant_id', tenantId)
      .in('external_ref', invoiceExternalIds)
      .is('deleted_at', null);

    const invoiceUuidByExternalRef = new Map<string, string>(
      (invoiceIdRows ?? []).map((r: { id: string; external_ref: string }) => [r.external_ref, r.id] as const),
    );

    const applicationRows: Record<string, unknown>[] = [];
    for (const inv of invoiceEntries) {
      const invExternalRef = asStr(inv.invoice_id);
      if (!invExternalRef) continue;
      const invoiceId = invExternalRef ? invoiceUuidByExternalRef.get(invExternalRef) : null;
      if (!invoiceId) continue;
      applicationRows.push({
        tenant_id:      tenantId,
        payment_id:     paymentId,
        invoice_id:     invoiceId,
        amount_applied: asNum(inv.amount_applied) ?? 0,
        balance_after:  asNum(inv.balance_amount) ?? 0,
      });
    }

    if (applicationRows.length > 0) {
      const { error: appError } = await admin
        .schema('app')
        .from('payment_applications')
        .upsert(applicationRows, { onConflict: 'payment_id,invoice_id' });
      if (appError) {
        console.error(`[persistCustomerPayments] application upsert error for payment ${externalRef}:`, appError.message);
      }
    }

    await new Promise<void>((r) => setTimeout(r, 300));
  }

  return result;
}

export async function persistZohoEntityPage(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  entityType: string,
  integrationTypeId: ZohoIntegrationTypeId,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  persistOptions?: PersistOptions,
): Promise<PersistResult> {
  // Uniform entry/exit checkpoint for every entity type — the single common
  // choke point between runPhaseSync's per-page fetch and every
  // entity-specific persister. If a phase hangs, this tells you whether it
  // ever even reached (or returned from) persistence for that page.
  const done = startTimer(null, entityType, 'persistZohoEntityPage');
  const result = await persistZohoEntityPageImpl(
    admin, tenantId, actorId, integrationId, entityType, integrationTypeId, records, adapter, persistOptions,
  );
  done({ created: result.created, updated: result.updated, skipped: result.skipped });
  return result;
}

async function persistZohoEntityPageImpl(
  admin: AdminClient,
  tenantId: string,
  actorId: string | null,
  integrationId: string,
  entityType: string,
  integrationTypeId: ZohoIntegrationTypeId,
  records: Record<string, unknown>[],
  adapter?: ZohoAdapter,
  persistOptions?: PersistOptions,
): Promise<PersistResult> {
  switch (entityType) {
    case 'locations':
      return persistLocations(admin, tenantId, actorId, integrationId, integrationTypeId, records, adapter);

    case 'warehouses':
      return persistWarehouses(admin, tenantId, actorId, integrationId, records);

    case 'customers':
      return persistBuyers(admin, tenantId, actorId, integrationId, records, adapter, integrationTypeId, persistOptions);

    case 'contact_persons':
      return persistContactPersonsPage(admin, tenantId, actorId, integrationId, records);

    case 'products':
      return persistProducts(admin, tenantId, actorId, integrationId, records, adapter);

    case 'pricelists':
      return persistPricelists(admin, tenantId, actorId, integrationId, records, adapter, persistOptions);

    case 'estimates':
      // List payload only — line items hydrated in transaction_line_items phase.
      return persistEstimates(admin, tenantId, actorId, integrationId, records, adapter, integrationTypeId);

    case 'orders':
      return persistOrders(admin, tenantId, actorId, integrationId, records, adapter, integrationTypeId);

    case 'invoices':
    case 'invoices_outstanding':
      return persistInvoices(admin, tenantId, actorId, integrationId, records, adapter, integrationTypeId);

    case 'customer_payments':
      return persistCustomerPayments(admin, tenantId, actorId, integrationId, records, adapter);

    default:
      return emptyPersistResult({ skipped: records.length });
  }
}
