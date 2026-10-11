'use client';

import { ReactNode } from 'react';
import { AUTH_LOGIN_COPY } from '@/constants/auth-login-copy';
import { useAuthSurface } from '@/hooks/useAuthSurface';
import type { AuthSurfaceInfo } from '@/lib/auth-surface';

export function AuthLoginChrome({
  children,
  initialSurface,
}: {
  children: ReactNode;
  initialSurface: AuthSurfaceInfo;
}) {
  const year = new Date().getFullYear();
  const surface = useAuthSurface(initialSurface);
  const isTenantBuyer = surface.surface === 'tenant_buyer_catalog';
  const { homeHref, supportHelpPrefix, supportWhatsAppDisplay, supportWhatsAppHref } =
    AUTH_LOGIN_COPY.login;

  return (
    <div className="fixed inset-0 z-10 flex min-h-dvh flex-col overflow-y-auto bg-cream-50">
      <main className="flex flex-1 items-center justify-center px-3 py-4 sm:px-6 sm:py-6">
        <div className="w-full max-w-md">{children}</div>
      </main>

      <footer className="shrink-0 space-y-1 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-caption text-cream-600">
        {isTenantBuyer ? (
          <p>
            Powered by{' '}
            <a
              href={homeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-ember-400 transition-colors hover:text-ember-500"
            >
              Yukti
            </a>
          </p>
        ) : (
          <p>
            {supportHelpPrefix}{' '}
            <a
              href={supportWhatsAppHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-ember-400 transition-colors hover:text-ember-500"
            >
              {supportWhatsAppDisplay}
            </a>
          </p>
        )}
        <p>
          <a
            href={homeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-cream-800"
          >
            © {year} Yukti
          </a>
        </p>
      </footer>
    </div>
  );
}
