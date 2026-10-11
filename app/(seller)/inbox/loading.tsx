import { PageWrap } from '@/components/seller/layout/PageWrap';
import { SellerMobileListSkeleton } from '@/components/seller/mobile/SellerMobileList';

export default function InboxLoading() {
  return (
    <PageWrap className="flex h-full min-h-0 flex-col">
      <div className="shrink-0" role="status" aria-label="Loading inbox">
        <div className="mb-3 space-y-2 md:mb-4">
          <div className="h-3 w-12 animate-pulse rounded-full bg-cream-200" />
          <div className="h-6 w-56 animate-pulse rounded-full bg-cream-200" />
          <div className="h-4 w-72 max-w-full animate-pulse rounded-full bg-cream-200" />
        </div>
        <div className="h-9 w-full animate-pulse rounded-[10px] border border-cream-200 bg-cream-100" />
        <div className="flex gap-2 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 w-20 animate-pulse rounded-full bg-cream-200" />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SellerMobileListSkeleton count={6} forceVisible showLeading />
      </div>
    </PageWrap>
  );
}
