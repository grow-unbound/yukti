import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabase } from '@/lib/supabase';
import { requireBuyerAccessProfile } from '@/lib/server/buyer-access';
import { BUYER_CACHE_PERSONAL } from '@/lib/server/buyer-cache-headers';
import { effectiveInvoiceStatus, hasInvoiceReceivableExposure } from '@/lib/invoice-status';
import { PAGE_SIZE, encodeCursor, decodeCursor } from '@/lib/pagination';

export interface BuyerInvoice {
  id: string;
  invoice_number: string;
  status: string;
  total_amount: number;
  outstanding_balance: number | null;
  invoice_date: string;
  due_date: string | null;
}

export interface BuyerInvoicesResponse {
  invoices: BuyerInvoice[];
  nextCursor: string | null;
  total: number | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: string;
  total_amount: number;
  outstanding_balance: number | null;
  invoice_date: string;
  due_date: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse<BuyerInvoicesResponse>> {
  try {
    const profile = await requireBuyerAccessProfile(request, { slim: true });
    if (!profile?.context.tenant_id) {
      return NextResponse.json({ invoices: [], nextCursor: null, total: null }, { status: 401 });
    }

    // Defense-in-depth: requireBuyerAccessProfile deliberately lets a
    // `buyer_pending` session read its own row, but this route uses the
    // service-role client for the actual invoices read, bypassing RLS
    // entirely. Matches the pattern in app/api/buyer/orders/route.ts.
    // Seller preview bypasses buyer_app_enabled (see buyer-access.ts) — a
    // preview session must be allowed through even for a pending/disabled buyer.
    if (profile.context.mode !== 'preview' && profile.buyer && profile.buyer.buyer_app_enabled === false) {
      return NextResponse.json({ invoices: [], nextCursor: null, total: null }, { status: 403 });
    }

    if (profile.context.mode === 'preview' && !profile.context.buyer_id) {
      return NextResponse.json({ invoices: [], nextCursor: null, total: null });
    }

    if (!profile.buyer?.id) {
      return NextResponse.json({ invoices: [], nextCursor: null, total: null }, { status: 401 });
    }

    const { tenant_id } = profile.context;
    const buyer_id = profile.buyer.id;
    const db = supabaseAdmin ?? supabase;
    const { searchParams } = request.nextUrl;
    const reqLimit = Math.min(Number(searchParams.get('limit') ?? PAGE_SIZE.BUYER), PAGE_SIZE.MAX);
    const cursorParam = searchParams.get('cursor');
    const unpaidOnly = searchParams.get('unpaid_only') === 'true';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .schema('app')
      .from('invoices')
      .select('id, invoice_number, status, total_amount, outstanding_balance, invoice_date, due_date')
      .eq('tenant_id', tenant_id)
      .eq('buyer_id', buyer_id)
      .is('deleted_at', null)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(reqLimit + 1);

    if (unpaidOnly) {
      query = query.gt('outstanding_balance', 0);
    }

    if (cursorParam) {
      const { created_at, id } = decodeCursor(cursorParam);
      query = query.or(`invoice_date.lt.${created_at},and(invoice_date.eq.${created_at},id.lt.${id})`);
    }

    const [{ data, error }, countRes] = await Promise.all([
      query,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .schema('app')
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant_id)
        .eq('buyer_id', buyer_id)
        .is('deleted_at', null),
    ]);

    if (error) {
      console.warn('[buyer/invoices] GET error:', error.message);
      return NextResponse.json({ invoices: [], nextCursor: null, total: null });
    }

    const rawRows = (data ?? []) as InvoiceRow[];
    const hasNextPage = rawRows.length > reqLimit;
    let rows = hasNextPage ? rawRows.slice(0, reqLimit) : rawRows;
    // The DB-level `.gt('outstanding_balance', 0)` above is a cheap pre-filter only;
    // it doesn't check status, so a `void` invoice with a stray positive balance
    // would otherwise slip through. Apply the canonical receivable predicate too.
    if (unpaidOnly) {
      rows = rows.filter((inv) => hasInvoiceReceivableExposure({ status: inv.status, outstanding_balance: inv.outstanding_balance }));
    }
    const lastRow = rows.at(-1);
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor({ created_at: lastRow.invoice_date, id: lastRow.id })
      : null;

    const invoices: BuyerInvoice[] = rows.map((inv) => ({
      id: inv.id,
      invoice_number: inv.invoice_number,
      status: effectiveInvoiceStatus({
        status: inv.status,
        due_date: inv.due_date,
        outstanding_balance: inv.outstanding_balance != null ? Number(inv.outstanding_balance) : null,
      }),
      total_amount: Number(inv.total_amount ?? 0),
      outstanding_balance: inv.outstanding_balance != null ? Number(inv.outstanding_balance) : null,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date ?? null,
    }));

    return NextResponse.json(
      { invoices, nextCursor, total: (countRes as { count: number | null }).count ?? null },
      { headers: BUYER_CACHE_PERSONAL },
    );
  } catch (err) {
    console.error('[buyer/invoices] Unexpected error:', err);
    return NextResponse.json({ invoices: [], nextCursor: null, total: null });
  }
}
