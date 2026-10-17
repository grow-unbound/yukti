import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { getFlag, FLAGS } from '@/lib/flags';
import { loadIntegrationsSettingsPayload } from '@/lib/integrations/server';
import { subscribeWabaToApp, WHATSAPP_GRAPH_API_VERSION as GRAPH_API_VERSION } from '@/lib/integrations/whatsapp-graph';
import { supabaseAdmin } from '@/lib/supabase';

function jsonError(status: number, message: string, code = 'ERROR') {
  return NextResponse.json({ data: null, error: { code, message } }, { status });
}

async function exchangeCodeForAccessToken(code: string): Promise<{ access_token?: string; error?: { message?: string } }> {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? '',
    client_secret: process.env.WHATSAPP_APP_SECRET ?? '',
    code,
  });
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?${params.toString()}`);
  return response.json();
}

async function registerPhoneNumber(phoneNumberId: string, accessToken: string, pin: string): Promise<{ success?: boolean; error?: { message?: string } }> {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });
  return response.json();
}

async function fetchDisplayPhoneNumber(phoneNumberId: string, accessToken: string): Promise<string | null> {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=display_phone_number`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const json = (await response.json().catch(() => ({}))) as { display_phone_number?: string };
  return json.display_phone_number ?? null;
}

export async function POST(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) return jsonError(401, 'Login required', 'UNAUTHORIZED');
    if (claims.role !== 'seller_admin') return jsonError(403, 'Admin only', 'FORBIDDEN');
    if (!(await getFlag(FLAGS.WHATSAPP_INTEGRATION, claims.tenant_id))) {
      return jsonError(403, 'WhatsApp integration is not enabled for this tenant', 'FEATURE_OFF');
    }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appId || !appSecret) return jsonError(500, 'WhatsApp Embedded Signup is not configured on this server', 'NOT_CONFIGURED');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof body?.code === 'string' ? body.code : null;
    const wabaId = typeof body?.waba_id === 'string' ? body.waba_id : null;
    const phoneNumberId = typeof body?.phone_number_id === 'string' ? body.phone_number_id : null;
    const businessId = typeof body?.business_id === 'string' ? body.business_id : null;
    const pin = typeof body?.pin === 'string' ? body.pin : null;

    if (!code || !wabaId || !phoneNumberId || !pin) {
      return jsonError(400, 'code, waba_id, phone_number_id, and pin are required', 'BAD_REQUEST');
    }
    if (!/^\d{6}$/.test(pin)) {
      return jsonError(400, 'pin must be a 6-digit number', 'BAD_REQUEST');
    }

    const db = supabaseAdmin;
    if (!db) return jsonError(500, 'Server configuration error', 'SERVER_ERROR');

    const tokenResponse = await exchangeCodeForAccessToken(code);
    if (!tokenResponse.access_token) {
      console.error('[whatsapp/oauth/callback] Token exchange failed:', tokenResponse.error);
      return jsonError(502, tokenResponse.error?.message ?? 'Failed to exchange authorization code with Meta', 'TOKEN_EXCHANGE_FAILED');
    }
    const accessToken = tokenResponse.access_token;

    const registerResponse = await registerPhoneNumber(phoneNumberId, accessToken, pin);
    if (!registerResponse.success) {
      console.error('[whatsapp/oauth/callback] Phone registration failed:', registerResponse.error);
      return jsonError(502, registerResponse.error?.message ?? 'Failed to register the phone number on Meta Cloud API', 'REGISTRATION_FAILED');
    }

    // Without a WABA -> app subscription Meta never delivers inbound messages or
    // statuses for this number, so do not mark the integration connected.
    const subscribeResult = await subscribeWabaToApp(wabaId, accessToken);
    if (!subscribeResult.ok) {
      console.error('[whatsapp/oauth/callback] WABA webhook subscription failed:', subscribeResult.message);
      return jsonError(502, subscribeResult.message, 'WEBHOOK_SUBSCRIBE_FAILED');
    }

    const displayPhoneNumber = await fetchDisplayPhoneNumber(phoneNumberId, accessToken);

    const now = new Date().toISOString();
    const { data: existing } = await db
      .schema('app')
      .from('tenant_integrations')
      .select('id, created_by')
      .eq('tenant_id', claims.tenant_id)
      .eq('integration_type_id', 'whatsapp_business')
      .maybeSingle();

    const { data: integrationRow, error: integrationError } = await db
      .schema('app')
      .from('tenant_integrations')
      .upsert(
        {
          id: existing?.id ?? undefined,
          tenant_id: claims.tenant_id,
          integration_type_id: 'whatsapp_business',
          status: 'connected',
          config: {
            provider: 'meta',
            auth_method: 'embedded_signup',
            waba_id: wabaId,
            phone_number_id: phoneNumberId,
            business_id: businessId,
            display_phone_number: displayPhoneNumber,
            webhook_subscribed_at: now,
          },
          connected_at: now,
          connected_by: claims.sub,
          last_health_check_at: now,
          health_status: 'ok',
          created_by: existing?.created_by ?? claims.sub,
          updated_by: claims.sub,
          deleted_at: null,
        },
        { onConflict: 'tenant_id,integration_type_id' },
      )
      .select('id')
      .single();

    if (integrationError?.code === '23505') {
      return jsonError(409, 'This WhatsApp number is already connected to another account', 'PHONE_ALREADY_CONNECTED');
    }
    if (integrationError || !integrationRow) {
      console.error('[whatsapp/oauth/callback] Failed to upsert tenant_integration:', integrationError);
      return jsonError(500, 'Failed to save the integration', 'SAVE_FAILED');
    }

    const { error: secretError } = await db.schema('app').rpc('upsert_tenant_integration_secret', {
      p_tenant_integration_id: integrationRow.id,
      p_actor_user_id: claims.sub,
      p_secret: {
        access_token: accessToken,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        business_id: businessId,
      },
      p_secret_name: `whatsapp_business_${claims.tenant_id}`,
    });

    if (secretError) {
      console.error('[whatsapp/oauth/callback] Failed to store secret:', secretError);
      return jsonError(500, 'Failed to securely store credentials', 'SECRET_STORE_FAILED');
    }

    await db.schema('app').from('audit_log').insert({
      tenant_id: claims.tenant_id,
      actor_user_id: claims.sub,
      entity_type: 'tenant_integration',
      entity_id: integrationRow.id,
      action: 'connect',
      diff: { integration_type_id: 'whatsapp_business', phone_number_id: phoneNumberId, waba_id: wabaId },
      ts: now,
    });

    const payload = await loadIntegrationsSettingsPayload(claims.tenant_id);
    return NextResponse.json({ data: payload, error: null }, { status: 200 });
  } catch (error) {
    console.error('[POST /api/settings/integrations/whatsapp/oauth/callback]', error);
    return jsonError(500, error instanceof Error ? error.message : 'Failed to connect WhatsApp', 'SERVER_ERROR');
  }
}
