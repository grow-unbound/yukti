import { PulseV2Skeleton } from '@/components/seller/pulse/v2/PulseV2Skeleton';

// Mirrors PulseV2Client (header, period bar, bands) so streaming and hydration do not jump.
export default function PulseLoading() {
  return <PulseV2Skeleton />;
}
