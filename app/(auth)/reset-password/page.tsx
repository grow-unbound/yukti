'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { YuktiLogo } from '@/components/brand/YuktiLogo';
import { supabaseBrowser } from '@/lib/supabase-browser';

const inputCls =
  'w-full px-3 py-2.5 rounded-md bg-cream-50 border border-cream-300 text-cream-900 placeholder:text-cream-500 text-body-sm focus:outline-none focus:border-ember-400 focus:ring-2 focus:ring-ember-400/20 transition-colors disabled:opacity-50';
const labelCls =
  'block text-cream-700 font-semibold mb-1.5 uppercase tracking-wide';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [accountKind, setAccountKind] = useState<'seller' | 'buyer' | 'unknown'>('unknown');
  const [sessionReady, setSessionReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    // Hash fragment from Supabase old-style email links: #access_token=...&refresh_token=...
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');

    const bootstrap = async () => {
      if (accessToken && refreshToken) {
        // Explicitly call setSession — createClientComponentClient (cookie storage) does
        // NOT auto-process hash fragments the way localStorage-based clients do.
        await supabaseBrowser.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        window.history.replaceState({}, '', window.location.pathname + window.location.search);
      } else if (code) {
        await supabaseBrowser.auth.exchangeCodeForSession(code);
        const clean = new URL(window.location.href);
        clean.searchParams.delete('code');
        window.history.replaceState({}, '', clean.toString());
      }

      const { data } = await supabaseBrowser.auth.getUser();
      if (!data.user) {
        setError('Your reset link has expired or is invalid. Please request a new one.');
        return;
      }
      const name =
        (data.user.user_metadata?.full_name as string | undefined) ??
        data.user.email ??
        null;
      const metadata = data.user.user_metadata ?? {};
      const appMetadata = data.user.app_metadata ?? {};
      const isBuyerAccount = typeof metadata.buyer_id === 'string'
        || typeof metadata.buyer_user_id === 'string'
        || typeof appMetadata.current_buyer_id === 'string';
      const isSellerAccount = typeof metadata.role === 'string' && metadata.role.startsWith('seller_')
        || typeof metadata.tenant_id === 'string'
        || typeof appMetadata.current_tenant_id === 'string';
      setDisplayName(name);
      setAccountKind(isBuyerAccount ? 'buyer' : isSellerAccount ? 'seller' : 'unknown');
      setSessionReady(true);
    };

    void bootstrap();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    let shouldResetLoading = true;
    try {
      const { error: updateError } = await supabaseBrowser.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }

      await supabaseBrowser.auth.signOut();
      shouldResetLoading = false;
      router.replace('/login?reset=success');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      if (shouldResetLoading) setLoading(false);
    }
  }

  return (
    <div className="bg-white border border-cream-300 rounded-xl shadow-md p-8">
      <div className="mb-7 flex justify-center">
        <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
      </div>

      <h1 className="text-h3 font-display text-cream-900 mb-1">
        {displayName ? `Hi ${displayName.split(' ')[0]}, set a new password` : 'Set a new password'}
      </h1>
      <p className="text-body-sm text-cream-600 mb-6">
        {accountKind === 'seller'
          ? 'Choose a strong password for your Supplier workspace account.'
          : accountKind === 'buyer'
            ? 'Choose a strong password for your supplier catalog account.'
            : 'Choose a strong password for your Yukti account.'}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelCls} style={{ fontSize: 'var(--yk-text-xs)', letterSpacing: '0.08em' }}>
            Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Min. 8 characters"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              disabled={loading || !sessionReady}
              required
              autoComplete="new-password"
              className={`${inputCls} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((current) => !current)}
              disabled={loading || !sessionReady}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-cream-500 transition-colors hover:text-cream-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className={labelCls} style={{ fontSize: 'var(--yk-text-xs)', letterSpacing: '0.08em' }}>
            Confirm password
          </label>
          <div className="relative">
            <input
              type={showConfirmPassword ? 'text' : 'password'}
              placeholder="Repeat your password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
              disabled={loading || !sessionReady}
              required
              autoComplete="new-password"
              className={`${inputCls} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((current) => !current)}
              disabled={loading || !sessionReady}
              aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-cream-500 transition-colors hover:text-cream-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-caption text-danger-500 bg-danger-50 px-3 py-2 rounded-md">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !sessionReady}
          className="w-full px-4 py-2.5 rounded-md bg-teal-500 hover:bg-teal-600 text-cream-50 text-body-sm font-semibold transition-colors duration-base disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Saving…' : !sessionReady && !error ? 'Verifying link…' : 'Set new password & continue'}
        </button>
      </form>

      <div className="mt-4 text-right">
        <p className="text-caption text-cream-600">
          Already remembered it?{' '}
          <Link href="/login" className="text-ember-400 hover:text-ember-500 font-medium transition-colors">
            Login
          </Link>
        </p>
      </div>
    </div>
  );
}
