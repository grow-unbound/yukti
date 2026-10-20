'use client';

import { useEffect, useRef, useState } from 'react';

/** True once the element has come within `margin` of the viewport; stays true (lazy-load, never unload). */
export function useNearViewport<T extends Element>(margin = '240px') {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [margin, near]);

  return { ref, near };
}
