'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabaseBrowser as supabase } from '@/lib/supabase-browser';
import { clearAuthClientStorage, getSessionExpiredRedirectPath } from '@/lib/auth-session';
import { type Role } from '@/constants';
import { clearClientAuthSnapshot, setClientAuthSnapshot } from '@/lib/auth-client-store';
import { clearApiAuthCache } from '@/lib/api-fetch';
import posthog from 'posthog-js';
import { resolveUserDisplayName } from '@/lib/user-display-name';
import { catalogOriginForRequest, parseRequestHost } from '@/lib/storefront-host';
import { decodeJwtPayloadClient } from '@/lib/jwt-client';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  phone?: string;
}

export interface TenantProfile {
  id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  location_ids?: string[] | null;
  tenant_name?: string | null;
  tenant_slug?: string | null;
  is_active: boolean;
  public_catalog_live?: boolean;
  storefront_url?: string;
}

export interface BuyerProfile {
  id: string;
  buyer_id: string;
  user_id: string;
  role: 'buyer_admin' | 'buyer_assistant';
  is_active: boolean;
}

export interface AuthContextType {
  session: Session | null;
  user: AuthUser | null;
  tenantProfile: TenantProfile | null;
  buyerProfiles: BuyerProfile[];
  currentTenantId: string | null;
  currentBuyerId: string | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  signOut: () => Promise<void>;
  switchTenant: (tenantId: string) => void;
  switchBuyer: (buyerId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

type SessionClaims = {
  tenantId: string | null;
  buyerId: string | null;
  role: Role | null;
  locationIds: string[] | null;
};

function resolveUserPhone(user: Session['user']): string | undefined {
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const metadataPhone = typeof metadata?.phone === 'string' ? metadata.phone.trim() : '';
  if (metadataPhone.length > 0) return metadataPhone;

  const metadataPhoneNumber = typeof metadata?.phone_number === 'string' ? metadata.phone_number.trim() : '';
  if (metadataPhoneNumber.length > 0) return metadataPhoneNumber;

  return user.phone?.trim() || undefined;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenantProfile, setTenantProfile] = useState<TenantProfile | null>(null);
  const [buyerProfiles, setBuyerProfiles] = useState<BuyerProfile[]>([]);
  const [currentTenantId, setCurrentTenantId] = useState<string | null>(null);
  const [currentBuyerId, setCurrentBuyerId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const manualSignOutRef = React.useRef(false);
  const manualSignOutRedirectRef = React.useRef<string | null>(null);
  const claimsKeyRef = React.useRef<string | null>(null);
  const tenantProfileRef = React.useRef<TenantProfile | null>(null);

  const resetAuthState = () => {
    clearAuthClientStorage();
    clearApiAuthCache();
    clearClientAuthSnapshot();
    setSession(null);
    setUser(null);
    setTenantProfile(null);
    tenantProfileRef.current = null;
    setBuyerProfiles([]);
    setCurrentTenantId(null);
    setCurrentBuyerId(null);
  };

  const redirectToLogin = () => {
    if (typeof window === 'undefined') return;
    window.location.replace('/login');
  };

  const manualSignOutRedirectTarget = async () => {
    if (typeof window === 'undefined') return '/login';
    const hostKind = parseRequestHost(window.location.hostname);
    if (hostKind.kind !== 'tenant') return '/login';

    const profile = tenantProfileRef.current;
    if (profile?.public_catalog_live === true) return '/';
    if (profile?.public_catalog_live === false) return `${catalogOriginForRequest(window.location.host)}/login`;

    try {
      const res = await fetch(`/api/public/tenant-branding?slug=${encodeURIComponent(hostKind.slug)}`, {
        cache: 'no-store',
      });
      const data = (await res.json()) as { is_live?: boolean };
      return data.is_live === false ? `${catalogOriginForRequest(window.location.host)}/login` : '/';
    } catch {
      return '/';
    }
  };

  const readSessionClaims = (activeSession: Session): SessionClaims => {
    const claims = decodeJwtPayloadClient(activeSession.access_token);
    const tenantId = typeof claims?.tenant_id === 'string' ? claims.tenant_id : null;
    const buyerId = typeof claims?.buyer_id === 'string' ? claims.buyer_id : null;
    const roleClaim = claims?.user_role ?? claims?.role;
    const role = typeof roleClaim === 'string' ? (roleClaim as Role) : null;
    const locationIds = Array.isArray(claims?.location_ids)
      ? claims.location_ids.filter((entry): entry is string => typeof entry === 'string')
      : null;

    return { tenantId, buyerId, role, locationIds };
  };

  const identifyForAnalytics = (activeSession: Session, claims: SessionClaims) => {
    if (!activeSession.user.id) return;

    posthog.identify(activeSession.user.id, {
      email: activeSession.user.email,
      tenant_id: claims.tenantId,
      role: claims.role,
      location_ids: claims.locationIds,
    });

    // Super properties — auto-included in every subsequent event as event properties,
    // enabling per-tenant filtering in PostHog custom endpoints and queries.
    posthog.register({
      tenant_id: claims.tenantId ?? undefined,
      buyer_id: claims.buyerId ?? undefined,
      role: claims.role ?? undefined,
    });

    if (claims.tenantId) {
      posthog.group('tenant', claims.tenantId);
    }
  };

  const shouldHydrateWorkspace = (claims: SessionClaims) => {
    if (!claims.tenantId) return false;
    if (!claims.role) return false;
    if (!tenantProfileRef.current) return true;
    return tenantProfileRef.current.tenant_id !== claims.tenantId
      || tenantProfileRef.current.role !== claims.role
      || !tenantProfileRef.current.tenant_name
      || !tenantProfileRef.current.tenant_slug;
  };

  const hydrateWorkspace = async (activeSession: Session, claims: SessionClaims) => {
    const response = await fetch('/api/tenant/current', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${activeSession.access_token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Workspace initialization failed (${response.status})`);
    }

    const payload = (await response.json()) as {
      tenant?: {
        id: string;
        slug: string;
        business_name: string;
      };
      role?: string;
      public_catalog_live?: boolean;
      storefront_url?: string;
    };

    const tenant = payload.tenant;
    if (!tenant?.id) {
      setTenantProfile(null);
      tenantProfileRef.current = null;
      setCurrentTenantId(null);
      return;
    }

    const nextProfile = {
      id: tenant.id,
      tenant_id: tenant.id,
      user_id: activeSession.user.id,
      role: (payload.role as Role | undefined) ?? claims.role ?? 'seller_assistant',
      location_ids: claims.locationIds,
      tenant_name: tenant.business_name,
      tenant_slug: tenant.slug,
      is_active: true,
      public_catalog_live: payload.public_catalog_live === true,
      storefront_url: payload.storefront_url,
    };
    setTenantProfile(nextProfile);
    tenantProfileRef.current = nextProfile;
    setCurrentTenantId(tenant.id);
  };

  // Initialize auth session
  useEffect(() => {
    const syncClientSnapshot = (activeSession: Session | null) => {
      if (!activeSession?.access_token) {
        clearApiAuthCache();
        clearClientAuthSnapshot();
        return;
      }

      setClientAuthSnapshot({ accessToken: activeSession.access_token });
    };

    const primeWorkspaceFromToken = (activeSession: Session) => {
      const claims = readSessionClaims(activeSession);

      if (claims.tenantId) {
        setCurrentTenantId(claims.tenantId);
      } else {
        setCurrentTenantId(null);
      }

      setCurrentBuyerId(claims.buyerId);

      if (!claims.tenantId || !claims.role) {
        setTenantProfile(null);
        tenantProfileRef.current = null;
        return claims;
      }

      const previous = tenantProfileRef.current;
      const nextProfile = {
        id: previous?.id ?? claims.tenantId!,
        tenant_id: claims.tenantId!,
        user_id: activeSession.user.id,
        role: claims.role!,
        location_ids: claims.locationIds,
        tenant_name: previous?.tenant_name ?? null,
        tenant_slug: previous?.tenant_slug ?? null,
        is_active: true,
        public_catalog_live: previous?.public_catalog_live,
        storefront_url: previous?.storefront_url,
      };
      setTenantProfile(nextProfile);
      tenantProfileRef.current = nextProfile;

      return claims;
    };

    const maybeHydrateWorkspace = (activeSession: Session, claims: SessionClaims) => {
      if (!shouldHydrateWorkspace(claims)) return;

      void hydrateWorkspace(activeSession, claims).catch((err) => {
        setIsError(true);
        setError(err instanceof Error ? err : new Error('Workspace initialization failed'));
      });
    };

    const initializeAuth = async () => {
      try {
        setIsLoading(true);
        const {
          data: { session: currentSession },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) throw sessionError;

        setSession(currentSession);
        syncClientSnapshot(currentSession);

        if (currentSession?.user) {
          setUser({
            id: currentSession.user.id,
            email: currentSession.user.email || '',
            displayName: resolveUserDisplayName(
              currentSession.user.user_metadata as Record<string, unknown> | undefined,
              currentSession.user.email,
              currentSession.user.email || 'Team member',
            ),
            phone: resolveUserPhone(currentSession.user),
          });
          const claims = primeWorkspaceFromToken(currentSession);
          claimsKeyRef.current = `${claims.tenantId ?? ''}:${claims.role ?? ''}:${claims.buyerId ?? ''}`;
          identifyForAnalytics(currentSession, claims);
          maybeHydrateWorkspace(currentSession, claims);
        }
      } catch (err) {
        setIsError(true);
        setError(err instanceof Error ? err : new Error('Auth initialization failed'));
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();

    // Subscribe to auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      setSession(newSession);
      syncClientSnapshot(newSession);
      if (newSession?.user) {
        setUser({
          id: newSession.user.id,
          email: newSession.user.email || '',
          displayName: resolveUserDisplayName(
            newSession.user.user_metadata as Record<string, unknown> | undefined,
            newSession.user.email,
            newSession.user.email || 'Team member',
          ),
          phone: resolveUserPhone(newSession.user),
        });
        const previousClaimsKey = claimsKeyRef.current;
        const claims = primeWorkspaceFromToken(newSession);
        const nextClaimsKey = `${claims.tenantId ?? ''}:${claims.role ?? ''}:${claims.buyerId ?? ''}`;
        claimsKeyRef.current = nextClaimsKey;
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          setIsError(false);
          setError(null);
          identifyForAnalytics(newSession, claims);
          if (previousClaimsKey !== nextClaimsKey || shouldHydrateWorkspace(claims)) {
            // A different identity/tenant/role is now active — any cached query data
            // was fetched under the PREVIOUS claims and would render as stale/wrong
            // content until a hard refresh. Ordinary TOKEN_REFRESHED events for the
            // same claims never reach here, so this doesn't cause refetch churn during
            // normal background token refresh.
            //
            // Deliberately NOT gated on event === 'SIGNED_IN' anymore -- that branch
            // was redundant for a genuine first sign-in (claimsKeyRef starts null, so
            // previousClaimsKey !== nextClaimsKey already catches it) and was the
            // actual cause of a real, reported bug: Supabase's GoTrue client can
            // re-emit SIGNED_IN around session-recovery checks it runs on tab
            // visibility/focus and near token expiry, even when the session's
            // identity hasn't changed at all. That unconditional branch was nuking
            // every cached query on ordinary tab-switches and idle periods, forcing
            // every visible detail pane back to its loading skeleton -- ordinary
            // TanStack Query background revalidation (the whole point of caching)
            // never got a chance to just quietly serve stale-then-fresh data. The
            // claims-key/workspace check alone still catches every real identity
            // change, including true first sign-in.
            queryClient.clear();
            maybeHydrateWorkspace(newSession, claims);
          }
        }
      } else {
        const wasManualSignOut = manualSignOutRef.current;
        manualSignOutRef.current = false;

        if (
          event === 'SIGNED_OUT' &&
          typeof window !== 'undefined'
        ) {
          if (wasManualSignOut) {
            const redirectTarget = manualSignOutRedirectRef.current ?? '/login';
            manualSignOutRedirectRef.current = null;
            resetAuthState();
            window.location.replace(redirectTarget);
            return;
          }

          resetAuthState();

          // Supabase fires a SIGNED_OUT-shaped event even for a client that
          // never had a session at all (e.g. GoTrue's initial state check on
          // a fresh guest visit) — not just for an actually-expired one. A
          // tenant storefront host has a real guest mode (public catalog,
          // no session required), so treat "no session" there as the normal
          // steady state, not an expiry to redirect out of. app.useyukti.in
          // and catalog.useyukti.in have no guest mode — every page there
          // does require ending up authenticated, so keep the redirect.
          const hostKind = parseRequestHost(window.location.hostname);
          if (hostKind.kind === 'tenant') {
            return;
          }

          window.location.assign(getSessionExpiredRedirectPath(window.location.pathname));
          return;
        }

        resetAuthState();
      }
    });

    return () => subscription?.unsubscribe();
  }, []);

  const signOut = async () => {
    manualSignOutRef.current = true;
    posthog.reset();
    const redirectTarget = await manualSignOutRedirectTarget();
    manualSignOutRedirectRef.current = redirectTarget;
    queryClient.clear();
    const { error } = await supabase.auth.signOut();
    if (error) {
      // GoTrue rejected the token (e.g. already expired) — clear local cookies only.
      // This avoids a 403 blocking the logout flow.
      await supabase.auth.signOut({ scope: 'local' } as any);
    }
    manualSignOutRedirectRef.current = null;
    window.location.replace(redirectTarget);
  };

  const switchTenant = (tenantId: string) => {
    setCurrentTenantId(tenantId);
  };

  const switchBuyer = async (buyerId: string) => {
    const res = await fetch('/api/auth/switch-buyer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyer_id: buyerId }),
    });
    const data: {
      session?: { access_token: string; refresh_token: string };
      error?: string;
    } = await res.json();
    if (!res.ok || !data.session) {
      throw new Error(data.error ?? 'Failed to switch buyer account');
    }
    await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    setCurrentBuyerId(buyerId);
    void queryClient.invalidateQueries({ queryKey: ['buyer-me'] });
  };

  const value: AuthContextType = {
    session,
    user,
    tenantProfile,
    buyerProfiles,
    currentTenantId,
    currentBuyerId,
    isLoading,
    isError,
    error,
    signOut,
    switchTenant,
    switchBuyer,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
