import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { BuyerProductDetailClient } from '@/components/buyer/catalog/BuyerProductDetailClient';
import { requireBuyerDeliverySelection } from '@/lib/server/buyer-location-selection';
import { storefrontPageTitle } from '@/lib/server/storefront-metadata';

type PageProps = {
  params: Promise<{ id: string }>;
};

// Static on purpose: looking the name up here cost a tenant_products (+ catalog.products) read on every
// PDP open, and BuyerProductDetailClient already receives the name in its detail payload and sets
// document.title once that loads.
export function generateMetadata(): Metadata {
  return storefrontPageTitle('Product');
}

export default async function BuyerProductPage({ params }: PageProps) {
  const { id } = await params;
  if (!id?.trim()) notFound();
  await requireBuyerDeliverySelection(`/buy/product/${id}`);
  return <BuyerProductDetailClient tenantProductId={id} />;
}
