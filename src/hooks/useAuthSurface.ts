'use client';

import { useEffect, useState } from 'react';
import {
  resolveAuthSurface,
  resolveBrowserAuthSurface,
  type AuthSurfaceInfo,
} from '@/lib/auth-surface';
import type { AuthTenantBranding } from '@/components/auth/AuthTenantBrand';

export function useAuthSurface(initialSurface?: AuthSurfaceInfo): AuthSurfaceInfo {
  const [surface, setSurface] = useState<AuthSurfaceInfo>(() => initialSurface ?? resolveAuthSurface(''));

  useEffect(() => {
    setSurface(resolveBrowserAuthSurface());
  }, []);

  return surface;
}

export function useTenantAuthBranding(tenantSlug: string | null) {
  const [branding, setBranding] = useState<AuthTenantBranding | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenantSlug) {
      setBranding(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetch(`/api/auth/tenant-branding?subdomain=${encodeURIComponent(tenantSlug)}`, {
      credentials: 'same-origin',
    })
      .then((response) => response.json() as Promise<{ branding: AuthTenantBranding | null }>)
      .then((body) => {
        if (!cancelled) setBranding(body.branding ?? null);
      })
      .catch(() => {
        if (!cancelled) setBranding(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenantSlug]);

  return { branding, loading };
}
