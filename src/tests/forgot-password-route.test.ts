import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sendMock = vi.fn();
const captureMock = vi.fn();

vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => captureMock(...a) }));
vi.mock('@/lib/server/email', () => ({ sendPasswordRecoveryEmail: (...a: unknown[]) => sendMock(...a) }));
vi.mock('@/lib/server/auth-surface-server', () => ({ requireSupplierWorkspaceSurface: () => null }));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: { admin: { generateLink: async () => ({ data: { properties: { action_link: 'https://x/reset' } }, error: null }) } },
  },
}));

import { POST } from '../../app/api/auth/forgot-password/route';

function req() {
  return new NextRequest('https://app.example.com/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'A@b.com' }),
  });
}

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => { sendMock.mockReset(); captureMock.mockReset(); });

  it('returns success and reports to Sentry when the email provider rejects', async () => {
    sendMock.mockRejectedValue(new Error('domain not verified'));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('returns success when the email sends', async () => {
    sendMock.mockResolvedValue(undefined);
    expect((await POST(req())).status).toBe(200);
    expect(captureMock).not.toHaveBeenCalled();
  });
});
