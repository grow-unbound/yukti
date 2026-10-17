import { NextResponse, type NextRequest } from 'next/server';

import { FEATURE_FLAGS } from '@/constants';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { canAccessDocumentLocation } from '@/lib/server/seller-location-access';
import { supabaseAdmin } from '@/lib/supabase';

export interface WhatsAppEntryThreadContext {
  tenantId: string;
  userId: string;
  entryId: string;
  threadId: string;
}

/**
 * Shared authorization for seller routes that act on a WhatsApp Today entry:
 * seller role, tenant flag, entry/thread belong to the caller's tenant, and
 * the entry's location is visible to the caller. Returns a ready-made error
 * response on any failure so routes stay linear.
 */
export async function authorizeWhatsAppEntryThread(
  request: NextRequest,
  entryId: string,
): Promise<{ ctx: WhatsAppEntryThreadContext; error?: undefined } | { ctx?: undefined; error: NextResponse }> {
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id || !claims.sub) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!claims.role?.startsWith('seller_')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  if (!(await getFlag(FEATURE_FLAGS.WHATSAPP_INBOX, claims.tenant_id))) {
    return { error: NextResponse.json({ error: 'WhatsApp inbox is not enabled' }, { status: 403 }) };
  }
  if (!supabaseAdmin) {
    return { error: NextResponse.json({ error: 'Server configuration error' }, { status: 500 }) };
  }

  const { data: entry, error: entryError } = await (supabaseAdmin as any)
    .schema('app')
    .from('entries')
    .select('id, location_id, source_entity_id')
    .eq('id', entryId)
    .eq('tenant_id', claims.tenant_id)
    .eq('entry_type', 'whatsapp_buyer_message')
    .eq('source_entity_type', 'whatsapp_thread')
    .is('deleted_at', null)
    .maybeSingle();
  if (entryError || !entry) {
    return { error: NextResponse.json({ error: 'Entry not found' }, { status: 404 }) };
  }
  if (entry.location_id && !canAccessDocumentLocation(claims, entry.location_id)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return {
    ctx: {
      tenantId: claims.tenant_id,
      userId: claims.sub,
      entryId: entry.id as string,
      threadId: entry.source_entity_id as string,
    },
  };
}
