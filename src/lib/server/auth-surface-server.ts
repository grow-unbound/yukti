import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { resolveAuthSurface, type AuthSurfaceInfo } from '@/lib/auth-surface';

export function resolveAuthSurfaceFromRequest(request: NextRequest): AuthSurfaceInfo {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return resolveAuthSurface(host, `${proto}:`);
}

export async function resolveAuthSurfaceFromHeaders(): Promise<AuthSurfaceInfo> {
  const headerList = await headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? '';
  const proto = headerList.get('x-forwarded-proto') ?? 'https';
  return resolveAuthSurface(host, `${proto}:`);
}

export function requireSupplierWorkspaceSurface(request: NextRequest): NextResponse | null {
  const surface = resolveAuthSurfaceFromRequest(request);
  if (surface.surface === 'supplier_workspace') return null;

  return NextResponse.json(
    { error: 'This action is only available from the Supplier workspace login.' },
    { status: 403 },
  );
}
