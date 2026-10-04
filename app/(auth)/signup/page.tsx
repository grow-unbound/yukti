import { SellerOnlyAuthSurfaceNotice } from '@/components/auth/SellerOnlyAuthSurfaceNotice';
import { SignupPageClient } from '@/components/auth/SignupPageClient';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export default async function SignupPage() {
  const surface = await resolveAuthSurfaceFromHeaders();
  if (surface.surface !== 'supplier_workspace') {
    return (
      <SellerOnlyAuthSurfaceNotice
        surface={surface}
        title="Create Supplier workspace"
      />
    );
  }

  return <SignupPageClient />;
}
