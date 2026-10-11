'use client';

import Image from 'next/image';
import { Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AuthTenantBranding {
  tenantName: string;
  tenantLogoUrl: string | null;
}

export function AuthTenantBrand({
  branding,
  className,
}: {
  branding: AuthTenantBranding | null;
  className?: string;
}) {
  const tenantName = branding?.tenantName?.trim() || 'Your supplier';

  return (
    <div className={cn('inline-flex min-w-0 items-center gap-3', className)}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-cream-200 bg-white">
        {branding?.tenantLogoUrl ? (
          <Image
            src={branding.tenantLogoUrl}
            alt={tenantName}
            width={40}
            height={40}
            className="h-full w-full object-contain p-1"
            unoptimized
          />
        ) : (
          <Building2 className="h-5 w-5 text-cream-600" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 text-left">
        <p className="truncate text-body-sm font-semibold text-cream-900">{tenantName}</p>
        <p className="text-caption text-cream-600">Supplier catalog</p>
      </div>
    </div>
  );
}
