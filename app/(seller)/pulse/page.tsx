import { redirect } from 'next/navigation';

import { sellerPageTitle, SELLER_PAGE_TITLES } from '@/lib/page-titles';
import { PulseDashboardClient } from '@/components/seller/pulse/PulseDashboardClient';
import { PulseV2Client } from '@/components/seller/pulse/v2/PulseV2Client';
import { FEATURE_FLAGS } from '@/constants';
import { getFlag } from '@/lib/flags';
import { canAccessPulse, sellerHomeRoute } from '@/lib/server/pulse-access';
import { getSellerServerClaims, requireSellerServerTenantId } from '@/lib/server/seller-server-claims';

export const metadata = sellerPageTitle(SELLER_PAGE_TITLES.dashboard);

export default async function PulsePage() {
  const tenantId = await requireSellerServerTenantId();
  const claims = await getSellerServerClaims();
  // Defense in depth: the layout already gates, but never render Pulse for non-admins.
  if (!canAccessPulse(claims.role)) redirect(sellerHomeRoute(claims.role));
  // df_pulse_v2 (default off): period-aware Pulse computed from raw tables; the old snapshot-fed Pulse stays until it is on everywhere.
  if (await getFlag(FEATURE_FLAGS.PULSE_V2, tenantId)) return <PulseV2Client />;
  return <PulseDashboardClient />;
}
