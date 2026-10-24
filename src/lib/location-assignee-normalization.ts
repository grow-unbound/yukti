export interface LocationAssociatedUser {
  email: string;
  user_name: string | null;
  user_id: string | null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function parseLocationAssociatedUserEmails(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => entry !== null)
      .map(normalizeEmail)
      .filter((email) => email.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\n,]/g)
      .map((part) => normalizeEmail(part))
      .filter((email) => email.length > 0);
  }

  return [];
}

export function normalizeLocationAssociatedUsers(value: unknown): LocationAssociatedUser[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        const email = normalizeEmail(entry);
        return email ? { email, user_name: null, user_id: null } : null;
      }

      if (typeof entry !== 'object' || entry === null) return null;
      const row = entry as Record<string, unknown>;
      const email = asString(row.email);
      if (!email) return null;

      return {
        email: normalizeEmail(email),
        user_name: asString(row.user_name ?? row.name),
        user_id: asString(row.user_id),
      };
    })
    .filter((entry): entry is LocationAssociatedUser => entry !== null);
}
