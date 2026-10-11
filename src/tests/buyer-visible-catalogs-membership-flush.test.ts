import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Membership = { cohort_id: string }[];

const state: {
  campaigns: Array<Record<string, unknown>>;
  membership: Membership;
  membershipAfterFlush: Membership;
  rpcResult: { data: unknown; error: { message: string } | null };
  flushed: boolean;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
} = {
  campaigns: [],
  membership: [],
  membershipAfterFlush: [],
  rpcResult: { data: false, error: null },
  flushed: false,
  rpcCalls: [],
};

vi.mock('@/lib/auth', () => ({ getBuyerAppContext: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: (schemaName: string) => {
      if (schemaName !== 'app') throw new Error(`Unexpected schema: ${schemaName}`);
      return {
        rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
          state.rpcCalls.push({ fn, args });
          if (state.rpcResult.data === true) state.flushed = true;
          return state.rpcResult;
        }),
        from: (tableName: string) => {
          if (tableName === 'campaigns') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    is: () => ({
                      order: async () => ({ data: state.campaigns, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (tableName === 'buyers') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: { id: 'buyer-1', default_cohort_id: null, geography: null },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (tableName === 'cohort_members_active') {
            return {
              select: () => ({
                eq: async () => ({
                  data: state.flushed ? state.membershipAfterFlush : state.membership,
                  error: null,
                }),
              }),
            };
          }
          throw new Error(`Unexpected table: ${tableName}`);
        },
      };
    },
  },
}));

const cohortCampaign = {
  id: 'campaign-1',
  tenant_id: 'tenant-1',
  name: 'Super September Sale',
  share_token: 'tok',
  valid_to: '2026-10-31T18:29:59.000Z',
  message: null,
  created_at: '2026-09-11T03:06:14.000Z',
  scope_type: 'cohort',
  scope_value: { cohort_id: 'cohort-1' },
  hero_image_url: null,
};

describe('getVisibleBuyerCatalogs — membership flush for newly enabled buyers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00+05:30'));
    state.campaigns = [cohortCampaign];
    state.membership = [];
    state.membershipAfterFlush = [{ cohort_id: 'cohort-1' }];
    state.rpcResult = { data: false, error: null };
    state.flushed = false;
    state.rpcCalls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('flushes pending membership and shows the campaign when the buyer was not yet in the cohort', async () => {
    state.rpcResult = { data: true, error: null };
    const { getVisibleBuyerCatalogs } = await import('@/lib/server/buyer-access');

    const catalogs = await getVisibleBuyerCatalogs('tenant-1', 'buyer-1');

    expect(catalogs.map((c) => c.id)).toEqual(['campaign-1']);
    expect(state.rpcCalls).toEqual([
      { fn: 'flush_buyer_membership', args: { p_tenant_id: 'tenant-1', p_buyer_id: 'buyer-1' } },
    ]);
  });

  it('does not call the flush RPC when the buyer is already a cohort member', async () => {
    state.membership = [{ cohort_id: 'cohort-1' }];
    const { getVisibleBuyerCatalogs } = await import('@/lib/server/buyer-access');

    const catalogs = await getVisibleBuyerCatalogs('tenant-1', 'buyer-1');

    expect(catalogs.map((c) => c.id)).toEqual(['campaign-1']);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('keeps the campaign hidden and remembers "nothing pending" briefly when no work was flushed', async () => {
    state.rpcResult = { data: false, error: null };
    const { getVisibleBuyerCatalogs } = await import('@/lib/server/buyer-access');

    expect(await getVisibleBuyerCatalogs('tenant-1', 'buyer-1')).toEqual([]);
    expect(await getVisibleBuyerCatalogs('tenant-1', 'buyer-1')).toEqual([]);
    expect(state.rpcCalls).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-11T10:01:00+05:30'));
    await getVisibleBuyerCatalogs('tenant-1', 'buyer-1');
    expect(state.rpcCalls).toHaveLength(2);
  });

  it('never throws when the flush RPC errors; the buyer just does not see the campaign yet', async () => {
    state.rpcResult = { data: null, error: { message: 'canceling statement due to statement timeout' } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getVisibleBuyerCatalogs } = await import('@/lib/server/buyer-access');

    await expect(getVisibleBuyerCatalogs('tenant-1', 'buyer-1')).resolves.toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not call the flush RPC for non-cohort campaigns', async () => {
    state.campaigns = [{ ...cohortCampaign, id: 'campaign-all', scope_type: 'all', scope_value: null }];
    const { getVisibleBuyerCatalogs } = await import('@/lib/server/buyer-access');

    const catalogs = await getVisibleBuyerCatalogs('tenant-1', 'buyer-1');

    expect(catalogs.map((c) => c.id)).toEqual(['campaign-all']);
    expect(state.rpcCalls).toHaveLength(0);
  });
});
