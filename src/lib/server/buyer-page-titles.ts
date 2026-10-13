import { cache } from 'react';
import { supabaseAdmin } from '@/lib/supabase';

async function loadCategoryTitleForTenant(tenantId: string, categoryId: string): Promise<string | null> {
  if (!supabaseAdmin || !categoryId.trim()) return null;

  const { data } = await supabaseAdmin
    .schema('app')
    .from('tenant_categories')
    .select('name')
    .eq('tenant_id', tenantId)
    .eq('id', categoryId)
    .is('deleted_at', null)
    .maybeSingle();

  const name = data?.name as string | null;
  return name?.trim() || null;
}

async function loadBrandTitleForTenant(tenantId: string, brandId: string): Promise<string | null> {
  if (!supabaseAdmin || !brandId.trim()) return null;

  const { data } = await supabaseAdmin
    .schema('app')
    .from('tenant_brands')
    .select('display_name_override, master_brand_id')
    .eq('tenant_id', tenantId)
    .eq('id', brandId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!data) return null;
  const override = data.display_name_override as string | null;
  if (override?.trim()) return override.trim();

  const masterBrandId = data.master_brand_id as string | null;
  if (!masterBrandId) return null;

  const { data: master } = await supabaseAdmin
    .schema('catalog')
    .from('brands')
    .select('name')
    .eq('id', masterBrandId)
    .maybeSingle();

  const masterName = master?.name as string | null;
  return masterName?.trim() || null;
}

async function loadProductTitleForTenant(tenantId: string, tenantProductId: string): Promise<string | null> {
  if (!supabaseAdmin || !tenantProductId.trim()) return null;

  const { data } = await supabaseAdmin
    .schema('app')
    .from('tenant_products')
    .select('name_override, internal_sku, master_product_id')
    .eq('tenant_id', tenantId)
    .eq('id', tenantProductId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!data) return null;
  const override = data.name_override as string | null;
  if (override?.trim()) return override.trim();

  const masterProductId = data.master_product_id as string | null;
  if (masterProductId) {
    const { data: master } = await supabaseAdmin
      .schema('catalog')
      .from('products')
      .select('name')
      .eq('id', masterProductId)
      .maybeSingle();
    const masterName = master?.name as string | null;
    if (masterName?.trim()) return masterName.trim();
  }

  const sku = data.internal_sku as string | null;
  return sku?.trim() || null;
}

/**
 * Tenant-scoped variants for the guest ISR tree (app/(buyer-guest)/buy/g/...)
 * — take `tenantId` from the `[tenantSlug]`-resolved route param instead of
 * `headers()`, so calling these never forces the page dynamic.
 */
export const loadBuyerCategoryTitleForTenant = cache(loadCategoryTitleForTenant);
export const loadBuyerBrandTitleForTenant = cache(loadBrandTitleForTenant);
export const loadBuyerProductTitleForTenant = cache(loadProductTitleForTenant);

