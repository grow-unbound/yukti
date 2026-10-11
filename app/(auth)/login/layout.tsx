import { ReactNode } from 'react';
import { sellerPageTitle, SELLER_PAGE_TITLES } from '@/lib/page-titles';
import { AuthLoginChrome } from '@/components/auth/AuthLoginChrome';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export const metadata = sellerPageTitle(SELLER_PAGE_TITLES.login);

export default async function LoginLayout({ children }: { children: ReactNode }) {
  const initialSurface = await resolveAuthSurfaceFromHeaders();

  return <AuthLoginChrome initialSurface={initialSurface}>{children}</AuthLoginChrome>;
}
