'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { NAVIGATION_QUERY_GC_TIME, NAVIGATION_QUERY_STALE_TIME } from '@/lib/query-navigation';
import { noQueryRetry } from '@/lib/query-retry';
import { applyBuyerQueryDefaults, isBuyerAppPath } from '@/lib/buyer-query-defaults';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: NAVIGATION_QUERY_STALE_TIME,
            gcTime: NAVIGATION_QUERY_GC_TIME,
            refetchOnWindowFocus: false,
            retry: noQueryRetry,
          },
        },
      }),
  );
  const isBuyerRoute = pathname.startsWith('/buy');
  const isBuyerApp = isBuyerAppPath(pathname);

  useEffect(() => {
    applyBuyerQueryDefaults(queryClient, isBuyerApp);
  }, [queryClient, isBuyerApp]);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        position={isBuyerRoute ? 'top-center' : 'top-right'}
        richColors
        closeButton={!isBuyerRoute}
      />
    </QueryClientProvider>
  );
}
