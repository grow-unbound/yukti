/**
 * Cheap "could this request carry a Supabase session?" check for middleware.
 *
 * `@supabase/ssr` stores the session in `sb-<project-ref>-auth-token`, split into `.0`, `.1`, ...
 * chunks when large. Without such a cookie there is nothing to verify, so middleware can skip
 * building a Supabase client and calling `getClaims()` (the dominant per-request cost for anonymous
 * public-catalog traffic). The PKCE `...-auth-token-code-verifier` cookie deliberately does NOT match:
 * it is not a session. Any other cookie shape is treated as "no session".
 */
const SUPABASE_AUTH_COOKIE_RE = /^sb-[a-z0-9-]+-auth-token(?:\.\d+)?$/i;

export function hasSupabaseAuthCookie(cookies: ReadonlyArray<{ name: string }>): boolean {
  return cookies.some((cookie) => SUPABASE_AUTH_COOKIE_RE.test(cookie.name));
}
