import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authorizeEmailEntry } from '@/lib/server/email-entry-access';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const RuleSchema = z.object({ rule: z.enum(['supplier', 'ignore']) });

const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  actor_not_allowed: { status: 403, message: 'Forbidden' },
  entry_not_found: { status: 404, message: 'Entry not found' },
  thread_not_found: { status: 404, message: 'Email thread not found' },
};

/** Marks the thread's sender as a supplier / ignored so they stop creating Today entries. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await authorizeEmailEntry(request, id);
    if (auth.error) return auth.error;
    const { tenantId, userId, entryId } = auth.access;

    const parsed = RuleSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'rule must be supplier or ignore' }, { status: 400 });
    }

    const { data, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('set_email_sender_rule', {
        p_tenant_id: tenantId,
        p_entry_id: entryId,
        p_actor_user_id: userId,
        p_rule: parsed.data.rule,
      });

    if (error) {
      const mapped = Object.entries(RPC_ERRORS).find(([key]) => error.message?.includes(key));
      if (mapped) return NextResponse.json({ error: mapped[1].message }, { status: mapped[1].status });
      console.error('[POST email-sender-rule] rpc failed', error);
      return NextResponse.json({ error: 'Failed to save sender rule' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    console.error('[POST /api/tenant/entries/[id]/email-sender-rule]', error);
    return NextResponse.json({ error: 'Failed to save sender rule' }, { status: 500 });
  }
}
