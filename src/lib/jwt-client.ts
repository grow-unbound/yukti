/** Decode a JWT payload in the browser. Not a verification — server code must never trust it. */
export function decodeJwtPayloadClient(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The app role claim (`user_role`, falling back to `role`) from an access token, or null. */
export function readAccessTokenRole(token: string | null | undefined): string | null {
  if (!token) return null;
  const claims = decodeJwtPayloadClient(token);
  const role = claims?.user_role ?? claims?.role;
  return typeof role === 'string' ? role : null;
}
