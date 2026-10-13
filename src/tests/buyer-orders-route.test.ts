import { beforeEach, describe, expect, it, vi } from 'vitest';

// `after()` only works inside a request scope; run the callback inline so tests can assert on it.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: unknown) => {
    void (typeof task === 'function' ? (task as () => unknown)() : task);
  },
}));

const requireBuyerAccessProfileMock = vi.fn();
const sendImmediateTransactionNotificationsMock = vi.fn();
const insertSingleMock = vi.fn();
const orderInsertPayloads: Array<Record<string, unknown>> = [];
const orderSelectMock = {
  eq: vi.fn(() => ({
    eq: vi.fn(() => ({
      is: vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn(async () => ({
            data: [],
            error: null,
          })),
        })),
      })),
    })),
  })),
};

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/lib/server/buyer-access', () => ({
  requireBuyerAccessProfile: (...args: unknown[]) => requireBuyerAccessProfileMock(...args),
}));

vi.mock('@/lib/server/transaction-outbound-push', () => ({
  tenantDefersTransactionNumber: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/server/buyer-transaction-notify-immediate', () => ({
  sendImmediateTransactionNotifications: (...args: unknown[]) =>
    sendImmediateTransactionNotificationsMock(...args),
}));

vi.mock('@/lib/server/buyer-location-selection', () => ({
  getSelectedBuyerDeliveryFromRequest: vi.fn().mockReturnValue(null),
  resolveTenantScopedLocationId: vi.fn().mockResolvedValue('loc-1'),
}));

vi.mock('@/lib/server/buyer-product-data', () => ({
  resolveBuyerInventoryWarehouseId: vi.fn().mockResolvedValue('wh-1'),
  resolveVisibleCampaignMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@/lib/server/buyer-cart-stock', () => ({
  validateBuyerCartStock: vi.fn(async (_db, input: { items: unknown[] }) => ({
    ok: true,
    items: input.items,
  })),
}));

vi.mock('@/lib/server/campaign-attribution', () => ({
  inferCampaignIdForBuyerCart: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/server/buyer-app-activity', () => ({
  recordBuyerAppActivitySafe: vi.fn(),
}));

vi.mock('@/lib/server/seller-features', () => ({
  getInAppCreateFlags: vi.fn().mockResolvedValue({
    create_sales_orders: true,
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'resolve_prices_batch') {
          return {
            data: [
              { tenant_product_id: 'prod-1', unit_price: 500 },
              { tenant_product_id: 'prod-2', unit_price: 1000 },
            ],
            error: null,
          };
        }
        return { data: null, error: null };
      }),
      from: vi.fn((table: string) => {
        if (table === 'orders') {
          return {
            select: vi.fn(() => orderSelectMock),
            insert: vi.fn((payload: Record<string, unknown>) => {
              orderInsertPayloads.push(payload);
              return { select: vi.fn(() => ({ single: insertSingleMock })) };
            }),
            update: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })),
          };
        }
        if (table === 'order_items') {
          return {
            insert: vi.fn(async () => ({ error: null })),
          };
        }
        if (table === 'tenant_settings') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { settings: { business_policy: { gst_inclusive: false, gst_rate: 18 } } },
                  error: null,
                })),
              })),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }),
    })),
  },
}));

vi.mock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({
    capture: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  }),
}));

function withNextUrl(request: Request): Request {
  Object.assign(request, { nextUrl: new URL(request.url) });
  return request;
}

describe('buyer orders route', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    orderInsertPayloads.length = 0;
    const { tenantDefersTransactionNumber } = await import('@/lib/server/transaction-outbound-push');
    vi.mocked(tenantDefersTransactionNumber).mockResolvedValue(false);
    insertSingleMock.mockResolvedValue({
      data: { id: 'ord-abc', order_number: 'ORD-2026-0001' },
      error: null,
    });
    sendImmediateTransactionNotificationsMock.mockResolvedValue(true);
  });

  it('returns the preview empty-state message in preview mode', async () => {
    requireBuyerAccessProfileMock.mockResolvedValue({
      context: {
        sub: 'seller-1',
        tenant_id: 'tenant-1',
        role: 'buyer_admin',
        buyer_id: null,
        mode: 'preview',
        share_token: 'tok',
        preview: { tenant_id: 'tenant-1', role: 'buyer_admin', share_token: 'tok', exp: 9999999999, iat: 1, typ: 'buyer_preview_v1' },
      },
      buyer: null,
      tenant: { id: 'tenant-1', business_name: 'Yukti Demo', slug: 'yukti-demo' },
    });

    const { GET } = await import('../../app/api/buyer/orders/route');
    const response = await GET(withNextUrl(new Request('http://localhost/api/buyer/orders')) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      mode: 'preview',
      orders: [],
      nextCursor: null,
      total: null,
      seller_preview: true,
    });
  });

  it('creates an order with routing details and sends whatsapp notifications', async () => {
    requireBuyerAccessProfileMock.mockResolvedValue({
      context: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        role: 'buyer_admin',
        buyer_id: 'buyer-1',
        mode: 'buyer',
        share_token: null,
        preview: null,
      },
      buyer: { id: 'buyer-1', phone: '9876543210', contact_name: 'Ravi', business_name: 'Ravi Wines' },
      tenant: { id: 'tenant-1', business_name: 'WineYard', slug: 'wineyard' },
    });

    const { POST } = await import('../../app/api/buyer/orders/route');
    const response = await POST(withNextUrl(new Request('http://localhost/api/buyer/orders', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ tenant_product_id: 'prod-1', qty: 2, unit_price: 500 }],
        location_id: 'loc-1',
        place_of_supply: 'Andheri East',
      }),
    })) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.document_status_note).toBeNull();
    expect(body.whatsapp_sent).toBe(true);
    expect(sendImmediateTransactionNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'order',
        documentId: 'ord-abc',
        documentNumber: 'ORD-2026-0001',
      }),
    );
    expect(orderInsertPayloads[0]).toMatchObject({
      source: 'buyer_app',
      is_buyer_app_order: true,
    });
  });

  it('rejects POST for a buyer_pending session with buyer_app_enabled=false', async () => {
    requireBuyerAccessProfileMock.mockResolvedValue({
      context: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        role: 'buyer_pending',
        buyer_id: 'buyer-1',
        mode: 'buyer',
        share_token: null,
        preview: null,
      },
      buyer: { id: 'buyer-1', phone: '9876543210', contact_name: 'Ravi', business_name: 'Ravi Wines', buyer_app_enabled: false },
      tenant: { id: 'tenant-1', business_name: 'WineYard', slug: 'wineyard' },
    });

    const { POST } = await import('../../app/api/buyer/orders/route');
    const response = await POST(withNextUrl(new Request('http://localhost/api/buyer/orders', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ tenant_product_id: 'prod-1', qty: 2, unit_price: 500 }],
        location_id: 'loc-1',
        place_of_supply: 'Andheri East',
      }),
    })) as any);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.success).toBe(false);
    expect(orderInsertPayloads.length).toBe(0);
  });

  it('rejects GET for a buyer_pending session with buyer_app_enabled=false', async () => {
    requireBuyerAccessProfileMock.mockResolvedValue({
      context: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        role: 'buyer_pending',
        buyer_id: 'buyer-1',
        mode: 'buyer',
        share_token: null,
        preview: null,
      },
      buyer: { id: 'buyer-1', phone: '9876543210', contact_name: 'Ravi', business_name: 'Ravi Wines', buyer_app_enabled: false },
      tenant: { id: 'tenant-1', business_name: 'WineYard', slug: 'wineyard' },
    });

    const { GET } = await import('../../app/api/buyer/orders/route');
    const response = await GET(withNextUrl(new Request('http://localhost/api/buyer/orders')) as any);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBeDefined();
  });

  it('defers whatsapp and returns the pending note when outbound integration owns numbering', async () => {
    requireBuyerAccessProfileMock.mockResolvedValue({
      context: {
        sub: 'user-1',
        tenant_id: 'tenant-1',
        role: 'buyer_admin',
        buyer_id: 'buyer-1',
        mode: 'buyer',
        share_token: null,
        preview: null,
      },
      buyer: { id: 'buyer-1', phone: '9876543210', contact_name: 'Ravi', business_name: 'Ravi Wines' },
      tenant: { id: 'tenant-1', business_name: 'WineYard', slug: 'wineyard' },
    });
    const { tenantDefersTransactionNumber } = await import('@/lib/server/transaction-outbound-push');
    vi.mocked(tenantDefersTransactionNumber).mockResolvedValue(true);
    insertSingleMock.mockResolvedValue({
      data: { id: 'ord-abc', order_number: null },
      error: null,
    });

    const { POST } = await import('../../app/api/buyer/orders/route');
    const response = await POST(withNextUrl(new Request('http://localhost/api/buyer/orders', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ tenant_product_id: 'prod-1', qty: 2, unit_price: 500 }],
        location_id: 'loc-1',
        place_of_supply: 'Andheri East',
      }),
    })) as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.order_number).toBeNull();
    expect(body.document_status_note).toBe('will be created soon');
    expect(body.whatsapp_sent).toBe(false);
    expect(sendImmediateTransactionNotificationsMock).not.toHaveBeenCalled();
  });
});
