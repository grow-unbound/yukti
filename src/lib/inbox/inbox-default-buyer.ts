import { groupEntriesByDateAndCustomer } from './inbox-grouping';
import type { InboxEntry } from './inbox-types';

export const TODAY_LAST_OPENED_COOKIE = 'yukti_today_last';
export const TODAY_VIEWPORT_COOKIE = 'yukti_today_vp';

const MOBILE_UA = /Mobi|Android|iPhone|iPod/i;

/** Route segment for a grouped buyer row -- the same id the list row links to. */
export function buyerRouteId(buyer: { buyerId: string | null; buyerKey: string }): string {
  return buyer.buyerId ?? buyer.buyerKey;
}

/**
 * Whether the request comes from a desktop-width viewport. The client-written
 * viewport cookie wins (it tracks window resizes); the user-agent is only the
 * first-visit fallback, before the cookie exists.
 */
export function isDesktopRequest(viewportCookie: string | undefined, userAgent: string | null): boolean {
  if (viewportCookie === 'desktop') return true;
  if (viewportCookie === 'mobile') return false;
  return !MOBILE_UA.test(userAgent ?? '');
}

/** The buyer Inbox should open by default: last opened if still listed, else the top row. */
export function pickDefaultBuyerRouteId(entries: InboxEntry[], lastOpenedKey: string | undefined): string | null {
  const buyers = groupEntriesByDateAndCustomer(entries).flatMap((section) => section.buyers);
  if (buyers.length === 0) return null;
  const match = lastOpenedKey ? buyers.find((buyer) => buyer.buyerKey === lastOpenedKey) : undefined;
  return buyerRouteId(match ?? buyers[0]);
}

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function writeClientCookie(name: string, value: string): void {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    // Cookies blocked — the server falls back to the first row / user-agent hint.
  }
}
