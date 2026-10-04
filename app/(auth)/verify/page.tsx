import { VerifyOtpPageClient } from '@/components/auth/VerifyOtpPageClient';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export default async function VerifyPage() {
  const initialSurface = await resolveAuthSurfaceFromHeaders();

  return <VerifyOtpPageClient initialSurface={initialSurface} />;
}
