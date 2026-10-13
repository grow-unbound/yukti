import { describe, expect, it, vi, beforeEach } from 'vitest';

import { inferCampaignIdForBuyerCart } from '@/lib/server/campaign-attribution';

const getVisibleBuyerCatalogsMock = vi.fn();

vi.mock('@/lib/server/buyer-access', () => ({
  getVisibleBuyerCatalogs: (...args: unknown[]) => getVisibleBuyerCatalogsMock(...args),
}));

function mockDb(
  itemRows: Array<{ campaign_id: string; tenant_product_id: string }> | null,
  error: unknown = null,
  ownedCampaign: { id: string } | null = null,
) {
  return {
    schema: () => ({
      from: (table: string) => {
        if (table === 'campaigns') {
          const chain: Record<string, unknown> = {};
          const next = () => chain;
          Object.assign(chain, {
            select: next,
            eq: next,
            is: next,
            maybeSingle: async () => ({ data: ownedCampaign, error: null }),
          });
          return chain;
        }
        return {
          select: () => ({
            in: () => ({
              is: async () => ({ data: itemRows, error }),
            }),
          }),
        };
      },
    }),
  };
}

describe('inferCampaignIdForBuyerCart', () => {
  beforeEach(() => {
    getVisibleBuyerCatalogsMock.mockReset();
    getVisibleBuyerCatalogsMock.mockResolvedValue([
      { id: 'c1' },
      { id: 'c2' },
    ]);
  });

  it('returns the client campaign id when it is a published campaign of the tenant', async () => {
    const result = await inferCampaignIdForBuyerCart(mockDb([], null, { id: 'client-c' }) as never, {
      tenantId: 't1',
      buyerId: 'b1',
      clientCampaignId: 'client-c',
      tenantProductIds: ['p1'],
    });
    expect(result).toBe('client-c');
  });

  it('ignores a client campaign id that is not an owned, published campaign', async () => {
    const result = await inferCampaignIdForBuyerCart(mockDb([], null, null) as never, {
      tenantId: 't1',
      buyerId: 'b1',
      clientCampaignId: 'forged-c',
      tenantProductIds: ['p1'],
    });
    expect(result).toBeNull();
  });

  it('attributes when only some cart SKUs are in the campaign', async () => {
    const result = await inferCampaignIdForBuyerCart(
      mockDb([
        { campaign_id: 'c1', tenant_product_id: 'p1' },
      ]) as never,
      {
        tenantId: 't1',
        buyerId: 'b1',
        tenantProductIds: ['p1', 'p-outside'],
      },
    );
    expect(result).toBe('c1');
  });

  it('returns null when no cart SKU belongs to any campaign', async () => {
    const result = await inferCampaignIdForBuyerCart(mockDb([]) as never, {
      tenantId: 't1',
      buyerId: 'b1',
      tenantProductIds: ['p-outside'],
    });
    expect(result).toBeNull();
  });

  it('picks campaign with highest overlap when multiple match', async () => {
    const result = await inferCampaignIdForBuyerCart(
      mockDb([
        { campaign_id: 'c1', tenant_product_id: 'p1' },
        { campaign_id: 'c2', tenant_product_id: 'p1' },
        { campaign_id: 'c2', tenant_product_id: 'p2' },
      ]) as never,
      {
        tenantId: 't1',
        buyerId: 'b1',
        tenantProductIds: ['p1', 'p2'],
      },
    );
    expect(result).toBe('c2');
  });

  it('returns null on tie for max overlap', async () => {
    const result = await inferCampaignIdForBuyerCart(
      mockDb([
        { campaign_id: 'c1', tenant_product_id: 'p1' },
        { campaign_id: 'c2', tenant_product_id: 'p2' },
      ]) as never,
      {
        tenantId: 't1',
        buyerId: 'b1',
        tenantProductIds: ['p1', 'p2'],
      },
    );
    expect(result).toBeNull();
  });

  it('ignores campaigns not visible to buyer', async () => {
    getVisibleBuyerCatalogsMock.mockResolvedValue([{ id: 'c2' }]);

    const result = await inferCampaignIdForBuyerCart(
      mockDb([
        { campaign_id: 'c1', tenant_product_id: 'p1' },
        { campaign_id: 'c2', tenant_product_id: 'p1' },
      ]) as never,
      {
        tenantId: 't1',
        buyerId: 'b1',
        tenantProductIds: ['p1'],
      },
    );
    expect(result).toBe('c2');
  });
});
