import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { FEATURE_FLAGS } from '@/constants';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { supabaseAdmin } from '@/lib/supabase';
import { getSellerLocationScope } from '@/lib/server/seller-location-access';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';

export const dynamic = 'force-dynamic';

const EntryTypeSchema = z.enum([
  'business_approval',
  'new_user_login',
  'new_enquiry',
  'new_order_confirmation',
  'order_dispatch_needed',
  'invoice_due',
  'invoice_overdue',
  'credit_limit_breach',
  'whatsapp_buyer_message',
  'email_buyer_message',
]);

const QuerySchema = z.object({
  status: z.enum(['active', 'resolved', 'all']).default('active'),
  q: z.string().trim().max(120).default(''),
  type: z.string().trim().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().optional(),
});

function decodeCursor(cursor: string | undefined): { priority_at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') return null;
    const value = decoded as { priority_at?: unknown; id?: unknown };
    if (typeof value.priority_at !== 'string' || typeof value.id !== 'string') return null;
    return { priority_at: value.priority_at, id: value.id };
  } catch {
    return null;
  }
}

function encodeCursor(row: { priority_at: string; id: string }): string {
  return Buffer.from(JSON.stringify(row)).toString('base64url');
}

export async function GET(request: NextRequest) {
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const parsed = QuerySchema.safeParse({
      status: request.nextUrl.searchParams.get('status') ?? undefined,
      q: request.nextUrl.searchParams.get('q') ?? undefined,
      type: request.nextUrl.searchParams.get('type') ?? undefined,
      limit: request.nextUrl.searchParams.get('limit') ?? undefined,
      cursor: request.nextUrl.searchParams.get('cursor') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' }, { status: 400 });
    }

    const typeValues = parsed.data.type
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const entryTypes = typeValues.length > 0 ? z.array(EntryTypeSchema).safeParse(typeValues) : null;
    if (entryTypes && !entryTypes.success) {
      return NextResponse.json({ error: 'Invalid entry type' }, { status: 400 });
    }

    const locationScope = getSellerLocationScope(claims);
    if (locationScope.mode === 'none') {
      return NextResponse.json({ entries: [], nextCursor: null }, { headers: SELLER_CACHE_PERSONAL });
    }

    const cursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }

    const { data, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc('list_entries', {
        p_tenant_id: claims.tenant_id,
        p_location_ids: locationScope.mode === 'subset' ? locationScope.locationIds : null,
        p_status_scope: parsed.data.status,
        p_entry_types: entryTypes?.success ? entryTypes.data : null,
        p_search: parsed.data.q || null,
        p_limit: parsed.data.limit + 1,
        p_cursor_priority_at: cursor?.priority_at ?? null,
        p_cursor_id: cursor?.id ?? null,
        // DB re-verifies the actor is a seller_admin; approval-request entries are hidden otherwise.
        p_actor_user_id: claims.sub,
      });

    if (error) {
      console.error('[GET /api/tenant/entries] list_entries failed', error);
      return NextResponse.json({ error: 'Failed to fetch entries' }, { status: 500 });
    }

    const [whatsappInboxEnabled, emailInboxEnabled] = await Promise.all([
      getFlag(FEATURE_FLAGS.WHATSAPP_INBOX, claims.tenant_id),
      getFlag(FEATURE_FLAGS.EMAIL_INBOX, claims.tenant_id),
    ]);
    const rows = ((data ?? []) as Array<{ id: string; priority_at: string; entry_type?: string } & Record<string, unknown>>)
      .filter((row) => whatsappInboxEnabled || row.entry_type !== 'whatsapp_buyer_message')
      .filter((row) => emailInboxEnabled || row.entry_type !== 'email_buyer_message');
    const entries = rows.slice(0, parsed.data.limit);
    const last = entries[entries.length - 1];
    const nextCursor = rows.length > parsed.data.limit && last
      ? encodeCursor({ id: last.id, priority_at: last.priority_at })
      : null;

    return NextResponse.json({ entries, nextCursor }, { headers: SELLER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/tenant/entries]', error);
    return NextResponse.json({ error: 'Failed to load entries' }, { status: 500 });
  }
}
