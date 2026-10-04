import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();
const generateLinkMock = vi.fn();
const sendSetupPasswordInviteEmailMock = vi.fn();

type QueryResult = {
  data?: unknown;
  error?: unknown;
};

type CallRecord = {
  payload?: Record<string, unknown>;
  filters: Array<[string, unknown, string]>;
};

const dbResponses: Record<string, QueryResult[]> = {};
const dbCalls: Record<string, CallRecord> = {};

function nextResult(key: string): QueryResult {
  const queue = dbResponses[key] ?? [];
  if (queue.length <= 1) return queue[0] ?? {};
  return queue.shift() ?? {};
}

function createChain(key: string) {
  const record = (dbCalls[key] ??= { filters: [] });
  const chain: any = {
    eq: vi.fn((column: string, value: unknown) => {
      record.filters.push([column, value, 'eq']);
      return chain;
    }),
    is: vi.fn((column: string, value: unknown) => {
      record.filters.push([column, value, 'is']);
      return chain;
    }),
    neq: vi.fn((column: string, value: unknown) => {
      record.filters.push([column, value, 'neq']);
      return chain;
    }),
    select: vi.fn(() => chain),
    single: vi.fn(async () => {
      const result = nextResult(key);
      return { data: result.data ?? null, error: result.error ?? null };
    }),
    maybeSingle: vi.fn(async () => {
      const result = nextResult(key);
      return { data: result.data ?? null, error: result.error ?? null };
    }),
  };
  return { chain, record };
}

const schemaMock = vi.fn((schemaName: string) => ({
  from: vi.fn((tableName: string) => {
    const key = `${schemaName}.${tableName}`;
    return {
      select: vi.fn(() => createChain(`${key}:select`).chain),
      insert: vi.fn((payload: Record<string, unknown>) => {
        dbCalls[`${key}:insert`] = { payload, filters: [] };
        return createChain(`${key}:insert`).chain;
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        dbCalls[`${key}:update`] = { payload, filters: [] };
        return createChain(`${key}:update`).chain;
      }),
    };
  }),
}));

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('@/lib/flags', () => ({
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: (...args: unknown[]) => schemaMock(...args),
    auth: {
      admin: {
        generateLink: (...args: unknown[]) => generateLinkMock(...args),
      },
    },
  },
}));

vi.mock('@/lib/server/email', () => ({
  sendSetupPasswordInviteEmail: (...args: unknown[]) => sendSetupPasswordInviteEmailMock(...args),
}));

import { POST } from '../../app/api/customers/[id]/users/route';
import { DELETE, PUT } from '../../app/api/customers/[id]/users/[userId]/route';
import { POST as INVITE } from '../../app/api/customers/[id]/users/[userId]/invite/route';

function resetDbState() {
  for (const key of Object.keys(dbResponses)) delete dbResponses[key];
  for (const key of Object.keys(dbCalls)) delete dbCalls[key];
}

describe('buyer user routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();

    getVerifiedClaimsMock.mockResolvedValue({
      tenant_id: 'tenant-1',
      role: 'seller_admin',
      sub: 'user-1',
      location_ids: null,
    });
    getFlagMock.mockResolvedValue(true);
    generateLinkMock.mockResolvedValue({
      data: {
        user: { id: 'auth-user-1' },
        properties: { action_link: 'http://localhost:3000/auth/v1/verify?token=invite-token' },
      },
      error: null,
    });
    sendSetupPasswordInviteEmailMock.mockResolvedValue(undefined);
  });

  it('creates, updates, soft-deletes, and invites buyer users', async () => {
    dbResponses['app.buyers:select'] = [{ data: { id: 'buyer-1' } }];
    dbResponses['app.buyer_users:select'] = [
      { data: null },
      { data: { id: 'user-1', buyer_id: 'buyer-1' } },
      { data: null },
      { data: { id: 'user-1', buyer_id: 'buyer-1', email: 'amit@example.com' } },
      {
        data: {
          id: 'user-1',
          buyer_id: 'buyer-1',
          email: 'amit@example.com',
          first_name: 'Amit',
          last_name: 'Sharma',
        },
      },
    ];
    dbResponses['app.tenants:select'] = [{ data: { business_name: 'Acme Distribution' } }];
    dbResponses['app.buyer_users:insert'] = [{
      data: {
        id: 'user-1',
        first_name: 'Amit',
        last_name: 'Sharma',
        phone: '9876543210',
      },
    }];
    dbResponses['app.buyer_users:update'] = [
      { data: { id: 'user-1', first_name: 'Amit', last_name: 'Sharma' } },
      { data: { id: 'user-1', first_name: 'Amit', last_name: 'Sharma' } },
    ];

    const createResponse = await POST(
      new NextRequest('http://localhost:3000/api/customers/buyer-1/users', {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'Amit',
          last_name: 'Sharma',
          phone: '9876543210',
          email: 'amit@example.com',
          designation: 'Owner',
        }),
      }),
      { params: Promise.resolve({ id: 'buyer-1' }) },
    );
    expect(createResponse.status).toBe(201);

    const createPayload = dbCalls['app.buyer_users:insert']?.payload ?? {};
    expect(createPayload).toMatchObject({
      buyer_id: 'buyer-1',
      first_name: 'Amit',
      last_name: 'Sharma',
      phone: '9876543210',
      email: 'amit@example.com',
      designation: 'Owner',
      is_active: true,
    });

    const updateResponse = await PUT(
      new NextRequest('http://localhost:3000/api/customers/buyer-1/users/user-1', {
        method: 'PUT',
        body: JSON.stringify({
          first_name: 'Amit',
          last_name: 'Sharma',
          phone: '9876543211',
          email: 'amit@example.com',
          designation: 'Purchase lead',
        }),
      }),
      { params: Promise.resolve({ id: 'buyer-1', userId: 'user-1' }) },
    );
    expect(updateResponse.status).toBe(200);

    const updatePayload = dbCalls['app.buyer_users:update']?.payload ?? {};
    expect(updatePayload).toMatchObject({
      first_name: 'Amit',
      last_name: 'Sharma',
      phone: '9876543211',
      designation: 'Purchase lead',
      updated_by: 'user-1',
    });

    const deleteResponse = await DELETE(
      new NextRequest('http://localhost:3000/api/customers/buyer-1/users/user-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'buyer-1', userId: 'user-1' }) },
    );
    expect(deleteResponse.status).toBe(200);

    const deletePayload = dbCalls['app.buyer_users:update']?.payload ?? {};
    expect(deletePayload).toMatchObject({
      is_active: false,
      updated_by: 'user-1',
    });

    const inviteResponse = await INVITE(
      new NextRequest('http://localhost:3000/api/customers/buyer-1/users/user-1/invite', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'buyer-1', userId: 'user-1' }) },
    );
    expect(inviteResponse.status).toBe(200);

    expect(generateLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'invite',
        email: 'amit@example.com',
        options: expect.objectContaining({
          redirectTo: 'http://localhost:3000/setup-password',
          data: {
            tenant_id: 'tenant-1',
            buyer_id: 'buyer-1',
            buyer_user_id: 'user-1',
          },
        }),
      }),
    );
    expect(sendSetupPasswordInviteEmailMock).toHaveBeenCalledWith({
      to: 'amit@example.com',
      inviteUrl: 'http://localhost:3000/auth/v1/verify?token=invite-token',
      tenantName: 'Acme Distribution',
      recipientName: 'Amit Sharma',
    });
    expect(dbCalls['app.buyer_users:update']?.payload).toMatchObject({
      user_id: 'auth-user-1',
      is_active: true,
      updated_by: 'user-1',
    });
  });
});
