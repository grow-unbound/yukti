import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPost: vi.fn(),
}));

vi.mock('@/contexts/BuyerDeliveryContext', () => ({
  useBuyerDeliveryOptional: () => ({ selected: null }),
}));

import {
  prefetchBuyerProductDetail,
  useBuyerProductDetail,
  useBuyerProductRecommendations,
} from '@/hooks/useBuyerProducts';
import { useInViewOnce } from '@/hooks/useInViewOnce';
import { BUYER_PDP_QUERY_STALE_TIME } from '@/lib/query-navigation';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => data });
}

describe('PDP lazy recommendations', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => jsonResponse({ item: null, same_category: [] }));
  });

  it('product detail hook does not fetch recommendations', async () => {
    renderHook(() => useBuyerProductDetail('tp-1'), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const urls = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/api/buyer/products/tp-1'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/buyer/recommendations'))).toBe(false);
  });

  it('recommendations stay idle until enabled', async () => {
    const client = makeClient();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBuyerProductRecommendations('tp-1', { enabled }),
      { wrapper: wrapperFor(client), initialProps: { enabled: false } },
    );
    await act(async () => {});
    expect(apiFetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/buyer/recommendations?product_id=tp-1'), undefined),
    );
  });

  it('pointerdown prefetch warms detail only, on the PDP stale-time tier', async () => {
    const client = makeClient();
    const prefetchSpy = vi.spyOn(client, 'prefetchQuery');
    prefetchBuyerProductDetail(client, 'tp-1', 'no-delivery');
    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy.mock.calls[0]?.[0]).toMatchObject({ staleTime: BUYER_PDP_QUERY_STALE_TIME });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(String(apiFetchMock.mock.calls[0]?.[0])).toContain('/api/buyer/products/tp-1');
  });
});

describe('useInViewOnce', () => {
  const original = globalThis.IntersectionObserver;
  let trigger: ((isIntersecting: boolean) => void) | null = null;

  beforeEach(() => {
    trigger = null;
    class FakeObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        trigger = (isIntersecting) => cb([{ isIntersecting }]);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    }
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.IntersectionObserver = original;
  });

  function Probe() {
    const [ref, inView] = useInViewOnce();
    return <div ref={ref} data-testid="probe">{String(inView)}</div>;
  }

  it('stays false until the element intersects, then latches true', async () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('false');

    act(() => trigger?.(false));
    expect(getByTestId('probe').textContent).toBe('false');

    act(() => trigger?.(true));
    expect(getByTestId('probe').textContent).toBe('true');
  });

  it('resolves true immediately without IntersectionObserver', () => {
    // @ts-expect-error simulate an environment without IntersectionObserver
    delete globalThis.IntersectionObserver;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('true');
  });
});
