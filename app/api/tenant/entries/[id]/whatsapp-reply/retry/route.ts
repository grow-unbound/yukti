import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authorizeWhatsAppEntryThread } from '@/lib/server/whatsapp-inbox-thread';
import { triggerWhatsAppDispatch } from '@/lib/server/whatsapp-enqueue';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const RetrySchema = z.object({ thread_message_id: z.string().uuid() });

const RPC_ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  reply_not_found: { status: 404, message: 'Reply not found' },
  reply_not_retryable: { status: 409, message: 'This reply cannot be retried' },
  service_window_expired: {
    status: 409,
    message: 'The 24-hour WhatsApp service window has expired. Approved template replies are not available yet.',
  },
  buyer_opted_out: { status: 409, message: 'This buyer has opted out of WhatsApp messages' },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await authorizeWhatsAppEntryThread(request, id);
    if (auth.error) return auth.error;
    const { tenantId, userId, entryId } = auth.ctx;

    const parsed = RetrySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'thread_message_id is required' }, { status: 400 });
    }

    const { data, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('retry_whatsapp_thread_reply', {
        p_tenant_id: tenantId,
        p_entry_id: entryId,
        p_thread_message_id: parsed.data.thread_message_id,
        p_actor_user_id: userId,
      });

    if (error) {
      const mapped = Object.entries(RPC_ERROR_MESSAGES).find(([key]) => error.message?.includes(key));
      if (mapped) return NextResponse.json({ error: mapped[1].message }, { status: mapped[1].status });
      console.error('[POST whatsapp-reply/retry] rpc failed', error);
      return NextResponse.json({ error: 'Failed to retry WhatsApp reply' }, { status: 500 });
    }

    const messageId = (data as { message_id?: string } | null)?.message_id;
    if (!messageId) {
      return NextResponse.json({ error: 'Failed to retry WhatsApp reply' }, { status: 500 });
    }

    const dispatch = await triggerWhatsAppDispatch([messageId]);
    return NextResponse.json({ data: { message_id: messageId, dispatch } });
  } catch (error) {
    console.error('[POST /api/tenant/entries/[id]/whatsapp-reply/retry]', error);
    return NextResponse.json({ error: 'Failed to retry WhatsApp reply' }, { status: 500 });
  }
}
