import { ActivatePageClient } from '@/components/auth/ActivatePageClient';
import { SellerOnlyAuthSurfaceNotice } from '@/components/auth/SellerOnlyAuthSurfaceNotice';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export default async function ActivatePage() {
  const surface = await resolveAuthSurfaceFromHeaders();
  if (surface.surface !== 'supplier_workspace') {
    return (
      <SellerOnlyAuthSurfaceNotice
        surface={surface}
        title="Activate Supplier workspace account"
      />
    );
  }

  return <ActivatePageClient />;
}
