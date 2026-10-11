'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface MobileHeader {
  title: string | null;
  phone: string | null;
  owner: symbol | null;
}

interface MobileHeaderTitleValue extends MobileHeader {
  setHeader: (update: (previous: MobileHeader) => MobileHeader) => void;
}

const EMPTY_HEADER: MobileHeader = { title: null, phone: null, owner: null };

const MobileHeaderTitleContext = createContext<MobileHeaderTitleValue>({ ...EMPTY_HEADER, setHeader: () => {} });

/** Lets a deep mobile screen name itself in the shared top bar (buyer name, entry title...)
 * instead of the bar falling back to the static route-segment title ("Inbox"). */
export function MobileHeaderTitleProvider({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<MobileHeader>(EMPTY_HEADER);
  const value = useMemo(() => ({ ...header, setHeader }), [header]);
  return <MobileHeaderTitleContext.Provider value={value}>{children}</MobileHeaderTitleContext.Provider>;
}

export function useMobileHeaderTitleValue(): string | null {
  return useContext(MobileHeaderTitleContext).title;
}

/** Phone number the top bar exposes as a tap-to-call icon (deep customer screens). */
export function useMobileHeaderPhoneValue(): string | null {
  return useContext(MobileHeaderTitleContext).phone;
}

/** Sets the mobile top-bar title (and optional tap-to-call phone) while the calling screen is
 * mounted. A falsy title leaves the header to whichever screen does set one. Each screen only
 * clears what it set, so a page unmounting late can't wipe the page that replaced it. */
export function useMobileHeaderTitle(title: string | null | undefined, options?: { phone?: string | null }) {
  const { setHeader } = useContext(MobileHeaderTitleContext);
  const owner = useRef(Symbol('mobile-header')).current;
  const phone = options?.phone ?? null;
  useEffect(() => {
    if (!title) return;
    setHeader(() => ({ title, phone, owner }));
    return () => setHeader((previous) => (previous.owner === owner ? EMPTY_HEADER : previous));
  }, [title, phone, owner, setHeader]);
}
