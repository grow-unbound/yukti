import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));
vi.mock('@/lib/flags', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
  FLAGS: { WHATSAPP_INTEGRATION: 'df_whatsapp_integration' },
}));
vi.mock('@/lib/integrations/server', () => ({
  loadIntegrationsSettingsPayload: vi.fn().mockResolvedValue({ integrations: [] }),
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: () => ({
      from: (...args: unknown[]) => fromMock(...args),
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

import { POST } from '../../app/api/settings/integrations/whatsapp/oauth/callback/route';
import { subscribeWabaToApp } from '@/lib/integrations/whatsapp-graph';

function req() {
  return new NextRequest('http://localhost/api/settings/integrations/whatsapp/oauth/callback', {
    method: 'POST',
    body: JSON.stringify({ code: 'c', waba_id: 'waba-1', phone_number_id: 'pn-1', business_id: 'b-1', pin: '123456' }),
    headers: { 'Content-Type': 'application/json' },
  });
}

function metaResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

/** Routes Graph calls by URL so call order does not matter. */
function mockGraph({ subscribeOk }: { subscribeOk: boolean }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/oauth/access_token')) return metaResponse({ access_token: 'tok' });
    if (url.includes('/register')) return metaResponse({ success: true });
    if (url.includes('/subscribed_apps')) {
      return subscribeOk
        ? metaResponse({ success: true })
        : metaResponse({ error: { message: 'Permission denied' } }, false);
    }
    return metaResponse({ display_phone_number: '+91 90000 00000' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setupTables(upsertResult: { data: unknown; error: unknown }) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'tenant_integrations') {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        }),
        upsert: (...args: unknown[]) => {
          upsertMock(...args);
          return { select: () => ({ single: async () => upsertResult }) };
        },
      };
    }
    return { insert: async () => ({ error: null }) };
  });
  rpcMock.mockResolvedValue({ error: null });
}

describe('POST /api/settings/integrations/whatsapp/oauth/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_APP_ID = 'app';
    process.env.WHATSAPP_APP_SECRET = 'secret';
    getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 't-1', sub: 'u-1', role: 'seller_admin' });
    getFlagMock.mockResolvedValue(true);
  });

  it('does not connect when the WABA webhook subscription fails', async () => {
    mockGraph({ subscribeOk: false });
    setupTables({ data: { id: 'int-1' }, error: null });

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error.code).toBe('WEBHOOK_SUBSCRIBE_FAILED');
    expect(upsertMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('subscribes the WABA and records webhook_subscribed_at on success', async () => {
    const fetchMock = mockGraph({ subscribeOk: true });
    setupTables({ data: { id: 'int-1' }, error: null });

    const res = await POST(req());

    expect(res.status).toBe(200);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.findIndex((u) => u.includes('/register'))).toBeLessThan(
      urls.findIndex((u) => u.includes('/waba-1/subscribed_apps')),
    );
    const row = upsertMock.mock.calls[0][0] as { config: Record<string, unknown> };
    expect(row.config.webhook_subscribed_at).toEqual(expect.any(String));
  });

  it('returns 409 when the phone number is already connected to another tenant', async () => {
    mockGraph({ subscribeOk: true });
    setupTables({ data: null, error: { code: '23505', message: 'duplicate key' } });

    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('PHONE_ALREADY_CONNECTED');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('subscribeWabaToApp', () => {
  it('returns Meta error message on failure and never throws on network error', async () => {
    const bad = vi.fn().mockResolvedValue(metaResponse({ error: { message: 'nope' } }, false));
    await expect(subscribeWabaToApp('w', 't', bad as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      message: 'nope',
    });
    const boom = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(subscribeWabaToApp('w', 't', boom as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      message: 'network down',
    });
  });
});

describe('phone_number_id unique mapping migration', () => {
  it('creates a partial unique index scoped to connected, non-deleted whatsapp rows', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261013120000_whatsapp_phone_number_id_unique_mapping.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS tenant_integrations_whatsapp_phone_number_id_unique');
    expect(sql).toContain("((config->>'phone_number_id'))");
    expect(sql).toContain("integration_type_id = 'whatsapp_business'");
    expect(sql).toContain("status = 'connected'");
    expect(sql).toContain('deleted_at IS NULL');
  });
});
