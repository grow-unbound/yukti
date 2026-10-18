// Node-only: calls posthog-node (not Edge-Runtime compatible) and Supabase.
// Only import this from Node-runtime contexts (Route Handlers, Server Components,
// middleware.ts — which runs on the Node.js runtime, not Edge).
import { PostHog } from 'posthog-node';
import { FEATURE_FLAGS } from '@/constants';
import type { TenantCreateFlags, TenantFlagsData } from '@/lib/server/tenant-flags-token';

const DEFAULT_CREATE_FLAGS: TenantCreateFlags = {
  create_enquiries: true,
  create_sales_orders: true,
  create_invoices: true,
};
const DEFAULT_OFF_FLAGS = new Set<string>([FEATURE_FLAGS.WHATSAPP_INBOX]);

let posthogClient: PostHog | null = null;

function createClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (posthogClient) return posthogClient;

  posthogClient = new PostHog(key, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
  });

  return posthogClient;
}

async function fetchAllPostHogFlags(tenantId: string): Promise<Record<string, boolean>> {
  const client = createClient();
  const flagNames = Object.values(FEATURE_FLAGS);
  // PostHog unavailable = not blocking; DB toggles in tenant_settings are the authority.
  // Only an explicit PostHog `false` acts as a global kill-switch.
  if (!client) {
    return Object.fromEntries(flagNames.map((name) => [name, !DEFAULT_OFF_FLAGS.has(name)]));
  }
  try {
    const flags = await client.evaluateFlags(tenantId);
    return Object.fromEntries(flagNames.map((name) => [name, flags.isEnabled(name) === true]));
  } catch {
    return Object.fromEntries(flagNames.map((name) => [name, !DEFAULT_OFF_FLAGS.has(name)]));
  }
}

async function fetchCreateFlags(tenantId: string): Promise<TenantCreateFlags> {
  // Lazy + defensive: @/lib/supabase throws at module scope when env vars are
  // missing (e.g. many unit tests that never mock it), and this function is reached
  // from a much broader import graph than it used to be (any getFlag() caller).
  // A dynamic import + catch keeps that failure mode local instead of crashing
  // every consumer of tenant-flags-resolve.ts / flags.ts at import time.
  let supabaseAdmin: Awaited<typeof import('@/lib/supabase')>['supabaseAdmin'];
  try {
    ({ supabaseAdmin } = await import('@/lib/supabase'));
  } catch {
    return DEFAULT_CREATE_FLAGS;
  }
  if (!supabaseAdmin) return DEFAULT_CREATE_FLAGS;

  const { data } = await supabaseAdmin
    .schema('app')
    .from('tenant_settings')
    .select('settings')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!data?.settings) return DEFAULT_CREATE_FLAGS;
  const s = data.settings as Record<string, unknown>;
  const orders = (s.orders as Record<string, unknown> | undefined) ?? {};
  const features = (orders.features as Record<string, unknown> | undefined) ?? {};
  return {
    create_enquiries: features.create_enquiries !== false,
    create_sales_orders: features.create_sales_orders !== false,
    create_invoices: features.create_invoices !== false,
  };
}

/** Cold path — one PostHog call (all flags) + one Supabase read, in parallel. */
export async function resolveTenantFlags(tenantId: string): Promise<TenantFlagsData> {
  const [flags, createFlags] = await Promise.all([
    fetchAllPostHogFlags(tenantId),
    fetchCreateFlags(tenantId),
  ]);
  return { flags, createFlags };
}
