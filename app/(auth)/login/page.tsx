import { LoginFormWithSuspense } from '@/components/auth/LoginForm';
import { resolveAuthSurfaceFromHeaders } from '@/lib/server/auth-surface-server';

export default async function LoginPage() {
  const initialSurface = await resolveAuthSurfaceFromHeaders();

  return <LoginFormWithSuspense initialSurface={initialSurface} />;
}
