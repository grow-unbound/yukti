import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { z } from 'zod';

const BrandUpsertSchema = z.object({
  tenant_brand_id: z.string().uuid().optional(),
  master_brand_id: z.string().uuid().optional(),
  name: z.string().min(1, 'Brand name is required'),
  display_name_override: z.string().optional(),
  description_override: z.string().optional(),
  logo_url_override: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  margin_pct: z.coerce.number().min(0).max(100).nullable().optional(),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function requireSellerClaims(req: NextRequest) {
  const claims = await getVerifiedClaims(req);

  if (!claims.tenant_id) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  if (!claims.role?.startsWith('seller_')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { claims };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireSellerClaims(req);
    if (auth.error) return auth.error;
    const { claims } = auth;

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any;
    const { data, error } = await db
      .schema('app')
      .from('tenant_brands')
      .select(`
        id,
        tenant_id,
        master_brand_id,
        display_name_override,
        description_override,
        logo_url_override,
        margin_pct,
        exclusivity,
        is_active,
        external_ref,
        created_at,
        updated_at
      `)
      .eq('tenant_id', claims.tenant_id)
      .is('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/tenant/brands] DB error:', error.code, error.message, error.details);
      return NextResponse.json(
        { error: 'Failed to fetch brands', code: error.code, detail: error.message },
        { status: 500 },
      );
    }

    const masterBrandIds = (data ?? []).map((row: { master_brand_id: string }) => row.master_brand_id);
    let masterBrands: Record<string, { id: string; name: string; slug: string; logo_url: string | null; description: string | null }> = {};

    if (masterBrandIds.length > 0) {
      const { data: catalogBrands } = await db
        .schema('catalog')
        .from('brands')
        .select('id, name, slug, logo_url, description')
        .in('id', masterBrandIds);

      masterBrands = Object.fromEntries(
        (catalogBrands ?? []).map((b: { id: string; name: string; slug: string; logo_url: string | null; description: string | null }) => [b.id, b])
      );
    }

    const brands = (data ?? []).map((row: {
      id: string;
      tenant_id: string;
      master_brand_id: string;
      display_name_override: string | null;
      description_override: string | null;
      logo_url_override: string | null;
      margin_pct: number | null;
      exclusivity: boolean | null;
      is_active: boolean;
      external_ref: string | null;
      created_at: string;
      updated_at: string;
    }) => ({
      ...row,
      master_brand: masterBrands[row.master_brand_id] ?? null,
    }));

    return NextResponse.json({ brands });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireSellerClaims(req);
    if (auth.error) return auth.error;
    const { claims } = auth;

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const body = await req.json();
    const parsed = BrandUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', details: parsed.error.flatten() }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any;
    const {
      master_brand_id,
      name,
      display_name_override,
      description_override,
      logo_url_override,
      margin_pct,
    } = parsed.data;

    let resolvedMasterBrandId = master_brand_id;

    if (!resolvedMasterBrandId) {
      let slug = slugify(name);
      if (!slug) {
        slug = `brand-${Date.now()}`;
      }

      const { data: insertedBrand, error: brandError } = await db
        .schema('catalog')
        .from('brands')
        .insert({
          name,
          slug,
          description: description_override ?? null,
          logo_url: logo_url_override || null,
          is_public: true,
          origin_tenant_id: claims.tenant_id,
          created_by: claims.tenant_id,
          updated_by: claims.tenant_id,
        })
        .select('id')
        .single();

      if (brandError) {
        if (brandError.code === '23505') {
          return NextResponse.json({ error: 'A brand with this slug already exists.' }, { status: 409 });
        }
        console.error('[POST /api/tenant/brands] Failed to create catalog brand:', brandError);
        return NextResponse.json({ error: 'Failed to create brand' }, { status: 500 });
      }

      resolvedMasterBrandId = insertedBrand.id;
    }

    const { data: existing } = await db
      .schema('app')
      .from('tenant_brands')
      .select('id')
      .eq('tenant_id', claims.tenant_id)
      .eq('master_brand_id', resolvedMasterBrandId)
      .is('is_active', true)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ error: 'Brand already in your catalog' }, { status: 409 });
    }

    const { data: inserted, error: insertError } = await db
      .schema('app')
      .from('tenant_brands')
      .insert({
        tenant_id: claims.tenant_id,
        master_brand_id: resolvedMasterBrandId,
        display_name_override: display_name_override?.trim() ? display_name_override : null,
        description_override: description_override?.trim() ? description_override : null,
        logo_url_override: logo_url_override?.trim() ? logo_url_override : null,
        margin_pct: margin_pct ?? null,
        is_active: true,
        created_by: claims.tenant_id,
        updated_by: claims.tenant_id,
      })
      .select('*')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json({ error: 'Brand already in your catalog' }, { status: 409 });
      }
      console.error('[POST /api/tenant/brands] DB error:', insertError.code, insertError.message);
      return NextResponse.json({ error: 'Failed to add brand' }, { status: 500 });
    }

    await db.schema('app').rpc('refresh_brand_embedding', { p_brand_id: resolvedMasterBrandId });

    const { data: masterBrand } = await db
      .schema('catalog')
      .from('brands')
      .select('id, name, slug, logo_url, description')
      .eq('id', resolvedMasterBrandId)
      .maybeSingle();

    return NextResponse.json({ brand: { ...inserted, master_brand: masterBrand ?? null } }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/tenant/brands] Unexpected error:', err);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireSellerClaims(req);
    if (auth.error) return auth.error;
    const { claims } = auth;

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const body = await req.json();
    const parsed = BrandUpsertSchema.safeParse(body);
    if (!parsed.success || !parsed.data.tenant_brand_id) {
      return NextResponse.json({ error: 'Invalid request body', details: parsed.success ? undefined : parsed.error.flatten() }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any;
    const {
      tenant_brand_id,
      name,
      display_name_override,
      description_override,
      logo_url_override,
      margin_pct,
    } = parsed.data;

    const { data: existingBrand, error: existingError } = await db
      .schema('app')
      .from('tenant_brands')
      .select('id, master_brand_id')
      .eq('id', tenant_brand_id)
      .eq('tenant_id', claims.tenant_id)
      .maybeSingle();

    if (existingError || !existingBrand) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
    }

    const { data: updated, error: updateError } = await db
      .schema('app')
      .from('tenant_brands')
      .update({
        display_name_override: display_name_override?.trim() ? display_name_override : null,
        description_override: description_override?.trim() ? description_override : null,
        logo_url_override: logo_url_override?.trim() ? logo_url_override : null,
        margin_pct: margin_pct ?? null,
        updated_by: claims.tenant_id,
      })
      .eq('id', tenant_brand_id)
      .eq('tenant_id', claims.tenant_id)
      .select('*')
      .single();

    if (updateError) {
      console.error('[PATCH /api/tenant/brands] DB error:', updateError.code, updateError.message);
      return NextResponse.json({ error: 'Failed to update brand' }, { status: 500 });
    }

    if (!display_name_override?.trim() && name.trim()) {
      await db
        .schema('catalog')
        .from('brands')
        .update({
          name: name.trim(),
          updated_by: claims.tenant_id,
        })
        .eq('id', existingBrand.master_brand_id)
        .eq('origin_tenant_id', claims.tenant_id);
    }

    await db.schema('app').rpc('refresh_brand_embedding', { p_brand_id: existingBrand.master_brand_id });

    const { data: masterBrand } = await db
      .schema('catalog')
      .from('brands')
      .select('id, name, slug, logo_url, description')
      .eq('id', existingBrand.master_brand_id)
      .maybeSingle();

    return NextResponse.json({ brand: { ...updated, master_brand: masterBrand ?? null } });
  } catch (err) {
    console.error('[PATCH /api/tenant/brands] Unexpected error:', err);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
