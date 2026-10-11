import { NextRequest, NextResponse } from 'next/server';
import { loadPublicTenantBrandingBySubdomain } from '@/lib/server/public-tenant-branding';

export async function GET(request: NextRequest) {
  const subdomain = request.nextUrl.searchParams.get('subdomain')?.trim() ?? '';
  if (!subdomain) {
    return NextResponse.json({ branding: null });
  }

  const branding = await loadPublicTenantBrandingBySubdomain(subdomain);
  return NextResponse.json({ branding });
}
