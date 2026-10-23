'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, apiPost } from '@/lib/api-fetch';
import { NAVIGATION_QUERY_GC_TIME, NAVIGATION_QUERY_STALE_TIME } from '@/lib/query-navigation';

export interface EmailThreadAttachment {
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  scan_status: string;
}

export interface EmailThreadMessage {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  text_body: string;
  at: string;
  sender_verified: boolean;
  attachments: EmailThreadAttachment[];
}

export function useEmailThread(entryId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['inbox-email-thread', entryId],
    enabled,
    queryFn: async () => {
      const res = await apiFetch(`/api/tenant/entries/${entryId}/email-thread`, { fresh: true });
      if (!res.ok) throw new Error('Failed to load email thread');
      return ((await res.json()) as { data: EmailThreadMessage[] }).data;
    },
    staleTime: NAVIGATION_QUERY_STALE_TIME,
    gcTime: NAVIGATION_QUERY_GC_TIME,
    placeholderData: keepPreviousData,
  });
}

/** Marks the sender as a supplier or ignored; the entry resolves and future mail is filtered. */
export function useSetEmailSenderRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, rule }: { entryId: string; rule: 'supplier' | 'ignore' }) => {
      const res = await apiPost(`/api/tenant/entries/${entryId}/email-sender-rule`, { rule });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Failed to save sender rule');
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-entries'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-entry-history'] });
    },
  });
}
