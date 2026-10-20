import type { JWTClaims } from '@/lib/auth';
import { canAccessPulse } from '@/lib/server/pulse-access';
import { supabaseAdmin } from '@/lib/supabase';
import type { SellerDashboardMetricsV4 } from '@/types/seller-dashboard';
import type {
  PulseContributionCard,
  PulseContributionResponse,
  PulseOpportunityBuyerPage,
  PulseOpportunityGroup,
  PulseOpportunityPreview,
  PulseOpportunitiesResponse,
} from '@/types/pulse';

// Pulse is tenant-scoped and seller_admin only: every read below is keyed by the verified
// tenant id and never narrowed to a location subset.

export function emptyPulseContribution(): PulseContributionResponse {
  return {
    source: 'app.get_landing_metrics_v4',
    computed_at: null,
    source_watermark: null,
    freshness_label: null,
    primary_demand_kind: 'none',
    cards: [],
  };
}

const SUMMARY_OPPORTUNITY_SOURCE = 'app.metrics_buyer_period_summary' as const;
const SUMMARY_OPPORTUNITY_CANDIDATE_LIMIT = 300;
const SUMMARY_OPPORTUNITY_PAGE_LIMIT = 100;

/** Same cut-off as the app's "Dormant 90+ days" last-order bucket (last invoice older than 90 days). */
export const PULSE_DORMANT_DAYS = 90;
/** Minimum invoiced value over the trailing 12 months for a dormant buyer to count as valuable. */
export const PULSE_DORMANT_MIN_VALUE = 10_000;
const PULSE_DORMANT_PREVIEW_LIMIT = 5;
const PULSE_DORMANT_PAGE_LIMIT = 50;
const DORMANT_TIME_BASIS = 'Rolling 90 days';

interface PeriodBuyerRow {
  buyer_id: string;
  invoice_value?: number | string | null;
  invoice_count?: number | string | null;
  source_watermark?: string | null;
  computed_at?: string | null;
}

interface BuyerNameRow {
  id: string;
  business_name?: string | null;
}

interface SummaryOpportunityRow {
  buyer_id: string;
  name: string;
  invoice_value_qtd?: number | null;
  invoice_count_qtd?: number | null;
  last_invoice_date?: string | null;
  days_since_last_invoice?: number | null;
  value_12m?: number | null;
  supporting_text?: string | null;
  source_watermark?: string | null;
  computed_at?: string | null;
}

interface DormantBuyerRpcRow {
  buyer_id: string;
  business_name: string | null;
  last_invoice_date: string | null;
  days_since_last_invoice: number | string | null;
  value_12m: number | string | null;
  invoice_count_12m: number | string | null;
  source_watermark: string | null;
  computed_at: string | null;
  total_count: number | string | null;
  total_value_12m: number | string | null;
}

function formatInvoiceSupport(value: number | null, count: number | null) {
  const invoiceCount = count ?? 0;
  const invoiceWord = invoiceCount === 1 ? 'invoice' : 'invoices';
  return `${value != null && value > 0 ? `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}` : '₹0'} · ${invoiceCount} ${invoiceWord}`;
}

function formatCurrency(value: number) {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}`;
}

function formatDormantSupport(daysSince: number, value: number) {
  return `Last purchase ${daysSince} ${daysSince === 1 ? 'day' : 'days'} ago · ${formatCurrency(value)} last 12m`;
}

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function oldestTimestamp(...values: Array<string | null | undefined>) {
  const timestamps = values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function numericValue(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** Today's calendar date in IST as YYYY-MM-DD. Dormancy is a rolling window off this date. */
export function istDateString(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function quarterStartFor(date: Date) {
  const [year, month] = istDateString(date).split('-').map(Number);
  const quarterMonth = Math.floor((month - 1) / 3) * 3;
  return new Date(Date.UTC(year, quarterMonth, 1)).toISOString().slice(0, 10);
}

function pageSummaryRows(rows: SummaryOpportunityRow[], offset: number, limit: number) {
  const pageRows = rows.slice(offset, offset + limit);
  const nextOffset = offset + pageRows.length;
  return {
    pageRows,
    nextCursor: nextOffset < rows.length ? String(nextOffset) : null,
  };
}

function summaryPreviews(rows: SummaryOpportunityRow[]): PulseOpportunityPreview[] {
  return rows.map((row) => ({
    buyer_id: row.buyer_id,
    name: row.name,
    initials: initials(row.name),
    invoice_value_qtd: row.invoice_value_qtd ?? null,
    invoice_count_qtd: row.invoice_count_qtd ?? null,
    last_invoice_date: row.last_invoice_date ?? null,
    days_since_last_invoice: row.days_since_last_invoice ?? null,
    value_12m: row.value_12m ?? null,
    supporting_text: row.supporting_text
      ?? formatInvoiceSupport(row.invoice_value_qtd ?? null, row.invoice_count_qtd ?? null),
    href: `/customers/${row.buyer_id}`,
  }));
}

function buildActivationGroup(rows: SummaryOpportunityRow[]): PulseOpportunityGroup | null {
  const definition = opportunityDefinition('valuable_assisted_customers_without_access');
  if (!definition || rows.length === 0) return null;

  const timeBasis = 'NOW + QTD';
  const value = rows.reduce((sum, row) => sum + numericValue(row.invoice_value_qtd), 0);

  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    count: rows.length,
    time_basis: timeBasis,
    evidence: value > 0
      ? `${formatCurrency(value)} qualifying assisted business · ${timeBasis}`
      : `Qualifying assisted business · ${timeBasis}`,
    action_label: definition.action_label,
    action_href: definition.action_href,
    previews: summaryPreviews(rows.slice(0, 5)),
  };
}

function dormantEvidence(total: number, totalValue: number) {
  if (total <= 0) return '';
  return totalValue > 0
    ? `${formatCurrency(totalValue)} last-12-month value · no purchase in ${PULSE_DORMANT_DAYS}+ days`
    : `No purchase in ${PULSE_DORMANT_DAYS}+ days`;
}

function buildDormantGroup(rows: SummaryOpportunityRow[], total: number, totalValue: number): PulseOpportunityGroup | null {
  const definition = opportunityDefinition('dormant_customers_90d');
  if (!definition || total <= 0) return null;

  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    count: total,
    time_basis: DORMANT_TIME_BASIS,
    evidence: dormantEvidence(total, totalValue),
    action_label: definition.action_label,
    action_href: definition.action_href,
    previews: summaryPreviews(rows.slice(0, PULSE_DORMANT_PREVIEW_LIMIT)),
  };
}

async function loadActiveBuyerNames(
  tenantId: string,
  buyerIds: string[],
  buyerAppEnabled: boolean,
): Promise<{ rows: BuyerNameRow[] | null; error: unknown }> {
  if (buyerIds.length === 0) return { rows: [], error: null };

  const { data, error } = await (supabaseAdmin as any)
    .schema('app')
    .from('buyers')
    .select('id,business_name')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .eq('buyer_app_enabled', buyerAppEnabled)
    .is('deleted_at', null)
    .in('id', buyerIds);

  return { rows: Array.isArray(data) ? data as BuyerNameRow[] : null, error };
}

async function loadActivationSummaryRows(tenantId: string, periodStart: string) {
  const { data, error } = await (supabaseAdmin as any)
    .schema('app')
    .from('metrics_buyer_period_summary')
    .select('buyer_id,invoice_value,invoice_count,source_watermark,computed_at')
    .eq('tenant_id', tenantId)
    .eq('grain', 'quarter')
    .eq('period_start', periodStart)
    .is('deleted_at', null)
    .gt('invoice_value', 0)
    .order('invoice_value', { ascending: false })
    .range(0, SUMMARY_OPPORTUNITY_CANDIDATE_LIMIT - 1);

  if (error) return { rows: null, error };

  const periodRows = Array.isArray(data) ? data as PeriodBuyerRow[] : [];
  const { rows: buyers, error: buyerError } = await loadActiveBuyerNames(
    tenantId,
    periodRows.map((row) => row.buyer_id),
    false,
  );
  if (buyerError) return { rows: null, error: buyerError };

  const buyerNames = new Map((buyers ?? []).map((buyer) => [buyer.id, buyer.business_name || 'Customer']));
  return {
    rows: periodRows
      .filter((row) => buyerNames.has(row.buyer_id))
      .map((row) => ({
        buyer_id: row.buyer_id,
        name: buyerNames.get(row.buyer_id) ?? 'Customer',
        invoice_value_qtd: numericValue(row.invoice_value),
        invoice_count_qtd: numericValue(row.invoice_count),
        source_watermark: row.source_watermark ?? null,
        computed_at: row.computed_at ?? null,
      })),
    error: null,
  };
}

/**
 * Rolling-window dormancy: active buyers whose last invoice day is more than PULSE_DORMANT_DAYS
 * before today (IST), ranked by trailing-12-month invoiced value. One bounded RPC over
 * app.metrics_buyer_now_summary + monthly app.metrics_buyer_period_summary rows; it returns the exact
 * total (window count) next to at most `limit` rows. No calendar-quarter dependence.
 */
async function loadDormantBuyers(tenantId: string, offset: number, limit: number, now = new Date()) {
  const { data, error } = await (supabaseAdmin as any)
    .schema('app')
    .rpc('get_pulse_dormant_buyers', {
      p_tenant_id: tenantId,
      p_as_of: istDateString(now),
      p_dormant_days: PULSE_DORMANT_DAYS,
      p_min_value: PULSE_DORMANT_MIN_VALUE,
      p_limit: limit,
      p_offset: offset,
    });

  if (error) return { rows: null, total: 0, totalValue: 0, error };

  const dbRows = Array.isArray(data) ? data as DormantBuyerRpcRow[] : [];
  const rows: SummaryOpportunityRow[] = dbRows.map((row) => {
    const days = numericValue(row.days_since_last_invoice);
    const value = numericValue(row.value_12m);
    return {
      buyer_id: row.buyer_id,
      name: row.business_name || 'Customer',
      last_invoice_date: row.last_invoice_date ?? null,
      days_since_last_invoice: days,
      value_12m: value,
      supporting_text: formatDormantSupport(days, value),
      source_watermark: row.source_watermark ?? null,
      computed_at: row.computed_at ?? null,
    };
  });
  return {
    rows,
    total: dbRows.length > 0 ? numericValue(dbRows[0].total_count) : 0,
    totalValue: dbRows.length > 0 ? numericValue(dbRows[0].total_value_12m) : 0,
    error: null,
  };
}

export async function loadPulseOpportunities(
  claims: Pick<JWTClaims, 'tenant_id' | 'role'>,
  now = new Date(),
) {
  if (!claims.tenant_id || !canAccessPulse(claims.role)) {
    return { response: null, status: 403 as const, error: null };
  }
  if (!supabaseAdmin) {
    return { response: null, status: 500 as const, error: new Error('Server configuration error') };
  }

  const [activation, dormant] = await Promise.all([
    loadActivationSummaryRows(claims.tenant_id, quarterStartFor(now)),
    loadDormantBuyers(claims.tenant_id, 0, PULSE_DORMANT_PREVIEW_LIMIT, now),
  ]);

  if (activation.error || dormant.error) {
    return { response: null, status: 500 as const, error: activation.error ?? dormant.error };
  }

  const activationRows = activation.rows ?? [];
  const dormantRows = dormant.rows ?? [];
  const groups = [
    buildActivationGroup(activationRows),
    buildDormantGroup(dormantRows, dormant.total, dormant.totalValue),
  ].filter((group): group is PulseOpportunityGroup => Boolean(group));
  const sourceWatermark = oldestTimestamp(
    ...activationRows.map((row) => row.source_watermark),
    ...dormantRows.map((row) => row.source_watermark),
  );
  const computedAt = oldestTimestamp(
    ...activationRows.map((row) => row.computed_at),
    ...dormantRows.map((row) => row.computed_at),
  );

  return {
    response: {
      source: SUMMARY_OPPORTUNITY_SOURCE,
      computed_at: computedAt,
      source_watermark: sourceWatermark,
      freshness_label: sourceWatermark ?? computedAt,
      groups,
    } satisfies PulseOpportunitiesResponse,
    status: 200 as const,
    error: null,
  };
}

export async function loadPulseOpportunityBuyerPage(
  claims: Pick<JWTClaims, 'tenant_id' | 'role'>,
  id: PulseOpportunityGroup['id'],
  offset: number,
  limit: number,
  now = new Date(),
) {
  if (!claims.tenant_id || !canAccessPulse(claims.role)) {
    return { page: null, status: 403 as const, error: null };
  }
  if (!supabaseAdmin) {
    return { page: null, status: 500 as const, error: new Error('Server configuration error') };
  }

  const definition = opportunityDefinition(id);
  if (!definition) {
    return { page: null, status: 404 as const, error: null };
  }

  if (id === 'dormant_customers_90d') {
    const pageLimit = Math.min(limit, PULSE_DORMANT_PAGE_LIMIT);
    const dormant = await loadDormantBuyers(claims.tenant_id, offset, pageLimit, now);
    if (dormant.error) {
      return { page: null, status: 500 as const, error: dormant.error };
    }
    const rows = dormant.rows ?? [];
    const nextOffset = offset + rows.length;
    return {
      page: {
        group: {
          id,
          title: definition.title,
          description: definition.description,
          count: dormant.total,
          evidence: dormantEvidence(dormant.total, dormant.totalValue),
          action_label: definition.action_label,
          action_href: definition.action_href,
        },
        rows: summaryPreviews(rows),
        nextCursor: rows.length > 0 && nextOffset < dormant.total ? String(nextOffset) : null,
        total: dormant.total,
      } satisfies PulseOpportunityBuyerPage,
      status: 200 as const,
      error: null,
    };
  }

  const activation = await loadActivationSummaryRows(claims.tenant_id, quarterStartFor(now));
  if (activation.error) {
    return { page: null, status: 500 as const, error: activation.error };
  }

  const rows = activation.rows ?? [];
  const group = buildActivationGroup(rows);
  const { pageRows, nextCursor } = pageSummaryRows(rows, offset, Math.min(limit, SUMMARY_OPPORTUNITY_PAGE_LIMIT));
  return {
    page: {
      group: {
        id,
        title: definition.title,
        description: definition.description,
        count: rows.length,
        evidence: group?.evidence ?? '',
        action_label: definition.action_label,
        action_href: definition.action_href,
      },
      rows: summaryPreviews(pageRows),
      nextCursor,
      total: rows.length,
    } satisfies PulseOpportunityBuyerPage,
    status: 200 as const,
    error: null,
  };
}

export function landingMetricsToPulseContribution(metrics: SellerDashboardMetricsV4 | null): PulseContributionResponse {
  if (!metrics) return emptyPulseContribution();

  const demand = metrics.cards.find((card) => card.id === 'app_sourced_demand_qtd') ?? null;
  const invoiced = metrics.cards.find((card) => card.id === 'app_sourced_invoiced_sales_qtd') ?? null;
  const access = metrics.cards.find((card) => card.id === 'customers_with_access') ?? null;
  const timeBasis = metrics.period.label ?? 'This Quarter';
  const maybeCards: Array<PulseContributionCard | null> = [
    access && Number(access.entity_count ?? access.value ?? 0) > 0 ? {
      id: 'yukti_access_enabled',
      label: 'Customers with Yukti access',
      value: Number(access.entity_count ?? access.value ?? 0),
      value_kind: 'count',
      buyer_count: Number(access.entity_count ?? access.value ?? 0),
      time_basis: access.time_basis || 'now',
      evidence: 'Customers who can submit demand through Yukti',
    } : null,
    demand && (Number(demand.value ?? 0) > 0 || Number(demand.document_count ?? 0) > 0 || Number(demand.entity_count ?? 0) > 0) ? {
      id: 'demand_captured',
      label: 'Demand captured through Yukti',
      value: Number(demand.value ?? 0),
      value_kind: 'currency',
      document_count: demand.document_count ?? null,
      buyer_count: demand.entity_count ?? null,
      time_basis: demand.time_basis || timeBasis,
      evidence: `${Number(demand.document_count ?? 0)} submitted demand document${Number(demand.document_count ?? 0) === 1 ? '' : 's'} from ${Number(demand.entity_count ?? 0)} buyer${Number(demand.entity_count ?? 0) === 1 ? '' : 's'}`,
    } : null,
    invoiced && Number(invoiced.value ?? 0) > 0 ? {
      id: 'invoiced_from_captured_demand',
      label: 'Invoiced from captured demand',
      value: Number(invoiced.value ?? 0),
      value_kind: 'currency',
      document_count: invoiced.document_count ?? null,
      buyer_count: invoiced.entity_count ?? null,
      share_pct: invoiced.secondary_value && Number(invoiced.secondary_value) > 0
        ? Number(((Number(invoiced.value ?? 0) / Number(invoiced.secondary_value)) * 100).toFixed(1))
        : null,
      time_basis: invoiced.time_basis || timeBasis,
      evidence: `${Number(invoiced.document_count ?? 0)} Yukti-attributed invoice${Number(invoiced.document_count ?? 0) === 1 ? '' : 's'} from ${Number(invoiced.entity_count ?? 0)} buyer${Number(invoiced.entity_count ?? 0) === 1 ? '' : 's'}`,
    } : null,
    demand && Number(demand.entity_count ?? 0) > 0 ? {
      id: 'active_yukti_buyers',
      label: 'Active buyers through Yukti',
      value: Number(demand.entity_count ?? 0),
      value_kind: 'count',
      buyer_count: demand.entity_count ?? null,
      time_basis: demand.time_basis || timeBasis,
      evidence: 'Buyers who submitted Yukti demand',
    } : null,
  ];
  const cards = maybeCards.filter((card): card is PulseContributionCard => Boolean(card));

  return {
    source: 'app.get_landing_metrics_v4',
    computed_at: metrics.computed_at,
    source_watermark: metrics.source_watermark,
    freshness_label: metrics.source_watermark ?? metrics.computed_at,
    primary_demand_kind: 'none',
    cards,
  };
}

const PULSE_OPPORTUNITY_DEFINITIONS: Array<{
  id: PulseOpportunityGroup['id'];
  title: string;
  description: string;
  action_label: string;
  action_href: string;
}> = [
  {
    id: 'valuable_assisted_customers_without_access',
    title: 'Activate valuable customers',
    description: 'High-value customers still order manually and do not have Yukti access enabled.',
    action_label: 'Open access management',
    action_href: '/buyer-app/access',
  },
  {
    id: 'dormant_customers_90d',
    title: 'Dormant customers to win back',
    description: `Customers with meaningful past business who have not purchased in ${PULSE_DORMANT_DAYS}+ days.`,
    action_label: 'Review customers',
    action_href: '/customers',
  },
];

function opportunityDefinition(id: PulseOpportunityGroup['id']) {
  return PULSE_OPPORTUNITY_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}
