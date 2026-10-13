import type { Metadata } from 'next';
import { CatalogFilteredBrowse } from '@/components/buyer/catalog/CatalogFilteredBrowse';
import { requireBuyerDeliverySelection } from '@/lib/server/buyer-location-selection';
import { storefrontPageTitle } from '@/lib/server/storefront-metadata';
import { loadInitialCatalogListData } from '@/lib/server/buyer-catalog-list-ssr';

type PageProps = {
  params: Promise<{ id: string }>;
};

// Static on purpose: the title lookup was a DB read on every open. The client component already
// receives the label in its data payload and sets document.title once that loads.
export function generateMetadata(): Metadata {
  return storefrontPageTitle('Brand');
}

export default async function BuyerCatalogBrandPage({ params }: PageProps) {
  const { id } = await params;
  await requireBuyerDeliverySelection(`/buy/home/brand/${id}`);
  const { catalogPage, brands, categories } = await loadInitialCatalogListData('brand', id);
  return (
    <CatalogFilteredBrowse
      mode="brand"
      id={id}
      initialCatalogPage={catalogPage}
      initialBrands={brands ?? undefined}
      initialCategories={categories ?? undefined}
    />
  );
}
