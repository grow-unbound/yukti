import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import {
  buildIntegrationDataFlowRows,
  buildIntegrationTopologyConfig,
  getIntegrationWebhookDefinitions,
} from '@/lib/integrations/definitions';
import {
  buildZohoWebhookRegistrationName,
  buildZohoWebhookRegistrationPayload,
  buildZohoWorkflowRegistrationPayload,
  deleteZohoWebhookRegistrationsByName,
  fetchZohoSettings,
  pauseForZohoSettingsRateLimit,
} from '@/lib/integrations/zoho-webhooks';
import { supabaseAdmin } from '@/lib/supabase';

interface ZohoSecret {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  org_id?: string;
  organization_id?: string;
  dc?: string;
  region?: string;
  accounts_base_url?: string;
}

function jsonError(status: number, message: string, code = 'ERROR') {
  return NextResponse.json({ data: null, error: { code, message } }, { status });
}

function getZohoAccountsBaseUrl(dc: string) {
  return `https://accounts.zoho.${dc}`;
}

function getFunctionsBaseUrl() {
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
  return `${supabaseUrl}/functions/v1`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractWorkflowIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  const record = toRecord(value);
  return Object.values(record).filter((entry): entry is string => typeof entry === 'string');
}

function resolveDc(config: Record<string, unknown>) {
  const transport = toRecord(config.transport);
  const accountsBaseUrl = typeof transport.accounts_base_url === 'string' ? transport.accounts_base_url : null;
  const match = accountsBaseUrl?.match(/accounts\.zoho\.([a-z.]+)$/i);
  if (match?.[1]) return match[1].toLowerCase();
  const dc = typeof config.region === 'string' ? config.region : typeof config.dc === 'string' ? config.dc : 'in';
  return dc.toLowerCase();
}

async function refreshAccessToken(secret: ZohoSecret, dc: string) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: secret.refresh_token,
    client_id: secret.client_id,
    client_secret: secret.client_secret,
  });

  const response = await fetch(`${getZohoAccountsBaseUrl(dc)}/oauth/v2/token`, {
    method: 'POST',
    body,
  });

  const json = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; message?: string };
  if (!response.ok || !json.access_token) {
    throw new Error(json.error ?? json.message ?? 'Zoho token refresh failed');
  }
  return json.access_token;
}

async function registerZohoWebhook(
  accessToken: string,
  orgId: string,
  dc: string,
  webhookUrl: string,
  integrationTypeId: string,
  entityType: string,
  providerEntity: string,
  secret: string,
  workflowRuleTypes: Array<'add_edit' | 'delete'> = ['add_edit'],
) {
  const module = integrationTypeId === 'zoho_inventory' ? 'inventory/v1' : 'books/v3';
  const url = new URL(`/${module}/settings/webhooks`, `https://www.zohoapis.${dc}`);
  url.searchParams.set('organization_id', orgId);

  const workflowIds: Record<string, string> = {};
  const webhookIds: Record<string, string> = {};
  const createdWorkflowIds: string[] = [];
  const createdWebhookIds: string[] = [];
  try {
    for (const ruleType of workflowRuleTypes) {
      await pauseForZohoSettingsRateLimit();
      const webhookResponse = await fetchZohoSettings(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildZohoWebhookRegistrationPayload({
          webhookUrl,
          entityType,
          providerEntity,
          secret,
          ruleType,
        })),
      });
      const webhookJson = (await webhookResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const remoteWebhook = typeof webhookJson.webhook === 'object' && webhookJson.webhook !== null
        ? webhookJson.webhook as Record<string, unknown>
        : null;
      const webhookId = typeof remoteWebhook?.webhook_id === 'string' ? remoteWebhook.webhook_id : null;
      if (!webhookResponse.ok || webhookJson.code !== 0 || !webhookId) {
        throw new Error(`Zoho ${entityType} ${ruleType} webhook registration failed (${webhookResponse.status}): ${String(webhookJson.message ?? 'Unknown Zoho error')}`);
      }
      webhookIds[ruleType] = webhookId;
      createdWebhookIds.push(webhookId);
      const workflowUrl = new URL(`/${module}/settings/workflows`, `https://www.zohoapis.${dc}`);
      workflowUrl.searchParams.set('organization_id', orgId);
      await pauseForZohoSettingsRateLimit();
      const workflowResponse = await fetchZohoSettings(workflowUrl.toString(), {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildZohoWorkflowRegistrationPayload({
          entityType,
          providerEntity,
          webhookId,
          ruleType,
        })),
      });
      const workflowJson = await workflowResponse.json().catch(() => ({})) as Record<string, unknown>;
      const workflow = workflowJson.workflow as Record<string, unknown> | undefined;
      const workflowId = typeof workflow?.workflow_id === 'string' ? workflow.workflow_id : null;
      if (!workflowResponse.ok || workflowJson.code !== 0 || !workflowId) {
        throw new Error(`Zoho ${entityType} ${ruleType} workflow registration failed (${workflowResponse.status}): ${String(workflowJson.message ?? 'Unknown Zoho error')}`);
      }
      workflowIds[ruleType] = workflowId;
      createdWorkflowIds.push(workflowId);
    }
    return { webhookIds, workflowIds };
  } catch (error) {
    // This entity's webhook (action) succeeded but its paired workflow (rule)
    // didn't — roll back the orphan. Pace + retry these deletes too, since
    // they hit the same Zoho rate limit that likely caused the failure above;
    // firing them in a burst just 429s again and leaves the orphan behind.
    for (const workflowId of createdWorkflowIds) {
      await pauseForZohoSettingsRateLimit();
      const workflowUrl = new URL(`/${module}/settings/workflows/${workflowId}`, `https://www.zohoapis.${dc}`);
      workflowUrl.searchParams.set('organization_id', orgId);
      const res = await fetchZohoSettings(workflowUrl.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      }).catch((cleanupError) => {
        console.error(`[registerZohoWebhook] cleanup: failed to delete orphan workflow ${workflowId}:`, cleanupError);
        return null;
      });
      if (res && !res.ok) {
        console.error(`[registerZohoWebhook] cleanup: delete workflow ${workflowId} returned ${res.status}`);
      }
    }
    for (const webhookId of createdWebhookIds) {
      await pauseForZohoSettingsRateLimit();
      const deleteUrl = new URL(`/${module}/settings/webhooks/${webhookId}`, `https://www.zohoapis.${dc}`);
      deleteUrl.searchParams.set('organization_id', orgId);
      const res = await fetchZohoSettings(deleteUrl.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      }).catch((cleanupError) => {
        console.error(`[registerZohoWebhook] cleanup: failed to delete orphan webhook ${webhookId}:`, cleanupError);
        return null;
      });
      if (res && !res.ok) {
        console.error(`[registerZohoWebhook] cleanup: delete webhook ${webhookId} returned ${res.status}`);
      }
    }
    throw error;
  }
}

async function deleteZohoWebhookRegistration(input: {
  accessToken: string;
  orgId: string;
  dc: string;
  integrationTypeId: string;
  remoteWebhookId?: string | null;
  remoteWebhookIds?: string[];
  workflowIds?: string[];
}) {
  const module = input.integrationTypeId === 'zoho_inventory' ? 'inventory/v1' : 'books/v3';

  for (const workflowId of input.workflowIds ?? []) {
    await pauseForZohoSettingsRateLimit();
    const workflowUrl = new URL(`/${module}/settings/workflows/${workflowId}`, `https://www.zohoapis.${input.dc}`);
    workflowUrl.searchParams.set('organization_id', input.orgId);
    const res = await fetchZohoSettings(workflowUrl.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Zoho-oauthtoken ${input.accessToken}` },
    }).catch((err) => {
      console.error(`[deleteZohoWebhookRegistration] failed to delete prior workflow ${workflowId}:`, err);
      return null;
    });
    if (res && !res.ok) {
      console.error(`[deleteZohoWebhookRegistration] delete prior workflow ${workflowId} returned ${res.status}`);
    }
  }

  const webhookIds = [...new Set([input.remoteWebhookId, ...(input.remoteWebhookIds ?? [])].filter((id): id is string => Boolean(id)))];
  for (const webhookId of webhookIds) {
    await pauseForZohoSettingsRateLimit();
    const webhookUrl = new URL(`/${module}/settings/webhooks/${webhookId}`, `https://www.zohoapis.${input.dc}`);
    webhookUrl.searchParams.set('organization_id', input.orgId);
    const res = await fetchZohoSettings(webhookUrl.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Zoho-oauthtoken ${input.accessToken}` },
    }).catch((err) => {
      console.error(`[deleteZohoWebhookRegistration] failed to delete prior webhook ${webhookId}:`, err);
      return null;
    });
    if (res && !res.ok) {
      console.error(`[deleteZohoWebhookRegistration] delete prior webhook ${webhookId} returned ${res.status}`);
    }
  }
}

function buildWebhookSetupState(input: {
  status: 'pending' | 'active' | 'failed';
  message?: string | null;
  webhookId?: string | null;
}) {
  return {
    status: input.status,
    attempted_at: new Date().toISOString(),
    last_error: input.status === 'failed' ? (input.message ?? 'Zoho webhook registration failed') : null,
    external_ref: input.webhookId ?? null,
    last_success_at: input.status === 'active' ? new Date().toISOString() : null,
  };
}

export async function POST(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) return jsonError(401, 'Login required', 'UNAUTHORIZED');
    if (claims.role !== 'seller_admin') return jsonError(403, 'Admin only', 'FORBIDDEN');

    const body = await request.json().catch(() => null);
    const tenantIntegrationId = typeof body?.tenant_integration_id === 'string' ? body.tenant_integration_id : null;
    if (!tenantIntegrationId) return jsonError(400, 'tenant_integration_id is required', 'BAD_REQUEST');

    const db = supabaseAdmin;
    if (!db) return jsonError(500, 'Server configuration error', 'SERVER_ERROR');

    const { data: integration, error: integrationError } = await db
      .schema('app')
      .from('tenant_integrations')
      .select('id, tenant_id, integration_type_id, config, vault_secret_id, deleted_at')
      .eq('id', tenantIntegrationId)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (integrationError || !integration) {
      return jsonError(404, 'Tenant integration not found', 'NOT_FOUND');
    }

    if (!['zoho_books', 'zoho_inventory'].includes(integration.integration_type_id)) {
      return jsonError(400, 'Only Zoho integrations can retry webhook setup', 'BAD_REQUEST');
    }

    const { data: secretData, error: secretError } = await db
      .schema('app')
      .rpc('get_tenant_integration_runtime_secret', {
        p_tenant_integration_id: integration.id,
        p_expected_integration_type_id: integration.integration_type_id,
      });

    if (secretError) {
      return jsonError(500, secretError.message ?? 'Unable to load integration secret', 'SECRET_FAILED');
    }

    const secret = toRecord(secretData) as unknown as ZohoSecret;
    const orgId = typeof secret.org_id === 'string'
      ? secret.org_id
      : typeof secret.organization_id === 'string'
        ? secret.organization_id
        : typeof (integration.config as Record<string, unknown>).org_id === 'string'
          ? String((integration.config as Record<string, unknown>).org_id)
          : null;

    if (!orgId) {
      return jsonError(400, 'Zoho organization_id is missing from this integration', 'BAD_REQUEST');
    }

    const dc = resolveDc(toRecord(integration.config));
    const accountsBaseUrl = getZohoAccountsBaseUrl(dc);
    const definitions = getIntegrationWebhookDefinitions(
      integration.integration_type_id === 'zoho_inventory' ? 'zoho_inventory' : 'zoho_books',
    );
    const accessToken = await refreshAccessToken(secret, dc);

    // A failed/reconnected row may have no stored remote id even though Zoho
    // still owns an action under the stable Yukti name. Reconcile only broken
    // registrations by name before attempting creates; healthy rows stay live.
    const { data: currentWebhookRows } = await db.schema('app').from('integration_webhooks')
      .select('entity_type, rule_type, status, remote_webhook_id')
      .eq('tenant_integration_id', integration.id)
      .eq('provider', 'zoho')
      .is('deleted_at', null);
    const currentByEntityRule = new Map(
      (currentWebhookRows ?? []).map((row) => [`${row.entity_type}:${row.rule_type}`, row]),
    );
    const namesToClean = definitions.flatMap((definition) => (
      (definition.workflow_rule_types ?? (['add_edit'] as const)).flatMap((ruleType) => {
        const row = currentByEntityRule.get(`${definition.entity_type}:${ruleType}`);
        const healthy = row?.status === 'active' && Boolean(row.remote_webhook_id);
        return healthy
          ? []
          : [buildZohoWebhookRegistrationName({ entityType: definition.entity_type, ruleType })];
      })
    ));
    if (namesToClean.length > 0) {
      await deleteZohoWebhookRegistrationsByName({
        accessToken,
        orgId,
        dc,
        integrationTypeId: integration.integration_type_id,
        webhookNames: namesToClean,
      });
    }

    const setupByEntity: Record<string, ReturnType<typeof buildWebhookSetupState>> = {};
    const webhookIdsByEntity: Record<string, string> = {};

    // One DB row per (entity_type, event_types subset) — mirrors the connect flow.
    for (const definition of definitions) {
      const ruleTypes = definition.workflow_rule_types ?? (['add_edit'] as const);
      let entityHasAnyFailure = false;

      for (const ruleType of ruleTypes) {
        const rowEventTypes = ruleType === 'delete'
          ? definition.event_types.filter((e) => e.endsWith('.deleted'))
          : definition.event_types.filter((e) => !e.endsWith('.deleted'));

        const { data: existingWebhook } = await db.schema('app').from('integration_webhooks')
          .select('id, endpoint_token, secret, remote_webhook_id, status, webhook_config')
          .eq('tenant_integration_id', integration.id)
          .eq('provider', 'zoho')
          .eq('entity_type', definition.entity_type)
          .contains('event_types', rowEventTypes)
          .is('deleted_at', null)
          .maybeSingle();

        let webhook = existingWebhook;
        if (!webhook) {
          const { data, error } = await db.schema('app').from('integration_webhooks').insert({
            tenant_id: integration.tenant_id,
            tenant_integration_id: integration.id,
            provider: 'zoho',
            entity_type: definition.entity_type,
            rule_type: ruleType,
            event_types: rowEventTypes,
            secret: crypto.randomUUID().replace(/-/g, ''),
            status: 'pending',
            is_active: false,
            created_by: claims.sub,
            updated_by: claims.sub,
          }).select('id, endpoint_token, secret, remote_webhook_id, status, webhook_config').single();
          if (error || !data) {
            entityHasAnyFailure = true;
            continue;
          }
          webhook = data;
        }

        if (ruleType === 'add_edit') {
          webhookIdsByEntity[definition.entity_type] = webhook.id;
        }

        if (webhook.status === 'active' && webhook.remote_webhook_id) {
          continue;
        }

        const callbackUrl = `${getFunctionsBaseUrl()}/integrations-webhook/${webhook.endpoint_token}`;
        const workflowIds = extractWorkflowIds(toRecord(webhook.webhook_config).workflow_ids);
        const remoteWebhookIds = extractWorkflowIds(toRecord(webhook.webhook_config).remote_webhook_ids);

        try {
          if (webhook.remote_webhook_id || workflowIds.length > 0 || remoteWebhookIds.length > 0) {
            await deleteZohoWebhookRegistration({
              accessToken,
              orgId,
              dc,
              integrationTypeId: integration.integration_type_id,
              remoteWebhookId: webhook.remote_webhook_id,
              remoteWebhookIds,
              workflowIds,
            });
          }

          const webhookSecret = (webhook.secret ?? crypto.randomUUID()).replace(/-/g, '');
          const registration = await registerZohoWebhook(
            accessToken,
            orgId,
            dc,
            callbackUrl,
            integration.integration_type_id,
            definition.entity_type,
            definition.provider_entity,
            webhookSecret,
            [ruleType],
          );
          const remoteWebhookId = registration.webhookIds[ruleType] ?? Object.values(registration.webhookIds)[0] ?? null;
          console.info('[zoho/webhooks/retry] webhook registered', {
            entity_type: definition.entity_type,
            rule_type: ruleType,
            event_types: rowEventTypes,
            webhook_id: remoteWebhookId,
          });

          if (!remoteWebhookId) entityHasAnyFailure = true;

          await db.schema('app').from('integration_webhooks').update({
            event_types: rowEventTypes,
            remote_webhook_id: remoteWebhookId,
            external_ref: remoteWebhookId,
            status: remoteWebhookId ? 'active' : 'failed',
            is_active: Boolean(remoteWebhookId),
            webhook_config: {
              sync_phase: definition.sync_phase,
              integration_type_id: integration.integration_type_id ?? 'zoho_books',
              workflow_ids: registration.workflowIds,
              remote_webhook_ids: registration.webhookIds,
              last_error: null,
            },
            secret: webhookSecret,
            last_verified_at: remoteWebhookId ? new Date().toISOString() : null,
            updated_by: claims.sub,
          }).eq('id', webhook.id);
        } catch (error) {
          entityHasAnyFailure = true;
          const message = error instanceof Error ? error.message : String(error);
          await db.schema('app').from('integration_webhooks').update({
            remote_webhook_id: null,
            external_ref: null,
            status: 'failed',
            is_active: false,
            last_verified_at: null,
            webhook_config: {
              ...toRecord(webhook.webhook_config),
              last_error: message,
              last_attempted_at: new Date().toISOString(),
            },
            updated_by: claims.sub,
          }).eq('id', webhook.id);
        }
      }

      setupByEntity[definition.entity_type] = buildWebhookSetupState({
        status: entityHasAnyFailure ? 'failed' : 'active',
        message: entityHasAnyFailure ? `One or more ${definition.entity_type} webhook registrations failed` : undefined,
      });
    }

    const flowRows = buildIntegrationDataFlowRows({
      tenant_id: integration.tenant_id,
      tenant_integration_id: integration.id,
      integration_type_id: integration.integration_type_id === 'zoho_inventory' ? 'zoho_inventory' : 'zoho_books',
      webhook_ids_by_entity: webhookIdsByEntity,
      created_by: claims.sub,
      updated_by: claims.sub,
    });
    await db.schema('app').from('integration_data_flows').upsert(flowRows, {
      onConflict: 'tenant_id,tenant_integration_id,entity_type',
    });

    const topologyConfig = buildIntegrationTopologyConfig(
      integration.integration_type_id === 'zoho_inventory' ? 'zoho_inventory' : 'zoho_books',
    );
    const nextConfig = {
      ...(toRecord(integration.config)),
      ...topologyConfig,
      webhook_setup_by_entity: setupByEntity,
      webhook_setup: buildWebhookSetupState({
        status: Object.values(setupByEntity).every((state) => state.status === 'active') ? 'active' : 'failed',
        message: 'One or more Zoho entity webhook registrations need attention.',
      }),
    };

    await db
      .schema('app')
      .from('tenant_integrations')
      .update({
        config: nextConfig,
        updated_by: claims.sub,
      })
      .eq('id', integration.id);

    const allActive = Object.values(setupByEntity).every((state) => state.status === 'active');

    return NextResponse.json({
      data: {
        ok: true,
        tenant_integration_id: integration.id,
        webhook_setup: {
          status: allActive ? 'active' : 'failed',
          message: allActive
            ? 'Zoho webhooks are active.'
            : 'Zoho webhooks could not be registered right now. Sync can continue, and you can retry later.',
          accounts_base_url: accountsBaseUrl,
        },
      },
      error: null,
    });
  } catch (error) {
    console.error('[POST /api/settings/integrations/zoho/webhooks/retry]', error);
    return jsonError(400, error instanceof Error ? error.message : 'Failed to retry webhook setup', 'RETRY_FAILED');
  }
}
