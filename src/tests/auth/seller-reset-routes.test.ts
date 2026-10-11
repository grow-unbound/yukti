import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  insertMock,
  getMock,
  setMock,
  deleteMock,
  findResetCandidatesMock,
  sendResetOtpMock,
  mintResetSessionMock,
} = vi.hoisted(() => ({
  insertMock: vi.fn(),
  getMock: vi.fn(),
  setMock: vi.fn(),
  deleteMock: vi.fn(),
  findResetCandidatesMock: vi.fn(),
  sendResetOtpMock: vi.fn(),
  mintResetSessionMock: vi.fn(),
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
  findSellerPasswordResetCandidatesByPhone: (...args: unknown[]) => findResetCandidatesMock(...args),
  mintSellerPasswordResetSession: (...args: unknown[]) => mintResetSessionMock(...args),
}));

vi.mock('@/lib/server/whatsapp', () => ({
  sendResetOtpWhatsapp: (...args: unknown[]) => sendResetOtpMock(...args),
}));

describe('seller reset routes', () => {
  beforeEach(() => {
    insertMock.mockReset();
    getMock.mockReset();
    setMock.mockReset();
    deleteMock.mockReset();
    findResetCandidatesMock.mockReset();
    sendResetOtpMock.mockReset();
    mintResetSessionMock.mockReset();
  });

  it('sends a reset OTP for a single seller account', async () => {
    findResetCandidatesMock.mockResolvedValue([{
      id: 'membership-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Acme Traders',
      tenant_slug: 'acme',
      user_id: 'user-1',
      role: 'seller_admin',
      full_name: 'Ravi Kumar',
      email: 'ravi@example.com',
      phone: '9876543210',
    }]);
    insertMock.mockResolvedValue('ref-123');
    sendResetOtpMock.mockResolvedValue(undefined);

    const { POST } = await import('../../../app/api/auth/reset/send/route');
    const response = await POST(new Request('http://localhost/api/auth/reset/send', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: '9876543210' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ref_id).toBe('ref-123');
    expect(sendResetOtpMock).toHaveBeenCalledWith('9876543210', expect.any(String));
  });

  it('rejects reset OTP sends from buyer surfaces', async () => {
    const { POST } = await import('../../../app/api/auth/reset/send/route');
    const response = await POST(new Request('http://catalog.localhost/api/auth/reset/send', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: '9876543210' }),
      headers: { 'Content-Type': 'application/json', host: 'catalog.localhost' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(403);
    expect(findResetCandidatesMock).not.toHaveBeenCalled();
    expect(sendResetOtpMock).not.toHaveBeenCalled();
  });

  it('verifies the reset OTP and returns a temporary session', async () => {
    getMock.mockResolvedValue({
      kind: 'pending',
      otp: '123456',
      phone: '9876543210',
      expiresAt: Date.now() + 60_000,
      attempts: 0,
      candidates: [],
    });
    findResetCandidatesMock.mockResolvedValue([{
      id: 'membership-1',
      tenant_id: 'tenant-1',
      tenant_name: 'Acme Traders',
      tenant_slug: 'acme',
      user_id: 'user-1',
      role: 'seller_admin',
      full_name: 'Ravi Kumar',
      email: 'ravi@example.com',
      phone: '9876543210',
    }]);
    mintResetSessionMock.mockResolvedValue({
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
      user: { id: 'user-1' },
    });

    const { POST } = await import('../../../app/api/auth/reset/verify/route');
    const response = await POST(new Request('http://localhost/api/auth/reset/verify', {
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

  it('rejects reset OTP verification from buyer surfaces', async () => {
    const { POST } = await import('../../../app/api/auth/reset/verify/route');
    const response = await POST(new Request('http://catalog.localhost/api/auth/reset/verify', {
      method: 'POST',
      body: JSON.stringify({ ref_id: 'ref-123', otp: '123456' }),
      headers: { 'Content-Type': 'application/json', host: 'catalog.localhost' },
    }) as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
    expect(mintResetSessionMock).not.toHaveBeenCalled();
  });
});
