import { NextRequest, NextResponse } from 'next/server';

import { authorizeEmailEntry } from '@/lib/server/email-entry-access';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const RESULT_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;

/** Strips characters that act as LIKE wildcards or break the PostgREST `or` filter. */
function sanitizeSearch(raw: string): string {
  return raw.replace(/[%_,()\\*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

interface AmbiguousCandidate {
  buyer_id?: string;
  business_name?: string;
}

/**
 * Buyers a seller can link an email thread to: the candidates the inbound flow
 * found (ambiguous senders) plus a bounded name/email/phone search.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await authorizeEmailEntry(request, id);
    if (auth.error) return auth.error;
    const { tenantId, ambiguityMetadata } = auth.access;

    const rawCandidates = Array.isArray(ambiguityMetadata.candidates)
      ? (ambiguityMetadata.candidates as AmbiguousCandidate[])
      : [];
    const ambiguous = rawCandidates
      .filter((c): c is Required<Pick<AmbiguousCandidate, 'buyer_id'>> & AmbiguousCandidate => Boolean(c?.buyer_id))
      .map((c) => ({ buyer_id: c.buyer_id, business_name: c.business_name ?? 'Buyer', role: null }));

    const q = sanitizeSearch(request.nextUrl.searchParams.get('q') ?? '');
    let results: Array<{ id: string; business_name: string; contact_name: string | null; phone: string | null }> = [];
    if (q.length >= MIN_QUERY_LENGTH) {
      const { data, error } = await (supabaseAdmin as any)
        .schema('app')
        .from('buyers')
        .select('id, business_name, contact_name, phone')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .or(`business_name.ilike.%${q}%,contact_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`)
        .order('business_name', { ascending: true })
        .limit(RESULT_LIMIT);
      if (error) {
        console.error('[GET email-buyer-candidates] search failed', error);
        return NextResponse.json({ error: 'Failed to search buyers' }, { status: 500 });
      }
      results = data ?? [];
    }

    return NextResponse.json({ data: { ambiguous, results } });
  } catch (error) {
    console.error('[GET /api/tenant/entries/[id]/email-buyer-candidates]', error);
    return NextResponse.json({ error: 'Failed to load buyers' }, { status: 500 });
  }
}
