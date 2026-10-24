import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { FEATURE_FLAGS } from '@/constants';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

async function authorize(request: NextRequest) {
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id || !claims.sub) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (claims.role !== 'seller_admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  if (!(await getFlag(FEATURE_FLAGS.EMAIL_INBOX, claims.tenant_id))) {
    return { error: NextResponse.json({ error: 'Email inbox is not enabled' }, { status: 403 }) };
  }
  if (!supabaseAdmin) return { error: NextResponse.json({ error: 'Server configuration error' }, { status: 500 }) };
  return { tenantId: claims.tenant_id, userId: claims.sub };
}

/** Connection status. The alias itself is never returned again after creation. */
export async function GET(request: NextRequest) {
  try {
    const auth = await authorize(request);
    if ('error' in auth) return auth.error;
    const db = supabaseAdmin as any;

    const { data: integration } = await db
      .schema('app')
      .from('tenant_integrations')
      .select('status, config, connected_at')
      .eq('tenant_id', auth.tenantId)
      .eq('integration_type_id', 'email_forwarding')
      .is('deleted_at', null)
      .maybeSingle();

    const { data: last } = await db
      .schema('app')
      .from('email_messages')
      .select('received_at')
      .eq('tenant_id', auth.tenantId)
      .is('deleted_at', null)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({
      data: {
        configured: Boolean(integration?.config?.alias_token_hash),
        domain: process.env.EMAIL_INBOUND_DOMAIN ?? null,
        rotated_at: integration?.config?.rotated_at ?? null,
        last_received_at: last?.received_at ?? null,
      },
    });
  } catch (error) {
    console.error('[GET /api/tenant/integrations/email-forwarding]', error);
    return NextResponse.json({ error: 'Failed to load email forwarding status' }, { status: 500 });
  }
}

/** Creates or rotates the forwarding address. The plaintext address is returned exactly once. */
export async function POST(request: NextRequest) {
  try {
    const auth = await authorize(request);
    if ('error' in auth) return auth.error;
    const domain = process.env.EMAIL_INBOUND_DOMAIN?.trim().toLowerCase();
    if (!domain) return NextResponse.json({ error: 'Email domain is not configured' }, { status: 503 });

    const token = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const { error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('set_email_forwarding_alias', {
        p_tenant_id: auth.tenantId,
        p_actor_user_id: auth.userId,
        p_alias_token_hash: hash,
      });
    if (error) {
      if (error.message?.includes('actor_not_allowed')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      console.error('[POST email-forwarding] rpc failed', error);
      return NextResponse.json({ error: 'Failed to create forwarding address' }, { status: 500 });
    }
    return NextResponse.json({ data: { address: `${token}@${domain}` } });
  } catch (error) {
    console.error('[POST /api/tenant/integrations/email-forwarding]', error);
    return NextResponse.json({ error: 'Failed to create forwarding address' }, { status: 500 });
  }
}
