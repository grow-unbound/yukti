import { NextRequest } from 'next/server';

import { getVerifiedClaims } from '@/lib/auth';
import { APP_GET_CACHE_CONTROL, jsonWithServerTiming } from '@/lib/server/bounded-get';
import { createTimer } from '@/lib/server-timing';
import { supabaseAdmin } from '@/lib/supabase';
import { parseSellerLandingPeriod, type SellerLandingPeriod } from '@/lib/seller-period';
import type { OrdersLandingMetricsV4 } from '@/hooks/useOrders';

export const dynamic = 'force-dynamic';

const PERIOD_KEY_BY_SELLER_PERIOD: Record<SellerLandingPeriod, string> = {
  today: 'today',
  week: 'this_week',
  month: 'this_month',
  quarter: 'this_quarter',
  year: 'this_quarter',
  last90: 'this_month',
};

function emptyOrdersLandingMetricsV4(periodKey = 'this_month'): OrdersLandingMetricsV4 {
  return {
    page_key: 'orders',
    period: {
      period_key: periodKey,
      grain: periodKey === 'today' ? 'day' : periodKey === 'this_week' ? 'week' : periodKey === 'this_quarter' ? 'quarter' : 'month',
      period_start: '',
      period_end_exclusive: '',
      label: periodKey === 'this_quarter' ? 'This Quarter' : periodKey === 'this_week' ? 'This Week' : periodKey === 'today' ? 'Today' : 'This Month',
    },
    computed_at: null,
    source_watermark: null,
    cards: [],
  };
}

export async function GET(request: NextRequest) {
  const timer = createTimer();
  const timedJson = (body: OrdersLandingMetricsV4 | { error: string }, init?: ResponseInit) =>
    jsonWithServerTiming(body, timer, 'orders_metrics_api', init, APP_GET_CACHE_CONTROL);

  const claims = await getVerifiedClaims(request);
  if (!claims.tenant_id) return timedJson({ error: 'Unauthorized' }, { status: 401 });
  if (!claims.role?.startsWith('seller_')) return timedJson({ error: 'Forbidden' }, { status: 403 });
  if (!supabaseAdmin) return timedJson({ error: 'Server configuration error' }, { status: 500 });

  const sellerPeriod = parseSellerLandingPeriod(request.nextUrl.searchParams.get('period'));
  const periodKey = PERIOD_KEY_BY_SELLER_PERIOD[sellerPeriod] ?? 'this_month';

  try {
    const { data, error } = await supabaseAdmin.schema('app').rpc('get_landing_kpis', {
      p_tenant_id: claims.tenant_id,
      p_page_key: 'orders',
      p_period_key: periodKey,
      p_as_of: new Date().toISOString(),
    });

    if (error) {
      console.error('[GET /api/tenant/orders/metrics] get_landing_kpis failed', error);
      return timedJson({ error: 'Failed to fetch order metrics' }, { status: 500 });
    }

    if (!data || typeof data !== 'object') return timedJson(emptyOrdersLandingMetricsV4(periodKey));

    const payload = data as OrdersLandingMetricsV4;
    return timedJson({
      ...payload,
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
  } catch (error) {
    console.error('[GET /api/tenant/orders/metrics] unexpected error', error);
    return timedJson({ error: 'Unexpected server error' }, { status: 500 });
  }
}
