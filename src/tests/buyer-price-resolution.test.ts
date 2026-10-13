import { describe, expect, it, vi } from 'vitest';

const resolveVisibleCampaignMapMock = vi.fn();

vi.mock('@/lib/server/buyer-product-data', () => ({
  resolveVisibleCampaignMap: (...args: unknown[]) => resolveVisibleCampaignMapMock(...args),
}));

import { resolveAuthoritativePrices } from '@/lib/server/buyer-price-resolution';

function chain(result: unknown) {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (value: unknown) => unknown) => resolve(result);
      if (prop === 'maybeSingle') return async () => result;
      return () => new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}

function fakeDb(
  listPrices: Record<string, number>,
  explicitCampaign: Record<string, number> = {},
  options: { campaignVisibleToTenant?: boolean } = {},
) {
  const campaignVisible = options.campaignVisibleToTenant ?? true;
  return {
    schema: () => ({
      rpc: async (_name: string, args: { p_tenant_product_ids: string[] }) => ({
        data: args.p_tenant_product_ids.map((id) => ({ tenant_product_id: id, unit_price: listPrices[id] })),
        error: null,
      }),
      from: (table: string) =>
        table === 'campaigns'
          ? chain({ data: campaignVisible ? { id: 'c-share' } : null, error: null })
          : chain({
              data: Object.entries(explicitCampaign).map(([tenant_product_id, price_override]) => ({
                tenant_product_id,
                price_override,
              })),
              error: null,
            }),
    }),
  } as never;
}

describe('resolveAuthoritativePrices', () => {
  it('prices each line from its own visible campaign, so mixed-campaign carts match what cards quoted', async () => {
    resolveVisibleCampaignMapMock.mockResolvedValue(new Map([
      ['p1', { campaign_price: 80 }],
      ['p3', { campaign_price: null }],
    ]));

    const result = await resolveAuthoritativePrices(fakeDb({ p1: 100, p2: 50, p3: 30 }), {
      tenantId: 't1',
      buyerId: 'b1',
      items: [
        { tenant_product_id: 'p1', qty: 1, unit_price: 999 },
        { tenant_product_id: 'p2', qty: 2, unit_price: 999 },
        { tenant_product_id: 'p3', qty: 1, unit_price: 999 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.unit_price)).toEqual([80, 50, 30]);
  });

  it('lets an explicit client campaign override the visible-campaign price', async () => {
    resolveVisibleCampaignMapMock.mockResolvedValue(new Map([['p1', { campaign_price: 80 }]]));

    const result = await resolveAuthoritativePrices(fakeDb({ p1: 100 }, { p1: 70 }), {
      tenantId: 't1',
      buyerId: 'b1',
      campaignId: 'c-share',
      items: [{ tenant_product_id: 'p1', qty: 1, unit_price: 999 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.unit_price).toBe(70);
  });

  it('ignores an explicit campaign id that is not a published campaign of this tenant', async () => {
    resolveVisibleCampaignMapMock.mockResolvedValue(new Map());

    const result = await resolveAuthoritativePrices(
      fakeDb({ p1: 100 }, { p1: 1 }, { campaignVisibleToTenant: false }),
      {
        tenantId: 't1',
        buyerId: 'b1',
        campaignId: 'someone-elses-campaign',
        items: [{ tenant_product_id: 'p1', qty: 1, unit_price: 999 }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.unit_price).toBe(100);
  });
});
