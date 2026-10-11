import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, getMock, setMock, deleteMock, findPendingMock, sendActivationOtpMock, mintSessionMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  getMock: vi.fn(),
  setMock: vi.fn(),
  deleteMock: vi.fn(),
  findPendingMock: vi.fn(),
  sendActivationOtpMock: vi.fn(),
  mintSessionMock: vi.fn(),
}));

vi.mock('@/lib/server/buyer-otp-store', () => ({
  buyerOtpStore: {
    insert: (...args: unknown[]) => insertMock(...args),
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
  hashOtp: (otp: string) => `hashed:${otp}`,
}));

vi.mock('@/lib/server/seller-team-activation', () => ({
  findPendingSellerActivationsByPhone: (...args: unknown[]) => findPendingMock(...args),
  mintSellerActivationSession: (...args: unknown[]) => mintSessionMock(...args),
}));

vi.mock('@/lib/server/whatsapp', () => ({
  sendActivationOtpWhatsapp: (...args: unknown[]) => sendActivationOtpMock(...args),
}));

describe('seller activation routes', () => {
  beforeEach(() => {
    insertMock.mockReset();
    getMock.mockReset();
    setMock.mockReset();
    deleteMock.mockReset();
    findPendingMock.mockReset();
    sendActivationOtpMock.mockReset();
    mintSessionMock.mockReset();
  });

  it('sends an activation OTP for a single pending invite', async () => {
    findPendingMock.mockResolvedValue([{
      id: 'membership-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Acme Traders',
      tenant_slug: 'acme',
      user_id: 'user-1',
      role: 'seller_assistant',
      full_name: 'Ravi Kumar',
      email: 'ravi@example.com',
      phone: '9876543210',
      invited_at: '2026-07-27T00:00:00.000Z',
    }]);
    insertMock.mockResolvedValue('ref-123');
    sendActivationOtpMock.mockResolvedValue(undefined);

    const { POST } = await import('../../../app/api/auth/activate/send/route');
    const response = await POST(new Request('http://localhost/api/auth/activate/send', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: '9876543210' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ref_id).toBe('ref-123');
    expect(sendActivationOtpMock).toHaveBeenCalledWith('9876543210', expect.any(String));
  });

  it('rejects activation OTP sends from buyer surfaces', async () => {
    const { POST } = await import('../../../app/api/auth/activate/send/route');
    const response = await POST(new Request('http://catalog.localhost/api/auth/activate/send', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: '9876543210' }),
      headers: { 'Content-Type': 'application/json', host: 'catalog.localhost' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(403);
    expect(findPendingMock).not.toHaveBeenCalled();
    expect(sendActivationOtpMock).not.toHaveBeenCalled();
  });

  it('verifies the OTP and returns a temporary session', async () => {
    getMock.mockResolvedValue({
      kind: 'pending',
      otp: '123456',
      phone: '9876543210',
      expiresAt: Date.now() + 60_000,
      attempts: 0,
      candidates: [],
    });
    findPendingMock.mockResolvedValue([{
      id: 'membership-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Acme Traders',
      tenant_slug: 'acme',
      user_id: 'user-1',
      role: 'seller_assistant',
      full_name: 'Ravi Kumar',
      email: 'ravi@example.com',
      phone: '9876543210',
      invited_at: '2026-07-27T00:00:00.000Z',
    }]);
    mintSessionMock.mockResolvedValue({
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
      user: { id: 'user-1' },
    });

    const { POST } = await import('../../../app/api/auth/activate/verify/route');
    const response = await POST(new Request('http://localhost/api/auth/activate/verify', {
      method: 'POST',
      body: JSON.stringify({ ref_id: 'ref-123', otp: '123456' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.context.email).toBe('ravi@example.com');
    expect(body.session.access_token).toBe('access-token');
    expect(deleteMock).toHaveBeenCalledWith('ref-123');
  });

  it('rejects activation OTP verification from buyer surfaces', async () => {
    const { POST } = await import('../../../app/api/auth/activate/verify/route');
    const response = await POST(new Request('http://catalog.localhost/api/auth/activate/verify', {
      method: 'POST',
      body: JSON.stringify({ ref_id: 'ref-123', otp: '123456' }),
      headers: { 'Content-Type': 'application/json', host: 'catalog.localhost' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
    expect(mintSessionMock).not.toHaveBeenCalled();
  });
});
