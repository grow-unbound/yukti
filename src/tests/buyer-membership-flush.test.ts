import { describe, expect, it, vi } from 'vitest';

import { flushBuyerMembershipsNow } from '@/lib/server/buyer-membership-flush';

function dbWith(responses: Array<{ data?: unknown; error?: { message: string } | null }>) {
  const rpc = vi.fn(async () => responses.shift() ?? { data: 'none', error: null });
  return { db: { schema: () => ({ rpc }) } as never, rpc };
}

describe('flushBuyerMembershipsNow', () => {
  it('flushes each buyer and reports the outcome', async () => {
    const { db, rpc } = dbWith([{ data: 'flushed' }, { data: 'none' }]);
    const result = await flushBuyerMembershipsNow(db, 't1', ['b1', 'b2']);
    expect(result).toEqual({ b1: 'flushed', b2: 'none' });
    expect(rpc).toHaveBeenCalledWith('flush_buyer_membership', { p_tenant_id: 't1', p_buyer_id: 'b1' });
  });

  it('retries a busy tick, then gives up without throwing', async () => {
    const { db, rpc } = dbWith([{ data: 'busy' }, { data: 'busy' }, { data: 'busy' }]);
    const result = await flushBuyerMembershipsNow(db, 't1', ['b1']);
    expect(result).toEqual({ b1: 'busy' });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('returns failed on an rpc error instead of throwing', async () => {
    const { db } = dbWith([{ data: null, error: { message: 'boom' } }]);
    const result = await flushBuyerMembershipsNow(db, 't1', ['b1']);
    expect(result).toEqual({ b1: 'failed' });
  });

  it('caps the number of inline flushes', async () => {
    const { db, rpc } = dbWith([]);
    const ids = Array.from({ length: 40 }, (_, i) => `b${i}`);
    await flushBuyerMembershipsNow(db, 't1', ids);
    expect(rpc).toHaveBeenCalledTimes(25);
  });
});
