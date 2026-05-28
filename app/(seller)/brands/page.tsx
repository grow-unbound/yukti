'use client';

import { Pencil, Plus } from 'lucide-react';

import { SellerTopbar } from '@/components/layout/SellerTopbar';
import { FeatureGate } from '@/components/FeatureGate';
import { BrandFormDialog } from '@/components/seller/brands/BrandFormDialog';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/empty-state';
import { useTenantBrands } from '@/hooks/useBrands';
import type { TenantBrand } from '@/hooks/useBrands';

function BrandAvatar({ brand }: { brand: TenantBrand }) {
  const masterBrand = brand.master_brand;
  const displayName = brand.display_name_override ?? masterBrand?.name ?? 'Unknown';
  const logoUrl = brand.logo_url_override ?? masterBrand?.logo_url;
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={displayName}
        className="w-10 h-10 rounded object-contain"
      />
    );
  }
  const initials = displayName
    .split(' ')
    .map((w: string) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="w-10 h-10 rounded bg-teal-100 text-teal-700 font-display text-sm font-semibold flex items-center justify-center">
      {initials}
    </span>
  );
}

function BrandCard({ brand }: { brand: TenantBrand }) {
  const displayName = brand.display_name_override ?? brand.master_brand?.name ?? 'Unknown Brand';
  const slug = brand.master_brand?.slug ?? '';
  const description = brand.master_brand?.description ?? '';

  return (
    <div className="bg-cream-100 rounded-lg shadow-xs border border-cream-200 p-4 flex items-center gap-4">
      <BrandAvatar brand={brand} />
      <div className="flex-1 min-w-0">
        <p className="font-display font-medium text-cream-900 truncate">{displayName}</p>
        {slug && (
          <p className="text-sm text-cream-600 truncate">{slug}</p>
        )}
        {description && (
          <p className="text-xs text-cream-500 truncate mt-1">{description}</p>
        )}
      </div>
      <BrandFormDialog
        mode="edit"
        brand={brand}
        trigger={(
          <Button variant="outline" size="sm">
            <Pencil className="w-3.5 h-3.5 mr-1" />
            Edit
          </Button>
        )}
      />
    </div>
  );
}

function BrandsContent() {
  const { data, isLoading, isError } = useTenantBrands();
  const brands = data?.brands ?? [];

  if (isLoading) {
    return <LoadingState label="Loading brands..." />;
  }

  if (isError) {
    return (
      <ErrorState
        heading="Couldn't load brands"
        description="There was a problem fetching your brands. Please try again."
      />
    );
  }

  if (brands.length === 0) {
    return (
      <EmptyState
        icon={<Plus size={28} strokeWidth={1.5} />}
        heading="No brands yet"
        description="Link brands from the master catalog or create a custom brand to start building your catalog."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {brands.map((brand) => (
        <BrandCard key={brand.id} brand={brand} />
      ))}
    </div>
  );
}

function BrandsActions() {
  return <BrandFormDialog mode="create" />;
}

export default function BrandsPage() {
  return (
    <div className="px-8 py-6">
      <SellerTopbar
        title="Brands"
        subtitle="Manage the brand principals and custom brands available to your seller workspace."
        action={<BrandsActions />}
      />
      <FeatureGate flag="BRAND_PRODUCT_MASTER">
        <BrandsContent />
      </FeatureGate>
      </div>
  );
}
