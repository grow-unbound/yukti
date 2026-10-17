import { withBuyerContextRevalidation } from '@/lib/server/buyer-context-cache';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { BuyerCsvRowSchema } from '@/lib/zod';

interface RowResult {
  row: Record<string, string>;
  rowIndex: number;
  valid: boolean;
  error?: string;
}

async function POSTImpl(request: NextRequest) {
  const claims = await getVerifiedClaims(request);

  if (!claims.tenant_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (claims.role !== 'seller_admin') {
    return NextResponse.json({ error: 'Forbidden: seller_admin only' }, { status: 403 });
  }

  const flagEnabled = await getFlag('df_customer_master', claims.tenant_id);
  if (!flagEnabled) {
    return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !('rows' in body) ||
    !Array.isArray((body as { rows: unknown }).rows)
  ) {
    return NextResponse.json({ error: 'Body must have a "rows" array' }, { status: 400 });
  }

  const rawRows = (body as { rows: Array<Record<string, string>> }).rows;

  // Phase 1: validate each row with schema
  const results: RowResult[] = rawRows.map((row, idx) => {
    const parsed = BuyerCsvRowSchema.safeParse(row);
    if (!parsed.success) {
      return {
        row,
        rowIndex: idx + 1,
        valid: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid row',
      };
    }
    return { row, rowIndex: idx + 1, valid: true };
  });

  // Phase 2: intra-batch phone dedup
  const phonesSeen = new Map<string, number>(); // phone -> first rowIndex
  for (const result of results) {
    if (!result.valid) continue;
    const phone = (result.row.phone ?? '').trim();
    if (phonesSeen.has(phone)) {
      result.valid = false;
      result.error = `Duplicate phone in batch (first seen at row ${phonesSeen.get(phone)})`;
    } else {
      phonesSeen.set(phone, result.rowIndex);
    }
  }

  // Phase 3: check existing phones in DB for this tenant
  const validPhones = results.filter((r) => r.valid).map((r) => (r.row.phone ?? '').trim());

  if (validPhones.length > 0) {
    const db = supabaseAdmin as any; // schema() not on TS interface; mirrors existing API pattern
    const { data: existingRows } = await db
      .schema('app')
      .from('buyers')
      .select('phone')
      .eq('tenant_id', claims.tenant_id)
      .in('phone', validPhones)
      .is('is_active', true);

    const existingPhones = new Set<string>(
      (existingRows ?? []).map((r: { phone: string }) => r.phone),
    );

    for (const result of results) {
      if (!result.valid) continue;
      const phone = (result.row.phone ?? '').trim();
      if (existingPhones.has(phone)) {
        result.valid = false;
        result.error = 'Phone number already exists in your customer list';
      }
    }
  }

  // Phase 4: insert valid rows
  const toInsert = results.filter((r) => r.valid);
  let inserted = 0;

  if (toInsert.length > 0) {
    const db = supabaseAdmin as any; // schema() not on TS interface; mirrors existing API pattern

    const insertRows = toInsert.map((r) => {
      const parsed = BuyerCsvRowSchema.parse(r.row);
      return {
        tenant_id: claims.tenant_id,
        business_name: parsed.business_name,
        contact_name: parsed.contact_name || null,
        phone: parsed.phone,
        email: parsed.email || null,
        gstin: parsed.gstin || null,
        geography:
          parsed.city || parsed.state || parsed.pincode || parsed.zone
            ? {
                city: parsed.city || null,
                state: parsed.state || null,
                pincode: parsed.pincode || null,
                zone: parsed.zone || null,
              }
            : null,
        tier: parsed.tier || null,
        credit_limit: parsed.credit_limit,
        payment_terms_days: parsed.payment_terms_days,
        external_ref: parsed.external_ref || null,
        is_active: true,
      };
    });

    const { error: insertError } = await db.schema('app').from('buyers').insert(insertRows);

    if (!insertError) {
      inserted = toInsert.length;
    } else {
      // Mark all as failed if batch insert fails
      for (const r of toInsert) {
        r.valid = false;
        r.error = 'Database insert failed';
      }
    }
  }

  return NextResponse.json({
    results: results.map((r) => ({
      rowIndex: r.rowIndex,
      valid: r.valid,
      error: r.error,
    })),
    inserted,
  });
}

export const POST = withBuyerContextRevalidation(POSTImpl);
