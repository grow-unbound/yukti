import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordBuyerAppActivitySafe } from '@/lib/server/buyer-app-activity';

function makeDb() {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const db = { schema: vi.fn(() => ({ rpc })) };
  return { db: db as never, rpc };
}

const base = { tenantId: 't1', buyerId: 'b1' };

describe('recordBuyerAppActivitySafe view-event throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('records the first catalog_viewed and drops repeats inside 30 minutes', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-1', eventName: 'catalog_viewed' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-1', eventName: 'catalog_viewed' });
    vi.advanceTimersByTime(29 * 60 * 1000);
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-1', eventName: 'catalog_viewed' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_idempotency_key).toMatch(/^view:catalog_viewed:b-throttle-1:/);
  });

  it('records again after the window and keeps buyers independent', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-2', eventName: 'home_viewed' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-3', eventName: 'home_viewed' });
    vi.advanceTimersByTime(31 * 60 * 1000);
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-2', eventName: 'home_viewed' });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('never throttles business events', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-4', eventName: 'estimate_created' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-throttle-4', eventName: 'estimate_created' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBeNull();
  });
});
