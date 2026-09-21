import { describe, expect, it } from 'vitest';
import { hasSupabaseAuthCookie } from '@/lib/server/supabase-auth-cookie';

const c = (...names: string[]) => names.map((name) => ({ name }));

describe('hasSupabaseAuthCookie', () => {
  it('detects the session cookie and its chunks', () => {
    expect(hasSupabaseAuthCookie(c('sb-cckmurgapnkytbzxqesp-auth-token'))).toBe(true);
    expect(hasSupabaseAuthCookie(c('sb-cckmurgapnkytbzxqesp-auth-token.0', 'sb-cckmurgapnkytbzxqesp-auth-token.1'))).toBe(true);
    expect(hasSupabaseAuthCookie(c('theme', 'sb-hcpzbnmumbykdqveyjhr-auth-token'))).toBe(true);
  });

  it('does not treat unrelated or non-session cookies as a session', () => {
    expect(hasSupabaseAuthCookie([])).toBe(false);
    expect(hasSupabaseAuthCookie(c('theme', 'ph_phc_x_posthog', 'df_human_verified'))).toBe(false);
    expect(hasSupabaseAuthCookie(c('sb-cckmurgapnkytbzxqesp-auth-token-code-verifier'))).toBe(false);
    expect(hasSupabaseAuthCookie(c('sb-cckmurgapnkytbzxqesp-auth-token-user'))).toBe(false);
    expect(hasSupabaseAuthCookie(c('not-sb-x-auth-token'))).toBe(false);
  });
});
