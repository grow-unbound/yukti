'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { SignupFormCardSkeleton } from '@/components/auth/SignupFormCardSkeleton';
import { useFlagState } from '@/hooks/useFeatureFlag';

const SignupFormCard = dynamic(
  () => import('@/components/auth/SignupFormCard').then((mod) => mod.SignupFormCard),
  {
    loading: () => <SignupFormCardSkeleton />,
  },
);

function ComingSoonPage() {
  return (
    <div className="flex flex-col items-center text-center gap-4 py-8">
      <div className="w-14 h-14 rounded-full bg-cream-200 flex items-center justify-center">
        <svg
          className="text-cream-500 w-7 h-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6l4 2M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"
          />
        </svg>
      </div>
      <h2 className="font-display text-h3 text-cream-900">This feature isn&rsquo;t enabled yet.</h2>
      <p className="font-sans text-body text-cream-700 max-w-xs">
        Sign-ups are currently by invitation only. Reach out to get early access.
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-teal-500 text-cream-50 font-sans font-semibold text-body-sm hover:bg-teal-600 transition-colors"
      >
        Go to Yukti home
      </Link>
    </div>
  );
}

export function SignupPageClient() {
  const onboardingFlag = useFlagState('TENANT_ONBOARDING');

  if (onboardingFlag === undefined) {
    return <SignupFormCardSkeleton />;
  }

  if (!onboardingFlag) {
    return (
      <div className="bg-cream-50 border border-cream-300 rounded-lg shadow-md p-8">
        <ComingSoonPage />
      </div>
    );
  }

  return <SignupFormCard />;
}
