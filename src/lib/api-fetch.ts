'use client';

import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import type { Database } from '@/types/database';

async function getAuthHeaders(): Promise<Record<string, string>> {
  const supabase = createClientComponentClient<Database>();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetch(url, {
    ...init,
    headers: {
      ...authHeaders,
      ...init?.headers,
    },
  });
}

export async function apiPost<T>(url: string, body: T, init?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetch(url, {
    method: 'POST',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function apiPatch<T>(url: string, body: T, init?: RequestInit): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  return fetch(url, {
    method: 'PATCH',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...init?.headers,
    },
    body: JSON.stringify(body),
  });
}
