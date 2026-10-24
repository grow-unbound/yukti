import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authorizeEmailEntry } from '@/lib/server/email-entry-access';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const LinkSchema = z.object({ buyer_id: z.string().uuid() });

const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  actor_not_allowed: { status: 403, message: 'Forbidden' },
  entry_not_found: { status: 404, message: 'Entry not found' },
  thread_not_found: { status: 404, message: 'Email thread not found' },
  buyer_not_found: { status: 404, message: 'Buyer not found' },
};

/** Links the entry's email thread (and future mail from the sender) to a buyer of the caller's tenant. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await authorizeEmailEntry(request, id);
    if (auth.error) return auth.error;
    const { tenantId, userId, entryId } = auth.access;

    const parsed = LinkSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'buyer_id is required' }, { status: 400 });
    }

    const { data, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('link_email_thread_buyer', {
        p_tenant_id: tenantId,
        p_entry_id: entryId,
        p_actor_user_id: userId,
        p_buyer_id: parsed.data.buyer_id,
      });

    if (error) {
      const mapped = Object.entries(RPC_ERRORS).find(([key]) => error.message?.includes(key));
      if (mapped) return NextResponse.json({ error: mapped[1].message }, { status: mapped[1].status });
      console.error('[POST email-buyer] rpc failed', error);
      return NextResponse.json({ error: 'Failed to link buyer' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    console.error('[POST /api/tenant/entries/[id]/email-buyer]', error);
    return NextResponse.json({ error: 'Failed to link buyer' }, { status: 500 });
  }
}
