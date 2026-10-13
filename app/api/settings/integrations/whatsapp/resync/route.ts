import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { getFlag, FLAGS } from '@/lib/flags';
import { loadIntegrationsSettingsPayload } from '@/lib/integrations/server';
import { subscribeWabaToApp } from '@/lib/integrations/whatsapp-graph';
import { supabaseAdmin } from '@/lib/supabase';

function jsonError(status: number, message: string, code = 'ERROR') {
  return NextResponse.json({ data: null, error: { code, message } }, { status });
}

/**
 * Re-subscribes the tenant's connected WABA to the app so inbound messages are
 * delivered. Repairs tenants connected before the callback subscribed at connect
 * time. Uses the stored vault token; never accepts a token from the client.
 */
export async function POST(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) return jsonError(401, 'Login required', 'UNAUTHORIZED');
    if (claims.role !== 'seller_admin') return jsonError(403, 'Admin only', 'FORBIDDEN');
    if (!(await getFlag(FLAGS.WHATSAPP_INTEGRATION, claims.tenant_id))) {
      return jsonError(403, 'WhatsApp integration is not enabled for this tenant', 'FEATURE_OFF');
    }

    const db = supabaseAdmin;
    if (!db) return jsonError(500, 'Server configuration error', 'SERVER_ERROR');

    const { data: integration, error: integrationError } = await db
      .schema('app')
      .from('tenant_integrations')
      .select('id, config')
      .eq('tenant_id', claims.tenant_id)
      .eq('integration_type_id', 'whatsapp_business')
      .eq('status', 'connected')
      .is('deleted_at', null)
      .maybeSingle();
    if (integrationError) return jsonError(500, 'Failed to load the integration', 'SERVER_ERROR');
    if (!integration) return jsonError(404, 'WhatsApp is not connected', 'NOT_CONNECTED');

    const { data: secret, error: secretError } = await db
      .schema('app')
      .rpc('get_tenant_integration_runtime_secret', {
        p_tenant_integration_id: integration.id,
        p_expected_integration_type_id: 'whatsapp_business',
      });
    const stored = (secret ?? null) as { access_token?: string; waba_id?: string } | null;
    if (secretError || !stored?.access_token || !stored.waba_id) {
      return jsonError(409, 'Stored WhatsApp credentials are missing. Reconnect WhatsApp.', 'CREDENTIALS_MISSING');
    }

    const result = await subscribeWabaToApp(stored.waba_id, stored.access_token);
    if (!result.ok) {
      console.error('[whatsapp/resync] WABA webhook subscription failed:', result.message);
      return jsonError(502, result.message, 'WEBHOOK_SUBSCRIBE_FAILED');
    }

    const now = new Date().toISOString();
    const config = { ...((integration.config as Record<string, unknown> | null) ?? {}), webhook_subscribed_at: now };
    const { error: updateError } = await db
      .schema('app')
      .from('tenant_integrations')
      .update({ config, updated_by: claims.sub })
      .eq('id', integration.id)
      .eq('tenant_id', claims.tenant_id);
    if (updateError) return jsonError(500, 'Failed to save the subscription state', 'SAVE_FAILED');

    await db.schema('app').from('audit_log').insert({
      tenant_id: claims.tenant_id,
      actor_user_id: claims.sub,
      entity_type: 'tenant_integration',
      entity_id: integration.id,
      action: 'whatsapp_webhook_resubscribe',
      diff: { waba_id: stored.waba_id },
      ts: now,
    });

    const payload = await loadIntegrationsSettingsPayload(claims.tenant_id);
    return NextResponse.json({ data: payload, error: null }, { status: 200 });
  } catch (error) {
    console.error('[POST /api/settings/integrations/whatsapp/resync]', error);
    return jsonError(500, 'Failed to re-sync WhatsApp', 'SERVER_ERROR');
  }
}
