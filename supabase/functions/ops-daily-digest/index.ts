/**
 * ops-daily-digest — posts the previous IST day's canonical business activity,
 * digital usage, operational health and explicit alerts to Slack.
 *
 * Invoked by pg_cron after app.compute_ops_daily_rollup. Delivery is
 * idempotent per day; a second scheduled invocation provides a bounded retry.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  buildDigestMessage,
  type DigestFlagRow,
  type DigestRollupRow,
  type DigestTenant,
} from '../_shared/ops-daily-digest.ts';

const FN = '[ops-daily-digest]';

const ROLLUP_FIELDS = [
  'tenant_id',
  'estimates_enabled', 'orders_enabled', 'invoices_enabled', 'primary_demand_kind',
  'estimate_count', 'estimate_value', 'estimate_buyer_count', 'estimate_void_count',
  'order_count', 'order_value', 'order_buyer_count', 'order_cancelled_count',
  'invoice_count', 'invoice_value', 'invoice_buyer_count', 'invoice_excluded_count',
  'app_estimate_count', 'app_estimate_value', 'app_estimate_buyer_count',
  'app_order_count', 'app_order_value', 'app_order_buyer_count',
  'app_invoice_count', 'app_invoice_value', 'app_invoice_buyer_count',
  'app_user_count', 'app_demand_buyer_count', 'repeat_app_demand_buyer_count',
  'first_time_app_user_count', 'new_customer_record_count',
  'webhook_event_count', 'webhook_failed_event_count', 'webhook_error_count',
  'webhook_retryable_error_count', 'webhook_error_critical_count',
  'sync_job_success_count', 'sync_job_failure_count', 'stale_integration_count',
  'post_sync_rebuild_failure_count', 'active_tenant_count', 'computed_at', 'calculation_version',
].join(',');

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Missing required env var: SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_KEY');
  if (!key) throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function verifyPushSecret(req: Request): boolean {
  const secret = Deno.env.get('INTEGRATIONS_PUSH_SECRET')?.trim()
    ?? Deno.env.get('INTEGRATIONS_DISPATCH_SECRET')?.trim();
  if (!secret) return false;
  const provided = req.headers.get('x-push-secret')?.trim() ?? '';
  if (provided.length !== secret.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(secret);
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function yesterdayIst(): string {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  nowIst.setUTCDate(nowIst.getUTCDate() - 1);
  return nowIst.toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
  if (!verifyPushSecret(req)) return jsonResponse(401, { ok: false, error: 'unauthorized' });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // An empty body uses the previous IST day.
  }
  const requestedDay = (body as { day?: unknown } | null)?.day;
  const day = typeof requestedDay === 'string' ? requestedDay : yesterdayIst();
  if (!isIsoDate(day)) return jsonResponse(400, { ok: false, error: 'invalid_day' });

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    console.error(`${FN} configuration failed:`, error instanceof Error ? error.message : String(error));
    return jsonResponse(500, { ok: false, error: 'function_configuration_failed' });
  }

  const { data: existingDelivery, error: deliveryLookupError } = await admin
    .schema('app')
    .from('ops_daily_digest_deliveries')
    .select('status, attempt_count')
    .eq('day', day)
    .maybeSingle<{ status: string; attempt_count: number }>();

  if (deliveryLookupError) {
    console.error(`${FN} delivery lookup failed:`, deliveryLookupError.message);
    return jsonResponse(503, { ok: false, error: 'delivery_lookup_failed' });
  }
  if (existingDelivery?.status === 'sent') {
    return jsonResponse(200, { ok: true, day, skipped: 'already_sent' });
  }

  const attemptCount = (existingDelivery?.attempt_count ?? 0) + 1;
  const { error: attemptError } = await admin.schema('app').from('ops_daily_digest_deliveries').upsert({
    day,
    status: 'attempting',
    attempt_count: attemptCount,
    last_attempt_at: new Date().toISOString(),
    response_status: null,
    error_category: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'day' });
  if (attemptError) {
    console.error(`${FN} failed to record attempt:`, attemptError.message);
    return jsonResponse(503, { ok: false, error: 'delivery_attempt_write_failed' });
  }

  async function fail(
    status: number,
    category: string,
    detail?: string,
    responseStatus?: number,
  ): Promise<Response> {
    const safeDetail = detail?.slice(0, 500) ?? null;
    const { error } = await admin.schema('app').from('ops_daily_digest_deliveries').update({
      status: 'failed',
      response_status: responseStatus ?? null,
      error_category: category,
      error_message: safeDetail,
      updated_at: new Date().toISOString(),
    }).eq('day', day);
    if (error) console.error(`${FN} failed to record ${category}:`, error.message);
    return jsonResponse(status, { ok: false, error: category });
  }

  const { data: webhookUrl, error: webhookUrlError } = await admin
    .schema('app')
    .rpc('get_ops_slack_webhook_url');
  if (webhookUrlError) {
    console.error(`${FN} Slack webhook lookup failed:`, webhookUrlError.message);
    return await fail(503, 'webhook_url_lookup_failed', webhookUrlError.message);
  }
  if (!webhookUrl) {
    console.error(`${FN} Slack webhook URL is not configured`);
    return await fail(503, 'no_webhook_configured');
  }

  const [globalResult, tenantRowsResult, flagsResult, tenantsResult] = await Promise.all([
    admin.schema('app').from('ops_daily_rollup').select(ROLLUP_FIELDS).eq('day', day).is('tenant_id', null).maybeSingle<DigestRollupRow>(),
    admin.schema('app').from('ops_daily_rollup').select(ROLLUP_FIELDS).eq('day', day).not('tenant_id', 'is', null),
    admin.schema('app').from('ops_daily_flags').select('tenant_id,metric,severity,current_value,baseline_value,delta_pct,message').eq('day', day),
    admin.schema('app').from('tenants').select('id,business_name').is('deleted_at', null),
  ]);

  const queryError = globalResult.error ?? tenantRowsResult.error ?? flagsResult.error ?? tenantsResult.error;
  if (queryError) {
    console.error(`${FN} digest query failed:`, queryError.message);
    return await fail(503, 'query_failed', queryError.message);
  }
  if (!globalResult.data) {
    console.error(`${FN} no rollup found for ${day}`);
    return await fail(503, 'no_rollup_for_day');
  }

  const globalRow = globalResult.data as DigestRollupRow;
  const computedAgeMs = Date.now() - Date.parse(globalRow.computed_at);
  if (!Number.isFinite(computedAgeMs) || computedAgeMs > 24 * 60 * 60 * 1000) {
    console.error(`${FN} stale rollup for ${day}:`, globalRow.computed_at);
    return await fail(503, 'stale_rollup', globalRow.computed_at);
  }

  const payload = buildDigestMessage({
    day,
    globalRow,
    tenantRows: (tenantRowsResult.data ?? []) as DigestRollupRow[],
    flags: (flagsResult.data ?? []) as DigestFlagRow[],
    tenants: (tenantsResult.data ?? []) as DigestTenant[],
  });

  const slackResponse = await fetch(webhookUrl as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!slackResponse.ok) {
    const responseBody = await slackResponse.text().catch(() => '');
    console.error(`${FN} Slack post failed ${slackResponse.status}: ${responseBody.slice(0, 300)}`);
    return await fail(502, 'slack_post_failed', responseBody, slackResponse.status);
  }

  const { error: sentError } = await admin.schema('app').from('ops_daily_digest_deliveries').update({
    status: 'sent',
    rollup_computed_at: globalRow.computed_at,
    response_status: slackResponse.status,
    sent_at: new Date().toISOString(),
    error_category: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq('day', day);
  if (sentError) {
    console.error(`${FN} Slack posted but delivery state update failed:`, sentError.message);
    return jsonResponse(500, { ok: false, error: 'sent_state_write_failed' });
  }

  console.log(`${FN} posted digest for ${day} (${payload.blocks.length} blocks, attempt ${attemptCount})`);
  return jsonResponse(200, { ok: true, day, attempt: attemptCount });
});
