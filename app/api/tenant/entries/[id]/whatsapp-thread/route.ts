import { NextRequest, NextResponse } from 'next/server';

import { authorizeWhatsAppEntryThread } from '@/lib/server/whatsapp-inbox-thread';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const THREAD_MESSAGE_LIMIT = 50;
const FAILURE_REASON_MAX = 200;

/**
 * Bounded thread timeline for a WhatsApp Today entry. Outbound rows carry the
 * delivery state of their send-ledger row, so the UI shows queued / sent /
 * delivered / read / failed straight from billing-grade state, not a copy.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await authorizeWhatsAppEntryThread(request, id);
    if (auth.error) return auth.error;
    const { tenantId, threadId } = auth.ctx;
    const db = supabaseAdmin as any;

    const { data: rows, error } = await db
      .schema('app')
      .from('whatsapp_thread_messages')
      .select('id, direction, text_body, message_type, received_at, sent_at, created_at, whatsapp_message_id')
      .eq('tenant_id', tenantId)
      .eq('thread_id', threadId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(THREAD_MESSAGE_LIMIT);
    if (error) {
      console.error('[GET whatsapp-thread] messages query failed', error);
      return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
    }

    const ledgerIds = (rows ?? [])
      .map((row: { whatsapp_message_id: string | null }) => row.whatsapp_message_id)
      .filter((value: string | null): value is string => Boolean(value));

    const ledger = new Map<string, { status: string; failure_reason: string | null }>();
    if (ledgerIds.length > 0) {
      const { data: ledgerRows, error: ledgerError } = await db
        .schema('app')
        .from('whatsapp_messages')
        .select('id, status, failure_reason')
        .eq('tenant_id', tenantId)
        .in('id', ledgerIds)
        .limit(THREAD_MESSAGE_LIMIT);
      if (ledgerError) {
        console.error('[GET whatsapp-thread] ledger query failed', ledgerError);
        return NextResponse.json({ error: 'Failed to load delivery state' }, { status: 500 });
      }
      for (const row of ledgerRows ?? []) ledger.set(row.id, row);
    }

    const data = [...(rows ?? [])]
      .reverse()
      .map((row: Record<string, any>) => {
        const delivery = row.whatsapp_message_id ? ledger.get(row.whatsapp_message_id) : undefined;
        const outbound = row.direction === 'outbound';
        return {
          id: row.id as string,
          direction: row.direction as 'inbound' | 'outbound',
          text_body: (row.text_body as string | null) ?? '',
          at: (row.received_at ?? row.sent_at ?? row.created_at) as string,
          delivery_status: outbound ? (delivery?.status ?? 'queued') : null,
          failure_reason:
            outbound && delivery?.status === 'failed' && delivery.failure_reason
              ? String(delivery.failure_reason).slice(0, FAILURE_REASON_MAX)
              : null,
          can_retry: outbound && delivery?.status === 'failed',
        };
      });

    return NextResponse.json({ data });
  } catch (error) {
    console.error('[GET /api/tenant/entries/[id]/whatsapp-thread]', error);
    return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
  }
}
