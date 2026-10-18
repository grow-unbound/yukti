import { PulseV2Skeleton } from '@/components/seller/pulse/v2/PulseV2Skeleton';

// Mirrors the df_pulse_v2 layout (the destination). Tenants still on the old Pulse see a similar
// header + section skeleton for the brief route transition.
export default function PulseLoading() {
  return <PulseV2Skeleton />;
}
