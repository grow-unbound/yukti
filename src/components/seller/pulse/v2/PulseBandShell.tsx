import { RefreshCcw } from 'lucide-react';
import type { ReactNode } from 'react';

export function PulseBandShell({
  id,
  title,
  subtitle,
  isFetching,
  children,
}: {
  id?: string;
  title: string;
  subtitle: string;
  isFetching?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id}>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-cream-950">{title}</h2>
          <p className="mt-1 max-w-[72ch] text-sm leading-5 text-cream-700">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-cream-600">
          {isFetching ? <RefreshCcw size={13} className="animate-spin" aria-hidden="true" /> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
