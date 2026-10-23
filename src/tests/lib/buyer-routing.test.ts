import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: null,
  supabase: {},
}));

import { resolveNearestBuyerLocation } from '@/lib/server/buyer-routing';

function createDb(settings: Record<string, unknown>, warehouseRows: Array<Record<string, unknown>>, defaultRows: Array<Record<string, unknown>>) {
  return {
    schema: () => ({
      from: (table: string) => {
        if (table === 'tenant_settings') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { settings }, error: null }),
              }),
            }),
          };
        }

        if (table === 'warehouses') {
          return {
            select: () => ({
              eq: () => ({
                // nearest-warehouse candidates: .eq().is().not().not()
                is: () => ({
                  not: () => ({
                    not: async () => ({ data: warehouseRows, error: null }),
                  }),
                }),
                // default warehouse fallback: .eq().eq().is().limit() - none configured in these cases
                eq: () => ({
                  is: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }

        if (table === 'locations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    limit: async () => ({ data: defaultRows, error: null }),
                  }),
                }),
              }),
            }),
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    }),
  };
}

describe('resolveNearestBuyerLocation', () => {
  it('falls back to the default location when no warehouse is within the 50km default threshold', async () => {
    const db = createDb(
      {},
      [
        {
          id: 'warehouse-1',
          name: 'Far Warehouse',
          lat: 0.6,
          lng: 0.6,
          is_default: false,
          location_id: 'branch-1',
        },
      ],
      [{ id: 'default-location', name: 'Default Warehouse' }],
    );

    const resolved = await resolveNearestBuyerLocation(db as never, 'tenant-1', { lat: 0, lng: 0 });

    expect(resolved).toEqual({
      warehouseId: null,
      locationId: 'default-location',
      locationName: 'Default Warehouse',
      warehouseName: null,
      distanceKm: null,
      fallback: true,
    });
  });

  it('uses a custom threshold when present and returns the nearest warehouse within range', async () => {
    const db = createDb(
      { delivery_routing_threshold_km: 120 },
      [
        {
          id: 'warehouse-1',
          name: 'Near Warehouse',
          lat: 0.3,
          lng: 0.3,
          is_default: false,
          location_id: 'branch-1',
        },
      ],
      [{ id: 'default-location', name: 'Default Warehouse' }],
    );

    const resolved = await resolveNearestBuyerLocation(db as never, 'tenant-1', { lat: 0, lng: 0 });

    expect(resolved?.warehouseId).toBe('warehouse-1');
    expect(resolved?.locationId).toBe('branch-1');
    expect(resolved?.locationName).toBe('Near Warehouse');
    expect(resolved?.fallback).toBe(false);
    expect(resolved?.distanceKm).toEqual(expect.any(Number));
  });
});

describe('routing inputs are cached per tenant', () => {
  it('reads settings and warehouses through the tenant-keyed, tag-scoped cache', async () => {
    const calls: Array<{ key: string[]; tags?: string[]; revalidate?: number }> = [];
    // re-import with an observing mock
    vi.resetModules();
    vi.doMock('next/cache', () => ({
      unstable_cache: (fn: () => unknown, key: string[], opts: { tags?: string[]; revalidate?: number }) => {
        calls.push({ key, tags: opts.tags, revalidate: opts.revalidate });
        return fn;
      },
    }));
    const mod = await import('@/lib/server/buyer-routing');
    const db = createDb({}, [{ id: 'w1', name: 'Near', lat: 0, lng: 0, is_default: true, location_id: null }], []);

    const resolved = await mod.resolveNearestBuyerLocation(db as never, 'tenant-9', { lat: 0, lng: 0 });

    expect(resolved?.warehouseId).toBe('w1');
    expect(calls.map((c) => c.key.join(':')).sort()).toEqual([
      'buyer-routing:threshold:tenant-9',
      'buyer-routing:warehouses:tenant-9',
    ]);
    expect(calls.every((c) => c.tags?.[0] === 'tenant-settings:tenant-9' && c.revalidate === 60)).toBe(true);
    vi.doUnmock('next/cache');
  });

  it('falls back to the 50 km default instead of throwing (or caching) when the settings read fails', async () => {
    const db = createDb({}, [{ id: 'w1', name: 'Near', lat: 0, lng: 0, is_default: true, location_id: null }], []);
    const failing = {
      schema: () => ({
        from: (table: string) => table === 'tenant_settings'
          ? { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }) }) }
          : (db.schema() as any).from(table),
      }),
    };
    const resolved = await resolveNearestBuyerLocation(failing as never, 'tenant-err', { lat: 0, lng: 0 });
    expect(resolved?.warehouseId).toBe('w1');
  });
});

