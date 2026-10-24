import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getVerifiedClaims } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { canAccessDocumentLocation } from '@/lib/server/seller-location-access';
import { loadEnquiryAlternates } from '@/lib/server/load-enquiry-triage';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ lineId: z.string().uuid() });

/**
 * GET /api/tenant/entries/[id]/enquiry/alternates?lineId=<estimate_items.id>
 *
 * In-stock substitutes (with pool velocity and what this buyer would pay) for ONE short line of a
 * `new_enquiry` entry. Loaded only when the seller opens that line's alternates. Auth mirrors
 * entries/[id]/enquiry.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const parsedParams = ParamsSchema.safeParse(await params);
    const parsedQuery = QuerySchema.safeParse({ lineId: request.nextUrl.searchParams.get('lineId') });
    if (!parsedParams.success || !parsedQuery.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!claims.role?.startsWith('seller_')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });

    const db = supabaseAdmin as any;
    const { data: entry, error } = await db
      .schema('app')
      .from('entries')
      .select('id, tenant_id, location_id, entry_type, source_entity_type, source_entity_id')
      .eq('id', parsedParams.data.id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    if (entry.tenant_id !== claims.tenant_id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (entry.location_id && !canAccessDocumentLocation(claims, entry.location_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (entry.entry_type !== 'new_enquiry' || entry.source_entity_type !== 'estimate' || !entry.source_entity_id) {
      return NextResponse.json({ error: 'Not an enquiry entry' }, { status: 404 });
    }

    const payload = await loadEnquiryAlternates(db, claims.tenant_id, entry.source_entity_id, parsedQuery.data.lineId);
    if (!payload) return NextResponse.json({ error: 'Line not found' }, { status: 404 });
    return NextResponse.json(payload);
  } catch (err) {
    console.error('[GET /api/tenant/entries/[id]/enquiry/alternates]', err);
    return NextResponse.json({ error: 'Failed to load alternates' }, { status: 500 });
  }
}
