'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { YuktiLogo } from '@/components/brand/YuktiLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { apiFetch } from '@/lib/api-fetch';
import { buildWhatsAppChatUrl } from '@/constants/auth-login-copy';
import { DocumentUploadField } from '@/components/buyer/onboarding/DocumentUploadField';
import { ProfilePicker } from '@/components/buyer/onboarding/ProfilePicker';
import { STOREFRONT } from '@/lib/storefront-paths';
import type { ExistingProfileRow } from '@/types/buyer-onboarding';

const GSTIN_REUSE_CHECK_DEBOUNCE_MS = 500;

function isGeneratedCustomerName(value: string, phone: string | null | undefined): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (phone && normalized === `Customer ${phone}`) return true;
  return /^Customer [0-9+ -]+$/.test(normalized);
}

/**
 * Self-registration intake form (Yukti_Inbox_Feature-Spec_v1.md §7.1 #1/#2).
 * Shown right after OTP verify for a brand-new-to-this-tenant buyer, before
 * /pending. Submitting fires a correctly-typed app.entries row (business_approval
 * or new_user_login) for the seller — see /api/buyer/onboarding/intake.
 */
export default function BuyerOnboardingPage() {
  const router = useRouter();
  const { data: me, isLoading, isError, refetch } = useBuyerMe();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [isBusiness, setIsBusiness] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [gstin, setGstin] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [pincode, setPincode] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Document uploads (business block only). Task 7's presign/confirm routes
  // return one document id per successful upload; documentIds is what gets
  // sent as document_ids on submit.
  const [shopImageDocId, setShopImageDocId] = useState<string | null>(null);
  const [gstCertDocId, setGstCertDocId] = useState<string | null>(null);
  const documentIds = [shopImageDocId, gstCertDocId].filter((id): id is string => Boolean(id));

  // GSTIN reuse-check (informational only this round — business-scope
  // reuse-copy is disabled, so this never offers a "Yes, reuse" action).
  const [gstinReuseNote, setGstinReuseNote] = useState<string | null>(null);
  const gstinReuseCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Multi-profile picker (frontend spec §1.1 row 6 / §0b). Fetched once the
  // OTP-verified session context is available; null = not checked yet.
  const [existingProfiles, setExistingProfiles] = useState<ExistingProfileRow[] | null>(null);
  const [profilePickerDismissed, setProfilePickerDismissed] = useState(false);

  useEffect(() => {
    if (prefilled || !me?.pending) return;
    const pendingFullName = me.pending.prefill_full_name?.trim() || me.contact_name?.trim() || '';
    if (pendingFullName) setFullName(pendingFullName);
    if (me.pending.prefill_email) setEmail(me.pending.prefill_email);
    const pendingBusinessName = me.business_name?.trim() || '';
    const pendingGstin = me.gstin?.trim() || '';
    if (pendingBusinessName && !isGeneratedCustomerName(pendingBusinessName, me.phone)) {
      setBusinessName(pendingBusinessName);
      setIsBusiness(true);
    }
    if (pendingGstin) {
      setGstin(pendingGstin);
      setIsBusiness(true);
    }
    setPrefilled(true);
  }, [me, prefilled]);

  useEffect(() => {
    if (!me?.pending || existingProfiles !== null) return;
    let cancelled = false;
    apiFetch('/api/buyer/onboarding/existing-profiles', { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data?.profiles) ? (data.profiles as ExistingProfileRow[]) : [];
      })
      .then((profiles) => {
        if (!cancelled) setExistingProfiles(profiles);
      })
      .catch(() => {
        if (!cancelled) setExistingProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [me?.pending, existingProfiles]);

  const hasExistingProfiles = Boolean(existingProfiles && existingProfiles.length > 0);
  const profilesChecked = existingProfiles !== null;
  const showIntakeForm = !hasExistingProfiles || profilePickerDismissed;

  function handleSelectProfile(profile: ExistingProfileRow) {
    setIsBusiness(profile.is_business);
    if (profile.is_business) {
      setBusinessName(profile.business_name?.trim() ?? '');
      setGstin(profile.gstin?.trim() ?? '');
    } else if (profile.contact_name?.trim()) {
      setFullName(profile.contact_name.trim());
    }
    setProfilePickerDismissed(true);
  }

  function handleStartFresh() {
    setProfilePickerDismissed(true);
  }

  const runGstinReuseCheck = useCallback((value: string) => {
    if (!value.trim()) {
      setGstinReuseNote(null);
      return;
    }
    apiFetch('/api/buyer/documents/reuse-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gstin: value.trim() }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (data?.found) {
          setGstinReuseNote(
            'We found existing documents for this GSTIN, but reuse isn’t available yet — please upload fresh copies below.',
          );
        } else {
          setGstinReuseNote(null);
        }
      })
      .catch(() => {
        // Non-critical lookup — silently skip the informational note on failure.
      });
  }, []);

  function handleGstinChange(value: string) {
    setGstin(value);
    setGstinReuseNote(null);
    if (gstinReuseCheckTimer.current) clearTimeout(gstinReuseCheckTimer.current);
    gstinReuseCheckTimer.current = setTimeout(() => {
      runGstinReuseCheck(value);
    }, GSTIN_REUSE_CHECK_DEBOUNCE_MS);
  }

  // Not pending (approved, or not a self-registration at all) or intake
  // already submitted — nothing to do here, follow the buyer to where it
  // actually belongs.
  // A non-self-registered buyer (seller/ERP-created, app access disabled) has no intake to file —
  // they request access from /pending.
  const shouldSkip =
    !isLoading &&
    !(isError && !me) &&
    (!me || me.mode !== 'pending' || me.pending?.intake_submitted || me.pending?.self_registered === false);
  useEffect(() => {
    if (!shouldSkip) return;
    if (!me || me.mode !== 'pending') {
      router.replace(STOREFRONT.home);
      return;
    }
    router.replace('/pending');
  }, [shouldSkip, me, router]);
  if (shouldSkip) return null;

  // A failed /api/buyer/me is not "not pending" — don't bounce a new buyer out of intake
  // (and into the workspace finder) over a transient or context error. Offer a retry instead.
  if (isError && !me) {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-center">
        <p className="mb-4 text-body-sm text-cream-700">We couldn't load your details. Please try again.</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }

  const sellerName = me?.tenant?.name ?? 'the seller';
  const sellerWhatsappNumber = me?.pending?.seller_whatsapp_number ?? null;
  const tenantName = me?.tenant?.name ?? null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError('');

    if (!fullName.trim()) {
      setError('Full name is required.');
      return;
    }
    if (isBusiness && !businessName.trim()) {
      setError('Business name is required.');
      return;
    }
    if (gstin.trim() && (!state.trim() || !pincode.trim())) {
      setError('State and pincode are required when GSTIN is provided.');
      return;
    }
    if (isBusiness && !shopImageDocId) {
      setError('Please upload a shop image.');
      return;
    }
    if (isBusiness && gstin.trim() && !gstCertDocId) {
      setError('Please upload your GST certificate.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch('/api/buyer/onboarding/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName.trim(),
          email: email.trim(),
          is_business: isBusiness,
          business_name: isBusiness ? businessName.trim() : '',
          gstin: gstin.trim(),
          address_line1: addressLine1.trim(),
          address_line2: addressLine2.trim(),
          city: city.trim(),
          state: state.trim(),
          pincode: pincode.trim(),
          document_ids: isBusiness ? documentIds : [],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      window.location.assign('/pending?intake_submitted=1');
    } catch {
      setError('Network error. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  const introContent = (
    <>
      <div className="mb-7 flex justify-center">
        <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
      </div>

      <h1 className="text-h3 font-display text-cream-900 mb-1">
        {tenantName ? `Looks like you're new to ${tenantName}'s catalog` : "Looks like you're new to this catalog"}
      </h1>
      <p className="text-body-sm text-cream-600 mb-6">
        {`Share a few details and we'll pass them on to ${tenantName ? `the ${tenantName} team` : 'the seller'}.`}
      </p>
    </>
  );

  const intakeForm = (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="full_name">Full name</Label>
        <Input
          id="full_name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={submitting}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email (optional)</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />
      </div>

      <label className="flex items-center gap-2.5 rounded-md border border-cream-300 bg-cream-50 px-4 py-3 cursor-pointer">
        <input
          type="checkbox"
          checked={isBusiness}
          onChange={(e) => setIsBusiness(e.target.checked)}
          disabled={submitting}
          className="h-4 w-4 rounded border-cream-400 text-teal-600 focus:ring-teal-400/30"
        />
        <span className="text-body-sm text-cream-800">I want to buy as a registered business</span>
      </label>

      {isBusiness && (
        <div className="space-y-4 rounded-md border border-cream-200 bg-cream-50/60 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="business_name">Business name</Label>
            <Input
              id="business_name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              disabled={submitting}
              required={isBusiness}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gstin">GSTIN (optional)</Label>
            <Input
              id="gstin"
              value={gstin}
              onChange={(e) => handleGstinChange(e.target.value.toUpperCase())}
              disabled={submitting}
            />
            {gstinReuseNote && (
              <p className="text-caption text-cream-600 bg-cream-100 px-3 py-2 rounded-md">
                {gstinReuseNote}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="address_line1">Address line 1</Label>
              <Input
                id="address_line1"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="address_line2">Address line 2 (optional)</Label>
              <Input
                id="address_line2"
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} disabled={submitting} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="state">
                State{gstin.trim() ? ' (required)' : ''}
              </Label>
              <Input
                id="state"
                value={state}
                onChange={(e) => setState(e.target.value)}
                disabled={submitting}
                required={Boolean(gstin.trim())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pincode">
                Pincode{gstin.trim() ? ' (required)' : ''}
              </Label>
              <Input
                id="pincode"
                value={pincode}
                onChange={(e) => setPincode(e.target.value)}
                disabled={submitting}
                required={Boolean(gstin.trim())}
              />
            </div>
          </div>

          <DocumentUploadField
            id="shop_image"
            label="Shop image"
            required
            docType="shop_image"
            scope={gstin.trim() ? 'business' : 'personal'}
            gstin={gstin.trim() || undefined}
            disabled={submitting}
            documentId={shopImageDocId}
            onChange={setShopImageDocId}
          />

          {gstin.trim() && (
            <DocumentUploadField
              id="gst_certificate"
              label="GST certificate"
              required
              docType="gst_certificate"
              scope="business"
              gstin={gstin}
              disabled={submitting}
              documentId={gstCertDocId}
              onChange={setGstCertDocId}
            />
          )}
        </div>
      )}

      <p className="text-caption text-cream-600">
        Your request will be sent to {sellerName}. They typically approve within 24 hours
        {sellerWhatsappNumber ? ' — you can also message them on WhatsApp in the meantime.' : '.'}
      </p>

      {error && (
        <p className="text-caption text-danger-500 bg-danger-50 px-3 py-2 rounded-md">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={submitting || isLoading} haptic>
        {submitting ? 'Sending…' : 'Send request'}
      </Button>

      {sellerWhatsappNumber && (
        <button
          type="button"
          onClick={() =>
            window.open(
              buildWhatsAppChatUrl(
                sellerWhatsappNumber,
                `Hi ${sellerName}, I'd like to get access to your Yukti catalog.`,
              ),
              '_blank',
              'noopener,noreferrer',
            )
          }
          className="w-full text-caption text-cream-600 hover:text-cream-800 transition-colors"
        >
          Contact {sellerName} on WhatsApp
        </button>
      )}
    </form>
  );

  const backToProfilePickerButton = hasExistingProfiles ? (
    <button
      type="button"
      onClick={() => setProfilePickerDismissed(false)}
      className="mb-5 inline-flex items-center gap-2 rounded-full border border-cream-300 bg-white px-3 py-1.5 text-caption font-medium text-cream-700 transition-colors hover:border-cream-400 hover:bg-cream-50 hover:text-cream-950"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to account options
    </button>
  ) : null;

  const requestAccessHeader = (
    <div className="mb-5">
      <h2 className="text-h3 font-display text-cream-900">Request access</h2>
      <p className="mt-1 text-body-sm text-cream-600">
        Fill this only if none of the listed accounts is the one you want to use.
      </p>
    </div>
  );

  const profilePickerCard = existingProfiles ? (
    <div className="w-full max-w-lg bg-white border border-cream-300 rounded-xl shadow-md p-8">
      {introContent}
      <ProfilePicker
        profiles={existingProfiles}
        onSelect={handleSelectProfile}
        onStartFresh={handleStartFresh}
        disabled={submitting}
      />
    </div>
  ) : null;

  if (!profilesChecked) {
    return (
      <div className="min-h-screen bg-cream-50 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-white border border-cream-300 rounded-xl shadow-md p-8">
          {introContent}
          <div className="rounded-lg border border-cream-200 bg-cream-50 px-4 py-3">
            <div className="h-4 w-44 animate-pulse rounded bg-cream-200" />
            <div className="mt-2 h-3 w-64 max-w-full animate-pulse rounded bg-cream-100" />
          </div>
        </div>
      </div>
    );
  }

  if (!hasExistingProfiles) {
    return (
      <div className="min-h-screen bg-cream-50 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-white border border-cream-300 rounded-xl shadow-md p-8">
          {introContent}
          {intakeForm}
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-cream-50 flex items-center justify-center p-4">
      <div className={showIntakeForm ? 'hidden md:block md:opacity-45' : 'w-full'}>
        <div className="mx-auto flex w-full justify-center">
          {profilePickerCard}
        </div>
      </div>

      {showIntakeForm && (
        <>
          <div className="w-full max-w-lg bg-white border border-cream-300 rounded-xl shadow-md p-8 md:hidden">
            {backToProfilePickerButton}
            {introContent}
            {requestAccessHeader}
            {intakeForm}
          </div>

          <div className="fixed inset-0 z-40 hidden items-center justify-center bg-cream-950/20 p-6 md:flex">
            <div className="max-h-[calc(100dvh-3rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-cream-300 bg-white p-8 shadow-xl">
              {backToProfilePickerButton}
              {requestAccessHeader}
              {intakeForm}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
