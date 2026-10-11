'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { VerifyAccountForm } from '@/components/auth/VerifyAccountForm';
import { AuthHomeLogoLink } from '@/components/auth/AuthHomeLogoLink';

function VerifyAccountInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? '';
  const phone = searchParams.get('phone') ?? null;
  const userId = searchParams.get('uid') ?? '';
  const tenantId = searchParams.get('tid') ?? null;

  useEffect(() => {
    if (!email || !userId) {
      router.replace('/signup');
    }
  }, [email, userId, router]);

  if (!email || !userId) return null;

  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-8">
      <div className="mb-7 flex justify-center">
        <AuthHomeLogoLink />
      </div>

      <h1 className="text-h3 font-display text-cream-900 mb-1">Verify your Supplier workspace account</h1>
      <p className="text-body-sm text-cream-600 mb-6">
        One more step — confirm your email to activate your workspace.
      </p>

      <VerifyAccountForm
        email={email}
        phone={phone}
        userId={userId}
        tenantId={tenantId}
      />

      <div className="mt-6 pt-4 border-t border-cream-200">
        <Link
          href="/login"
          className="text-caption text-cream-500 hover:text-cream-700 transition-colors"
        >
          ← Back to Login
        </Link>
      </div>
    </div>
  );
}

function VerifyAccountFallback() {
  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-8">
      <div className="mb-7 flex justify-center">
        <div className="h-14 w-[76px] rounded-xl bg-cream-200 animate-pulse" />
      </div>
      <div className="space-y-3 mb-6">
        <div className="h-5 w-40 rounded bg-cream-200 animate-pulse" />
        <div className="h-4 w-56 rounded bg-cream-200 animate-pulse" />
      </div>
      <div className="flex gap-2 justify-between">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-10 h-12 rounded bg-cream-200 animate-pulse" />
        ))}
      </div>
      <div className="mt-4 h-10 w-full rounded bg-cream-200 animate-pulse" />
    </div>
  );
}

export function VerifyAccountPageClient() {
  return (
    <Suspense fallback={<VerifyAccountFallback />}>
      <VerifyAccountInner />
    </Suspense>
  );
}
