import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBuyerMembership } from '@/lib/server/buyer-membership';

function fakeDb() {
  const calls: string[] = [];
  const builder = (table: string) => {
    calls.push(table);
    const result =
      table === 'buyers'
        ? { data: { default_cohort_id: 'c-default', geography: { state: 'KA' } }, error: null }
        : { data: [{ cohort_id: 'c-1' }, { cohort_id: 'c-2' }], error: null };
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () => Promise.resolve(result);
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  const db = { schema: () => ({ from: builder }) } as unknown as SupabaseClient;
  return { db, calls };
}

describe('loadBuyerMembership', () => {
  it('shares one buyers + cohort_members_active read between overlapping callers', async () => {
    const { db, calls } = fakeDb();
    const [a, b] = await Promise.all([
      loadBuyerMembership(db, 't1', 'b1'),
      loadBuyerMembership(db, 't1', 'b1'),
    ]);
    expect(calls.sort()).toEqual(['buyers', 'cohort_members_active']);
    expect(a).toEqual(b);
    expect(a).toEqual({
      defaultCohortId: 'c-default',
      geography: { state: 'KA' },
      explicitCohortIds: ['c-1', 'c-2'],
    });
  });

  it('never serves a settled result: a later call re-reads', async () => {
    const { db, calls } = fakeDb();
    await loadBuyerMembership(db, 't1', 'b1');
    await loadBuyerMembership(db, 't1', 'b1');
    expect(calls).toHaveLength(4);
  });

  it('does not coalesce across different buyers or tenants', async () => {
    const { db, calls } = fakeDb();
    await Promise.all([
      loadBuyerMembership(db, 't1', 'b1'),
      loadBuyerMembership(db, 't1', 'b2'),
      loadBuyerMembership(db, 't2', 'b1'),
    ]);
    expect(calls).toHaveLength(6);
  });

  it('propagates read errors and clears the in-flight entry', async () => {
    const failing = {
      schema: () => ({
        from: () => {
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.maybeSingle = () => Promise.resolve({ data: null, error: { message: 'boom' } });
          chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r);
          return chain;
        },
      }),
    } as unknown as SupabaseClient;
    await expect(loadBuyerMembership(failing, 't9', 'b9')).rejects.toThrow('boom');
    const { db, calls } = fakeDb();
    await loadBuyerMembership(db, 't9', 'b9');
    expect(calls).toHaveLength(2);
  });
});
