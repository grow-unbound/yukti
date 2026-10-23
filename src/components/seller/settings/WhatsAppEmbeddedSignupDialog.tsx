'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPost } from '@/lib/api-fetch';

declare global {
  interface Window {
    FB?: {
      init: (params: Record<string, unknown>) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
        params: Record<string, unknown>,
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

type Step = 'warning' | 'connecting' | 'pin' | 'submitting';

interface WhatsAppSignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
}

const FACEBOOK_MESSAGE_ORIGINS = new Set([
  'https://www.facebook.com',
  'https://web.facebook.com',
]);
const SIGNUP_ATTEMPT_TIMEOUT_MS = 120_000;

interface WhatsAppEmbeddedSignupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metaAppId: string | undefined;
  configId: string | undefined;
  onConnected: () => void;
}

function loadFacebookSdk(appId: string): Promise<void> {
  return new Promise((resolve) => {
    if (window.FB) {
      resolve();
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({ appId, xfbml: false, version: 'v21.0' });
      resolve();
    };

    if (document.getElementById('facebook-jssdk')) return;

    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  });
}

export function WhatsAppEmbeddedSignupDialog({
  open,
  onOpenChange,
  metaAppId,
  configId,
  onConnected,
}: WhatsAppEmbeddedSignupDialogProps) {
  const [step, setStep] = useState<Step>('warning');
  const [billingConfirmed, setBillingConfirmed] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const signupResultRef = useRef<WhatsAppSignupResult | null>(null);
  const messageListenerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const signupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signupAttemptIdRef = useRef(0);
  const [fbSdkReady, setFbSdkReady] = useState(false);

  const clearSignupAttempt = useCallback(() => {
    if (messageListenerRef.current) {
      window.removeEventListener('message', messageListenerRef.current);
      messageListenerRef.current = null;
    }
    if (signupTimeoutRef.current) {
      clearTimeout(signupTimeoutRef.current);
      signupTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setStep('warning');
      setPin('');
      setBillingConfirmed(false);
      setError(null);
      signupResultRef.current = null;
      signupAttemptIdRef.current += 1;
      clearSignupAttempt();
      return;
    }

    // Preload the Facebook SDK as soon as the dialog opens, well before the
    // user clicks "Continue with Facebook". FB.login() must open its popup
    // synchronously inside the click handler to count as a user-gesture — if
    // we `await` SDK loading inside the click handler instead, the browser
    // no longer treats the resulting FB.login() call as gesture-triggered
    // and silently blocks the popup (no error, it just never opens).
    if (metaAppId) {
      loadFacebookSdk(metaAppId).then(() => setFbSdkReady(true));
    }
  }, [clearSignupAttempt, open, metaAppId]);

  useEffect(() => {
    return () => {
      signupAttemptIdRef.current += 1;
      clearSignupAttempt();
    };
  }, [clearSignupAttempt]);

  function startEmbeddedSignup() {
    setError(null);

    if (!metaAppId || !configId) {
      setError('WhatsApp connect is not configured on this server yet. Contact support.');
      return;
    }

    if (!fbSdkReady || !window.FB) {
      setError('Still getting things ready — please wait a second and try again.');
      return;
    }

    setStep('connecting');
    clearSignupAttempt();
    signupResultRef.current = null;
    const attemptId = signupAttemptIdRef.current + 1;
    signupAttemptIdRef.current = attemptId;

    const isCurrentAttempt = () => signupAttemptIdRef.current === attemptId;
    const endAttempt = () => {
      if (!isCurrentAttempt()) return;
      signupAttemptIdRef.current += 1;
      clearSignupAttempt();
    };
    const failAttempt = (message: string) => {
      endAttempt();
      setError(message);
      setStep('warning');
    };
    const advanceWhenAuthorized = () => {
      if (!isCurrentAttempt()) return false;
      const result = signupResultRef.current;
      if (!result?.code) return false;
      if (signupTimeoutRef.current) {
        clearTimeout(signupTimeoutRef.current);
        signupTimeoutRef.current = null;
      }
      setStep('pin');
      return true;
    };

    const handleMessage = (event: MessageEvent) => {
      if (!FACEBOOK_MESSAGE_ORIGINS.has(event.origin) || !isCurrentAttempt()) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;

        if (data.event === 'ERROR') {
          const message = typeof data.data?.error_message === 'string'
            ? data.data.error_message
            : 'WhatsApp setup could not be completed. Please try again.';
          failAttempt(message);
          return;
        }
        if (data.event === 'CANCEL') {
          failAttempt('WhatsApp connection was cancelled.');
          return;
        }
        if (typeof data.event === 'string' && (data.event === 'FINISH' || data.event.startsWith('FINISH_'))) {
          const { waba_id, waba_ids, phone_number_id, business_id, businessId } = data.data ?? {};
          const soleWabaId = Array.isArray(waba_ids) && waba_ids.length === 1 && typeof waba_ids[0] === 'string'
            ? waba_ids[0]
            : '';
          signupResultRef.current = {
            code: signupResultRef.current?.code ?? '',
            wabaId: typeof waba_id === 'string' ? waba_id : soleWabaId,
            phoneNumberId: phone_number_id ?? '',
            businessId: business_id ?? businessId ?? null,
          };
          advanceWhenAuthorized();
        }
      } catch {
        // Non-JSON postMessage from an unrelated source — ignore.
      }
    };
    window.addEventListener('message', handleMessage);
    messageListenerRef.current = handleMessage;
    signupTimeoutRef.current = setTimeout(() => {
      if (!isCurrentAttempt()) return;
      failAttempt('Facebook login did not complete. Check that pop-ups are allowed, then try again.');
    }, SIGNUP_ATTEMPT_TIMEOUT_MS);

    window.FB?.login(
      (response) => {
        if (!isCurrentAttempt()) return;
        const code = response.authResponse?.code;
        if (!code) {
          failAttempt('Facebook did not return an authorization code. Please try again.');
          return;
        }
        signupResultRef.current = {
          code,
          wabaId: signupResultRef.current?.wabaId ?? '',
          phoneNumberId: signupResultRef.current?.phoneNumberId ?? '',
          businessId: signupResultRef.current?.businessId ?? null,
        };
        advanceWhenAuthorized();
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  }

  async function submitPinAndConnect() {
    const result = signupResultRef.current;
    if (!result) {
      setError('WhatsApp signup session expired. Please start again.');
      setStep('warning');
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setError('Enter the 6-digit PIN you want to set for this number.');
      return;
    }

    setStep('submitting');
    setError(null);
    clearSignupAttempt();
    try {
      const res = await apiPost('/api/settings/integrations/whatsapp/oauth/callback', {
        code: result.code,
        waba_id: result.wabaId,
        phone_number_id: result.phoneNumberId,
        business_id: result.businessId,
        pin,
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error?.message ?? 'Failed to connect WhatsApp');
      }
      toast.success('WhatsApp Business connected');
      onConnected();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect WhatsApp');
      setStep('pin');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-cream-200 bg-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-cream-900">
            <MessageCircle className="h-5 w-5 text-teal-700" />
            Connect WhatsApp Business
          </DialogTitle>
          <DialogDescription className="text-cream-700">
            Send order updates and offers to your customers on WhatsApp, using your own business number.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {step === 'warning' && (
            <div className="space-y-4">
              <div className="flex gap-3 rounded-2xl border border-warning-500/30 bg-warning-50 px-4 py-4 text-sm leading-6 text-warning-700">
                <AlertTriangle className="h-5 w-5 shrink-0 text-warning-500" />
                <div className="space-y-2">
                  <p className="font-semibold text-warning-950">Before you connect, please know:</p>
                  <ul className="list-disc space-y-1.5 pl-4">
                    <li>A WhatsApp number can only be linked to one app at a time. If this number is already used in another app or tool, connecting it here will remove it from there.</li>
                    <li>Anything set up with that other app — auto-replies, chatbots, message templates — will stop working right away.</li>
                    <li>You'll be asked to set a 6-digit PIN for this number. Keep it safe — you'll need it again if you ever reconnect.</li>
                    <li>Please make sure a valid credit card is added in your Meta Business Manager (under WhatsApp Manager → Payment methods). Without one, WhatsApp messages can fail to send.</li>
                  </ul>
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-cream-200 bg-cream-50 px-4 py-3 text-sm leading-6 text-cream-900">
                <Checkbox
                  checked={billingConfirmed}
                  onCheckedChange={(checked) => setBillingConfirmed(checked === true)}
                  className="mt-0.5"
                />
                <span>
                  I understand that WhatsApp messages (notifications, alerts, marketing) are billed directly by Meta to my business, separately from my Yukti plan, and I agree to pay for that usage.
                </span>
              </label>

              {error && <p className="text-sm text-destructive-600">{error}</p>}
            </div>
          )}

          {step === 'connecting' && (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-cream-700">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Waiting for Facebook login to complete…</p>
            </div>
          )}

          {(step === 'pin' || step === 'submitting') && (
            <div className="space-y-3">
              <p className="text-sm text-cream-700">
                Almost done. Choose a 6-digit PIN for this WhatsApp number — you'll need it again if you ever reconnect.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="whatsapp-pin">6-digit PIN</Label>
                <Input
                  id="whatsapp-pin"
                  inputMode="numeric"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  disabled={step === 'submitting'}
                />
              </div>
              {error && <p className="text-sm text-destructive-600">{error}</p>}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={step === 'submitting'}>
            Cancel
          </Button>
          {step === 'warning' && (
            <Button variant="accent" onClick={startEmbeddedSignup} disabled={!billingConfirmed || !fbSdkReady}>
              Continue with Facebook
            </Button>
          )}
          {step === 'pin' && (
            <Button variant="accent" onClick={submitPinAndConnect}>
              Connect
            </Button>
          )}
          {step === 'submitting' && (
            <Button variant="accent" disabled>
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
