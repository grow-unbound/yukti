import { NextResponse, type NextRequest } from 'next/server';

import { FEATURE_FLAGS } from '@/constants';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { canAccessDocumentLocation } from '@/lib/server/seller-location-access';
import { supabaseAdmin } from '@/lib/supabase';

export interface EmailEntryAccess {
  tenantId: string;
  userId: string;
  entryId: string;
  threadId: string;
  senderAddress: string;
  /** Thread ambiguity candidates (exact-email / GSTIN / domain suggestions). */
  ambiguityMetadata: Record<string, unknown>;
}

/**
 * Seller role + tenant flag + tenant-owned entry/thread + location visibility
 * for routes that act on an email Today entry. Returns a ready error response
 * on failure. Mirrors authorizeWhatsAppEntry.
 */
export async function authorizeEmailEntry(
  request: NextRequest,
  entryId: string,
): Promise<{ access: EmailEntryAccess; error?: undefined } | { access?: undefined; error: NextResponse }> {
  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id || !claims.sub) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!claims.role?.startsWith('seller_')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  if (!(await getFlag(FEATURE_FLAGS.EMAIL_INBOX, claims.tenant_id))) {
    return { error: NextResponse.json({ error: 'Email inbox is not enabled' }, { status: 403 }) };
  }
  if (!supabaseAdmin) {
    return { error: NextResponse.json({ error: 'Server configuration error' }, { status: 500 }) };
  }
  const db = supabaseAdmin as any;

  const { data: entry } = await db
    .schema('app')
    .from('entries')
    .select('id, location_id, source_entity_id')
    .eq('id', entryId)
    .eq('tenant_id', claims.tenant_id)
    .eq('entry_type', 'email_buyer_message')
    .eq('source_entity_type', 'email_thread')
    .is('deleted_at', null)
    .maybeSingle();
  if (!entry) return { error: NextResponse.json({ error: 'Entry not found' }, { status: 404 }) };
  if (entry.location_id && !canAccessDocumentLocation(claims, entry.location_id)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const { data: thread } = await db
    .schema('app')
    .from('email_threads')
    .select('id, sender_address, ambiguity_metadata')
    .eq('id', entry.source_entity_id)
    .eq('tenant_id', claims.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!thread) return { error: NextResponse.json({ error: 'Email thread not found' }, { status: 404 }) };

  return {
    access: {
      tenantId: claims.tenant_id,
      userId: claims.sub,
      entryId: entry.id as string,
      threadId: thread.id as string,
      senderAddress: thread.sender_address as string,
      ambiguityMetadata: (thread.ambiguity_metadata as Record<string, unknown> | null) ?? {},
    },
  };
}
