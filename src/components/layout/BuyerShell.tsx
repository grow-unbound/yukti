'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  isBuyerCampaignShareRoute,
  isBuyerCartPillRoute,
  isBuyerChromelessRoute,
  isBuyerDeepRoute,
  isBuyerLandingRoute,
  shouldShowBuyerDesktopBreadcrumbs,
} from '@/lib/buyer-routes';
import { isActiveBuyerRefreshQuery } from '@/lib/buyer-refresh';
import { createRefreshThrottle } from '@/lib/buyer-query-defaults';
import { BuyerScrollRootContext } from '@/contexts/BuyerScrollContext';
import { BuyerScrollChromeProvider, useBuyerScrollChromeState } from '@/contexts/BuyerScrollChromeContext';
import { BuyerRealtimeProvider, useBuyerRealtimeContext } from '@/contexts/BuyerRealtimeContext';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { isNeedsMoreInfoBuyer, pendingBuyerDestination } from '@/lib/buyer-pending-destination';
import { prefetchBuyerSiblings, useBuyerSiblings } from '@/hooks/useBuyerSiblings';
import { readStoredBuyAsBuyerId } from '@/lib/buy-as-storage';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { BuyerPreviewBootstrap } from './BuyerPreviewBootstrap';
import { BuyerTabBar } from './BuyerTabBar';
import { CartBar } from '@/components/buyer/cart/CartBar';
import { BuyerPullToRefresh } from '@/components/buyer/layout/BuyerPullToRefresh';
import { BuyerDesktopHeader } from '@/components/buyer/layout/BuyerDesktopHeader';
import { BuyerDesktopBreadcrumbs } from '@/components/buyer/layout/BuyerDesktopBreadcrumbs';
import { StorefrontLoginOverlay } from '@/components/buyer/auth/StorefrontLoginOverlay';
interface BuyerShellProps {
  children: ReactNode;
}

// One pull-to-refresh round per 10 s: rage pulls must not each refetch every active buyer query.
const throttlePullRefresh = createRefreshThrottle(10_000);

function BuyerShellMain({
  children,
  scrollRootRef,
}: {
  children: ReactNode;
  scrollRootRef: React.RefCallback<HTMLDivElement>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasShareToken = Boolean(searchParams?.get('share_token'));
  const router = useRouter();
  const queryClient = useQueryClient();
  const isDeep = isBuyerDeepRoute(pathname);
  const isLanding = isBuyerLandingRoute(pathname);
  const isChromeless = isBuyerChromelessRoute(pathname);
  const showDesktopBreadcrumbs =
    shouldShowBuyerDesktopBreadcrumbs(pathname) || isBuyerCampaignShareRoute(pathname, hasShareToken);
  const { tabBarVisible } = useBuyerScrollChromeState();
  const { triggerRefresh } = useBuyerRealtimeContext();
  const showTabBarPadding = !isChromeless && !isDeep && tabBarVisible;
  const canPullToRefresh = !isBuyerChromelessRoute(pathname);

  const handleRefresh = useCallback(() => throttlePullRefresh(async () => {
    if (triggerRefresh) {
      await triggerRefresh();
      return;
    }

    const activeQueries = queryClient.getQueryCache().getAll().filter(isActiveBuyerRefreshQuery);
    if (activeQueries.length === 0) {
      router.refresh();
      return;
    }

    await queryClient.refetchQueries({
      type: 'active',
      predicate: (query) => isActiveBuyerRefreshQuery(query),
    });
  }), [queryClient, router, triggerRefresh]);

  return (
    <BuyerPullToRefresh
      viewportRef={scrollRootRef}
      pullEnabled={canPullToRefresh}
      onRefresh={handleRefresh}
      contentClassName="flex h-full min-h-0 flex-col"
      className={`min-h-0 flex-1 ${showTabBarPadding ? '[--buyer-bottom-chrome:var(--tab-bar-h)] md:[--buyer-bottom-chrome:0px]' : '[--buyer-bottom-chrome:0px]'}`}
      style={{ paddingBottom: 'calc(var(--buyer-bottom-chrome, 0px) + env(safe-area-inset-bottom, 0px))' }}
    >
      {!isChromeless ? (
        <>
          <BuyerDesktopHeader />
          {showDesktopBreadcrumbs ? <BuyerDesktopBreadcrumbs /> : null}
        </>
      ) : null}
      {children}
    </BuyerPullToRefresh>
  );
}

export function BuyerShell({ children }: BuyerShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const { data: me } = useBuyerMe();
  const { data: siblings } = useBuyerSiblings(me?.mode === 'buyer');
  const defaultBuyerRemintAttemptedRef = useRef(false);

  const handleScrollRootRef = useCallback((node: HTMLDivElement | null) => {
    scrollRootRef.current = node;
    setScrollRoot(node);
  }, []);

  useEffect(() => {
    if (me?.mode === 'buyer') {
      prefetchBuyerSiblings(queryClient);
    }
  }, [me?.mode, queryClient]);

  useEffect(() => {
    if (defaultBuyerRemintAttemptedRef.current) return;
    if (!me || me.mode !== 'buyer' || !me.tenant?.id || !me.buyer_id) return;
    if (!siblings) return;

    defaultBuyerRemintAttemptedRef.current = true;
    if (siblings.length <= 1) return;

    const storedBuyerId = readStoredBuyAsBuyerId(me.tenant.id);
    if (!storedBuyerId || storedBuyerId === me.buyer_id) return;
    if (!siblings.some((row) => row.buyer_id === storedBuyerId)) return;

    void (async () => {
      try {
        const res = await fetch('/api/auth/switch-buyer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ buyer_id: storedBuyerId }),
        });
        const data: {
          session?: { access_token: string; refresh_token: string };
        } = await res.json();
        if (!res.ok || !data.session) return;

        await supabaseBrowser.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
        void queryClient.invalidateQueries({ queryKey: ['buyer-me'] });
        void queryClient.invalidateQueries({
          predicate: (query) => {
            const key = query.queryKey[0];
            return typeof key === 'string' && (
              key.startsWith('buyer-catalog')
              || key.startsWith('buyer-product')
              || key.startsWith('buyer-resolved')
            );
          },
        });
      } catch {
        // silent default — user can still switch manually in cart
      }
    })();
  }, [me, queryClient, siblings]);

  const scrollRootContextValue = useMemo(
    () => ({ scrollRootRef, scrollRoot }),
    [scrollRoot],
  );

  useEffect(() => {
    if (me?.whatsapp_consent_required) {
      router.replace('/consent');
    }
  }, [me?.whatsapp_consent_required, router]);

  // Self-registered, not yet approved (Yukti_Inbox_Feature-Spec_v1.md §7.1) —
  // bounce out of the catalog shell to the intake form or the blocked screen,
  // same pattern as the WhatsApp consent gate above.
  const pendingDestination = pendingBuyerDestination(me);
  useEffect(() => {
    if (me?.mode !== 'pending') return;
    router.replace(pendingDestination);
  }, [me?.mode, pendingDestination, router]);

  // A needs_more_info buyer must never see the catalog, even for the frame before the redirect
  // lands (public_link storefronts serve the catalog to pending sessions like guests).
  if (isNeedsMoreInfoBuyer(me)) return null;

  return (
    <BuyerRealtimeProvider>
      <div data-app="buyer" className="min-h-dvh bg-[var(--bg-page)]">
        <div
          className="mx-auto flex h-dvh w-full max-w-[1440px] flex-col overflow-hidden bg-[var(--bg-page)] md:h-dvh md:max-w-[1440px] md:rounded-none md:border-0 md:shadow-none"
        >
          <BuyerPreviewBootstrap>
            <BuyerScrollRootContext.Provider value={scrollRootContextValue}>
              <BuyerScrollChromeProvider>
                <BuyerShellMain scrollRootRef={handleScrollRootRef}>{children}</BuyerShellMain>
                {isBuyerCartPillRoute(pathname) ? <div className="md:hidden"><CartBar /></div> : null}
                <BuyerTabBar />
                {me?.mode !== 'buyer' && me?.mode !== 'preview' ? <StorefrontLoginOverlay /> : null}
              </BuyerScrollChromeProvider>
            </BuyerScrollRootContext.Provider>
          </BuyerPreviewBootstrap>
        </div>
      </div>
    </BuyerRealtimeProvider>
  );
}
