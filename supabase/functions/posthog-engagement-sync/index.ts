/**
 * posthog-engagement-sync — copies yesterday's buyer-app engagement from PostHog into the Yukti DB.
 *
 * Invoked daily by pg_cron (see 20261007103119_posthog_engagement_tables_and_activity_apply.sql) at
 * 22:00 UTC = 03:30 IST. Reads one closed IST day at a time with HogQL, then calls
 * app.engagement_apply_daily per tenant (idempotent), which also raises buyers.last_login_at /
 * last_active_at and refreshes the tenant's active-buyer windows.
 *
 * Supabase Dashboard → Edge Functions → posthog-engagement-sync
 *   Headers: x-push-secret: <INTEGRATIONS_PUSH_SECRET>
 *   Body (all optional): { "day": "YYYY-MM-DD", "days": 2, "tenant_id": "<uuid>" }
 *     day  = newest IST day to sync (default: yesterday, IST)
 *     days = how many days to sync, walking back from `day` (default 2 to absorb late events; max 90 for backfill)
 *   Secrets: POSTHOG_PERSONAL_API_KEY (read, HogQL), POSTHOG_PROJECT_ID, NEXT_PUBLIC_POSTHOG_HOST | POSTHOG_HOST
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const FN = '[posthog-engagement-sync]';
const MAX_DAYS = 90;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Passive/system events that must not count as buyer activity.
const PASSIVE_EVENTS = ['$web_vitals', '$set', '$groupidentify', '$feature_flag_called', '$identify'];

function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Missing required env var: SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_KEY');
  if (!key) throw new Error('Missing required env var: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function verifyPushSecret(req: Request): boolean {
  const secret = Deno.env.get('INTEGRATIONS_PUSH_SECRET')?.trim()
    ?? Deno.env.get('INTEGRATIONS_DISPATCH_SECRET')?.trim();
  if (!secret) return true; // no secret configured → open (dev mode)
  const provided = req.headers.get('x-push-secret')?.trim() ?? '';
  if (provided.length !== secret.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(secret);
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function json(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function iso(epochSeconds: unknown): string | null {
  const n = Number(epochSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

type PostHogConfig = { host: string; projectId: string; key: string };

function posthogConfig(): PostHogConfig {
  const key = Deno.env.get('POSTHOG_PERSONAL_API_KEY')?.trim();
  const projectId = Deno.env.get('POSTHOG_PROJECT_ID')?.trim();
  if (!key || !projectId) throw new Error('Missing POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID');
  const raw = Deno.env.get('NEXT_PUBLIC_POSTHOG_HOST') ?? Deno.env.get('POSTHOG_HOST') ?? 'https://us.posthog.com';
  // The ingestion host (us.i.posthog.com) does not serve the query API.
  const host = raw.replace('.i.posthog.com', '.posthog.com').replace(/\/+$/, '');
  return { host, projectId, key };
}

async function hogql(cfg: PostHogConfig, query: string, name: string): Promise<unknown[][]> {
  const res = await fetch(`${cfg.host}/api/projects/${cfg.projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `yukti-engagement-sync:${name}`, query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`PostHog ${name} failed: HTTP ${res.status} ${body}`);
  }
  const data = await res.json() as { results?: unknown[][] };
  return data.results ?? [];
}

type BuyerAgg = {
  buyer_id: string;
  pageviews: number;
  searches: number;
  product_views: number;
  cart_opens: number;
  add_to_cart: number;
  submit_clicks: number;
  submit_failed: number;
  quotes_created: number;
  logins: number;
  first_event_at: string | null;
  last_event_at: string | null;
  last_login_at: string | null;
};

type DayData = {
  buyers: Map<string, Map<string, BuyerAgg>>;
  products: Map<string, Array<{ tenant_product_id: string; viewers: number; views: number; carters: number }>>;
  sessions: Map<string, number>;
};

async function fetchDay(cfg: PostHogConfig, day: string): Promise<DayData> {
  const next = addDays(day, 1);
  const win = `timestamp >= toDateTime('${day} 00:00:00', 'Asia/Kolkata') and timestamp < toDateTime('${next} 00:00:00', 'Asia/Kolkata')`;
  const passive = PASSIVE_EVENTS.map((e) => `'${e}'`).join(',');
  const base = `${win} and properties.tenant_id is not null and properties.buyer_id is not null and event not in (${passive})`;

  const [buyerRows, loginRows, productRows, sessionRows] = await Promise.all([
    hogql(cfg, `
      select toString(properties.tenant_id) t, toString(properties.buyer_id) b,
        countIf(event = '$pageview') pageviews,
        countIf(event in ('buyer_catalog_search_results_viewed', 'buyer_search_opened')) searches,
        countIf(event = 'product_viewed') product_views,
        countIf(event = 'buyer_cart_opened') cart_opens,
        countIf(event in ('catalog_item_added_to_cart', 'reco_add_to_cart', 'reco_cart_gap_add')) add_to_cart,
        countIf(event = 'buyer_cart_submit_clicked') submit_clicks,
        countIf(event = 'buyer_cart_submit_failed') submit_failed,
        countIf(event = 'inquiry_created') quotes_created,
        toUnixTimestamp(min(timestamp)) first_at, toUnixTimestamp(max(timestamp)) last_at
      from events where ${base}
      group by t, b limit 100000`, 'buyers'),
    // otp_verified carries no buyer_id: resolve distinct_id -> buyer via the last buyer-bearing event in the
    // prior 30 days (multi-outlet users resolve to their most recent buyer; documented limitation).
    hogql(cfg, `
      select o.t, m.b, count() logins, toUnixTimestamp(max(o.ts)) last_login
      from (
        select toString(properties.tenant_id) t, distinct_id d, timestamp ts
        from events where event = 'otp_verified' and ${win} and properties.tenant_id is not null
      ) o
      join (
        select distinct_id d, toString(argMax(properties.buyer_id, timestamp)) b
        from events
        where timestamp >= toDateTime('${day} 00:00:00', 'Asia/Kolkata') - interval 30 day
          and timestamp < toDateTime('${next} 00:00:00', 'Asia/Kolkata')
          and properties.buyer_id is not null
        group by d
      ) m on o.d = m.d
      group by o.t, m.b limit 100000`, 'logins'),
    hogql(cfg, `
      select toString(properties.tenant_id) t, toString(properties.tenant_product_id) p,
        uniqExactIf(properties.buyer_id, event = 'product_viewed') viewers,
        countIf(event = 'product_viewed') views,
        uniqExactIf(properties.buyer_id, event in ('catalog_item_added_to_cart', 'reco_add_to_cart')) carters
      from events
      where ${base} and event in ('product_viewed', 'catalog_item_added_to_cart', 'reco_add_to_cart')
        and properties.tenant_product_id is not null
      group by t, p limit 100000`, 'products'),
    hogql(cfg, `
      select toString(properties.tenant_id) t, uniqExact(\`$session_id\`) s
      from events where ${base} group by t limit 10000`, 'sessions'),
  ]);

  const buyers: DayData['buyers'] = new Map();
  const ensure = (t: string, b: string): BuyerAgg => {
    let per = buyers.get(t);
    if (!per) buyers.set(t, per = new Map());
    let row = per.get(b);
    if (!row) {
      per.set(b, row = {
        buyer_id: b, pageviews: 0, searches: 0, product_views: 0, cart_opens: 0, add_to_cart: 0, submit_clicks: 0,
        submit_failed: 0, quotes_created: 0, logins: 0, first_event_at: null, last_event_at: null, last_login_at: null,
      });
    }
    return row;
  };

  for (const r of buyerRows) {
    const [t, b, pv, se, prv, co, atc, sc, sf, qc, first, last] = r as [string, string, number, number, number, number, number, number, number, number, number, number];
    if (!UUID_RE.test(t) || !UUID_RE.test(b)) continue;
    const row = ensure(t, b);
    row.pageviews = Number(pv); row.searches = Number(se); row.product_views = Number(prv);
    row.cart_opens = Number(co); row.add_to_cart = Number(atc); row.submit_clicks = Number(sc);
    row.submit_failed = Number(sf); row.quotes_created = Number(qc);
    row.first_event_at = iso(first); row.last_event_at = iso(last);
  }
  for (const r of loginRows) {
    const [t, b, n, last] = r as [string, string, number, number];
    if (!UUID_RE.test(t) || !UUID_RE.test(b)) continue;
    const row = ensure(t, b);
    row.logins = Number(n);
    row.last_login_at = iso(last);
    // a login is activity even if no other event carried a buyer_id that day
    if (!row.last_event_at || (row.last_login_at && row.last_login_at > row.last_event_at)) row.last_event_at = row.last_login_at;
    if (!row.first_event_at || (row.last_login_at && row.last_login_at < row.first_event_at)) row.first_event_at = row.last_login_at;
  }

  const products: DayData['products'] = new Map();
  for (const r of productRows) {
    const [t, p, viewers, views, carters] = r as [string, string, number, number, number];
    if (!UUID_RE.test(t) || !UUID_RE.test(p)) continue;
    const list = products.get(t) ?? [];
    list.push({ tenant_product_id: p, viewers: Number(viewers), views: Number(views), carters: Number(carters) });
    products.set(t, list);
  }

  const sessions = new Map<string, number>();
  for (const r of sessionRows) {
    const [t, s] = r as [string, number];
    if (UUID_RE.test(t)) sessions.set(t, Number(s));
  }
  return { buyers, products, sessions };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (!verifyPushSecret(req)) return json(401, { ok: false, error: 'Unauthorized' });

  let body: { day?: string; days?: number; tenant_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const newest = body.day && DAY_RE.test(body.day) ? body.day : addDays(istToday(), -1);
  if (newest >= istToday()) return json(400, { ok: false, error: 'day must be a closed IST day (before today)' });
  const days = Math.min(Math.max(Math.trunc(Number(body.days ?? 2)) || 2, 1), MAX_DAYS);
  const onlyTenant = body.tenant_id && UUID_RE.test(body.tenant_id) ? body.tenant_id.toLowerCase() : null;

  try {
    const db = createAdminClient();
    const cfg = posthogConfig();

    const { data: tenantRows, error: tenantErr } = await db.schema('app').rpc('engagement_sync_tenants');
    if (tenantErr) throw new Error(`engagement_sync_tenants failed: ${tenantErr.message}`);
    const tenants = (tenantRows as Array<{ tenant_id: string }> ?? [])
      .map((r) => r.tenant_id.toLowerCase())
      .filter((t) => !onlyTenant || t === onlyTenant);

    const results: Array<Record<string, unknown>> = [];
    const failures: string[] = [];

    for (let i = 0; i < days; i++) {
      const day = addDays(newest, -i);
      const data = await fetchDay(cfg, day);
      for (const tenantId of tenants) {
        const buyers = Array.from(data.buyers.get(tenantId)?.values() ?? []);
        const { data: applied, error } = await db.schema('app').rpc('engagement_apply_daily', {
          p_tenant_id: tenantId,
          p_day: day,
          p_buyers: buyers,
          p_products: data.products.get(tenantId) ?? [],
          p_totals: { sessions: data.sessions.get(tenantId) ?? 0 },
        });
        if (error) {
          failures.push(`${tenantId} ${day}: ${error.message}`);
          console.error(FN, 'apply failed', tenantId, day, error.message);
        } else {
          results.push(applied as Record<string, unknown>);
        }
      }
    }

    console.log(FN, `synced ${days} day(s) ending ${newest} for ${tenants.length} tenant(s); failures=${failures.length}`);
    return json(failures.length ? 500 : 200, { ok: failures.length === 0, newest, days, tenants: tenants.length, applied: results.length, failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(FN, message);
    return json(500, { ok: false, error: message });
  }
});
