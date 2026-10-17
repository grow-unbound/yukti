import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

import { applyBuyerQueryDefaults, createRefreshThrottle, isBuyerAppPath } from '@/lib/buyer-query-defaults';

describe('isBuyerAppPath', () => {
  it('matches the buyer PWA only, not the seller buyer-app section', () => {
    expect(isBuyerAppPath('/buy')).toBe(true);
    expect(isBuyerAppPath('/buy/home')).toBe(true);
    expect(isBuyerAppPath('/buyer-app')).toBe(false);
    expect(isBuyerAppPath('/buyers')).toBe(false);
    expect(isBuyerAppPath('/dashboard')).toBe(false);
  });
});

describe('applyBuyerQueryDefaults', () => {
  it('turns reconnect refetch off for the buyer surface and keeps the other defaults', () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 123, refetchOnWindowFocus: false } } });
    applyBuyerQueryDefaults(client, true);
    expect(client.getDefaultOptions().queries).toMatchObject({
      refetchOnReconnect: false,
      staleTime: 123,
      refetchOnWindowFocus: false,
    });
  });

  it('restores reconnect refetch off the buyer surface', () => {
    const client = new QueryClient();
    applyBuyerQueryDefaults(client, true);
    applyBuyerQueryDefaults(client, false);
    expect(client.getDefaultOptions().queries?.refetchOnReconnect).toBe(true);
  });
});

describe('createRefreshThrottle', () => {
  it('shares one in-flight run and ignores repeats inside the interval', async () => {
    let clock = 1_000;
    const throttle = createRefreshThrottle(10_000, () => clock);
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = throttle(run);
    const second = throttle(run); // while in flight
    expect(second).toBe(first);
    release();
    await first;

    clock += 5_000;
    await throttle(run); // inside 10 s: no new run
    expect(run).toHaveBeenCalledTimes(1);

    clock += 6_000;
    const third = throttle(run);
    release();
    await third;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('allows a retry after a failed run', async () => {
    let clock = 0;
    const throttle = createRefreshThrottle(10_000, () => clock);
    await expect(throttle(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    clock += 11_000;
    const run = vi.fn(async () => {});
    await throttle(run);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
