import Link from 'next/link';
import { YuktiLogo } from '@/components/brand/YuktiLogo';
import type { AuthSurfaceInfo } from '@/lib/auth-surface';

export function SellerOnlyAuthSurfaceNotice({
  surface,
  title,
}: {
  surface: AuthSurfaceInfo;
  title: string;
}) {
  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-5 sm:p-8">
      <div className="mb-7 flex justify-center">
        <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
      </div>
      <h1 className="mb-2 text-h3 font-display text-cream-900">{title}</h1>
      <p className="mb-6 text-body-sm text-cream-600">
        This page is for Supplier workspace accounts. Buyers can continue with WhatsApp OTP from their supplier catalog.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/login"
          className="inline-flex min-h-10 flex-1 items-center justify-center rounded-md bg-teal-500 px-4 py-2.5 text-body-sm font-semibold text-cream-50 transition-colors hover:bg-teal-600"
        >
          Back to catalog Login
        </Link>
        <a
          href={surface.sellerLoginHref}
          className="inline-flex min-h-10 flex-1 items-center justify-center rounded-md border border-cream-300 bg-white px-4 py-2.5 text-body-sm font-semibold text-cream-800 transition-colors hover:bg-cream-50"
        >
          Supplier workspace Login
        </a>
      </div>
    </div>
  );
}
