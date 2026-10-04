import { ForgotPasswordPageClient } from '@/components/auth/ForgotPasswordPageClient';
import { SellerOnlyAuthSurfaceNotice } from '@/components/auth/SellerOnlyAuthSurfaceNotice';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export default async function ForgotPasswordPage() {
  const surface = await resolveAuthSurfaceFromHeaders();
  if (surface.surface !== 'supplier_workspace') {
    return (
      <SellerOnlyAuthSurfaceNotice
        surface={surface}
        title="Reset Supplier workspace password"
      />
    );
  }

  return <ForgotPasswordPageClient />;
}
