import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authorizeMock = vi.fn();
const rpcMock = vi.fn();
const fromMock = vi.fn();
const triggerDispatchMock = vi.fn();

vi.mock('@/lib/server/whatsapp-inbox-thread', () => ({
  authorizeWhatsAppEntryThread: (...args: unknown[]) => authorizeMock(...args),
}));
vi.mock('@/lib/server/whatsapp-enqueue', () => ({
  triggerWhatsAppDispatch: (...args: unknown[]) => triggerDispatchMock(...args),
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: () => ({
      from: (...args: unknown[]) => fromMock(...args),
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

import { POST as retryPost } from '../../app/api/tenant/entries/[id]/whatsapp-reply/retry/route';
import { GET as threadGet } from '../../app/api/tenant/entries/[id]/whatsapp-thread/route';

const params = { params: Promise.resolve({ id: 'entry-1' }) };
const ctx = { tenantId: 'tenant-1', userId: 'user-1', entryId: 'entry-1', threadId: 'thread-1' };
const THREAD_MESSAGE_ID = '3f8f6c1e-2b34-4c55-9a77-0d6a4f1f9a10';

function retryReq(body: unknown) {
  return new NextRequest('http://localhost/api/tenant/entries/entry-1/whatsapp-reply/retry', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST whatsapp-reply/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({ ctx });
    triggerDispatchMock.mockResolvedValue({ dispatched: true });
  });

  it('returns the auth error untouched', async () => {
    const { NextResponse } = await import('next/server');
    authorizeMock.mockResolvedValue({ error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    const res = await retryPost(retryReq({ thread_message_id: THREAD_MESSAGE_ID }), params);
    expect(res.status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-uuid thread_message_id', async () => {
    const res = await retryPost(retryReq({ thread_message_id: 'nope' }), params);
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('re-queues the ledger row and triggers dispatch for that message only', async () => {
    rpcMock.mockResolvedValue({ data: { message_id: 'ledger-1', thread_message_id: THREAD_MESSAGE_ID }, error: null });
    const res = await retryPost(retryReq({ thread_message_id: THREAD_MESSAGE_ID }), params);
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('retry_whatsapp_thread_reply', {
      p_tenant_id: 'tenant-1',
      p_entry_id: 'entry-1',
      p_thread_message_id: THREAD_MESSAGE_ID,
      p_actor_user_id: 'user-1',
    });
    expect(triggerDispatchMock).toHaveBeenCalledWith(['ledger-1']);
  });

  it.each([
    ['reply_not_retryable', 409],
    ['service_window_expired', 409],
    ['buyer_opted_out', 409],
    ['reply_not_found', 404],
  ])('maps rpc error %s to %i without dispatching', async (code, status) => {
    rpcMock.mockResolvedValue({ data: null, error: { message: code } });
    const res = await retryPost(retryReq({ thread_message_id: THREAD_MESSAGE_ID }), params);
    expect(res.status).toBe(status);
    expect(triggerDispatchMock).not.toHaveBeenCalled();
  });
});

describe('GET whatsapp-thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({ ctx });
  });

  function mockTables(messages: unknown[], ledger: unknown[]) {
    fromMock.mockImplementation((table: string) => {
      const rows = table === 'whatsapp_thread_messages' ? messages : ledger;
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'in', 'order']) chain[method] = () => chain;
      chain.limit = async () => ({ data: rows, error: null });
      return chain;
    });
  }

  it('joins ledger delivery state onto outbound rows and only allows retry on failed', async () => {
    mockTables(
      [
        { id: 'm3', direction: 'outbound', text_body: 'c', created_at: '2026-10-13T10:03:00Z', whatsapp_message_id: 'l2' },
        { id: 'm2', direction: 'outbound', text_body: 'b', created_at: '2026-10-13T10:02:00Z', whatsapp_message_id: 'l1' },
        { id: 'm1', direction: 'inbound', text_body: 'a', received_at: '2026-10-13T10:01:00Z', created_at: '2026-10-13T10:01:00Z', whatsapp_message_id: null },
      ],
      [
        { id: 'l1', status: 'delivered', failure_reason: null },
        { id: 'l2', status: 'failed', failure_reason: 'x'.repeat(500) },
      ],
    );

    const res = await threadGet(new NextRequest('http://localhost/x'), params);
    const { data } = await res.json();

    expect(data.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(data[0]).toMatchObject({ direction: 'inbound', delivery_status: null, can_retry: false });
    expect(data[1]).toMatchObject({ delivery_status: 'delivered', can_retry: false, failure_reason: null });
    expect(data[2]).toMatchObject({ delivery_status: 'failed', can_retry: true });
    expect(data[2].failure_reason).toHaveLength(200);
  });

  it('treats an outbound row with no ledger match as queued, not retryable', async () => {
    mockTables(
      [{ id: 'm1', direction: 'outbound', text_body: 'a', created_at: '2026-10-13T10:00:00Z', whatsapp_message_id: 'gone' }],
      [],
    );
    const res = await threadGet(new NextRequest('http://localhost/x'), params);
    const { data } = await res.json();
    expect(data[0]).toMatchObject({ delivery_status: 'queued', can_retry: false });
  });
});

describe('retry_whatsapp_thread_reply migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261013130000_whatsapp_thread_reply_retry.sql'),
    'utf8',
  );

  it('re-queues the failed ledger row in place and never inserts a new message', () => {
    expect(sql).toContain("IF v_msg.status <> 'failed' THEN");
    expect(sql).toContain('UPDATE app.whatsapp_messages');
    expect(sql).not.toMatch(/INSERT INTO app\.whatsapp_messages/);
    expect(sql).toContain("attempt_count = COALESCE(attempt_count, 0) + 1");
  });

  it('re-checks service window and buyer opt-out inside the function', () => {
    expect(sql).toContain("'service_window_expired'");
    expect(sql).toContain("'buyer_opted_out'");
  });

  it('is tenant-scoped and service-role only', () => {
    expect(sql).toContain('AND tenant_id = p_tenant_id');
    expect(sql).toContain('REVOKE ALL ON FUNCTION app.retry_whatsapp_thread_reply(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('TO service_role;');
  });
});
