import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getVerifiedClaims } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { canAccessDocumentLocation } from '@/lib/server/seller-location-access';
import { loadEnquirySummaries } from '@/lib/server/load-enquiry-triage';

export const dynamic = 'force-dynamic';

const MAX_IDS = 50;
const QuerySchema = z.object({
  ids: z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(MAX_IDS)),
});

/**
 * GET /api/tenant/entries/enquiry-summary?ids=<entryId>,<entryId>
 *
 * Inbox list-row summaries (estimate number, total, line count, first item, stock-gap flag) for
 * many `new_enquiry` entries in one round trip. No velocity, pricing or alternates -- those live
 * on the detail and alternates endpoints. Same auth as entries/[id]/enquiry; entries the caller
 * cannot see are silently omitted.
 */
export async function GET(request: NextRequest) {
  try {
    const parsed = QuerySchema.safeParse({ ids: request.nextUrl.searchParams.get('ids') ?? '' });
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!claims.role?.startsWith('seller_')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

    const db = supabaseAdmin as any;
    const { data, error } = await db
      .schema('app')
      .from('entries')
      .select('id, location_id, source_entity_id')
      .in('id', parsed.data.ids)
      .eq('tenant_id', claims.tenant_id)
      .eq('entry_type', 'new_enquiry')
      .eq('source_entity_type', 'estimate')
      .is('deleted_at', null)
      .limit(MAX_IDS);
    if (error) throw error;

    const allowed = ((data ?? []) as Array<{ id: string; location_id: string | null; source_entity_id: string | null }>)
      .filter((e) => e.source_entity_id && (!e.location_id || canAccessDocumentLocation(claims, e.location_id)))
      .map((e) => ({ entryId: e.id, estimateId: e.source_entity_id as string }));

    const summaries = await loadEnquirySummaries(db, claims.tenant_id, allowed);
    return NextResponse.json({ summaries });
  } catch (err) {
    console.error('[GET /api/tenant/entries/enquiry-summary]', err);
    return NextResponse.json({ error: 'Failed to load enquiry summaries' }, { status: 500 });
  }
}
