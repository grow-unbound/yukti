import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const composerRoute = readFileSync(join(root, 'app/api/tenant/products/composer/route.ts'), 'utf8');
const buyerProductData = readFileSync(join(root, 'src/lib/server/buyer-product-data.ts'), 'utf8');
const campaignItemsCache = readFileSync(join(root, 'src/lib/server/campaign-items-cache.ts'), 'utf8');

describe('product query bounds', () => {
  it('caps metadata inputs and chunks selected product hydration without dropping normal selections', () => {
    expect(composerRoute).toContain('const METADATA_LOOKUP_LIMIT = PAGE_SIZE.MAX');
    expect(composerRoute).toContain('const SELECTED_PRODUCTS_LIMIT = 250');
    expect(composerRoute).toContain("readMultiParam(params, 'selected_id', SELECTED_PRODUCTS_LIMIT)");
    expect(composerRoute).toContain('chunkIds(selectedIds, PAGE_SIZE.MAX)');
    expect(composerRoute.match(/\.limit\(METADATA_LOOKUP_LIMIT\)/g)).toHaveLength(2);
  });

  it('bounds catalog summaries and uses aggregate item counts outside authoritative product paging', () => {
    expect(buyerProductData).toContain('const BUYER_CATALOG_SUMMARY_LIMIT = 100');
    expect(buyerProductData).toContain(".select('id, campaign_items(count)')");
    expect(buyerProductData).toContain('.limit(BUYER_CATALOG_SUMMARY_LIMIT)');
    // campaign_items are read once per campaign through the bounded, cached helper — never per page
    expect(buyerProductData).toContain('getCampaignItemsForProducts');
    expect(buyerProductData).not.toContain(".from('campaign_items')");
    expect(campaignItemsCache).toContain('.limit(CAMPAIGN_ITEMS_LIMIT)');
    expect(buyerProductData).toContain('limit,\n      offset,');
    expect(buyerProductData).not.toContain(".from('campaign_items')\n      .select('campaign_id')");
  });
});
