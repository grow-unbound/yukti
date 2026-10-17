'use client';

import { useTenantSettings } from '@/hooks/useTenantSettings';

export function useBusinessPolicy() {
  const { data, isLoading } = useTenantSettings();
  return {
    // True only while settings are in flight: lets money surfaces wait instead of flashing non-inclusive totals.
    policyLoading: isLoading,
    creditEnabled: data?.modules.business_policy.credit_enabled ?? true,
    gstInclusive: data?.modules.business_policy.gst_inclusive ?? false,
    gstRate: data?.modules.business_policy.gst_rate ?? 18,
  };
}
