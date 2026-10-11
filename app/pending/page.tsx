'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Store } from 'lucide-react';
import { YuktiLogo } from '@/components/brand/YuktiLogo';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { apiFetch } from '@/lib/api-fetch';
import { needsIntakeForm } from '@/lib/buyer-pending-destination';
import { Button } from '@/components/ui/button';
import { buildWhatsAppChatUrl } from '@/constants/auth-login-copy';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { DeclinedContactScreen } from '@/components/buyer/onboarding/DeclinedContactScreen';
import { ExistingBuyerAccountPicker } from '@/components/buyer/onboarding/ExistingBuyerAccountPicker';
import { OtherAccountsPanel } from '@/components/buyer/onboarding/OtherAccountsPanel';
import { useAccessAccounts, useAccountSwitch } from '@/hooks/useAccessAccounts';
import { STOREFRONT } from '@/lib/storefront-paths';

/**
 * Blocked screen for a self-registered buyer awaiting seller approval
 * (Yukti_Inbox_Feature-Spec_v1.md §7.1). Shown until buyer_app_enabled
 * flips true — the buyer simply lands on the storefront home instead, next time
 * /api/buyer/me reports mode:'buyer'. No polling, matching the rest of
 * this app's approval-gate pattern (see /consent).
 */
function BuyerPendingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: me, isLoading, refetch } = useBuyerMe();
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [selectedBuyerId, setSelectedBuyerId] = useState<string | null>(null);

  const submittedState =
    searchParams.get('resubmitted') === '1'
      ? 'resubmitted'
      : searchParams.get('intake_submitted') === '1'
        ? 'intake_submitted'
        : searchParams.get('request_sent') === '1'
          ? 'request_sent'
          : null;
  const hasSubmittedState = submittedState !== null;
  const notPending = !isLoading && (!me || me.mode !== 'pending');
  const needsIntake = !isLoading && needsIntakeForm(me);
  const rawNeedsMoreInfo = !isLoading && me?.mode === 'pending' && me.pending?.onboarding_status === 'needs_more_info';
  const shouldRedirectToResubmit = rawNeedsMoreInfo && submittedState !== 'resubmitted';
  const shouldRedirectToOnboarding = needsIntake && submittedState !== 'intake_submitted';
  useEffect(() => {
    if (shouldRedirectToResubmit) {
      router.replace('/resubmit-documents');
      return;
    }
    if (notPending) {
      router.replace(me ? STOREFRONT.home : '/login');
      return;
    }
    if (shouldRedirectToOnboarding) {
      router.replace('/onboarding');
    }
  }, [notPending, shouldRedirectToOnboarding, shouldRedirectToResubmit, me, router]);
  const showsMainCard =
    !isLoading && me?.mode === 'pending' && !shouldRedirectToOnboarding && !shouldRedirectToResubmit && me.pending?.onboarding_status !== 'declined';

  // Every account this phone has at the tenant (some enabled, some not) — so the buyer can open an
  // enabled one instead of being forced to request access for a disabled one. `accounts` stays null
  // until the lookup succeeds; until then (or if it fails) we fall back to /api/buyer/me alone.
  const { accounts, lookupDone: accountsLookupDone, reload: loadAccounts } = useAccessAccounts(showsMainCard, me?.buyer_id);
  const { busyBuyerId, error: switchError, openAccount } = useAccountSwitch(me?.tenant?.id);

  if (notPending || shouldRedirectToOnboarding || shouldRedirectToResubmit) return null;

  const sellerName = me?.tenant?.name ?? 'the seller';
  const sellerWhatsappNumber = me?.pending?.seller_whatsapp_number ?? null;
  const isDeclined = me?.pending?.onboarding_status === 'declined';
  const publicBrowseAllowed = me?.buyer_catalog?.public_browse_allowed === true;
  const pendingStatus = me?.pending?.onboarding_status ?? null;
  const statusLabel =
    pendingStatus === 'needs_more_info'
      ? 'Details received, awaiting seller review'
      : pendingStatus === 'declined'
        ? 'Declined'
        : pendingStatus === 'approved'
          ? 'Approved, waiting for access'
          : 'Pending approval';
  const confirmationTitle =
    submittedState === 'resubmitted'
      ? 'Details resubmitted'
      : submittedState === 'intake_submitted'
        ? 'Request sent'
        : submittedState === 'request_sent'
          ? 'Request sent'
          : null;
  const confirmationBody =
    submittedState === 'resubmitted'
      ? `Thanks. We've sent your updated details to ${sellerName}. You'll get a WhatsApp message once your access is approved.`
      : submittedState === 'intake_submitted'
        ? `Thanks. We've sent your details to ${sellerName}. You'll get a WhatsApp message once your access is approved.`
        : submittedState === 'request_sent'
          ? `We've sent your access request to ${sellerName}. You'll get a WhatsApp message once your access is approved.`
          : null;

  const accountList = accounts ?? [];
  const hasMultipleAccounts = accountList.length > 1;
  const requestableAccounts = accountList.filter((account) => account.state === 'can_request');
  // One requestable account is preselected; with several, the buyer must choose.
  const effectiveSelectedId =
    (selectedBuyerId && requestableAccounts.some((account) => account.buyer_id === selectedBuyerId) ? selectedBuyerId : null)
    ?? (requestableAccounts.length === 1 ? requestableAccounts[0].buyer_id : null);

  // An existing buyer (seller/ERP-created, app access disabled) has nothing to register — they
  // ask the seller to switch access on. The request is a seller-inbox entry, not an intake form.
  // Once the accounts load they are the source of truth; until then (or if the lookup fails) fall
  // back to what /api/buyer/me says about the session's own buyer.
  const isExistingBuyer = me?.pending?.self_registered === false;
  // Don't flash a request button for the session's own account while we may still find siblings.
  const checkingAccounts = !accountsLookupDone && !accounts;
  const canRequestAccess = accounts
    ? !hasSubmittedState && requestableAccounts.length > 0
    : !hasSubmittedState &&
      isExistingBuyer &&
      !me?.pending?.access_requested &&
      !me?.pending?.intake_submitted &&
      me?.pending?.onboarding_status !== 'needs_more_info';
  const showAccountList = !hasSubmittedState && (hasMultipleAccounts || (accounts !== null && isExistingBuyer && accountList.length === 1 && canRequestAccess));

  async function handleRequestAccess() {
    setRequesting(true);
    setRequestError('');
    try {
      const res = await apiFetch(
        '/api/buyer/access/request',
        effectiveSelectedId
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyer_id: effectiveSelectedId }) }
          : { method: 'POST' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRequestError(typeof data?.error === 'string' ? data.error : 'Could not send your request. Please try again.');
        return;
      }
      setSelectedBuyerId(null);
      await Promise.all([refetch(), loadAccounts()]);
      router.replace('/pending?request_sent=1');
    } catch {
      setRequestError('Could not send your request. Please try again.');
    } finally {
      setRequesting(false);
    }
  }

  async function handleLogout() {
    await supabaseBrowser.auth.signOut();
    router.replace('/login');
  }

  if (isDeclined) {
    return (
      <DeclinedContactScreen
        sellerName={sellerName}
        sellerWhatsappNumber={sellerWhatsappNumber}
        publicBrowseAllowed={publicBrowseAllowed}
        onLogout={handleLogout}
        otherAccounts={<OtherAccountsPanel tenantId={me?.tenant?.id} currentBuyerId={me?.buyer_id} />}
      />
    );
  }

  return (
    <div className="min-h-screen bg-cream-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-cream-300 rounded-xl shadow-md p-8">
        <div className="mb-7 flex justify-center">
          <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
        </div>

        <h1 className="text-h3 font-display text-cream-900 mb-1">
          {confirmationTitle ?? (hasMultipleAccounts ? 'Choose your account' : canRequestAccess ? 'Access needed' : 'Request sent')}
        </h1>
        {confirmationTitle && confirmationBody ? (
          <div className="rounded-md bg-success-50 border border-success-500/30 px-4 py-3 space-y-2 mb-4 mt-4">
            <p className="text-body-sm font-medium text-success-700">{confirmationTitle}</p>
            <p className="text-body-sm text-success-700/90">{confirmationBody}</p>
            <div className="rounded-md bg-white border border-cream-300 px-3 py-2">
              <p className="text-caption font-semibold text-cream-700 uppercase">Current status</p>
              <p className="text-body-sm text-cream-900">{statusLabel}</p>
            </div>
          </div>
        ) : null}
        {showAccountList ? (
          <div className="mb-6 mt-4 space-y-4">
            <div className="rounded-md bg-warning-50 border border-warning-200 px-4 py-3 space-y-1">
              <p className="text-body-sm text-warning-700 font-medium">
                {hasMultipleAccounts
                  ? `We found multiple accounts for this number with ${sellerName}.`
                  : `Your account with ${sellerName} doesn't have app access yet.`}
              </p>
              <p className="text-body-sm text-warning-700/90">
                {hasMultipleAccounts
                  ? requestableAccounts.length > 0
                    ? 'Choose an account to open it, or request access for one that is switched off.'
                    : "Open an active account, or finish what an in-progress one is waiting for."
                  : `Request access and ${sellerName} will be notified to switch it on.`}
              </p>
            </div>
            <ExistingBuyerAccountPicker
              accounts={accountList}
              selectedBuyerId={effectiveSelectedId}
              busyBuyerId={busyBuyerId}
              onSelect={setSelectedBuyerId}
              onAction={(account, action) => void openAccount(account, action)}
            />
            {requestError || switchError ? <p className="text-body-sm text-danger-500">{requestError || switchError}</p> : null}
            {requestableAccounts.length > 0 ? (
              <Button
                className="w-full"
                onClick={() => void handleRequestAccess()}
                disabled={requesting || !effectiveSelectedId}
              >
                {requesting ? 'Sending request…' : 'Request access'}
              </Button>
            ) : null}
            {requestableAccounts.length === 0 &&
            !accountList.some((account) => account.state === 'active') &&
            accountList.some((account) => account.state === 'requested' || account.state === 'awaiting_approval') ? (
              <p className="text-body-sm text-cream-700">
                {sellerName} typically approves within 24 hours. We'll let you in as soon as that happens.
              </p>
            ) : null}
          </div>
        ) : canRequestAccess ? (
          <div className="mb-6 mt-4 space-y-4">
            <div className="rounded-md bg-warning-50 border border-warning-200 px-4 py-3 space-y-2">
              <p className="text-body-sm text-warning-700 font-medium">
                Your account with {sellerName} doesn't have app access yet.
              </p>
              <p className="text-body-sm text-warning-700/90">
                Request access and {sellerName} will be notified to switch it on.
              </p>
            </div>
            {requestError ? <p className="text-body-sm text-danger-500">{requestError}</p> : null}
            <Button className="w-full" onClick={() => void handleRequestAccess()} disabled={requesting || checkingAccounts}>
              {requesting ? 'Sending request…' : checkingAccounts ? 'Checking your accounts…' : 'Request access'}
            </Button>
          </div>
        ) : (
          <div className="rounded-md bg-warning-50 border border-warning-200 px-4 py-3 space-y-2 mb-6 mt-4">
            <p className="text-body-sm text-warning-700 font-medium">
              {sellerName} needs to approve your access before you can view pricing or place orders.
            </p>
            <p className="text-body-sm text-warning-700/90">
              They typically approve within 24 hours. We'll let you in as soon as that happens.
            </p>
          </div>
        )}

        {publicBrowseAllowed ? (
          <Link
            href={STOREFRONT.home}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-ember-400 hover:bg-ember-500 text-cream-50 text-body-sm font-semibold transition-colors duration-base mb-3"
          >
            <Store className="h-4 w-4" />
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
                  `Hi ${sellerName}, I'd like to get access to your Yukti catalog. Can you please confirm once you've approved my access.`,
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

        <button
          type="button"
          onClick={handleLogout}
          className="w-full text-caption text-cream-600 hover:text-cream-800 transition-colors"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

export default function BuyerPendingPage() {
  return (
    <Suspense fallback={null}>
      <BuyerPendingContent />
    </Suspense>
  );
}
