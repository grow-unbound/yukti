import { NextRequest, NextResponse } from 'next/server';

import { authorizeEmailEntry } from '@/lib/server/email-entry-access';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const THREAD_MESSAGE_LIMIT = 30;
const ATTACHMENT_LIMIT = 100;

/**
 * Bounded thread timeline for an email Today entry: plain-text bodies only
 * (HTML is never rendered in the app origin) and attachment metadata without
 * a download URL (no scanner yet).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await authorizeEmailEntry(request, id);
    if (auth.error) return auth.error;
    const { tenantId, threadId } = auth.access;
    const db = supabaseAdmin as any;

    const { data: rows, error } = await db
      .schema('app')
      .from('email_messages')
      .select('id, from_address, from_name, subject, text_body, received_at, auth_dkim, auth_dmarc')
      .eq('tenant_id', tenantId)
      .eq('thread_id', threadId)
      .is('deleted_at', null)
      .order('received_at', { ascending: false })
      .limit(THREAD_MESSAGE_LIMIT);
    if (error) {
      console.error('[GET email-thread] messages query failed', error);
      return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
    }

    const messageIds = (rows ?? []).map((row: { id: string }) => row.id);
    const attachmentsByMessage = new Map<string, Array<{ filename: string; mime_type: string | null; size_bytes: number | null; scan_status: string }>>();
    if (messageIds.length > 0) {
      const { data: attachments, error: attachmentError } = await db
        .schema('app')
        .from('email_attachments')
        .select('message_id, filename, mime_type, size_bytes, scan_status')
        .eq('tenant_id', tenantId)
        .in('message_id', messageIds)
        .is('deleted_at', null)
        .limit(ATTACHMENT_LIMIT);
      if (attachmentError) {
        console.error('[GET email-thread] attachments query failed', attachmentError);
        return NextResponse.json({ error: 'Failed to load attachments' }, { status: 500 });
      }
      for (const row of attachments ?? []) {
        const list = attachmentsByMessage.get(row.message_id) ?? [];
        list.push({ filename: row.filename, mime_type: row.mime_type, size_bytes: row.size_bytes, scan_status: row.scan_status });
        attachmentsByMessage.set(row.message_id, list);
      }
    }

    const data = [...(rows ?? [])].reverse().map((row: Record<string, any>) => ({
      id: row.id as string,
      from_address: row.from_address as string,
      from_name: (row.from_name as string | null) ?? null,
      subject: (row.subject as string | null) ?? '',
      text_body: (row.text_body as string | null) ?? '',
      at: row.received_at as string,
      sender_verified: row.auth_dkim === 'pass' || row.auth_dmarc === 'pass',
      attachments: attachmentsByMessage.get(row.id) ?? [],
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('[GET /api/tenant/entries/[id]/email-thread]', error);
    return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
  }
}
