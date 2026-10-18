import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getVerifiedClaims } from '@/lib/auth';
import { getFlag } from '@/lib/flags';
import { SELLER_CACHE_PERSONAL } from '@/lib/server/bounded-get';

type DbClient = NonNullable<typeof supabaseAdmin>;

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';
type AvatarHue = 'teal' | 'ember' | 'cream';
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function pickHue(seed: string): AvatarHue {
  const n = seed.charCodeAt(0) || 0;
  if (n % 3 === 0) return 'teal';
  if (n % 3 === 1) return 'ember';
  return 'cream';
}

function yearsLoyalLabel(createdAt: string | null): string {
  if (!createdAt) return '0 yrs loyal';
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const years = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365.25)));
  return `${years} yrs loyal`;
}

function formatShortDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const claims = await getVerifiedClaims(request);

    if (!claims.tenant_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const flagEnabled = await getFlag('df_customer_master', claims.tenant_id);
    if (!flagEnabled) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const db = supabaseAdmin as DbClient as any;
    const tenantId = claims.tenant_id;

    const { data: buyer, error: buyerError } = await db
      .schema('app')
      .from('buyers')
      .select(
        'id, tenant_id, business_name, contact_name, phone, email, gstin, gst_treatment, billing_address, shipping_address, is_active, buyer_app_enabled, credit_limit, payment_terms_days, default_cohort_id, geography, created_at, whatsapp_opt_out_at',
      )
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .maybeSingle();

    if (buyerError) {
      return NextResponse.json({ error: 'Failed to fetch customer' }, { status: 500 });
    }

    if (!buyer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }

    const [
      buyerUsersRes,
      cohortMembersRes,
      buyerPriceListAssignmentRes,
      snapshotRes,
      lastInvoiceRes,
      lastEstimateRes,
      lastOrderRes,
      lastBuyerAppActivityRes,
      primaryDemandKindRes,
    ] = await Promise.all([
      db
        .schema('app')
        .from('buyer_users')
        .select('id, user_id, first_name, last_name, email, phone, designation, department, is_active, created_at')
        .eq('buyer_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true }),
      db
        .schema('app')
        .from('cohort_members_active')
        .select('cohort_id')
        .eq('buyer_id', id),
      db
        .schema('app')
        .from('price_list_assignments')
        .select('price_list_id')
        .eq('target_type', 'buyer')
        .eq('target_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Live quarter/dues figures straight from invoices, estimates and orders (no metrics_* tables).
      db.schema('app').rpc('existing_buyer_context_snapshot', { p_buyer_id: id }),
      db
        .schema('app')
        .from('invoices')
        .select('total_amount, invoice_date, created_at')
        .eq('tenant_id', tenantId)
        .eq('buyer_id', id)
        .is('deleted_at', null)
        .not('status', 'in', '("draft","void")')
        .order('invoice_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .schema('app')
        .from('estimates')
        .select('estimate_date, created_at')
        .eq('tenant_id', tenantId)
        .eq('buyer_id', id)
        .is('deleted_at', null)
        .order('estimate_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .schema('app')
        .from('orders')
        .select('placed_at, created_at')
        .eq('tenant_id', tenantId)
        .eq('buyer_id', id)
        .is('deleted_at', null)
        .not('status', 'in', '("cancelled","draft")')
        .order('placed_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .schema('app')
        .from('buyer_app_activity')
        .select('occurred_at')
        .eq('tenant_id', tenantId)
        .eq('buyer_id', id)
        .is('deleted_at', null)
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.schema('app').rpc('metrics_v4_primary_demand_kind', { p_tenant_id: tenantId }),
    ]);

    if (
      buyerUsersRes.error ||
      cohortMembersRes.error ||
      buyerPriceListAssignmentRes.error ||
      snapshotRes.error ||
      lastInvoiceRes.error ||
      lastEstimateRes.error ||
      lastOrderRes.error ||
      lastBuyerAppActivityRes.error ||
      primaryDemandKindRes.error
    ) {
      console.error(
        '[GET /api/tenant/customers/[id]] bootstrap failed',
        buyerUsersRes.error ??
          cohortMembersRes.error ??
          buyerPriceListAssignmentRes.error ??
          snapshotRes.error ??
          lastInvoiceRes.error ??
          lastEstimateRes.error ??
          lastOrderRes.error ??
          lastBuyerAppActivityRes.error ??
          primaryDemandKindRes.error,
      );
      return NextResponse.json({ error: 'Failed to fetch customer detail data' }, { status: 500 });
    }

    const primaryDemandKind = (typeof primaryDemandKindRes.data === 'string' ? primaryDemandKindRes.data : 'none') as
      | 'orders'
      | 'estimates'
      | 'none';

    type Snapshot = {
      sales?: { current?: { invoice_value?: number; invoice_count?: number }; previous?: { invoice_value?: number; invoice_count?: number } };
      demand?: { current?: { value?: number; count?: number }; previous?: { value?: number; count?: number } };
      app_engagement?: { value?: number; count?: number };
      dues?: {
        receivable_amount?: number;
        receivable_invoice_count?: number;
        overdue_amount?: number;
        overdue_invoice_count?: number;
        credit_limit?: number;
        credit_available?: number;
      };
    };
    const snapshot = (snapshotRes.data ?? null) as Snapshot | null;
    const nowSummary = snapshot?.dues ?? null;
    const currentQuarter = {
      invoice_value: snapshot?.sales?.current?.invoice_value ?? 0,
      invoice_count: snapshot?.sales?.current?.invoice_count ?? 0,
      primary_demand_value: snapshot?.demand?.current?.value ?? 0,
      primary_demand_count: snapshot?.demand?.current?.count ?? 0,
      app_demand_value: snapshot?.app_engagement?.value ?? 0,
      app_demand_count: snapshot?.app_engagement?.count ?? 0,
    };
    const previousQuarter = {
      invoice_value: snapshot?.sales?.previous?.invoice_value ?? 0,
      primary_demand_value: snapshot?.demand?.previous?.value ?? 0,
    };

    function trendPct(current: number, previous: number): number | null {
      if (previous <= 0) return null;
      return Math.round(((current - previous) / previous) * 1000) / 10;
    }

    const lastInvoice = lastInvoiceRes.data as { total_amount: number; invoice_date: string | null; created_at: string } | null;
    const lastEstimate = lastEstimateRes.data as { estimate_date: string | null; created_at: string } | null;
    const lastOrder = lastOrderRes.data as { placed_at: string | null; created_at: string } | null;
    const lastBuyerAppActivity = lastBuyerAppActivityRes.data as { occurred_at: string } | null;

    const lastInvoiceAt = lastInvoice ? (lastInvoice.invoice_date ?? lastInvoice.created_at) : null;
    const lastEstimateAt = lastEstimate ? (lastEstimate.estimate_date ?? lastEstimate.created_at) : null;
    const lastOrderAt = lastOrder ? (lastOrder.placed_at ?? lastOrder.created_at) : null;
    // The ledger keeps one row per buyer per day per event, so this is the day's first event, not the last one.
    const lastBuyerAppActivityAt = lastBuyerAppActivity?.occurred_at ?? null;

    const activityCandidates: Array<{ kind: string; at: string | null }> = [
      { kind: 'sale', at: lastInvoiceAt },
      { kind: 'order', at: lastOrderAt },
      { kind: 'estimate', at: lastEstimateAt },
      { kind: 'buyer app', at: lastBuyerAppActivityAt },
    ];
    const lastActivity = activityCandidates
      .filter((candidate): candidate is { kind: string; at: string } => candidate.at != null)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0] ?? null;
    const lastActivityDaysAgo = lastActivity
      ? Math.max(0, Math.floor((Date.now() - new Date(lastActivity.at).getTime()) / (1000 * 60 * 60 * 24)))
      : null;

    const memberCohortIds = ((cohortMembersRes.data ?? []) as Array<{ cohort_id: string }>).map((row) => row.cohort_id);
    let activeCohorts: Array<{ id: string; name: string }> = [];
    if (memberCohortIds.length > 0) {
      const { data: cohortNameRows } = await db
        .schema('app')
        .from('cohorts')
        .select('id, name')
        .in('id', memberCohortIds)
        .is('deleted_at', null);
      activeCohorts = ((cohortNameRows ?? []) as Array<{ id: string; name: string }>).map((row) => ({
        id: row.id,
        name: row.name ?? 'Customer group',
      }));
    }

    const cohortFilter = memberCohortIds.length
      ? `,and(target_type.eq.cohort,target_id.in.(${memberCohortIds.join(',')}))`
      : '';
    const { data: priceListAssignmentRows, error: priceListAssignmentsError } = await db
      .schema('app')
      .from('price_list_assignments')
      .select('price_list_id, price_lists!inner(tenant_id, deleted_at)')
      .eq('price_lists.tenant_id', tenantId)
      .is('price_lists.deleted_at', null)
      .is('deleted_at', null)
      .or(`and(target_type.eq.buyer,target_id.eq.${id}),target_type.eq.all_buyers${cohortFilter}`);
    if (priceListAssignmentsError) {
      console.error('[GET /api/tenant/customers/[id]] failed to load price list assignments', priceListAssignmentsError);
      return NextResponse.json({ error: 'Failed to fetch customer detail data' }, { status: 500 });
    }
    const priceListsAssignedCount = new Set(
      ((priceListAssignmentRows ?? []) as Array<{ price_list_id: string }>).map((row) => row.price_list_id),
    ).size;

    const contacts = (buyerUsersRes.data ?? []).map((contact: any) => ({
      id: contact.id,
      user_id: contact.user_id ?? null,
      first_name: contact.first_name ?? '',
      last_name: contact.last_name ?? '',
      full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Buyer user',
      name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Buyer user',
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      designation: contact.designation ?? null,
      department: contact.department ?? null,
      is_active: Boolean(contact.is_active),
      status: !contact.is_active ? 'Inactive' : contact.user_id ? 'Active' : 'Pending invite',
    }));

    const creditLimit = Number(nowSummary?.credit_limit ?? buyer.credit_limit ?? 0);
    const creditUsed = Number(nowSummary?.receivable_amount ?? 0);
    const creditAvailable = Number(nowSummary?.credit_available ?? 0);
    const creditUsedPct = creditLimit > 0 ? Math.round((creditUsed / creditLimit) * 1000) / 10 : 0;

    const defaultPriceListId =
      (buyerPriceListAssignmentRes.data?.price_list_id as string | undefined) ?? null;
    let assignedPriceListName: string | null = null;
    if (defaultPriceListId) {
      const { data: priceList, error: priceListError } = await db
        .schema('app')
        .from('price_lists')
        .select('id, name')
        .eq('id', defaultPriceListId)
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .maybeSingle();

      if (priceListError) {
        console.error('[GET /api/tenant/customers/[id]] failed to load assigned pricelist', priceListError);
        return NextResponse.json({ error: 'Failed to fetch customer detail data' }, { status: 500 });
      }

      assignedPriceListName = (priceList?.name as string | undefined) ?? null;
    }

    const response = {
      header: {
        id: buyer.id,
        buyer_name: buyer.business_name,
        initials: getInitials(buyer.business_name),
        hue: pickHue(buyer.business_name),
        status_label: buyer.is_active ? 'Active' : 'Inactive',
        status_tone: (buyer.is_active ? 'success' : 'neutral') as StatusTone,
        buyer_app_enabled: Boolean(buyer.buyer_app_enabled),
        whatsapp_opted_out: Boolean(buyer.whatsapp_opt_out_at),
        city: buyer.geography?.city ?? 'Unknown',
        buyer_since: buyer.created_at,
        years_label: yearsLoyalLabel(buyer.created_at),
        net_terms_days: Number(buyer.payment_terms_days ?? 0),
        subtitle_meta: {
          buyer_app_status_label: buyer.buyer_app_enabled ? 'Buyer App enabled' : 'Buyer App disabled',
          city: typeof buyer.geography?.city === 'string' ? buyer.geography.city : null,
          phone: buyer.phone ?? null,
          last_activity_at: lastActivity?.at ?? null,
          last_activity_kind: lastActivity?.kind ?? null,
          last_activity_days_ago: lastActivityDaysAgo,
          last_activity_date_label: formatShortDate(lastActivity?.at ?? null),
        },
      },
      meta_strip_4: {
        sales_qtd_value: Number(currentQuarter.invoice_value ?? 0),
        sales_qtd_count: Number(currentQuarter.invoice_count ?? 0),
        sales_qtd_trend_pct: trendPct(Number(currentQuarter.invoice_value ?? 0), Number(previousQuarter.invoice_value ?? 0)),
        receivable_amount: Number(nowSummary?.receivable_amount ?? 0),
        receivable_invoice_count: Number(nowSummary?.receivable_invoice_count ?? 0),
        overdue_amount: Number(nowSummary?.overdue_amount ?? 0),
        overdue_invoice_count: Number(nowSummary?.overdue_invoice_count ?? 0),
        primary_demand_kind: primaryDemandKind,
        demand_qtd_value: Number(currentQuarter.primary_demand_value ?? 0),
        demand_qtd_count: Number(currentQuarter.primary_demand_count ?? 0),
        demand_qtd_trend_pct: trendPct(Number(currentQuarter.primary_demand_value ?? 0), Number(previousQuarter.primary_demand_value ?? 0)),
        app_engagement_value: Number(currentQuarter.app_demand_value ?? 0),
        app_engagement_count: Number(currentQuarter.app_demand_count ?? 0),
        credit_used: creditUsed,
        credit_available: creditAvailable,
        credit_limit: creditLimit,
        credit_used_pct: creditUsedPct,
      },
      details: {
        business_name: buyer.business_name,
        contact_name: buyer.contact_name,
        phone: buyer.phone,
        email: buyer.email,
        gstin: buyer.gstin,
        gst_treatment: buyer.gst_treatment ?? null,
        city: buyer.geography?.city ?? null,
        state: buyer.geography?.state ?? null,
        pincode: buyer.geography?.pincode ?? null,
        zone: buyer.geography?.zone ?? null,
        billing_address: buyer.billing_address ?? null,
        shipping_address: buyer.shipping_address ?? null,
        payment_terms_days: buyer.payment_terms_days,
        credit_limit: buyer.credit_limit,
        default_price_list_id: defaultPriceListId,
        assigned_price_list: assignedPriceListName,
        buyer_users: contacts,
        contacts,
        default_cohort_id: buyer.default_cohort_id,
        cohorts: activeCohorts.map((cohort) => cohort.name),
        is_active: buyer.is_active,
        buyer_app_enabled: Boolean(buyer.buyer_app_enabled),
      },
      performance: {
        monthly_spend_trend: [],
        order_frequency: [],
        brand_mix: [],
        top_skus: [],
        price_list_summary: [],
      },
      tab_badges: {
        price_lists_assigned: priceListsAssignedCount,
      },
      cohorts_summary: {
        rows: activeCohorts.map((cohort) => ({
          id: cohort.id,
          name: cohort.name,
          member_count: 1,
        })),
      },
      price_lists: {
        assigned_count: priceListsAssignedCount,
      },
      role: claims.role,
    };

    return NextResponse.json(response, { headers: SELLER_CACHE_PERSONAL });
  } catch (error) {
    console.error('[GET /api/tenant/customers/[id]]', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
