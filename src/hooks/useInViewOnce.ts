import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Flips to `true` the first time the attached element comes within `rootMargin` of the viewport,
 * then stays true. Used to defer non-critical below-the-fold fetches until they are about to be seen.
 * Resolves to `true` immediately when IntersectionObserver is unavailable so content is never withheld.
 */
export function useInViewOnce<T extends Element = HTMLDivElement>(rootMargin = '600px') {
  const [inView, setInView] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || inView) return;
      if (typeof IntersectionObserver === 'undefined') {
        setInView(true);
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setInView(true);
            observer.disconnect();
          }
        },
        { rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [inView, rootMargin],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [ref, inView] as const;
}
