import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getSession = vi.fn();
const refreshSession = vi.fn();
vi.mock('@/lib/supabase-browser', () => ({
  supabaseBrowser: { auth: { getSession: (...a: unknown[]) => getSession(...a), refreshSession: (...a: unknown[]) => refreshSession(...a) } },
}));

import {
  isStaleBuyerPendingSession,
  useBuyerStalePendingTokenRefresh,
} from '@/hooks/useBuyerStalePendingTokenRefresh';

function tokenWithRole(role: string, claim: 'user_role' | 'role' = 'user_role'): string {
  const payload = Buffer.from(JSON.stringify({ [claim]: role })).toString('base64url');
  return `h.${payload}.s`;
}

const reload = vi.fn();

describe('isStaleBuyerPendingSession', () => {
  it('is true only when /me says buyer but the token role is buyer_pending', () => {
    expect(isStaleBuyerPendingSession({ mode: 'buyer' }, tokenWithRole('buyer_pending'))).toBe(true);
    expect(isStaleBuyerPendingSession({ mode: 'buyer' }, tokenWithRole('buyer_admin'))).toBe(false);
    expect(isStaleBuyerPendingSession({ mode: 'pending' }, tokenWithRole('buyer_pending'))).toBe(false);
    expect(isStaleBuyerPendingSession({ mode: 'preview' }, tokenWithRole('buyer_pending'))).toBe(false);
    expect(isStaleBuyerPendingSession(undefined, tokenWithRole('buyer_pending'))).toBe(false);
    expect(isStaleBuyerPendingSession({ mode: 'buyer' }, 'not-a-jwt')).toBe(false);
    expect(isStaleBuyerPendingSession({ mode: 'buyer' }, null)).toBe(false);
  });
});

describe('useBuyerStalePendingTokenRefresh', () => {
  beforeEach(() => {
    getSession.mockReset();
    refreshSession.mockReset();
    reload.mockReset();
    window.sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
  });

  it('refreshes the session once and reloads when the refreshed role is no longer pending', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: tokenWithRole('buyer_pending') } } });
    refreshSession.mockResolvedValue({ data: { session: { access_token: tokenWithRole('buyer_admin') } }, error: null });

    const { rerender } = renderHook(({ mode }) => useBuyerStalePendingTokenRefresh({ mode }), {
      initialProps: { mode: 'buyer' as const },
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    rerender({ mode: 'buyer' });
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the token role is already approved', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: tokenWithRole('buyer_admin') } } });
    renderHook(() => useBuyerStalePendingTokenRefresh({ mode: 'buyer' }));
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(refreshSession).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not run for pending, guest or preview sessions', async () => {
    for (const mode of ['pending', 'guest', 'preview'] as const) {
      renderHook(() => useBuyerStalePendingTokenRefresh({ mode }));
    }
    await Promise.resolve();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('never reloads (no loop) when the refreshed token is still buyer_pending, and does not retry', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: tokenWithRole('buyer_pending') } } });
    refreshSession.mockResolvedValue({ data: { session: { access_token: tokenWithRole('buyer_pending') } }, error: null });

    renderHook(() => useBuyerStalePendingTokenRefresh({ mode: 'buyer' }));
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();

    renderHook(() => useBuyerStalePendingTokenRefresh({ mode: 'buyer' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the refresh errors', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: tokenWithRole('buyer_pending') } } });
    refreshSession.mockResolvedValue({ data: { session: null }, error: new Error('rate limited') });
    renderHook(() => useBuyerStalePendingTokenRefresh({ mode: 'buyer' }));
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();
  });
});
