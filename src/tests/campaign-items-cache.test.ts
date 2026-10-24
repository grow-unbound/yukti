import { describe, expect, it, vi } from 'vitest';

const cacheCalls: Array<{ keyParts: string[]; opts: { revalidate?: number; tags?: string[] } }> = [];
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: string[], opts: { revalidate?: number; tags?: string[] }) => {
    cacheCalls.push({ keyParts, opts });
    return fn;
  },
}));

import { getCampaignItemsCached, getCampaignItemsForProducts } from '@/lib/server/campaign-items-cache';

function dbWith(rowsByCampaign: Record<string, unknown[]>) {
  const limit = vi.fn();
  const eq = vi.fn();
  const db = {
    schema: () => ({
      from: () => {
        let campaignId = '';
        const query: Record<string, unknown> = {
          select: () => query,
          eq: (_col: string, id: string) => { campaignId = id; eq(id); return query; },
          is: () => query,
          in: (col: string, ids: string[]) => { if (col === 'campaign_id') campaignId = ids[0]; return query; },
          limit: (n: number) => { limit(n); return query; },
          then: (resolve: (v: unknown) => void) => resolve({ data: rowsByCampaign[campaignId] ?? [], error: null }),
        };
        return query;
      },
    }),
  } as any;
  return { db, limit, eq };
}

const item = (campaign_id: string, tenant_product_id: string) => ({
  campaign_id, tenant_product_id, price_override: 10, display_order: 1, is_featured: false,
});

describe('campaign items cache', () => {
  it('reads one campaign with a bounded query, keyed and tagged by tenant + campaign', async () => {
    const { db, limit } = dbWith({ c1: [item('c1', 'p1')] });
    const rows = await getCampaignItemsCached(db, 'tenant-a', 'c1');

    expect(rows).toHaveLength(1);
    expect(limit).toHaveBeenCalledWith(1000);
    const last = cacheCalls.at(-1)!;
    expect(last.keyParts).toEqual(['campaign-items', 'tenant-a', 'c1']);
    expect(last.opts.tags).toEqual(['buyer-ctx:tenant-a']);
    expect(last.opts.revalidate).toBe(60);
  });

  it('serves every page from whole-campaign rows, narrowed in memory to the page products', async () => {
    const { db, eq } = dbWith({ c1: [item('c1', 'p1'), item('c1', 'p2')], c2: [item('c2', 'p2'), item('c2', 'p9')] });
    const rows = await getCampaignItemsForProducts(db, 'tenant-a', ['c1', 'c2'], ['p2', 'p3']);

    expect(rows.map((r) => `${r.campaign_id}:${r.tenant_product_id}`).sort()).toEqual(['c1:p2', 'c2:p2']);
    expect(eq.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2']);
  });

  it('reads straight from the DB, bypassing the cache, for authoritative pricing', async () => {
    const before = cacheCalls.length;
    const { db, eq } = dbWith({ c1: [item('c1', 'p1')] });
    const rows = await getCampaignItemsForProducts(db, 'tenant-a', ['c1'], ['p1'], { fresh: true });

    expect(rows).toHaveLength(1);
    expect(cacheCalls.length).toBe(before);
    expect(eq).not.toHaveBeenCalled(); // direct IN-query, not the per-campaign cached read
  });
});
