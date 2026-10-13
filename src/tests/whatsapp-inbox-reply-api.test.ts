import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();
const canAccessDocumentLocationMock = vi.fn();
const enqueueWhatsAppMessageMock = vi.fn();
const triggerWhatsAppDispatchMock = vi.fn();
const captureEventMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('@/lib/flags', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: () => ({
      from: (...args: unknown[]) => fromMock(...args),
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

vi.mock('@/lib/server/seller-location-access', () => ({
  canAccessDocumentLocation: (...args: unknown[]) => canAccessDocumentLocationMock(...args),
}));

vi.mock('@/lib/server/whatsapp-enqueue', () => ({
  enqueueWhatsAppMessage: (...args: unknown[]) => enqueueWhatsAppMessageMock(...args),
  triggerWhatsAppDispatch: (...args: unknown[]) => triggerWhatsAppDispatchMock(...args),
}));

vi.mock('@/lib/server/whatsapp-inbox-analytics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/whatsapp-inbox-analytics')>(
    '@/lib/server/whatsapp-inbox-analytics',
  );
  return { ...actual, captureWhatsAppInboxEvent: (...args: unknown[]) => captureEventMock(...args) };
});

import { POST } from '../../app/api/tenant/entries/[id]/whatsapp-reply/route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/tenant/entries/entry-1/whatsapp-reply', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function tableResult(row: Record<string, unknown> | null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  };
}

const params = { params: Promise.resolve({ id: 'entry-1' }) };
const entry = {
  id: 'entry-1',
  tenant_id: 'tenant-1',
  buyer_id: 'buyer-1',
  location_id: null,
  entry_type: 'whatsapp_buyer_message',
  source_entity_type: 'whatsapp_thread',
  source_entity_id: 'thread-1',
};

describe('POST /api/tenant/entries/[id]/whatsapp-reply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-1', sub: 'seller-1', role: 'seller_admin' });
    getFlagMock.mockResolvedValue(true);
    canAccessDocumentLocationMock.mockReturnValue(true);
    enqueueWhatsAppMessageMock.mockResolvedValue({ messageId: 'wa-msg-1', enqueued: true });
    triggerWhatsAppDispatchMock.mockResolvedValue({ ok: true, dispatched: 1, failed: 0, skipped: 0 });
    rpcMock.mockResolvedValue({ data: { thread_message_id: 'tm-1' }, error: null });
  });

  it('blocks free-form replies outside the service window', async () => {
    fromMock
      .mockReturnValueOnce(tableResult(entry))
      .mockReturnValueOnce(tableResult({
        id: 'thread-1',
        tenant_id: 'tenant-1',
        buyer_id: 'buyer-1',
        sender_phone: '919876543210',
        service_window_expires_at: '2026-01-01T00:00:00.000Z',
      }));

    const res = await POST(req({ body: 'Hello' }), params);

    expect(res.status).toBe(409);
    expect(enqueueWhatsAppMessageMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('enqueues a service-window text reply and records the thread audit link', async () => {
    fromMock
      .mockReturnValueOnce(tableResult(entry))
      .mockReturnValueOnce(tableResult({
        id: 'thread-1',
        tenant_id: 'tenant-1',
        buyer_id: 'buyer-1',
        sender_phone: '919876543210',
        service_window_expires_at: '2099-01-01T00:00:00.000Z',
        last_inbound_message_at: new Date(Date.now() - 90_000).toISOString(),
        resolution_status: 'matched',
      }))
      .mockReturnValueOnce(tableResult({ id: 'buyer-1', whatsapp_opt_out_at: null }));

    const res = await POST(req({ body: 'We will check and reply shortly.' }), params);

    expect(res.status).toBe(200);
    expect(enqueueWhatsAppMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      recipientPhone: '919876543210',
      metaCategory: 'service',
      triggerSource: 'whatsapp_inbox_reply',
      sendPayload: expect.objectContaining({
        type: 'text',
        text_body: 'We will check and reply shortly.',
      }),
    }));
    expect(rpcMock).toHaveBeenCalledWith('record_whatsapp_thread_outbound_reply', {
      p_tenant_id: 'tenant-1',
      p_entry_id: 'entry-1',
      p_actor_user_id: 'seller-1',
      p_reply_text: 'We will check and reply shortly.',
      p_whatsapp_message_id: 'wa-msg-1',
    });
    expect(triggerWhatsAppDispatchMock).toHaveBeenCalledWith(['wa-msg-1']);

    expect(captureEventMock).toHaveBeenCalledTimes(1);
    const [event, tenantId, actorId, props] = captureEventMock.mock.calls[0];
    expect(event).toBe('whatsapp_reply_submitted');
    expect(tenantId).toBe('tenant-1');
    expect(actorId).toBe('seller-1');
    expect(props).toMatchObject({
      entry_id: 'entry-1',
      thread_id: 'thread-1',
      resolution_status: 'matched',
      generation_mode: 'manual',
      reply_length: 'We will check and reply shortly.'.length,
    });
    expect(props.seconds_since_inbound).toBeGreaterThanOrEqual(89);
    expect(JSON.stringify(props)).not.toContain('We will check');
  });

  it('does not emit a submitted event when the window has expired', async () => {
    fromMock
      .mockReturnValueOnce(tableResult(entry))
      .mockReturnValueOnce(tableResult({
        id: 'thread-1',
        tenant_id: 'tenant-1',
        buyer_id: 'buyer-1',
        sender_phone: '919876543210',
        service_window_expires_at: '2026-01-01T00:00:00.000Z',
      }));
    const res = await POST(req({ body: 'late' }), params);
    expect(res.status).toBe(409);
    expect(captureEventMock).not.toHaveBeenCalled();
  });
});
