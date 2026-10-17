import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordBuyerAppActivitySafe } from '@/lib/server/buyer-app-activity';

function makeDb() {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const db = { schema: vi.fn(() => ({ rpc })) };
  return { db: db as never, rpc };
}

const base = { tenantId: 't1', buyerId: 'b1' };

describe('recordBuyerAppActivitySafe daily presence ledger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-10-15 06:00Z = 11:30 IST
    vi.setSystemTime(new Date('2026-10-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('records the first presence event of the IST day and drops repeats all day', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-1', eventName: 'catalog_viewed' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-1', eventName: 'catalog_viewed' });
    vi.advanceTimersByTime(6 * 60 * 60 * 1000); // 17:30 IST, same IST day
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-1', eventName: 'catalog_viewed' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe('d:catalog_viewed:b-day-1:2026-10-15');
  });

  it('rolls over at IST midnight, not UTC midnight', async () => {
    const { db, rpc } = makeDb();
    vi.setSystemTime(new Date('2026-10-15T18:20:00Z')); // 23:50 IST on the 15th
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-2', eventName: 'home_viewed' });
    vi.setSystemTime(new Date('2026-10-15T18:40:00Z')); // 00:10 IST on the 16th (UTC still the 15th)
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-2', eventName: 'home_viewed' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe('d:home_viewed:b-day-2:2026-10-15');
    expect(rpc.mock.calls[1][1].p_idempotency_key).toBe('d:home_viewed:b-day-2:2026-10-16');
  });

  it('keeps buyers and event kinds independent', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-3', eventName: 'session_started' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-3', eventName: 'catalog_viewed' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-4', eventName: 'session_started' });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('does not override an explicit idempotency key', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-5', eventName: 'session_started', idempotencyKey: 'custom' });
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBe('custom');
  });

  it('does not throttle or key non-presence events', async () => {
    const { db, rpc } = makeDb();
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-6', eventName: 'custom_event' });
    await recordBuyerAppActivitySafe(db, { ...base, buyerId: 'b-day-6', eventName: 'custom_event' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_idempotency_key).toBeNull();
  });
});

describe('estimate/order creation is not written to the activity ledger', () => {
  it.each(['app/api/buyer/estimates/route.ts', 'app/api/buyer/orders/route.ts'])('%s does not record activity', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('recordBuyerAppActivity');
  });
});
