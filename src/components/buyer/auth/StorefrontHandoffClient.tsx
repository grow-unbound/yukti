'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthHomeLogoLink } from '@/components/auth/AuthHomeLogoLink';
import { TenantLogo } from '@/components/brand/TenantLogo';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { markLoggedInOnDevice } from '@/lib/auth-device-login';

/** Same-origin-only path check — the server already validated `next` resolves
 * to this exact host before minting the link (buildStorefrontHandoffUrl /
 * safeReturnToPath), this is just a belt-and-braces client-side guard against
 * a malformed or tampered value before using it for navigation. */
function safeLocalPath(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export interface StorefrontHandoffBranding {
  businessName: string;
  logoUrl: string | null;
}

function StorefrontHandoffInner({ branding }: { branding: StorefrontHandoffBranding | null }) {
  const searchParams = useSearchParams();
  const tokenHash = searchParams.get('token_hash');
  const destination = safeLocalPath(searchParams.get('next'));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tokenHash) {
      setError('Missing or invalid link.');
      return;
    }

    let cancelled = false;

    (async () => {
      const { error: verifyError } = await supabaseBrowser.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'magiclink',
      });

      if (cancelled) return;

      if (verifyError) {
        setError('This link has expired or already been used. Please log in again.');
        return;
      }

      markLoggedInOnDevice();
      window.location.assign(destination);
    })();

    return () => {
      cancelled = true;
    };
  }, [tokenHash, destination]);

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-page)] px-4">
      <div className="bg-white border border-cream-300 rounded-xl shadow-md p-8 max-w-sm w-full text-center">
        <div className="mb-5 flex justify-center">
          {branding ? (
            <TenantLogo name={branding.businessName} logoUrl={branding.logoUrl} size={64} />
          ) : (
            <AuthHomeLogoLink />
          )}
        </div>
        {error ? (
          <>
            <p className="text-body-sm text-danger-600 font-medium mb-4">{error}</p>
            <a href="/login" className="text-caption text-ember-400 hover:text-ember-500 font-medium">
              Back to login
            </a>
          </>
        ) : branding ? (
          <>
            <p className="text-body-sm font-semibold text-cream-900">Signing you in to {branding.businessName}</p>
            <p className="mt-1 text-caption text-cream-600">Powered by Yukti</p>
          </>
        ) : (
          <p className="text-body-sm text-cream-600">Signing you in…</p>
        )}
      </div>
    </div>
  );
}

export function StorefrontHandoffClient({ branding }: { branding: StorefrontHandoffBranding | null }) {
  return (
    <Suspense fallback={null}>
      <StorefrontHandoffInner branding={branding} />
    </Suspense>
  );
}
