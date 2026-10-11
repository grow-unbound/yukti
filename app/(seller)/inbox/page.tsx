import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  TODAY_LAST_OPENED_COOKIE,
  TODAY_VIEWPORT_COOKIE,
  isDesktopRequest,
  pickDefaultBuyerRouteId,
} from '@/lib/inbox/inbox-default-buyer';
import type { InboxEntry } from '@/lib/inbox/inbox-types';
import { fetchSellerPageBootstrap } from '@/lib/server/seller-page-bootstrap';

// List rendering lives in ./layout.tsx (EntitySplitShell) so it stays mounted
// across /inbox <-> /inbox/[id]. Inbox has no "closed" state on desktop, so the
// default buyer is resolved here, before first paint, instead of a client
// redirect that would flash the list full-width first. Mobile stays on the list.
export default async function InboxPage() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const isDesktop = isDesktopRequest(cookieStore.get(TODAY_VIEWPORT_COOKIE)?.value, headerStore.get('user-agent'));
  if (!isDesktop) return null;

  const { data } = await fetchSellerPageBootstrap<{ entries: InboxEntry[] }>('/api/tenant/entries?status=active&limit=50');
  const lastOpened = cookieStore.get(TODAY_LAST_OPENED_COOKIE)?.value;
  const target = pickDefaultBuyerRouteId(data?.entries ?? [], lastOpened);
  if (target) redirect(`/inbox/${target}`);
  return null;
}
