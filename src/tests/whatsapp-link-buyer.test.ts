import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authorizeMock = vi.fn();
const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@/lib/server/whatsapp-entry-access', () => ({
  authorizeWhatsAppEntry: (...args: unknown[]) => authorizeMock(...args),
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: () => ({
      from: (...args: unknown[]) => fromMock(...args),
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

import { POST as linkPost } from '../../app/api/tenant/entries/[id]/whatsapp-buyer/route';
import { GET as candidatesGet } from '../../app/api/tenant/entries/[id]/whatsapp-buyer-candidates/route';

const params = { params: Promise.resolve({ id: 'entry-1' }) };
const BUYER_ID = '3f8f6c1e-2b34-4c55-9a77-0d6a4f1f9a10';
const access = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  entryId: 'entry-1',
  threadId: 'thread-1',
  ambiguityMetadata: {},
};

function post(body: unknown) {
  return new NextRequest('http://localhost/api/tenant/entries/entry-1/whatsapp-buyer', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST whatsapp-buyer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({ access });
  });

  it('passes through an auth failure without touching the database', async () => {
    const { NextResponse } = await import('next/server');
    authorizeMock.mockResolvedValue({ error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    const res = await linkPost(post({ buyer_id: BUYER_ID }), params);
    expect(res.status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid buyer_id', async () => {
    const res = await linkPost(post({ buyer_id: 'abc' }), params);
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('calls the link RPC with tenant and actor from the verified session, never the body', async () => {
    rpcMock.mockResolvedValue({ data: { thread_id: 't', buyer_id: BUYER_ID }, error: null });
    const res = await linkPost(post({ buyer_id: BUYER_ID, tenant_id: 'other', actor_user_id: 'evil' }), params);
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('link_whatsapp_thread_buyer', {
      p_tenant_id: 'tenant-1',
      p_entry_id: 'entry-1',
      p_actor_user_id: 'user-1',
      p_buyer_id: BUYER_ID,
    });
  });

  it.each([
    ['buyer_not_found', 404],
    ['actor_not_allowed', 403],
    ['entry_not_found', 404],
  ])('maps rpc error %s to %i', async (code, status) => {
    rpcMock.mockResolvedValue({ data: null, error: { message: code } });
    const res = await linkPost(post({ buyer_id: BUYER_ID }), params);
    expect(res.status).toBe(status);
  });
});

describe('GET whatsapp-buyer-candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockBuyers(rows: unknown[]) {
    const calls: Record<string, unknown[][]> = {};
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'or', 'order']) {
      chain[method] = (...args: unknown[]) => {
        (calls[method] ??= []).push(args);
        return chain;
      };
    }
    chain.limit = async (...args: unknown[]) => {
      (calls.limit ??= []).push(args);
      return { data: rows, error: null };
    };
    fromMock.mockReturnValue(chain);
    return calls;
  }

  function get(q?: string) {
    const url = new URL('http://localhost/api/tenant/entries/entry-1/whatsapp-buyer-candidates');
    if (q !== undefined) url.searchParams.set('q', q);
    return new NextRequest(url);
  }

  it('returns phone-match candidates from the thread without querying when there is no search', async () => {
    authorizeMock.mockResolvedValue({
      access: {
        ...access,
        ambiguityMetadata: {
          candidates: [
            { buyer_id: 'b1', business_name: 'Alpha', role: 'buyer_admin', kind: 'owner' },
            { business_name: 'no id' },
          ],
        },
      },
    });
    const res = await candidatesGet(get(), params);
    const { data } = await res.json();
    expect(data.ambiguous).toEqual([{ buyer_id: 'b1', business_name: 'Alpha', role: 'buyer_admin' }]);
    expect(data.results).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('searches within the tenant, bounded, with wildcard/filter characters stripped', async () => {
    authorizeMock.mockResolvedValue({ access });
    const calls = mockBuyers([{ id: 'b2', business_name: 'Acme', contact_name: null, phone: '9000000000' }]);
    const res = await candidatesGet(get('ac%me,or(x)'), params);
    const { data } = await res.json();
    expect(data.results).toHaveLength(1);
    expect(calls.eq).toContainEqual(['tenant_id', 'tenant-1']);
    expect(calls.limit).toEqual([[20]]);
    // User-supplied wildcard / filter-syntax characters become spaces; only the
    // three intended ilike clauses (joined by commas) and their % wrappers remain.
    expect(calls.or[0][0]).toBe(
      'business_name.ilike.%ac me or x%,contact_name.ilike.%ac me or x%,phone.ilike.%ac me or x%',
    );
  });

  it('ignores one-character searches', async () => {
    authorizeMock.mockResolvedValue({ access });
    const res = await candidatesGet(get('a'), params);
    expect((await res.json()).data.results).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('link_whatsapp_thread_buyer migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261013160000_whatsapp_link_thread_buyer.sql'),
    'utf8',
  );
  const code = sql.replace(/^--.*$/gm, '');

  it('re-checks actor role and tenant in the database and is service-role only', () => {
    expect(code).toContain("tu.role IN ('seller_admin', 'seller_assistant')");
    expect(code).toContain("RAISE EXCEPTION 'actor_not_allowed'");
    expect(code).toContain('REVOKE ALL ON FUNCTION app.link_whatsapp_thread_buyer(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('TO service_role;');
  });

  it('grants no buyer-app access or buyer-admin role to a linked buyer', () => {
    expect(code).toContain("buyer_contact_kind = 'seller_linked'");
    expect(code).toContain('buyer_contact_role = NULL');
    expect(code).not.toMatch(/buyer_app_enabled\s*=\s*true/);
  });

  it('only removes the auto-created placeholder buyer when nothing references it', () => {
    expect(code).toContain("'whatsapp_unknown_sender' = 'true'");
    for (const table of ['app.whatsapp_threads', 'app.orders', 'app.estimates', 'app.invoices']) {
      expect(code).toContain(`FROM ${table}`);
    }
  });

  it('makes a manual link win in the inbound function and persist across threads', () => {
    expect(code).toContain("t.metadata->>'manual_buyer_link' = 'true'");
    expect(code).toContain('IF v_manual_buyer_id IS NOT NULL THEN');
    expect(code).not.toMatch(/\bmin\(\s*buyer_id\s*\)/i);
  });
});
