import { NextRequest, NextResponse } from 'next/server';

import { FEATURE_FLAGS } from '@/constants';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { supabaseAdmin } from '@/lib/supabase';
import { getSellerLocationScope } from '@/lib/server/seller-location-access';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const locationScope = getSellerLocationScope(claims);
    if (locationScope.mode === 'none') {
      return NextResponse.json({ count: 0 }, { headers: SELLER_CACHE_PERSONAL });
    }

    const { data, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('list_entries', {
        p_tenant_id: claims.tenant_id,
        p_location_ids: locationScope.mode === 'subset' ? locationScope.locationIds : null,
        p_status_scope: 'active',
        p_entry_types: null,
        p_search: null,
        p_limit: 100,
        p_cursor_priority_at: null,
        p_cursor_id: null,
        p_actor_user_id: claims.sub,
      });

    if (error) {
      console.error('[GET /api/tenant/entries/count]', error);
      return NextResponse.json({ error: 'Failed to load count' }, { status: 500 });
    }

    const [whatsappInboxEnabled, emailInboxEnabled] = await Promise.all([
      getFlag(FEATURE_FLAGS.WHATSAPP_INBOX, claims.tenant_id),
      getFlag(FEATURE_FLAGS.EMAIL_INBOX, claims.tenant_id),
    ]);
    const rows = ((data ?? []) as Array<{ entry_type?: string }>)
      .filter((row) => whatsappInboxEnabled || row.entry_type !== 'whatsapp_buyer_message')
      .filter((row) => emailInboxEnabled || row.entry_type !== 'email_buyer_message');
    return NextResponse.json({ count: rows.length }, { headers: SELLER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/tenant/entries/count]', error);
    return NextResponse.json({ error: 'Failed to load count' }, { status: 500 });
  }
}
