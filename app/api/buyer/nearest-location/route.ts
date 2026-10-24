import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { resolveNearestBuyerLocation } from '@/lib/server/buyer-routing';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';

export const dynamic = 'force-dynamic';

export interface NearestLocationResponse {
  warehouse_id: string | null;
  warehouse_name: string | null;
  location_id: string | null;
  location_name: string | null;
  distance_km: number | null;
  fallback: boolean;
}

export async function GET(req: NextRequest): Promise<NextResponse<NearestLocationResponse>> {
  const profile = await requireBuyerAccessProfile(req, { slim: true });
  if (!profile?.context.tenant_id) {
    return NextResponse.json({ warehouse_id: null, warehouse_name: null, location_id: null, location_name: null, distance_km: null, fallback: true });
  }

  const lat = parseFloat(req.nextUrl.searchParams.get('lat') ?? '');
  const lng = parseFloat(req.nextUrl.searchParams.get('lng') ?? '');
  if (!isFinite(lat) || !isFinite(lng)) {
    return NextResponse.json({ warehouse_id: null, warehouse_name: null, location_id: null, location_name: null, distance_km: null, fallback: true });
  }

  const db = supabaseAdmin;
  if (!db) {
    return NextResponse.json({ warehouse_id: null, warehouse_name: null, location_id: null, location_name: null, distance_km: null, fallback: true });
  }

  const tenant_id = profile.context.tenant_id;
  const resolved = await resolveNearestBuyerLocation(db as any, tenant_id, { lat, lng });
  return NextResponse.json({
    warehouse_id: resolved?.warehouseId ?? null,
    warehouse_name: resolved?.warehouseName ?? null,
    location_id: resolved?.locationId ?? null,
    location_name: resolved?.locationName ?? null,
    distance_km: resolved?.distanceKm ?? null,
    fallback: resolved?.fallback ?? true,
  }, { headers: BUYER_CACHE_PERSONAL });
}
