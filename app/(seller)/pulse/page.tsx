import { redirect } from 'next/navigation';

import { sellerPageTitle, SELLER_PAGE_TITLES } from '@/lib/page-titles';
import { PulseV2Client } from '@/components/seller/pulse/v2/PulseV2Client';
import { canAccessPulse, sellerHomeRoute } from '@/lib/server/pulse-access';
import { getSellerServerClaims, requireSellerServerTenantId } from '@/lib/server/seller-server-claims';

export const metadata = sellerPageTitle(SELLER_PAGE_TITLES.dashboard);

export default async function PulsePage() {
  await requireSellerServerTenantId();
  const claims = await getSellerServerClaims();
  // Defense in depth: the layout already gates, but never render Pulse for non-admins.
  if (!canAccessPulse(claims.role)) redirect(sellerHomeRoute(claims.role));
  return <PulseV2Client />;
}
