import { sendSetupPasswordInviteEmail } from '@/lib/server/email';

type AnyAdminClient = any;
type AnyQuery = any;

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

function uniqByEmail(users: LocationAssociatedUser[]): LocationAssociatedUser[] {
  const seen = new Set<string>();
  const out: LocationAssociatedUser[] = [];
  for (const user of users) {
    const key = normalizeEmail(user.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...user, email: key });
  }
  return out;
}

export async function syncLocationAssignees(
  admin: AnyAdminClient,
  tenantId: string,
  locationId: string,
  users: Array<Pick<LocationAssociatedUser, 'email' | 'user_name'>>,
  actorId: string | null,
): Promise<LocationAssociatedUser[]> {
  const desiredUsers = uniqByEmail(
    users
      .map((user) => ({
        email: normalizeEmail(user.email),
        user_name: user.user_name ?? null,
        user_id: null,
      }))
      .filter((user) => user.email.length > 0),
  );

  if (desiredUsers.length === 0) return [];

  const now = new Date().toISOString();
  const { data: tenantRow } = await admin
    .schema('app')
    .from('tenants')
    .select('business_name')
    .eq('id', tenantId)
    .maybeSingle();
  const tenantName = asString(tenantRow?.business_name) ?? 'Your team';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  let setupPasswordRedirectTo: string | undefined;
  if (appUrl) {
    try {
      setupPasswordRedirectTo = new URL('/setup-password', appUrl).toString();
    } catch {
      setupPasswordRedirectTo = undefined;
    }
  }

  // Previously fetched every user in the whole project (listUsers()) up front to check
  // for an existing account before inviting. Invite directly instead — it's the common
  // case (these are almost always brand-new invites) — and only fall back to a lookup
  // (lazily, once, cached across this loop) when an invite collides with an existing
  // account.
  let authByEmail: Map<string, { id: string; email: string; user_name: string | null }> | null = null;

  const resolved: LocationAssociatedUser[] = [];
  for (const user of desiredUsers) {
    const email = normalizeEmail(user.email);
    let userId: string | null = null;
    let userName = user.user_name ?? null;

    const { data: inviteData, error } = await admin.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        ...(setupPasswordRedirectTo ? { redirectTo: setupPasswordRedirectTo } : {}),
        data: {
          tenant_id: tenantId,
          role: 'seller_assistant',
          full_name: user.user_name ?? user.email,
        },
      },
    });

    if (!error && inviteData?.user?.id) {
      userId = inviteData.user.id;
      userName = userName ?? asString((inviteData.user.user_metadata ?? {})['full_name']) ?? user.email;
      if (inviteData.properties?.action_link) {
        await sendSetupPasswordInviteEmail({
          to: email,
          inviteUrl: inviteData.properties.action_link,
          tenantName,
          recipientName: userName,
        });
      }
    } else if (error && /already.*(registered|exists)/i.test(error.message ?? '')) {
      if (!authByEmail) {
        const { data: authUsers } = await admin.auth.admin.listUsers();
        authByEmail = new Map();
        for (const authUser of (authUsers?.users ?? []) as Array<{
          id: string;
          email: string | null;
          user_metadata?: Record<string, unknown>;
        }>) {
          const authEmail = normalizeEmail(authUser.email ?? '');
          if (!authEmail) continue;
          authByEmail.set(authEmail, {
            id: authUser.id,
            email: authEmail,
            user_name: asString((authUser.user_metadata ?? {})['full_name']) ?? authUser.email ?? null,
          });
        }
      }

      const existingAuth = authByEmail.get(email);
      if (!existingAuth) continue;
      userId = existingAuth.id;
      userName = userName ?? existingAuth.user_name;
    } else {
      continue;
    }

    if (!userId) continue;

    const { data: tenantUser } = await admin
      .schema('app')
      .from('tenant_users')
      .select('id, location_ids, role, is_active')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!tenantUser) {
      await admin.schema('app').from('tenant_users').insert({
        tenant_id: tenantId,
        user_id: userId,
        full_name: userName,
        email: user.email,
        role: 'seller_assistant',
        location_ids: [locationId],
        is_active: true,
        invited_at: null,
        joined_at: now,
        created_by: actorId,
        updated_by: actorId,
      });
    } else {
      const currentLocations = Array.isArray(tenantUser.location_ids)
        ? tenantUser.location_ids.filter((locationIdValue: unknown): locationIdValue is string => typeof locationIdValue === 'string' && locationIdValue.length > 0)
        : [];
      if (!currentLocations.includes(locationId)) {
        await admin.schema('app').from('tenant_users').update({
          full_name: userName,
          location_ids: [...currentLocations, locationId],
          updated_at: now,
          updated_by: actorId,
        }).eq('id', tenantUser.id as string);
      }
    }

    resolved.push({ email: user.email, user_name: userName, user_id: userId });
  }

  return resolved;
}
