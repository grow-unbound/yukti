'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { YuktiLogo } from '@/components/brand/YuktiLogo';
import { buildWhatsAppChatUrl } from '@/constants/auth-login-copy';
import { STOREFRONT } from '@/lib/storefront-paths';

interface DeclinedContactScreenProps {
  sellerName: string;
  sellerWhatsappNumber: string | null;
  publicBrowseAllowed: boolean;
  onLogout: () => void;
  /** Optional "other accounts for this number" panel, shown under the contact actions. */
  otherAccounts?: ReactNode;
}

/**
 * Yukti_Public-Signup_Frontend-Spec_v1.md §1.1 row 8. Shown at /pending when
 * onboarding_status === 'declined' — same shape as the pending/needs-more-info
 * content (WhatsApp seller-contact button, logout), but factual rather than
 * "in progress" framing, and deliberately no appeal CTA (locked decisions:
 * no in-app appeal flow for a decline).
 */
export function DeclinedContactScreen({ sellerName, sellerWhatsappNumber, publicBrowseAllowed, onLogout, otherAccounts }: DeclinedContactScreenProps) {
  return (
    <div className="min-h-screen bg-cream-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-cream-300 rounded-xl shadow-md p-8">
        <div className="mb-7 flex justify-center">
          <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
        </div>

        <h1 className="text-h3 font-display text-cream-900 mb-1">Access declined</h1>
        <div className="rounded-md bg-cream-100 border border-cream-300 px-4 py-3 space-y-2 mb-6 mt-4">
          <p className="text-body-sm text-cream-700 font-medium">
            {sellerName} has declined your access request.
          </p>
          <p className="text-body-sm text-cream-700/90">
            {publicBrowseAllowed
              ? 'You can still browse the public catalog. For questions about this decision, contact the seller directly.'
              : `For questions about this decision, contact ${sellerName} directly.`}
          </p>
        </div>

        {publicBrowseAllowed ? (
          <Link
            href={STOREFRONT.home}
            className="mb-3 inline-flex w-full items-center justify-center rounded-md bg-ember-400 px-4 py-2.5 text-body-sm font-semibold text-cream-50 transition-colors duration-base hover:bg-ember-500"
          >
            Browse the public catalog
          </Link>
        ) : null}

        {sellerWhatsappNumber && (
          <button
            type="button"
            onClick={() =>
              window.open(
                buildWhatsAppChatUrl(
                  sellerWhatsappNumber,
                  `Hi ${sellerName}, I'd like to ask about my declined access request on your Yukti catalog.`,
                ),
                '_blank',
                'noopener,noreferrer',
              )
            }
            className="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-md bg-teal-500 hover:bg-teal-600 text-cream-50 text-body-sm font-semibold transition-colors duration-base mb-3"
          >
            Contact {sellerName} on WhatsApp
          </button>
        )}

        {otherAccounts}

        <button
          type="button"
          onClick={onLogout}
          className="w-full text-caption text-cream-600 hover:text-cream-800 transition-colors"
        >
          Log out
        </button>
      </div>
    </div>
  );
}
