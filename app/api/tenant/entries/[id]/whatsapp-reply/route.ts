import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { FEATURE_FLAGS } from '@/constants';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { formatWhatsappDestination } from '@/lib/phone';
import { supabaseAdmin } from '@/lib/supabase';
import { canAccessDocumentLocation } from '@/lib/server/seller-location-access';
import { enqueueWhatsAppMessage, triggerWhatsAppDispatch } from '@/lib/server/whatsapp-enqueue';
import { captureWhatsAppInboxEvent, secondsSince } from '@/lib/server/whatsapp-inbox-analytics';

export const dynamic = 'force-dynamic';

const ReplySchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!(await getFlag(FEATURE_FLAGS.WHATSAPP_INBOX, claims.tenant_id))) {
      return NextResponse.json({ error: 'WhatsApp inbox is not enabled' }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const parsed = ReplySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid reply' }, { status: 400 });
    }

    const { data: entry, error: entryError } = await (supabaseAdmin as any)
      .schema('app')
      .from('entries')
      .select('id, tenant_id, buyer_id, location_id, entry_type, source_entity_type, source_entity_id')
      .eq('id', id)
      .eq('tenant_id', claims.tenant_id)
      .eq('entry_type', 'whatsapp_buyer_message')
      .eq('source_entity_type', 'whatsapp_thread')
      .is('deleted_at', null)
      .maybeSingle();

    if (entryError || !entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }
    if (entry.location_id && !canAccessDocumentLocation(claims, entry.location_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: thread, error: threadError } = await (supabaseAdmin as any)
      .schema('app')
      .from('whatsapp_threads')
      .select('id, tenant_id, buyer_id, sender_phone, service_window_expires_at, last_inbound_message_at, resolution_status')
      .eq('id', entry.source_entity_id)
      .eq('tenant_id', claims.tenant_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (threadError || !thread) {
      return NextResponse.json({ error: 'WhatsApp thread not found' }, { status: 404 });
    }

    if (!thread.service_window_expires_at || new Date(thread.service_window_expires_at).getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'The 24-hour WhatsApp reply window has closed. You can reply again once the buyer messages you.' },
        { status: 409 },
      );
    }

    if (thread.buyer_id) {
      const { data: buyer, error: buyerError } = await (supabaseAdmin as any)
        .schema('app')
        .from('buyers')
        .select('id, whatsapp_opt_out_at')
        .eq('id', thread.buyer_id)
        .eq('tenant_id', claims.tenant_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (buyerError) {
        return NextResponse.json({ error: 'Failed to verify buyer opt-out state' }, { status: 500 });
      }
      if (buyer?.whatsapp_opt_out_at) {
        return NextResponse.json({ error: 'This buyer has opted out of WhatsApp messages' }, { status: 409 });
      }
    }

    const result = await enqueueWhatsAppMessage({
      tenantId: claims.tenant_id,
      buyerId: thread.buyer_id ?? null,
      recipientPhone: formatWhatsappDestination(thread.sender_phone),
      metaCategory: 'service',
      triggerSource: 'whatsapp_inbox_reply',
      sendPayload: {
        type: 'text',
        text_body: parsed.data.body,
        body_params: [],
      },
      relatedEntityType: null,
      relatedEntityId: null,
      priority: 1,
    });

    if (!result.messageId) {
      return NextResponse.json({ error: 'Failed to enqueue WhatsApp reply' }, { status: 500 });
    }

    const { error: auditError } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('record_whatsapp_thread_outbound_reply', {
        p_tenant_id: claims.tenant_id,
        p_entry_id: id,
        p_actor_user_id: claims.sub,
        p_reply_text: parsed.data.body,
        p_whatsapp_message_id: result.messageId,
      });

    if (auditError) {
      console.error('[POST /api/tenant/entries/[id]/whatsapp-reply] audit failed', auditError);
      return NextResponse.json({ error: 'Failed to record WhatsApp reply' }, { status: 500 });
    }

    captureWhatsAppInboxEvent('whatsapp_reply_submitted', claims.tenant_id, claims.sub, {
      entry_id: id,
      thread_id: thread.id,
      resolution_status: thread.resolution_status ?? null,
      generation_mode: 'manual',
      reply_length: parsed.data.body.length,
      seconds_since_inbound: secondsSince(thread.last_inbound_message_at),
    });

    const dispatch = await triggerWhatsAppDispatch([result.messageId]);

    return NextResponse.json({
      data: {
        message_id: result.messageId,
        enqueued: result.enqueued,
        dispatch,
      },
    });
  } catch (error) {
    console.error('[POST /api/tenant/entries/[id]/whatsapp-reply]', error);
    return NextResponse.json({ error: 'Failed to send WhatsApp reply' }, { status: 500 });
  }
}
