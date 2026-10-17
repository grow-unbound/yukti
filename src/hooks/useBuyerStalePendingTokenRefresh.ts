'use client';

import { useEffect, useRef } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { readAccessTokenRole } from '@/lib/jwt-client';
import type { BuyerMeData } from '@/hooks/useBuyerMe';

const ATTEMPT_KEY = 'buyer-pending-token-refresh-attempted';

/**
 * `/api/buyer/me` reads buyer_app_enabled live, but the session token's role is only recomputed
 * (custom_access_token_hook) when the token is issued or refreshed. A buyer approved after sign-in
 * keeps a `buyer_pending` token, so gated routes (estimate/invoice detail, catalog, ...) 403 with
 * "Approval required" until it refreshes. True when /me says approved but the token says pending.
 */
export function isStaleBuyerPendingSession(
  me: Pick<BuyerMeData, 'mode'> | undefined,
  accessToken: string | null | undefined,
): boolean {
  return me?.mode === 'buyer' && readAccessTokenRole(accessToken) === 'buyer_pending';
}

function readAttempted(): boolean {
  try {
    return window.sessionStorage.getItem(ATTEMPT_KEY) === '1';
  } catch {
    return false;
  }
}

function markAttempted(): void {
  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, '1');
  } catch {
    // Storage blocked: the in-memory ref below still bounds this to one attempt per mount.
  }
}

function clearAttempted(): void {
  try {
    window.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // ignore
  }
}

/**
 * Self-heal a stale `buyer_pending` token: refresh the session once (re-runs the hook, so the role
 * is recomputed from app.buyers) and reload so middleware, SSR and gated routes see the new token.
 * Attempted at most once per tab session and only reloads when the refreshed role is no longer
 * pending, so an account that is genuinely still pending can never reload-loop.
 */
export function useBuyerStalePendingTokenRefresh(me: Pick<BuyerMeData, 'mode'> | undefined): void {
  const attemptedRef = useRef(false);
  // Depend on the mode only: /me refetches must not cancel a refresh that is already in flight.
  const mode = me?.mode;

  useEffect(() => {
    if (mode !== 'buyer') return;
    if (attemptedRef.current || readAttempted()) return;

    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabaseBrowser.auth.getSession();
        if (cancelled || !isStaleBuyerPendingSession({ mode }, data.session?.access_token)) return;

        attemptedRef.current = true;
        markAttempted();
        const { data: refreshed, error } = await supabaseBrowser.auth.refreshSession();
        if (cancelled || error) return;
        if (readAccessTokenRole(refreshed.session?.access_token) === 'buyer_pending') return;

        clearAttempted();
        window.location.reload();
      } catch {
        // Best effort: the token still refreshes on its own at expiry.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode]);
}
