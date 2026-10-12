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
  return storefrontPageTitle('Category');
}

export default async function BuyerCatalogCategoryPage({ params }: PageProps) {
  const { id } = await params;
  await requireBuyerDeliverySelection(`/buy/home/category/${id}`);
  const { catalogPage, brands, categories } = await loadInitialCatalogListData('category', id);
  return (
    <CatalogFilteredBrowse
      mode="category"
      id={id}
      initialCatalogPage={catalogPage}
      initialBrands={brands ?? undefined}
      initialCategories={categories ?? undefined}
    />
  );
}
