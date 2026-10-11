import { VerifyAccountPageClient } from '@/components/auth/VerifyAccountPageClient';
import { SellerOnlyAuthSurfaceNotice } from '@/components/auth/SellerOnlyAuthSurfaceNotice';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export default async function VerifyAccountPage() {
  const surface = await resolveAuthSurfaceFromHeaders();
  if (surface.surface !== 'supplier_workspace') {
    return (
      <SellerOnlyAuthSurfaceNotice
        surface={surface}
        title="Verify Supplier workspace account"
      />
    );
  }

  return <VerifyAccountPageClient />;
}
