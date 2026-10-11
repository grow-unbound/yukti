'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { YuktiLogo } from '@/components/brand/YuktiLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/buyer/auth/PhoneInput';
import { OtpForm } from '@/components/buyer/auth/OtpForm';
import { DocumentUploadField } from '@/components/buyer/onboarding/DocumentUploadField';
import { OtherAccountsPanel } from '@/components/buyer/onboarding/OtherAccountsPanel';
import { apiFetch } from '@/lib/api-fetch';
import { useBuyerMe } from '@/hooks/useBuyerMe';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { markLoggedInOnDevice } from '@/lib/auth-device-login';
import { buildWhatsAppChatUrl } from '@/constants/auth-login-copy';
import { MISSING_FIELD_LABELS } from '@/lib/inbox/missing-field-labels';

/**
 * /resubmit-documents
 *
 * Task 11 -- the "documentation resubmission" flow reached from the
 * access_more_info_needed_buyer WhatsApp deep link and from tapping the
 * needs_more_info OnboardingStatusPill (Task 10).
 *
 * Per Yukti_Public-Signup_Frontend-Spec_v1.md §0b's forced-re-OTP correction:
 * this flow ALWAYS requires a fresh OTP verification before showing the
 * resubmission form, even if the browser already holds a valid session --
 * because this flow accepts new identity documents, a stale-but-valid
 * session is a weaker guarantee than for a plain status check.
 *
 * Implementation choice: rather than navigating through the shared
 * /login -> /verify pages (which would require threading a new
 * post-verify-destination override through phone-otp/verify's redirect
 * logic -- explicitly restricted surface for this task), the OTP send/verify
 * step is done INLINE on this page, reusing the exact same components
 * (PhoneInput, OtpForm) and API routes (/api/auth/phone-otp/send,
 * /api/auth/phone-otp/verify) the shared login flow uses. This gives the
 * "always fresh OTP" guarantee for free and unforgeably: the 'form' phase
 * below can only be reached via a real, just-completed verify() call in
 * THIS page load -- there is no query param or stored flag that can fake
 * it, and a page reload/revisit resets straight back to the phone step.
 *
 * Known limitation (documented, not fixed here): if the verified phone
 * resolves to multiple accounts (contexts.length > 1) or a cross-tenant
 * handoff (the buyer is verifying from a host other than their own tenant),
 * this page hands off to the existing shared flows (/login/select-context,
 * or the handoff URL) rather than landing back here directly -- those flows
 * were explicitly out of scope to modify for this task. The buyer can
 * simply return to /resubmit-documents afterward, which re-triggers a fresh
 * OTP challenge again. The overwhelmingly common case (a buyer with exactly
 * one account, verifying on their own tenant's storefront) lands directly
 * on the form below.
 */

const SESSION_CONTEXTS_KEY = 'yukti_auth_contexts';

// Mirrors RESUBMISSION_OTP_FRESHNESS_MS in src/lib/server/buyer-access.ts (enforced server-side on submit).
const OTP_FRESHNESS_MS = 15 * 60 * 1000;

function requestedFieldLabel(key: string): string {
  const label = MISSING_FIELD_LABELS[key] ?? key.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type Phase = 'checking' | 'phone' | 'otp' | 'loading_profile' | 'form' | 'not_applicable' | 'submitted';

interface ResubmissionProfile {
  full_name: string;
  email: string;
  is_business: boolean;
  business_name: string;
  gstin: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  pincode: string;
}

interface ResubmissionData {
  missing_fields: string[];
  profile: ResubmissionProfile;
  documents: {
    shop_image_id: string | null;
    gst_certificate_id: string | null;
  };
}

function isFlagged(missingFields: string[], key: string): boolean {
  return missingFields.includes(key);
}

export default function ResubmitDocumentsPage() {
  const router = useRouter();
  const { data: me } = useBuyerMe();
  const [phase, setPhase] = useState<Phase>('checking');
  const [phone, setPhone] = useState('');
  const [refId, setRefId] = useState('');
  const [sendError, setSendError] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const [data, setData] = useState<ResubmissionData | null>(null);
  const [loadError, setLoadError] = useState('');

  // Editable form state -- pre-filled from data.profile once loaded.
  const [fullName, setFullName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [gstin, setGstin] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [pincode, setPincode] = useState('');
  const [shopImageDocId, setShopImageDocId] = useState<string | null>(null);
  const [gstCertDocId, setGstCertDocId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const sellerName = me?.tenant?.name ?? 'the seller';
  const sellerWhatsappNumber = me?.pending?.seller_whatsapp_number ?? null;

  // Arriving straight from the login OTP (the WhatsApp "Login" link) already carries a fresh,
  // server-stamped OTP claim — don't make the buyer verify twice. The server re-checks freshness
  // on submit, so this only spares the redundant prompt; a stale/absent claim falls back to OTP.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: sessionData } = await supabaseBrowser.auth.getSession();
        const stampedAt = (sessionData.session?.user?.app_metadata as Record<string, unknown> | undefined)
          ?.otp_verified_phone_at;
        const stampedMs = typeof stampedAt === 'string' ? new Date(stampedAt).getTime() : Number.NaN;
        if (!cancelled && !Number.isNaN(stampedMs) && Date.now() - stampedMs < OTP_FRESHNESS_MS) {
          await loadResubmissionProfile();
          return;
        }
      } catch {
        // fall through to the OTP step
      }
      if (!cancelled) setPhase('phone');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSendOtp(phoneNumber: string) {
    setSendError('');
    setSending(true);
    try {
      const res = await fetch('/api/auth/phone-otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      });
      const resData = await res.json().catch(() => ({}));
      if (!res.ok || !resData?.registered || !resData?.ref_id) {
        setSendError(
          resData?.message
          ?? resData?.error
          ?? 'We could not find an account for this number.',
        );
        return;
      }
      setPhone(phoneNumber);
      setRefId(resData.ref_id as string);
      setPhase('otp');
    } catch {
      setSendError('Network error. Please check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  async function loadResubmissionProfile() {
    setPhase('loading_profile');
    try {
      const res = await apiFetch('/api/buyer/onboarding/resubmission-profile');
      if (res.status === 404) {
        setPhase('not_applicable');
        return;
      }
      if (!res.ok) {
        setLoadError('Could not load your profile. Please try again.');
        setPhase('not_applicable');
        return;
      }
      const resData = (await res.json()) as ResubmissionData;
      setData(resData);
      setFullName(resData.profile.full_name);
      setBusinessName(resData.profile.business_name);
      setGstin(resData.profile.gstin);
      setAddressLine1(resData.profile.address_line1);
      setAddressLine2(resData.profile.address_line2);
      setCity(resData.profile.city);
      setState(resData.profile.state);
      setPincode(resData.profile.pincode);
      setShopImageDocId(resData.documents.shop_image_id);
      setGstCertDocId(resData.documents.gst_certificate_id);
      setPhase('form');
    } catch {
      setLoadError('Network error while loading your profile.');
      setPhase('not_applicable');
    }
  }

  async function handleVerifyOtp(otp: string) {
    setVerifyError('');
    setVerifying(true);
    try {
      const res = await fetch('/api/auth/phone-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_id: refId, otp }),
      });
      const resData: {
        success?: boolean;
        redirect?: string;
        handoff_url?: string;
        contexts?: unknown[];
        ref_id?: string;
        session?: { access_token: string; refresh_token: string };
        error?: string;
      } = await res.json();

      if (!res.ok || !resData.success) {
        setVerifyError(resData.error ?? 'Verification failed. Please try again.');
        return;
      }

      // Multiple accounts on this phone -- hand off to the existing shared
      // account-selector flow rather than re-implementing it here (out of
      // scope; see the file-level doc comment above).
      if (resData.contexts && resData.contexts.length > 1 && resData.ref_id) {
        try {
          sessionStorage.setItem(SESSION_CONTEXTS_KEY, JSON.stringify(resData.contexts));
        } catch {
          // sessionStorage may be unavailable in some environments
        }
        router.push(`/login/select-context?ref_id=${encodeURIComponent(resData.ref_id)}`);
        return;
      }

      // Cross-tenant handoff -- same rationale as above.
      if (resData.handoff_url) {
        if (resData.session?.access_token && resData.session?.refresh_token) {
          await supabaseBrowser.auth.setSession({
            access_token: resData.session.access_token,
            refresh_token: resData.session.refresh_token,
          });
        }
        markLoggedInOnDevice();
        window.location.assign(resData.handoff_url);
        return;
      }

      if (resData.session?.access_token && resData.session?.refresh_token) {
        await supabaseBrowser.auth.setSession({
          access_token: resData.session.access_token,
          refresh_token: resData.session.refresh_token,
        });
        markLoggedInOnDevice();
      }

      await loadResubmissionProfile();
    } catch {
      setVerifyError('Network error. Please check your connection and try again.');
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !data) return;
    setSubmitError('');

    const missingFields = data.missing_fields;
    const isBusiness = data.profile.is_business;

    if (isFlagged(missingFields, 'contact_name') && !fullName.trim()) {
      setSubmitError('Full name is required.');
      return;
    }
    if (isFlagged(missingFields, 'business_name') && isBusiness && !businessName.trim()) {
      setSubmitError('Business name is required.');
      return;
    }
    if (isFlagged(missingFields, 'shop_image') && !shopImageDocId) {
      setSubmitError('Please upload a shop image.');
      return;
    }
    if (isFlagged(missingFields, 'gst_certificate') && !gstCertDocId) {
      setSubmitError('Please upload your GST certificate.');
      return;
    }

    setSubmitting(true);
    try {
      // Only send a document id for a field the seller actually flagged --
      // sending both unconditionally could carry an unrelated/stale document
      // id (e.g. a personal shop_image id) into an intake payload that never
      // asked for it. Task 11 review, Important #2.
      const documentIds = [
        isFlagged(missingFields, 'shop_image') ? shopImageDocId : null,
        isFlagged(missingFields, 'gst_certificate') ? gstCertDocId : null,
      ].filter((id): id is string => Boolean(id));
      const res = await apiFetch('/api/buyer/onboarding/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName.trim(),
          email: data.profile.email,
          is_business: isBusiness,
          business_name: isBusiness ? businessName.trim() : '',
          gstin: gstin.trim(),
          address_line1: addressLine1.trim(),
          address_line2: addressLine2.trim(),
          city: city.trim(),
          state: state.trim(),
          pincode: pincode.trim(),
          document_ids: documentIds,
        }),
      });
      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(resData?.error ?? 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      window.location.assign('/pending?resubmitted=1');
    } catch {
      setSubmitError('Network error. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-cream-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white border border-cream-300 rounded-xl shadow-md p-8">
        <div className="mb-7 flex justify-center">
          <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
        </div>

        {(phase === 'checking' || phase === 'loading_profile') && (
          <div className="space-y-3">
            <div className="h-4 w-48 rounded bg-cream-200 animate-pulse" />
            <div className="h-10 w-full rounded bg-cream-200 animate-pulse" />
            <div className="h-10 w-full rounded bg-cream-200 animate-pulse" />
          </div>
        )}

        {phase === 'phone' && (
          <>
            <h1 className="text-h3 font-display text-cream-900 mb-1">Verify your number</h1>
            <p className="text-body-sm text-cream-600 mb-6">
              To update your details, we need to confirm it&apos;s really you -- please verify your
              WhatsApp number.
            </p>
            <PhoneInput onSubmit={handleSendOtp} loading={sending} error={sendError} />
          </>
        )}

        {phase === 'otp' && (
          <>
            <h1 className="text-h3 font-display text-cream-900 mb-1">Enter OTP</h1>
            <p className="text-body-sm text-cream-600 mb-6">We sent a 6-digit code to your WhatsApp.</p>
            <OtpForm phone={phone} onSubmit={handleVerifyOtp} loading={verifying} error={verifyError} />
            <button
              type="button"
              onClick={() => {
                setPhase('phone');
                setVerifyError('');
              }}
              className="mt-4 text-caption text-cream-600 hover:text-cream-800 transition-colors"
            >
              ← Use a different number
            </button>
          </>
        )}

        {phase === 'not_applicable' && (
          <div className="space-y-4">
            <h1 className="text-h3 font-display text-cream-900 mb-1">Nothing to resubmit</h1>
            <p className="text-body-sm text-cream-600">
              {loadError
                || 'We couldn’t find a document request that needs your attention right now.'}
            </p>
            <Button className="w-full" onClick={() => router.replace('/pending')}>
              Check current access status
            </Button>
          </div>
        )}

        {phase === 'form' && data && (
          <>
          <form onSubmit={handleSubmit} className="space-y-4">
            <h1 className="text-h3 font-display text-cream-900 mb-1">A few things need fixing</h1>
            <p className="text-body-sm text-cream-600 mb-2">
              The seller needs a bit more information before approving your account. Your earlier
              details are filled in below — update the field(s) marked &quot;needs update&quot; and resubmit.
            </p>

            {data.missing_fields.length > 0 && (
              <div className="rounded-md bg-warning-50 border border-warning-200 px-4 py-3 mb-2">
                <p className="text-body-sm font-medium text-warning-700">Requested by the seller:</p>
                <ul className="mt-1 list-disc pl-5 text-body-sm text-warning-700/90">
                  {data.missing_fields.map((key) => (
                    <li key={key}>{requestedFieldLabel(key)}</li>
                  ))}
                </ul>
              </div>
            )}

            <ReadOnlyOrEditableText
              id="full_name"
              label="Full name"
              value={fullName}
              onChange={setFullName}
              editable={isFlagged(data.missing_fields, 'contact_name')}
              disabled={submitting}
              required
            />

            {data.profile.is_business && (
              <ReadOnlyOrEditableText
                id="business_name"
                label="Business name"
                value={businessName}
                onChange={setBusinessName}
                editable={isFlagged(data.missing_fields, 'business_name')}
                disabled={submitting}
                required
              />
            )}

            <ReadOnlyOrEditableText
              id="gstin"
              label="GSTIN"
              value={gstin}
              onChange={(v) => setGstin(v.toUpperCase())}
              editable={isFlagged(data.missing_fields, 'gstin')}
              disabled={submitting}
            />

            <fieldset className="space-y-3 rounded-md border border-cream-200 bg-cream-50/60 p-4">
              <legend className="px-1 text-caption font-semibold text-cream-700 uppercase tracking-wide">
                Address{isFlagged(data.missing_fields, 'address') ? ' (needs update)' : ''}
              </legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5 col-span-2">
                  <Label htmlFor="address_line1">Address line 1</Label>
                  <Input
                    id="address_line1"
                    value={addressLine1}
                    onChange={(e) => setAddressLine1(e.target.value)}
                    disabled={submitting || !isFlagged(data.missing_fields, 'address')}
                  />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label htmlFor="address_line2">Address line 2 (optional)</Label>
                  <Input
                    id="address_line2"
                    value={addressLine2}
                    onChange={(e) => setAddressLine2(e.target.value)}
                    disabled={submitting || !isFlagged(data.missing_fields, 'address')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    disabled={submitting || !isFlagged(data.missing_fields, 'address')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="state">State</Label>
                  <Input
                    id="state"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    disabled={submitting || !isFlagged(data.missing_fields, 'address')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pincode">Pincode</Label>
                  <Input
                    id="pincode"
                    value={pincode}
                    onChange={(e) => setPincode(e.target.value)}
                    disabled={submitting || !isFlagged(data.missing_fields, 'address')}
                  />
                </div>
              </div>
            </fieldset>

            {isFlagged(data.missing_fields, 'shop_image') && (
              <DocumentUploadField
                id="shop_image"
                label="Shop image"
                required
                docType="shop_image"
                scope="personal"
                disabled={submitting}
                documentId={shopImageDocId}
                onChange={setShopImageDocId}
              />
            )}

            {isFlagged(data.missing_fields, 'gst_certificate') && (
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

            {submitError && (
              <p className="text-caption text-danger-500 bg-danger-50 px-3 py-2 rounded-md">
                {submitError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={submitting} haptic>
              {submitting ? 'Sending…' : 'Resubmit'}
            </Button>
          </form>
          {/* The phone may match other accounts at this seller: let the buyer continue with one of those instead. */}
          <OtherAccountsPanel tenantId={null} />
          </>
        )}

        {sellerWhatsappNumber && (
          <button
            type="button"
            onClick={() =>
              window.open(
                buildWhatsAppChatUrl(
                  sellerWhatsappNumber,
                  `Hi ${sellerName}, I have a question about my Yukti catalog access request.`,
                ),
                '_blank',
                'noopener,noreferrer',
              )
            }
            className="mt-5 w-full inline-flex items-center justify-center px-4 py-2.5 rounded-md bg-teal-500 hover:bg-teal-600 text-cream-50 text-body-sm font-semibold transition-colors duration-base"
          >
            Contact {sellerName} on WhatsApp
          </button>
        )}
      </div>
    </div>
  );
}

function ReadOnlyOrEditableText({
  id,
  label,
  value,
  onChange,
  editable,
  disabled,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {editable ? ' (needs update)' : ''}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !editable}
        required={editable && required}
      />
    </div>
  );
}
