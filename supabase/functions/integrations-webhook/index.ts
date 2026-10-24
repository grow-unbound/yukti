// supabase/functions/integrations-webhook/index.ts

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { persistZohoEntityPage, LockTimeoutError } from '../_shared/integrations-persist.ts';
import {
  loadWebhookByToken,
  validateWebhookSecret,
  parseWebhookBody,
  extractEntityPayload,
  resolveWebhookOperation,
  resolveExternalId,
  touchWebhookLastReceived,
} from '../_shared/zoho-webhook-utils.ts';
import { createZohoAdapter, type ZohoAdapter } from '../_shared/integrations-zoho.ts';
import {
  loadIntegrationCredentials,
  createDbTokenCache,
  assertZohoIntegration,
} from '../_shared/sync-utils.ts';
import { captureSentryError } from '../_shared/sentry.ts';

// Maps integration_webhooks.entity_type → persistZohoEntityPage phase param
const PHASE_BY_ENTITY: Record<string, string> = {
  contacts: 'customers',
  items: 'products',
  estimates: 'estimates',
  salesorders: 'orders',
  invoices: 'invoices',
  customerpayments: 'customer_payments',
};

// Maps persist phase → app schema table name (for soft-delete path)
const TABLE_BY_PHASE: Record<string, string> = {
  customers: 'buyers',
  products: 'tenant_products',
  estimates: 'estimates',
  orders: 'orders',
  invoices: 'invoices',
  customer_payments: 'payments',
};

// Extract endpoint_token from URL path: /integrations-webhook/{token}
function extractTokenFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last !== 'integrations-webhook' ? last : null;
}

// Always return HTTP 200 — Zoho retries on any non-200, which causes duplicate processing
function ok(reason: string): Response {
  return new Response(reason, { status: 200, headers: { 'content-type': 'text/plain' } });
}

// Exception to the "always 200" rule: a lock_timeout means persist_with_-
// natural_key_lock never wrote anything (nothing to duplicate), so returning
// 503 here lets Zoho's own retry recover the event instead of it being
// silently dropped — the failure mode this guards against is data loss, not
// the duplicate-processing risk `ok()` exists to avoid.
function retryable(reason: string): Response {
  return new Response(reason, {
    status: 503,
    headers: { 'content-type': 'text/plain', 'retry-after': '5' },
  });
}

// Hard ceiling for the persist step. Supabase kills the function at 150s;
// this fires at 100s so the catch block has time to mark the event "failed"
// and return 200 before the wall is hit (avoiding orphaned "received" rows).
const PERSIST_TIMEOUT_MS = 100_000;

function webhookDebugEnabled(): boolean {
  const value = Deno.env.get('WEBHOOK_LOG_LEVEL') ?? Deno.env.get('LOG_LEVEL') ?? '';
  return value.toLowerCase() === 'debug';
}

function debugLog(message: string): void {
  if (webhookDebugEnabled()) {
    console.log(message);
  }
}

// Postgres/PostgREST failures where nothing (or only idempotent upserts —
// see the "All persisters are idempotent" note atop integrations-persist.ts)
// happened before the error: safe to hand back to Zoho for retry, same
// reasoning as LockTimeoutError below. Without this, these errors fall
// through to ok('error') and the event is silently dropped for good.
function isTransientPersistError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.startsWith('persist_timeout') ||
    message.includes('canceling statement due to statement timeout') ||
    message.includes('canceling statement due to lock timeout') ||
    message.includes('current transaction is aborted') ||
    message.includes('deadlock detected') ||
    message.includes('could not serialize access')
  );
}

// Create placeholder webhook event record at START
async function createWebhookEventPlaceholder(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    tenantIntegrationId: string;
    webhookId: string;
    entityType: string;
    eventType: 'upsert' | 'delete' | null;
    externalEntityId: string | null;
    rawPayload: Record<string, unknown>;
  },
): Promise<string | null> {
  try {
    const { data, error } = await admin.schema('app').from('integration_webhook_events').insert({
      tenant_id: opts.tenantId,
      tenant_integration_id: opts.tenantIntegrationId,
      integration_webhook_id: opts.webhookId,
      entity_type: opts.entityType,
      event_type: opts.eventType,
      external_entity_id: opts.externalEntityId,
      processing_status: 'received',
      raw_payload: opts.rawPayload,
    }).select('id').single();

    if (error) {
      console.error(`[webhook-events] failed to create placeholder: ${error.message}`);
      return null;
    }

    return data?.id ?? null;
  } catch (e) {
    console.error(`[webhook-events] exception creating placeholder: ${String(e)}`);
    return null;
  }
}

// Check if the record was just created locally (echo guard)
async function isEchoGuarded(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    phase: string;
    externalId: string;
  },
): Promise<boolean> {
  try {
    const table = TABLE_BY_PHASE[opts.phase];
    if (!table) return false;

    // Check if record was created in the last 10 seconds (fresh local create)
    const { data } = await admin.schema('app').from(table)
      .select('created_at')
      .eq('tenant_id', opts.tenantId)
      .eq('external_ref', opts.externalId)
      .is('deleted_at', null)
      .gt('created_at', new Date(Date.now() - 10000).toISOString())
      .maybeSingle();

    return !!data;
  } catch {
    return false;
  }
}

// Update webhook event record with final status and delta
async function updateWebhookEventResult(
  admin: SupabaseClient,
  opts: {
    eventId: string;
    status: 'processed' | 'failed' | 'ignored';
    delta: Record<string, unknown>;
    errorMessage?: string;
  },
): Promise<void> {
  const { error } = await admin.schema('app').from('integration_webhook_events').update({
    processing_status: opts.status,
    processed_at: new Date().toISOString(),
    runtime_meta: {
      delta: opts.delta,
      error: opts.errorMessage,
    },
  }).eq('id', opts.eventId);
  if (error) {
    console.error(`[webhook-events] failed to update event ${opts.eventId} to ${opts.status}: ${error.message}`);
  }
}

// Log webhook error to integration_webhook_errors
async function logWebhookError(
  admin: SupabaseClient,
  opts: {
    tenantId: string;
    tenantIntegrationId: string;
    webhookId: string;
    eventId: string | null;
    entityType: string;
    externalRef: string | null;
    stage: string; // e.g., 'persist', 'echo_guard', 'validation'
    reasonCode: string;
    message: string;
    // 'skip': DB row only (expected noise, e.g. Zoho posting to a deliberately
    // disabled webhook). Default is 'error' — persist slowness/timeouts stay
    // pageable: they signal prod DB saturation.
    sentry?: 'error' | 'warning' | 'skip';
  },
): Promise<void> {
  try {
    await admin.schema('app').from('integration_webhook_errors').insert({
      tenant_id: opts.tenantId,
      tenant_integration_id: opts.tenantIntegrationId,
      integration_webhook_id: opts.webhookId,
      integration_webhook_event_id: opts.eventId,
      entity_type: opts.entityType,
      external_ref: opts.externalRef,
      stage: opts.stage,
      reason_code: opts.reasonCode,
      message: opts.message,
    });
  } catch (e) {
    console.error(`[webhook-errors] failed to log error: ${String(e)}`);
  }

  // Every caller of logWebhookError is a path that used to be silent (this
  // is the fix for the WineYard contacts secret-drift outage — see the
  // auth_failed branch above). DB row is queryable; Sentry is the "someone
  // gets paged/notified" half — one place to see this instead of relying on
  // someone thinking to check integration_webhook_errors.
  const sentryMode = opts.sentry ?? 'error';
  if (sentryMode === 'skip') return;
  await captureSentryError(`[integrations-webhook] ${opts.stage}/${opts.reasonCode}: ${opts.message}`, {
    level: sentryMode,
    // One Sentry issue per (stage, reason, entity) — messages embed row ids,
    // durations and gateway HTML, which split a single failure into many issues.
    fingerprint: ['integrations-webhook', opts.stage, opts.reasonCode, opts.entityType],
    tags: {
      integration: 'zoho',
      entity_type: opts.entityType,
      stage: opts.stage,
      reason_code: opts.reasonCode,
    },
    extra: {
      tenant_id: opts.tenantId,
      tenant_integration_id: opts.tenantIntegrationId,
      webhook_id: opts.webhookId,
      event_id: opts.eventId,
      external_ref: opts.externalRef,
    },
  });
}

Deno.serve(async (req: Request) => {
  const traceId = crypto.randomUUID().slice(0, 8);
  debugLog(`[${traceId}] webhook start | method=${req.method}`);

  let eventId: string | null = null;
  let catchCtx: {
    admin: SupabaseClient;
    tenantId: string;
    tenantIntegrationId: string;
    webhookId: string;
    entityType: string;
    externalId: string | null;
  } | null = null;

  try {
    if (req.method !== 'POST') {
      debugLog(`[${traceId}] non-POST request, returning ok`);
      return ok('ok');
    }

    const url = new URL(req.url);
    debugLog(`[${traceId}] url=${url.pathname}${url.search}`);

    const endpointToken =
      extractTokenFromPath(url.pathname) ??
      url.searchParams.get('endpoint_token') ??
      req.headers.get('x-endpoint-token');

    debugLog(`[${traceId}] endpoint_token=${endpointToken ? 'present' : 'missing'}`);
    if (!endpointToken) {
      debugLog(`[${traceId}] FAIL: no_token`);
      return ok('no_token');
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    debugLog(`[${traceId}] admin client created`);

    debugLog(`[${traceId}] loading webhook by token`);
    const webhook = await loadWebhookByToken(admin, endpointToken);
    debugLog(`[${traceId}] webhook loaded | id=${webhook?.id ?? 'null'} | entity_type=${webhook?.entity_type} | is_active=${webhook?.is_active} | status=${webhook?.status}`);

    if (!webhook || !webhook.is_active || webhook.status !== 'active') {
      debugLog(`[${traceId}] FAIL: inactive webhook`);
      if (webhook) {
        await logWebhookError(admin, {
          tenantId: webhook.tenant_id,
          tenantIntegrationId: webhook.tenant_integration_id,
          webhookId: webhook.id,
          eventId: null,
          entityType: webhook.entity_type,
          externalRef: null,
          stage: 'routing',
          reasonCode: 'webhook_inactive',
          message: `Webhook row is_active=${webhook.is_active} status=${webhook.status} — Zoho is still posting to a disabled/removed endpoint.`,
          // Expected after a webhook is disabled until the Zoho-side
          // subscription is removed; the DB row is the audit trail.
          sentry: 'skip',
        });
      }
      return ok('inactive');
    }

    debugLog(`[${traceId}] validating webhook secret`);
    if (!validateWebhookSecret(req, webhook.secret)) {
      debugLog(`[${traceId}] FAIL: auth_failed - secret mismatch`);
      // This is exactly the failure mode that caused the WineYard contacts
      // outage (2026-08-31 to 2026-09-05): a stale/drifted secret silently
      // ate every inbound event with no trace anywhere. Always 200 Zoho
      // (see ok() above), but never let this be silent to us again.
      await logWebhookError(admin, {
        tenantId: webhook.tenant_id,
        tenantIntegrationId: webhook.tenant_integration_id,
        webhookId: webhook.id,
        eventId: null,
        entityType: webhook.entity_type,
        externalRef: null,
        stage: 'auth',
        reasonCode: 'secret_mismatch',
        message: 'x-zoho-webhook-token did not match the stored secret for this endpoint_token — Zoho and our DB have drifted.',
      });
      return ok('auth_failed');
    }
    debugLog(`[${traceId}] secret validated ✓`);

    const entityType: string = webhook.entity_type;
    const phase = PHASE_BY_ENTITY[entityType];
    debugLog(`[${traceId}] entity_type=${entityType} | phase=${phase}`);

    if (!phase) {
      debugLog(`[${traceId}] FAIL: unsupported_entity`);
      await logWebhookError(admin, {
        tenantId: webhook.tenant_id,
        tenantIntegrationId: webhook.tenant_integration_id,
        webhookId: webhook.id,
        eventId: null,
        entityType,
        externalRef: null,
        stage: 'routing',
        reasonCode: 'unsupported_entity',
        message: `No PHASE_BY_ENTITY mapping for entity_type=${entityType}.`,
      });
      return ok('unsupported_entity');
    }

    const webhookConfig = (webhook.webhook_config ?? {}) as Record<string, unknown>;
    const integrationTypeId: string =
      (webhookConfig['integration_type_id'] as string) ?? 'zoho_books';
    debugLog(`[${traceId}] integration_type_id=${integrationTypeId}`);

    debugLog(`[${traceId}] parsing body...`);
    const body = await parseWebhookBody(req);
    debugLog(`[${traceId}] body parsed | body_present=${!!body} | body_keys=${body ? Object.keys(body).slice(0, 5).join(',') : 'none'}`);

    // Derive operation from event_types stored on the DB row.
    // Delete rows store only *.deleted events; add_edit rows store *.created/*.updated.
    // Fall back to ?event_type= URL param (legacy single-row registrations) then body-based detection.
    const rowEventTypes = Array.isArray((webhook as Record<string, unknown>).event_types)
      ? ((webhook as Record<string, unknown>).event_types as string[])
      : [];
    const isDeleteRow = rowEventTypes.length > 0 && rowEventTypes.every((e) => e.endsWith('.deleted'));
    const eventTypeParam = url.searchParams.get('event_type');
    debugLog(`[${traceId}] row_event_types=${rowEventTypes.join(',')} is_delete_row=${isDeleteRow} event_type_param=${eventTypeParam}`);

    const operation: 'upsert' | 'delete' | null =
      isDeleteRow ? 'delete' :
      rowEventTypes.length > 0 ? 'upsert' :
      eventTypeParam === 'delete' ? 'delete' :
      eventTypeParam === 'upsert' ? 'upsert' :
      (body ? resolveWebhookOperation(body) : null);

    debugLog(`[${traceId}] operation=${operation}`);

    if (!operation) {
      debugLog(`[${traceId}] FAIL: no operation — logging as skipped`);
      // No operation determinable — create placeholder and mark skipped
      eventId = await createWebhookEventPlaceholder(admin, {
        tenantId: webhook.tenant_id,
        tenantIntegrationId: webhook.tenant_integration_id,
        webhookId: webhook.id,
        entityType,
        eventType: null,
        externalEntityId: null,
        rawPayload: body ?? {},
      });
      if (eventId) {
        await updateWebhookEventResult(admin, {
          eventId,
          status: 'ignored',
          delta: { reason: body ? 'unknown_operation' : 'empty_payload' },
        });
      }
      return ok('skipped');
    }

    debugLog(`[${traceId}] extracting entity payload...`);
    const entityPayload = body ? extractEntityPayload(body, entityType) : null;
    const externalId = resolveExternalId(entityPayload, entityType);
    debugLog(`[${traceId}] entity_payload=${entityPayload ? 'present' : 'null'} | external_id=${externalId ?? 'null'}`);

    // Create placeholder event record FIRST
    eventId = await createWebhookEventPlaceholder(admin, {
      tenantId: webhook.tenant_id,
      tenantIntegrationId: webhook.tenant_integration_id,
      webhookId: webhook.id,
      entityType,
      eventType: operation,
      externalEntityId: externalId,
      rawPayload: body ?? {},
    });

    // Check echo guard (skip if record was just created locally)
    if (externalId && (operation === 'upsert' || operation === 'delete')) {
      const isGuarded = await isEchoGuarded(admin, {
        tenantId: webhook.tenant_id,
        phase,
        externalId,
      });
      if (isGuarded) {
        debugLog(`[${traceId}] ECHO GUARDED: skipping locally-created record`);
        if (eventId) {
          await updateWebhookEventResult(admin, {
            eventId,
            status: 'ignored',
            delta: { reason: 'echo_guard_prevented_overwrite' },
          });
        }
        await touchWebhookLastReceived(admin, webhook.id);
        return ok('echo_guarded');
      }
    }

    if (operation === 'delete') {
      debugLog(`[${traceId}] processing DELETE operation`);
      if (externalId) {
        const table = TABLE_BY_PHASE[phase];
        debugLog(`[${traceId}] soft-deleting from table=${table}`);
        if (table) {
          const result = await admin.schema('app').from(table)
            .update({ deleted_at: new Date().toISOString() })
            .eq('tenant_id', webhook.tenant_id)
            .eq('external_ref', externalId)
            .is('deleted_at', null);
          debugLog(`[${traceId}] soft-delete result | error=${result.error ? result.error.message : 'none'}`);
        }
      }
      await touchWebhookLastReceived(admin, webhook.id);
      if (eventId) {
        await updateWebhookEventResult(admin, {
          eventId,
          status: 'processed',
          delta: { operation: 'soft_delete', external_id: externalId, table: TABLE_BY_PHASE[phase] },
        });
      }
      debugLog(`[${traceId}] SUCCESS: deleted | external_id=${externalId}`);
      return ok('deleted');
    }

    // Upsert path
    if (!entityPayload) {
      debugLog(`[${traceId}] FAIL: no entity payload for upsert`);
      if (eventId) {
        await updateWebhookEventResult(admin, {
          eventId,
          status: 'ignored',
          delta: { reason: 'no_entity_payload' },
        });
      }
      return ok('skipped_no_payload');
    }

    catchCtx = {
      admin,
      tenantId: webhook.tenant_id,
      tenantIntegrationId: webhook.tenant_integration_id,
      webhookId: webhook.id,
      entityType,
      externalId: externalId ?? null,
    };

    // Build Zoho adapter for FK-failsafe fetching — if credentials can't be loaded,
    // proceed without adapter (graceful degradation: null buyer/location, throw on missing product).
    let adapter: ZohoAdapter | undefined;
    try {
      const zohoTypeId = assertZohoIntegration(integrationTypeId);
      const credentials = await loadIntegrationCredentials(admin, webhook.tenant_integration_id, integrationTypeId);
      const tokenCache = createDbTokenCache(admin, webhook.tenant_integration_id);
      adapter = createZohoAdapter(zohoTypeId, credentials, tokenCache);
      debugLog(`[${traceId}] adapter created for FK-failsafe fetching`);
    } catch (adapterErr) {
      console.warn(`[${traceId}] adapter creation failed, proceeding without FK-failsafe: ${String(adapterErr)}`);
    }

    // 100s ceiling keeps the catch block reachable before Supabase's 150s
    // wall-clock kill — ensures orphaned "received" rows can't accumulate.
    // FK-failsafe Zoho calls happen before the DB persist, so normal paths
    // complete well under this limit; only pathological cases (all Zoho calls
    // timing out at max retry budget) would approach it.
    debugLog(`[${traceId}] calling persistZohoEntityPage...`);
    const persistResult = await Promise.race([
      persistZohoEntityPage(
        admin,
        webhook.tenant_id,
        null,
        webhook.tenant_integration_id,
        phase,
        integrationTypeId,
        [entityPayload],
        adapter,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('persist_timeout: exceeded 100s budget')), PERSIST_TIMEOUT_MS)
      ),
    ]);
    debugLog(`[${traceId}] persistZohoEntityPage returned | result.created=${persistResult.created} | result.updated=${persistResult.updated}`);

    await touchWebhookLastReceived(admin, webhook.id);
    if (eventId) {
      await updateWebhookEventResult(admin, {
        eventId,
        status: 'processed',
        delta: {
          operation: 'upsert',
          external_id: externalId,
          phase,
          created: persistResult.created,
          updated: persistResult.updated,
        },
      });
    }

    debugLog(`[${traceId}] SUCCESS: processed | external_id=${externalId} | phase=${phase}`);
    return ok('processed');
  } catch (err) {
    console.error(`[${traceId}] EXCEPTION: ${String(err)}`);
    const freshAdmin = catchCtx?.admin ?? createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    if (eventId) {
      const { error: updateErr } = await freshAdmin.schema('app').from('integration_webhook_events').update({
        processing_status: 'failed',
        processed_at: new Date().toISOString(),
        runtime_meta: { error: String(err) },
      }).eq('id', eventId);
      if (updateErr) {
        console.error(`[${traceId}] failed to mark event failed: ${updateErr.message}`);
      }
    }
    if (catchCtx) {
      await logWebhookError(freshAdmin, {
        tenantId: catchCtx.tenantId,
        tenantIntegrationId: catchCtx.tenantIntegrationId,
        webhookId: catchCtx.webhookId,
        eventId,
        entityType: catchCtx.entityType,
        externalRef: catchCtx.externalId,
        stage: 'persist',
        reasonCode: err instanceof LockTimeoutError
          ? 'LOCK_TIMEOUT'
          : isTransientPersistError(err) ? 'TRANSIENT_DB_ERROR' : 'EXCEPTION',
        message: String(err),
      });
    }
    if (err instanceof LockTimeoutError) {
      debugLog(`[${traceId}] lock_timeout — returning 503 so Zoho retries`);
      return retryable('lock_timeout');
    }
    if (isTransientPersistError(err)) {
      debugLog(`[${traceId}] transient_db_error — returning 503 so Zoho retries`);
      return retryable('transient_db_error');
    }
    return ok('error');
  }
});
