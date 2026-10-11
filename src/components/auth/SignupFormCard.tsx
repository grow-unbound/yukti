'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { usePostHog } from 'posthog-js/react';
import { Turnstile } from '@marsidev/react-turnstile';
import { AuthHomeLogoLink } from '@/components/auth/AuthHomeLogoLink';
import {
  AUTH_LOGIN_COPY,
  buildInformSellerMessage,
  openWhatsAppShare,
} from '@/constants/auth-login-copy';

const SignupFormSchema = z
  .object({
    full_name: z.string().min(1, 'Full name is required'),
    business_name: z.string().min(1, 'Business name is required'),
    email: z.string().email('Enter a valid email address'),
    phone: z.string().regex(/^[0-9]{10}$/, 'Enter a valid 10-digit mobile number'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirm_password: z.string(),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type SignupFormValues = z.infer<typeof SignupFormSchema>;

interface SignupResponse {
  code?: string;
  error?: string;
  pending_verification?: boolean;
  user_id?: string;
  email?: string;
  phone?: string | null;
  tenant?: { tenant_id?: string; slug?: string; subdomain?: string };
  otp_send_failed?: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

const inputCls =
  'w-full px-3 py-2.5 rounded-md bg-cream-50 border border-cream-300 text-cream-900 placeholder:text-cream-500 text-body-sm focus:outline-none focus:border-ember-400 focus:ring-2 focus:ring-ember-400/20 transition-colors disabled:opacity-50';

const labelCls =
  'block text-cream-700 font-semibold mb-1.5 text-xs uppercase tracking-[0.08em]';

export function SignupFormCard() {
  const router = useRouter();
  const posthog = usePostHog();
  const [apiError, setApiError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(SignupFormSchema),
    defaultValues: {
      full_name: '',
      business_name: '',
      email: '',
      phone: '',
      password: '',
      confirm_password: '',
    },
    mode: 'onBlur',
  });

  async function onSubmit(values: SignupFormValues) {
    setApiError('');
    posthog?.capture('signup_attempted', {
      has_phone: Boolean(values.phone),
      has_turnstile: Boolean(turnstileSiteKey),
      business_slug_length: slugify(values.business_name).length,
      plan: 'starter',
    });
    try {
      const distinctId = posthog?.get_distinct_id();
      const sessionId = posthog?.get_session_id?.();
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(distinctId && { 'X-POSTHOG-DISTINCT-ID': distinctId }),
          ...(sessionId && { 'X-POSTHOG-SESSION-ID': sessionId }),
        },
        body: JSON.stringify({
          full_name: values.full_name,
          email: values.email,
          password: values.password,
          business_name: values.business_name,
          slug: slugify(values.business_name),
          phone: values.phone,
          turnstile_token: turnstileToken || undefined,
        }),
      });

      const data = (await res.json()) as SignupResponse;

      if (!res.ok) {
        if (res.status === 409 || data.code === 'SLUG_TAKEN') {
          setApiError('A workspace with that business name already exists. Try a slightly different name.');
          posthog?.capture('signup_failed', {
            failure_type: 'slug_taken',
            status: res.status,
            code: data.code ?? 'SLUG_TAKEN',
            has_phone: Boolean(values.phone),
            has_turnstile: Boolean(turnstileSiteKey),
          });
        } else {
          setApiError(data.error ?? 'Signup failed. Please try again.');
          posthog?.capture('signup_failed', {
            failure_type: data.code ?? 'api_error',
            status: res.status,
            reason: data.error ?? null,
            has_phone: Boolean(values.phone),
            has_turnstile: Boolean(turnstileSiteKey),
          });
        }
        return;
      }

      if (data.pending_verification) {
        posthog?.capture('user_signed_up', {
          tenant_slug: data.tenant?.slug,
          plan: 'starter',
        });
        const params = new URLSearchParams({
          email: data.email ?? values.email,
          uid: data.user_id ?? '',
          ...(data.phone ? { phone: data.phone } : {}),
          ...(data.tenant?.tenant_id ? { tid: data.tenant.tenant_id } : {}),
        });
        router.replace(`/verify-account?${params.toString()}`);
        return;
      }

      setApiError('Account was created but verification could not be initiated. Please login.');
      posthog?.capture('signup_failed', {
        failure_type: 'verification_not_initiated',
        status: res.status,
        has_phone: Boolean(values.phone),
        has_turnstile: Boolean(turnstileSiteKey),
      });
    } catch (err) {
      posthog?.capture('signup_failed', {
        failure_type: 'network_or_unexpected_error',
        has_phone: Boolean(values.phone),
        has_turnstile: Boolean(turnstileSiteKey),
      });
      posthog?.captureException(err);
      setApiError('An unexpected error occurred. Please try again.');
    }
  }

  function handleInformDistributor() {
    const signupLink = new URL('/signup', window.location.origin).toString();
    openWhatsAppShare(buildInformSellerMessage({ signupLink }));
  }

  return (
    <div className="bg-cream-50 border border-cream-300 rounded-lg shadow-md p-8">
      <div className="mb-7 flex justify-center">
        <AuthHomeLogoLink />
      </div>

      <h1 className="font-display text-h2 text-cream-900 mb-1">Create your Supplier workspace</h1>
      <p className="text-body-sm text-cream-600 mb-6">
        For manufacturers, distributors, and wholesalers selling in bulk to other businesses
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-h-[calc(100vh-280px)] overflow-y-auto pr-1" noValidate>

        <div>
          <label className={labelCls}>Business name</label>
          <input
            type="text"
            placeholder="Your Business Ltd."
            className={inputCls}
            {...register('business_name')}
          />
          {errors.business_name && <p className="mt-1 text-caption text-danger-500">{errors.business_name.message}</p>}
        </div>

        <div>
          <label className={labelCls}>Your full name</label>
          <input
            type="text"
            placeholder="Ravi Kumar"
            autoComplete="name"
            className={inputCls}
            {...register('full_name')}
          />
          {errors.full_name && <p className="mt-1 text-caption text-danger-500">{errors.full_name.message}</p>}
        </div>

        <div>
          <label className={labelCls}>Email</label>
          <input
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            className={inputCls}
            {...register('email')}
          />
          {errors.email && <p className="mt-1 text-caption text-danger-500">{errors.email.message}</p>}
        </div>

        <div>
          <label className={labelCls}>Mobile number</label>
          <div className="flex items-stretch">
            <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-cream-300 bg-cream-100 text-cream-600 text-body-sm select-none">
              +91
            </span>
            <input
              type="tel"
              inputMode="numeric"
              pattern="[0-9]{10}"
              maxLength={10}
              placeholder="9876543210"
              autoComplete="tel-national"
              className={`${inputCls} rounded-l-none`}
              {...register('phone', {
                onChange: (e) => {
                  e.target.value = e.target.value.replace(/\D/g, '');
                  setValue('phone', e.target.value);
                },
              })}
            />
          </div>
          {errors.phone && <p className="mt-1 text-caption text-danger-500">{errors.phone.message}</p>}
        </div>

        <div>
          <label className={labelCls}>Password</label>
          <input
            type="password"
            placeholder="Min. 8 characters"
            autoComplete="new-password"
            className={inputCls}
            {...register('password')}
          />
          {errors.password && <p className="mt-1 text-caption text-danger-500">{errors.password.message}</p>}
        </div>

        <div>
          <label className={labelCls}>Confirm password</label>
          <input
            type="password"
            placeholder="Repeat your password"
            autoComplete="new-password"
            className={inputCls}
            {...register('confirm_password')}
          />
          {errors.confirm_password && <p className="mt-1 text-caption text-danger-500">{errors.confirm_password.message}</p>}
        </div>

        {apiError && <p className="text-caption text-danger-500 bg-danger-50 px-3 py-2 rounded-md">{apiError}</p>}

        {turnstileSiteKey && (
          <Turnstile
            siteKey={turnstileSiteKey}
            onSuccess={setTurnstileToken}
            onError={() => setApiError('Bot check failed. Please refresh and try again.')}
            options={{ theme: 'light' }}
          />
        )}

        <button
          type="submit"
          disabled={isSubmitting || (!!turnstileSiteKey && !turnstileToken)}
          className="w-full px-4 py-2.5 rounded-md bg-[#221E1A] hover:bg-[#3D3630] active:bg-[#2E2A26] active:scale-[0.97] text-cream-50 text-body-sm font-semibold transition-all duration-base disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? 'Creating workspace…' : 'Create workspace'}
        </button>
      </form>

      <div className="mt-5 rounded-lg border border-ember-200 bg-ember-50 px-4 py-3 text-center">
        <p className="text-caption font-semibold uppercase tracking-[0.08em] text-cream-600">
          {AUTH_LOGIN_COPY.login.buyerInsteadPrefix}
        </p>
        <button
          type="button"
          onClick={handleInformDistributor}
          className="mt-1 text-body-sm font-semibold text-ember-500 transition-colors hover:text-ember-600"
        >
          {AUTH_LOGIN_COPY.login.buyerInsteadCta}
        </button>
      </div>

      <p className="mt-5 text-center text-body-sm text-cream-600">
        Already have an account?{' '}
        <Link href="/login" className="text-ember-400 hover:text-ember-500 font-medium transition-colors">
          Login
        </Link>
      </p>
    </div>
  );
}
