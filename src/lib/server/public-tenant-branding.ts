import { supabaseAdmin } from '@/lib/supabase';

export interface PublicTenantBranding {
  tenantName: string;
  tenantLogoUrl: string | null;
}

export async function loadPublicTenantBrandingBySubdomain(
  subdomain: string,
): Promise<PublicTenantBranding | null> {
  const slug = subdomain.trim().toLowerCase();
  if (!slug || !supabaseAdmin) return null;
  if (!/^[a-z0-9-]{2,63}$/.test(slug)) return null;

  const tenantResult = await supabaseAdmin
    .schema('app')
    .from('tenants')
    .select('id, business_name')
    .or(`subdomain.eq.${slug},slug.eq.${slug}`)
    .maybeSingle();

  if (tenantResult.error || !tenantResult.data) return null;

  const settingsResult = await supabaseAdmin
    .schema('app')
    .from('tenant_settings')
    .select('settings')
    .eq('tenant_id', tenantResult.data.id)
    .maybeSingle();

  const settings = settingsResult.data?.settings as Record<string, unknown> | null | undefined;
  const business = (settings?.business as Record<string, unknown> | undefined) ?? {};
  const tenantLogoUrl =
    typeof business.logo_url === 'string' && business.logo_url.trim().length > 0
      ? business.logo_url
      : null;

  return {
    tenantName: tenantResult.data.business_name || 'Your supplier',
    tenantLogoUrl,
  };
}
