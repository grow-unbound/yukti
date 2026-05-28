'use client';

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { BrandUpsertSchema, type BrandUpsertInput } from '@/lib/zod';
import { useSaveTenantBrand, useSearchMasterBrands, type TenantBrand } from '@/hooks/useBrands';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ImageUploadZone } from '@/components/seller/products/ImageUploadZone';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function getEffectiveBrandName(brand: TenantBrand): string {
  return brand.display_name_override ?? brand.master_brand?.name ?? '';
}

function getEffectiveDescription(brand: TenantBrand): string {
  return brand.description_override ?? brand.master_brand?.description ?? '';
}

function getEffectiveLogo(brand: TenantBrand): string {
  return brand.logo_url_override ?? brand.master_brand?.logo_url ?? '';
}

interface BrandFormDialogProps {
  mode: 'create' | 'edit';
  brand?: TenantBrand;
  trigger?: React.ReactNode;
  onSaved?: () => void;
}

interface BrandSearchOption {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  description: string | null;
}

export function BrandFormDialog({ mode, brand, trigger, onSaved }: BrandFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedCatalogBrand, setSelectedCatalogBrand] = useState<BrandSearchOption | null>(null);
  const { data: searchData, isLoading: isSearching } = useSearchMasterBrands(search);
  const saveBrand = useSaveTenantBrand();

  const form = useForm<BrandUpsertInput>({
    resolver: zodResolver(BrandUpsertSchema),
    defaultValues: {
      tenant_brand_id: undefined,
      master_brand_id: undefined,
      name: '',
      display_name_override: '',
      description_override: '',
      logo_url_override: '',
      margin_pct: null,
    },
  });

  const isEdit = mode === 'edit' && !!brand;

  useEffect(() => {
    if (!open) return;

    if (isEdit && brand) {
      const effectiveName = getEffectiveBrandName(brand);
      form.reset({
        tenant_brand_id: brand.id,
        master_brand_id: brand.master_brand_id,
        name: effectiveName,
        display_name_override: brand.display_name_override ?? '',
        description_override: getEffectiveDescription(brand),
        logo_url_override: getEffectiveLogo(brand),
        margin_pct: brand.margin_pct,
      });
      setSearch(effectiveName);
      setSelectedCatalogBrand(null);
      return;
    }

    form.reset({
      tenant_brand_id: undefined,
      master_brand_id: undefined,
      name: '',
      display_name_override: '',
      description_override: '',
      logo_url_override: '',
      margin_pct: null,
    });
    setSearch('');
    setSelectedCatalogBrand(null);
  }, [open, isEdit, brand, form]);

  const watchedName = form.watch('name');
  const watchedLogoUrl = form.watch('logo_url_override');
  const showOverrideName = Boolean(selectedCatalogBrand);

  const results = useMemo(() => searchData?.brands ?? [], [searchData?.brands]);

  function handleSelectCatalogBrand(option: BrandSearchOption) {
    setSelectedCatalogBrand(option);
    setSearch(option.name);
    form.setValue('name', option.name, { shouldValidate: true });
    form.setValue('master_brand_id', option.id);
    form.setValue('description_override', option.description ?? '');
    form.setValue('logo_url_override', option.logo_url ?? '');
    form.setValue('display_name_override', '');
  }

  function handleNameChange(value: string) {
    setSearch(value);
    form.setValue('name', value, { shouldValidate: true });

    if (selectedCatalogBrand && value.trim() !== selectedCatalogBrand.name) {
      setSelectedCatalogBrand(null);
      form.setValue('master_brand_id', undefined);
    }
  }

  async function onSubmit(values: BrandUpsertInput) {
    try {
      const payload: BrandUpsertInput = {
        tenant_brand_id: isEdit ? values.tenant_brand_id : undefined,
        master_brand_id: values.master_brand_id,
        name: values.name.trim(),
        display_name_override: values.display_name_override?.trim() || undefined,
        description_override: values.description_override?.trim() || undefined,
        logo_url_override: values.logo_url_override?.trim() || undefined,
        margin_pct: values.margin_pct ?? null,
      };

      await saveBrand.mutateAsync(payload);
      toast.success(isEdit ? 'Brand updated' : 'Brand added');
      setOpen(false);
      onSaved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save brand';
      toast.error(msg);
    }
  }

  return (
    <>
      {trigger ? (
        <span
          role="button"
          tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setOpen(true);
            }
          }}
        >
          {trigger}
        </span>
      ) : (
        <Button onClick={() => setOpen(true)} className="bg-teal-500 hover:bg-teal-600 text-cream-50">
          <Plus className="w-4 h-4 mr-1" />
          Add brand
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl p-0">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit brand' : 'Add brand'}</DialogTitle>
            <DialogDescription>
              Search an existing catalog brand or type a new brand name to create your custom brand.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)}>
            <DialogBody className="space-y-5">
              <div>
                <label className="text-sm font-medium text-cream-900">Brand name</label>
                <Input
                  value={watchedName ?? ''}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Search catalog brands or type a new name"
                  className="mt-1"
                />
                {search.length >= 1 && !isEdit && (
                  <div className="mt-2 rounded-md border border-cream-200 max-h-48 overflow-auto">
                    {isSearching ? (
                      <p className="text-xs text-cream-600 px-3 py-2">Searching...</p>
                    ) : results.length === 0 ? (
                      <p className="text-xs text-cream-600 px-3 py-2">No matches. Save to create a new custom brand.</p>
                    ) : (
                      <div className="divide-y divide-cream-200">
                        {results.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="w-full text-left px-3 py-2 hover:bg-cream-100 flex items-center justify-between"
                            onClick={() => handleSelectCatalogBrand(item)}
                          >
                            <span className="flex items-center gap-3">
                              {item.logo_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={item.logo_url}
                                  alt={item.name}
                                  className="w-8 h-8 rounded object-contain border border-cream-200 bg-white"
                                />
                              ) : (
                                <span className="w-8 h-8 rounded bg-teal-100 text-teal-700 font-display text-xs font-semibold flex items-center justify-center">
                                  {item.name
                                    .split(' ')
                                    .map((w) => w[0])
                                    .slice(0, 2)
                                    .join('')
                                    .toUpperCase()}
                                </span>
                              )}
                              <span>
                                <span className="text-sm text-cream-900">{item.name}</span>
                                <span className="text-xs text-cream-600 block">{item.slug}</span>
                              </span>
                            </span>
                            {selectedCatalogBrand?.id === item.id && <Check className="w-4 h-4 text-teal-600" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {showOverrideName && (
                <div>
                  <label className="text-sm font-medium text-cream-900">Override brand name (optional)</label>
                  <Input
                    {...form.register('display_name_override')}
                    placeholder="Tenant-specific brand display name"
                    className="mt-1"
                  />
                </div>
              )}

              <div>
                <label className="text-sm font-medium text-cream-900">Description</label>
                <Textarea
                  {...form.register('description_override')}
                  rows={3}
                  placeholder="Brand description"
                  className="mt-1"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-cream-900">Brand logo</label>
                <div className="mt-2">
                  <ImageUploadZone
                    value={watchedLogoUrl ? [watchedLogoUrl] : []}
                    onChange={(urls) => {
                      form.setValue('logo_url_override', urls[0] ?? '', { shouldValidate: true });
                    }}
                    maxImages={1}
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-cream-900">Margin percentage</label>
                <div className="relative mt-1">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    {...form.register('margin_pct')}
                    placeholder="e.g. 12.5"
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-cream-600">%</span>
                </div>
              </div>
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="bg-teal-500 hover:bg-teal-600 text-cream-50" disabled={saveBrand.isPending}>
                {saveBrand.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Saving...</>
                ) : isEdit ? (
                  <><Pencil className="w-4 h-4 mr-1" /> Save changes</>
                ) : (
                  <><Plus className="w-4 h-4 mr-1" /> Add brand</>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
