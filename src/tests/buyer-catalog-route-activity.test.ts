import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireBuyerAccessProfileMock = vi.fn();
const resolveBuyerCatalogContextMock = vi.fn();
const fetchBuyerCatalogPageMock = vi.fn();
const recordActivityMock = vi.fn();

vi.mock('@/lib/server/buyer-access', () => ({
  requireBuyerAccessProfile: (...args: unknown[]) => requireBuyerAccessProfileMock(...args),
}));
vi.mock('@/lib/server/buyer-product-data', () => ({
  resolveBuyerCatalogContext: (...args: unknown[]) => resolveBuyerCatalogContextMock(...args),
  fetchBuyerCatalogPage: (...args: unknown[]) => fetchBuyerCatalogPageMock(...args),
  isCatalogApprovalRequiredForProfile: () => false,
}));
vi.mock('@/lib/server/buyer-product-families', () => ({ fetchBuyerFamilyCatalogPage: vi.fn() }));
vi.mock('@/lib/server/buyer-app-activity', () => ({
  recordBuyerAppActivitySafe: (...args: unknown[]) => recordActivityMock(...args),
}));
vi.mock('@/lib/server/campaign-engagement', () => ({ recordCampaignView: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabaseAdmin: {} }));

describe('GET /api/buyer/catalog catalog_viewed activity', () => {
  beforeEach(() => {
    requireBuyerAccessProfileMock.mockReset().mockResolvedValue({ context: { tenant_id: 'tenant-1' }, buyer: null });
    resolveBuyerCatalogContextMock.mockReset().mockResolvedValue({
      tenantId: 'tenant-1',
      buyerId: 'buyer-1',
      inventoryWarehouseId: null,
      allowedTenantBrandIds: null,
      visibleCampaigns: [],
      catalogs: [],
      guestPricing: null,
      publicCatalog: null,
    });
    fetchBuyerCatalogPageMock.mockReset().mockResolvedValue({
      items: [], total: 0, has_more: false, selected_campaign_id: null,
    });
    recordActivityMock.mockReset();
  });

  it('records catalog_viewed on the first page', async () => {
    const { GET } = await import('../../app/api/buyer/catalog/route');
    await GET(new NextRequest('http://localhost/api/buyer/catalog?limit=40&offset=0'));
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][1]).toMatchObject({ eventName: 'catalog_viewed', buyerId: 'buyer-1' });
  });

  it('does not record for scroll pages (offset > 0)', async () => {
    const { GET } = await import('../../app/api/buyer/catalog/route');
    await GET(new NextRequest('http://localhost/api/buyer/catalog?limit=40&offset=40'));
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
