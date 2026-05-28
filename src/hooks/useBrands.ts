'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BrandUpsertInput } from '@/lib/zod';
import { apiFetch, apiPost, apiPatch } from '@/lib/api-fetch';

export interface MasterBrand {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  description: string | null;
}

export interface TenantBrand {
  id: string;
  tenant_id: string;
  master_brand_id: string;
  display_name_override: string | null;
  description_override: string | null;
  logo_url_override: string | null;
  margin_pct: number | null;
  exclusivity: boolean | null;
  is_active: boolean;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
  master_brand: MasterBrand | null;
}

export interface TenantBrandsResponse {
  brands: TenantBrand[];
}

export interface SearchBrandsResponse {
  brands: MasterBrand[];
}

export interface AddBrandPayload {
  master_brand_id: string;
  display_name_override?: string;
}

export function useTenantBrands() {
  return useQuery({
    queryKey: ['tenant-brands'],
    queryFn: async (): Promise<TenantBrandsResponse> => {
      const res = await apiFetch('/api/tenant/brands');
      if (!res.ok) {
        throw new Error('Failed to fetch brands');
      }
      return res.json();
    },
  });
}

export function useSearchMasterBrands(query: string) {
  return useQuery({
    queryKey: ['master-brands-search', query],
    queryFn: async (): Promise<SearchBrandsResponse> => {
      const params = new URLSearchParams({ q: query });
      const res = await apiFetch(`/api/brands/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to search brands');
      }
      return res.json();
    },
    enabled: query.length >= 1,
    staleTime: 30_000,
  });
}

export function useAddBrandToTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: AddBrandPayload): Promise<TenantBrand> => {
      const res = await apiPost('/api/tenant/brands', payload);

      if (res.status === 409) {
        throw new Error('Brand already in your catalog');
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to add brand');
      }

      const data = await res.json();
      return data.brand as TenantBrand;
    },

    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['tenant-brands'] });
      const prev = queryClient.getQueryData<TenantBrandsResponse>(['tenant-brands']);

      // Optimistic brand: placeholder until server responds
      const optimisticBrand: TenantBrand = {
        id: `optimistic-${Date.now()}`,
        tenant_id: '',
        master_brand_id: payload.master_brand_id,
        display_name_override: payload.display_name_override ?? null,
        description_override: null,
        logo_url_override: null,
        margin_pct: null,
        exclusivity: null,
        is_active: true,
        external_ref: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        master_brand: null,
      };

      queryClient.setQueryData<TenantBrandsResponse>(['tenant-brands'], (old) => ({
        brands: [optimisticBrand, ...(old?.brands ?? [])],
      }));

      return { prev };
    },

    onError: (_err, _payload, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['tenant-brands'], context.prev);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-brands'] });
    },

    onSuccess: () => {
      toast.success('Brand added to your catalog');
    },
  });
}

export interface BrandSaveError {
  status: number;
  error: string;
  details?: unknown;
}

export function useSaveTenantBrand() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: BrandUpsertInput): Promise<{ brand: TenantBrand }> => {
      const isEdit = Boolean(data.tenant_brand_id);
      const res = isEdit
        ? await apiPatch('/api/tenant/brands', data)
        : await apiPost('/api/tenant/brands', data);

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw { status: res.status, ...(err as object) } as BrandSaveError;
      }

      return res.json() as Promise<{ brand: TenantBrand }>;
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-brands'] });
    },
  });
}
