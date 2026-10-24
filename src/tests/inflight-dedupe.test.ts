import { describe, expect, it, vi } from 'vitest';
import { dedupeInflight } from '@/lib/server/inflight-dedupe';

describe('dedupeInflight', () => {
  it('runs once for concurrent identical calls and nothing is cached afterwards', async () => {
    const scope = {};
    const run = vi.fn().mockResolvedValue('v');

    const [a, b] = await Promise.all([
      dedupeInflight(scope, 'k', run),
      dedupeInflight(scope, 'k', run),
    ]);
    expect([a, b]).toEqual(['v', 'v']);
    expect(run).toHaveBeenCalledTimes(1);

    await dedupeInflight(scope, 'k', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not share across scopes or keys', async () => {
    const run = vi.fn().mockResolvedValue('v');
    await Promise.all([
      dedupeInflight({}, 'k', run),
      dedupeInflight({}, 'k', run),
      dedupeInflight({}, 'other', run),
    ]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('releases the entry after a rejection so the next call retries', async () => {
    const scope = {};
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');

    await expect(dedupeInflight(scope, 'k', run)).rejects.toThrow('boom');
    await expect(dedupeInflight(scope, 'k', run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
