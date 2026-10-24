import { unstable_cache } from 'next/cache';

import { FEATURE_FLAGS, ROLES } from '@/constants';
import { effectiveInvoiceStatus } from '@/lib/invoice-status';
import { getFlag } from '@/lib/flags';
import type { JWTClaims } from '@/lib/auth';
import type { SellerLandingPeriodMeta } from '@/lib/seller-period';
import {
  applySellerLocationScope,
  getSellerLocationScope,
  loadAccessibleSellerLocations,
  locationScopeCacheKey,
} from '@/lib/server/seller-location-access';
import { getSellerShellFeatureAvailability } from '@/lib/server/seller-features';
import { supabaseAdmin } from '@/lib/supabase';
import { SELLER_ROUTES } from '@/lib/seller-routes';
import type {
  SellerDashboardResponse,
  SellerDashboardMetric,
  SellerDashboardFeed,
  SellerDashboardFeedRow,
  SellerDashboardRole,
  SellerDashboardTenantSummary,
} from '@/types/seller-dashboard';

type BuyerRow = {
  id: string;
  business_name: string;
  credit_limit: number | null;
  geography: Record<string, unknown> | null;
  buyer_app_enabled: boolean | null;
};

type OrderRow = {
  id: string;
  location_id: string | null;
  buyer_id: string;
  order_number: string;
  status: string;
  total_amount: number | null;
  order_date: string | null;
  placed_at: string | null;
  created_at: string;
  updated_at: string | null;
  buyers?: {
    business_name: string | null;
  } | Array<{
    business_name: string | null;
  }> | null;
};

type EstimateRow = {
  id: string;
  location_id: string | null;
  buyer_id: string;
  estimate_number: string | null;
  status: string;
  total_amount: number | null;
  estimate_date: string | null;
  created_at: string;
  updated_at: string | null;
  buyers?: {
    business_name: string | null;
  } | Array<{
    business_name: string | null;
  }> | null;
};

type InvoiceRow = {
  id: string;
  location_id: string | null;
  buyer_id: string;
  invoice_number: string;
  status: string;
  total_amount: number | null;
  outstanding_balance: number | null;
  invoice_date: string;
  due_date: string | null;
  created_at: string;
  updated_at: string | null;
  buyers?: {
    business_name: string | null;
  } | Array<{
    business_name: string | null;
  }> | null;
};

type InventoryRow = {
  tenant_product_id: string;
  warehouse_id: string | null;
  qty_available: number | null;
  reorder_point: number | null;
  warehouses?: {
    location_id: string | null;
  } | null;
};

type TenantRow = {
  id: string;
  business_name: string;
  subdomain: string | null;
  plan: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function buyerNameFor(
  row: { buyer_id: string; buyers?: { business_name: string | null } | Array<{ business_name: string | null }> | null },
  buyersById: Map<string, BuyerRow>,
) {
  const joinedBuyer = Array.isArray(row.buyers) ? row.buyers[0] : row.buyers;
  return joinedBuyer?.business_name ?? buyersById.get(row.buyer_id)?.business_name ?? 'Unknown buyer';
}

function statusToneForOrder(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'received' || status === 'confirmed' || status === 'partially_dispatched') return 'warning';
  if (status === 'cancelled') return 'danger';
  if (status === 'delivered' || status === 'invoiced' || status === 'partially_invoiced') return 'success';
  return 'neutral';
}

function orderStatusLabel(status: string) {
  if (status === 'partially_dispatched') return 'Partly dispatched';
  if (status === 'partially_invoiced') return 'Partly invoiced';
  return status.replace(/_/g, ' ').replace(/\b\w/g, (char: string) => char.toUpperCase());
}

function estimateStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'draft' || status === 'sent') return 'warning';
  if (status === 'expired' || status === 'rejected' || status === 'void') return 'danger';
  if (status === 'accepted' || status === 'converted') return 'success';
  return 'neutral';
}

function invoicePresentation(row: Pick<InvoiceRow, 'status' | 'due_date'>) {
  const effective = effectiveInvoiceStatus({ status: row.status, due_date: row.due_date });
  if (effective === 'overdue') return { label: 'Overdue', tone: 'danger' as const };
  if (effective === 'paid') return { label: 'Paid', tone: 'success' as const };
  if (effective === 'sent') return { label: 'Sent', tone: 'warning' as const };
  if (effective === 'void') return { label: 'Void', tone: 'neutral' as const };
  return { label: 'Draft', tone: 'neutral' as const };
}

function orderEventAt(row: Pick<OrderRow, 'order_date' | 'placed_at' | 'created_at'>) {
  return row.order_date ?? row.placed_at ?? row.created_at;
}

function buildRecentFeedRows<T extends {
  id: string;
  buyer_id: string;
  total_amount: number | null;
  updated_at: string | null;
  created_at: string;
  buyers?: { business_name: string | null } | Array<{ business_name: string | null }> | null;
}>(
  rows: T[],
  buyersById: Map<string, BuyerRow>,
  builder: (row: T) => Omit<SellerDashboardFeedRow, 'customer_name' | 'amount' | 'updated_at'>,
): SellerDashboardFeedRow[] {
  return rows.map((row) => {
    return {
      ...builder(row),
      customer_name: buyerNameFor(row, buyersById),
      amount: Number(row.total_amount ?? 0),
      updated_at: row.updated_at ?? row.created_at,
    };
  });
}

function buildTenantSummary(tenant: TenantRow | null, locationNames: string[]): SellerDashboardTenantSummary {
  return {
    id: tenant?.id ?? '',
    business_name: tenant?.business_name ?? 'Tenant',
    subdomain: tenant?.subdomain ?? null,
    plan: tenant?.plan ?? null,
    location_names: locationNames,
  };
}

async function fetchSellerDashboardData(
  tenantId: string,
  claims: Pick<JWTClaims, 'sub' | 'role' | 'location_ids'>,
  period: SellerLandingPeriodMeta,
): Promise<SellerDashboardResponse> {
  const role = (claims.role === ROLES.SELLER_ASSISTANT ? ROLES.SELLER_ASSISTANT : ROLES.SELLER_ADMIN) as SellerDashboardRole;

  if (!supabaseAdmin) {
    return {
      role,
      period,
      tenant: buildTenantSummary(null, []),
      admin: role === ROLES.SELLER_ADMIN ? {} : undefined,
      assistant: role === ROLES.SELLER_ASSISTANT ? { metrics: [], feeds: [] } : undefined,
    };
  }

  const db: any = supabaseAdmin;
  const [featureAvailability, zohoEnabled, tenantRes, accessibleLocations] = await Promise.all([
    getSellerShellFeatureAvailability(tenantId),
    getFlag(FEATURE_FLAGS.ZOHO_INTEGRATION, tenantId),
    db.schema('app').from('tenants').select('id, business_name, subdomain, plan').eq('id', tenantId).single(),
    loadAccessibleSellerLocations(db, tenantId, claims),
  ]);

  const locationNames = accessibleLocations.map((location) => location.name);
  const tenant = buildTenantSummary((tenantRes.data as TenantRow | null) ?? null, locationNames);
  const scopedLocationIds = accessibleLocations.map((location) => location.id);

  let inventoryQuery = db
    .schema('app')
    .from('tenant_inventory')
    .select('tenant_product_id, warehouse_id, qty_available, reorder_point, warehouses!inner(location_id, tenant_id)')
    .eq('warehouses.tenant_id', tenantId)
    .is('deleted_at', null);

  const scope = getSellerLocationScope(claims);
  if (scope.mode === 'subset') {
    inventoryQuery = inventoryQuery.in('warehouses.location_id', scopedLocationIds);
  } else if (scope.mode === 'none') {
    inventoryQuery = inventoryQuery.eq('warehouse_id', '00000000-0000-0000-0000-000000000000');
  }


  const [buyersRes, inventoryRes, ordersRes, estimatesRes, invoicesRes] = await Promise.all([
    db
      .schema('app')
      .from('buyers')
      .select('id, business_name, credit_limit, geography, buyer_app_enabled')
      .eq('tenant_id', tenantId),
    inventoryQuery,
    applySellerLocationScope(
      db
        .schema('app')
        .from('orders')
        .select('id, location_id, buyer_id, order_number, status, total_amount, order_date, placed_at, created_at, updated_at, buyers!buyer_id(business_name)')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        // Bounded to the most recently touched rows — feeds the seller_assistant
        // section's feeds/callouts (previewRows only ever shows 3 unless a specific
        // full-callout is requested via a separate, already-bounded path). Was
        // previously unbounded — for a tenant with thousands of orders this
        // transferred and JS-sorted the entire table on every dashboard load.
        .order('updated_at', { ascending: false })
        .limit(300),
      claims,
    ),
    applySellerLocationScope(
      db
        .schema('app')
        .from('estimates')
        .select('id, location_id, buyer_id, estimate_number, status, total_amount, estimate_date, created_at, updated_at, buyers!buyer_id(business_name)')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(300),
      claims,
    ),
    applySellerLocationScope(
      db
        .schema('app')
        .from('invoices')
        .select('id, location_id, buyer_id, invoice_number, status, total_amount, outstanding_balance, invoice_date, due_date, created_at, updated_at, buyers!buyer_id(business_name)')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(300),
      claims,
    ),
  ]);

  const rawBuyers = (buyersRes.data ?? []) as BuyerRow[];
  const inventoryRows = (inventoryRes.data ?? []) as InventoryRow[];
  const orders = (ordersRes.data ?? []) as OrderRow[];
  const estimates = (estimatesRes.data ?? []) as EstimateRow[];
  const invoices = (invoicesRes.data ?? []) as InvoiceRow[];
  const scopedBuyerIds = role === ROLES.SELLER_ASSISTANT
    ? new Set(
        [...orders, ...estimates, ...invoices]
          .map((row) => row.buyer_id)
          .filter((buyerId): buyerId is string => typeof buyerId === 'string' && buyerId.length > 0),
      )
    : null;
  const buyers = scopedBuyerIds
    ? rawBuyers.filter((buyer) => scopedBuyerIds.has(buyer.id))
    : rawBuyers;

  const buyersById = new Map(buyers.map((buyer) => [buyer.id, buyer]));
  const lowStockAlerts = inventoryRows.filter((row) => {
    const reorder = Number(row.reorder_point ?? 0);
    const qty = Number(row.qty_available ?? 0);
    return reorder > 0 && qty <= reorder;
  }).length;

  const allOrdersSorted = [...orders].sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime());
  const allEstimatesSorted = [...estimates].sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime());
  const allInvoicesSorted = [...invoices].sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime());

  if (role === ROLES.SELLER_ADMIN) {
    // admin.metrics/callouts/recent_activity, the Metrics V2 portfolio (both
    // get_metrics_v2_seller_dashboard and metrics_v2_transaction_landing), and
    // every query/computation that fed only those are gone -- confirmed unread
    // by the frontend (the 4 explore cards are each sourced from their own v4
    // RPC; the KPI strip reads get_landing_kpis via useSellerDashboardMetrics,
    // including the "as of" timestamp, which used to come from portfolio.as_of).
    // `admin` stays a truthy empty marker so the frontend can still branch on
    // role via `dashboard.admin`.
    return {
      role,
      period,
      tenant,
      admin: {},
    };
  }

  const lowStockFeatureEnabled = zohoEnabled || featureAvailability.tallyExport;

  const lastOrderByBuyer = new Map<string, OrderRow>();
  for (const order of [...orders].sort((a, b) => new Date(orderEventAt(b)).getTime() - new Date(orderEventAt(a)).getTime())) {
    if (!lastOrderByBuyer.has(order.buyer_id)) {
      lastOrderByBuyer.set(order.buyer_id, order);
    }
  }

  const operationalMetrics: SellerDashboardMetric[] = [];
  if (featureAvailability.estimates) {
    operationalMetrics.push({
      label: 'Open estimates',
      value: estimates.filter((estimate) => estimate.status === 'draft' || estimate.status === 'sent').length,
      sub: 'Awaiting customer response',
      href: SELLER_ROUTES.sales.estimates,
    });
  }
  if (featureAvailability.salesOrders) {
    operationalMetrics.push({
      label: 'Orders to confirm',
      value: orders.filter((order) => order.status === 'received').length,
      sub: 'Received and pending confirmation',
      tone: 'warn',
      href: SELLER_ROUTES.sales.orders,
    });
  }
  if (lowStockFeatureEnabled) {
    operationalMetrics.push({
      label: 'Low-stock alerts',
      value: lowStockAlerts,
      sub: 'Below reorder threshold',
      tone: lowStockAlerts > 0 ? 'warn' : undefined,
      href: '/products',
    });
  }
  if (featureAvailability.customerMaster) {
    const inactiveCount = buyers.filter((buyer) => {
      const lastOrder = lastOrderByBuyer.get(buyer.id);
      const lastOrderAt = lastOrder ? orderEventAt(lastOrder) : null;
      if (!lastOrderAt) return false;
      return (Date.now() - new Date(lastOrderAt).getTime()) / DAY_MS > 30;
    }).length;
    operationalMetrics.push({
      label: 'Inactive customers',
      value: inactiveCount,
      sub: 'No order in 30 days',
      href: '/customers',
    });
  }

  const limitedMetrics = operationalMetrics.slice(0, 4);
  if (limitedMetrics.length === 1) {
    limitedMetrics.push({
      label: 'Assigned locations',
      value: Math.max(1, tenant.location_names.length),
      sub: tenant.location_names.join(', ') || 'Scope enforced from your role',
    });
  } else if (limitedMetrics.length === 0) {
    limitedMetrics.push(
      {
        label: 'Assigned locations',
        value: Math.max(1, tenant.location_names.length),
        sub: tenant.location_names.join(', ') || 'Scope enforced from your role',
      },
      {
        label: 'Active customers',
        value: buyers.length,
        sub: 'Customers visible to your team',
      },
    );
  }

  const feeds: SellerDashboardFeed[] = [];
  if (featureAvailability.estimates) {
    feeds.push({
      id: 'estimates',
      title: 'Estimates',
      href: SELLER_ROUTES.sales.estimates,
      empty_label: 'No estimates yet',
      rows: buildRecentFeedRows(
        allEstimatesSorted.slice(0, 5),
        buyersById,
        (row) => ({
          id: row.id,
          href: `${SELLER_ROUTES.sales.estimates}/${row.id}`,
          document_number: row.estimate_number ?? 'Draft estimate',
          status: { label: orderStatusLabel(row.status), tone: estimateStatusTone(row.status) },
        }),
      ),
    });
  }
  if (featureAvailability.salesOrders) {
    feeds.push({
      id: 'sales_orders',
      title: 'Sales Orders',
      href: SELLER_ROUTES.sales.orders,
      empty_label: 'No orders yet',
      rows: buildRecentFeedRows(
        allOrdersSorted.slice(0, 5),
        buyersById,
        (row) => ({
          id: row.id,
          href: `${SELLER_ROUTES.sales.orders}/${row.id}`,
          document_number: row.order_number,
          status: { label: orderStatusLabel(row.status), tone: statusToneForOrder(row.status) },
        }),
      ),
    });
  }
  if (featureAvailability.invoices) {
    feeds.push({
      id: 'invoices',
      title: 'Invoices',
      href: SELLER_ROUTES.sales.invoices,
      empty_label: 'No invoices yet',
      rows: buildRecentFeedRows(
        allInvoicesSorted.slice(0, 5),
        buyersById,
        (row) => ({
          id: row.id,
          href: `${SELLER_ROUTES.sales.invoices}/${row.id}`,
          document_number: row.invoice_number,
          status: invoicePresentation(row),
        }),
      ),
    });
  }

  return {
    role,
    period,
    tenant,
    assistant: {
      metrics: limitedMetrics,
      feeds,
    },
  };
}

export async function getSellerDashboardData(
  tenantId: string,
  claims: Pick<JWTClaims, 'sub' | 'role' | 'location_ids'>,
  period: SellerLandingPeriodMeta,
) {
  const cacheKey = [
    'seller-dashboard',
    tenantId,
    claims.sub ?? 'anon',
    claims.role ?? 'unknown',
    locationScopeCacheKey(claims),
    period.selected,
    period.current_start.slice(0, 10),
    period.current_end_exclusive.slice(0, 10),
    period.previous_start.slice(0, 10),
    period.previous_end_exclusive.slice(0, 10),
  ];

  return unstable_cache(
    () => fetchSellerDashboardData(tenantId, claims, period),
    cacheKey,
    { revalidate: 30, tags: [`seller-dashboard:${tenantId}`] },
  )();
}
