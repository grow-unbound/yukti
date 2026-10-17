'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLinkWhatsAppBuyer, useWhatsAppBuyerCandidates } from '@/hooks/useWhatsAppBuyerLink';

const SEARCH_DEBOUNCE_MS = 300;

function roleLabel(role: string | null): string | null {
  if (role === 'buyer_admin') return 'Owner';
  if (role === 'buyer_assistant') return 'Assistant';
  return null;
}

/**
 * Lets a seller say which buyer a WhatsApp sender is when the number matched
 * several buyers (ambiguous) or none (unknown). Linking gives the thread buyer
 * context only; it never enables buyer-app access or financial replies.
 */
export function WhatsAppBuyerLinker({
  entryId,
  resolutionStatus,
}: {
  entryId: string;
  resolutionStatus: 'ambiguous' | 'unknown';
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const candidates = useWhatsAppBuyerCandidates(entryId, debounced, true);
  const link = useLinkWhatsAppBuyer();

  async function onLink(buyerId: string, name: string) {
    try {
      await link.mutateAsync({ entryId, buyerId });
      toast.success(`Linked to ${name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not link buyer');
    }
  }

  const ambiguous = candidates.data?.ambiguous ?? [];
  const results = candidates.data?.results ?? [];

  return (
    <div className="space-y-3 rounded-[10px] border border-cream-200 bg-white p-3">
      <div>
        <p className="text-sm font-semibold text-cream-900">
          {resolutionStatus === 'ambiguous' ? 'Which buyer is this?' : 'Link this number to a buyer'}
        </p>
        <p className="mt-0.5 text-xs text-cream-600">
          {resolutionStatus === 'ambiguous'
            ? 'This number matches more than one buyer. Pick the right one so the right context is shown.'
            : "We don't recognise this number yet. Link it to an existing buyer, or just reply without linking."}
        </p>
      </div>

      {ambiguous.length > 0 ? (
        <ul className="space-y-1.5">
          {ambiguous.map((candidate) => (
            <li key={candidate.buyer_id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-cream-900">
                {candidate.business_name}
                {roleLabel(candidate.role) ? <span className="text-cream-500"> · {roleLabel(candidate.role)}</span> : null}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={link.isPending}
                onClick={() => void onLink(candidate.buyer_id, candidate.business_name)}
              >
                Link
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Input
        label="Find a buyer"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Business name, contact or phone"
      />
      {debounced.length >= 2 ? (
        results.length > 0 ? (
          <ul className="space-y-1.5">
            {results.map((buyer) => (
              <li key={buyer.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-cream-900">
                  {buyer.business_name}
                  {buyer.phone ? <span className="font-mono text-cream-500"> · {buyer.phone}</span> : null}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={link.isPending}
                  onClick={() => void onLink(buyer.id, buyer.business_name)}
                >
                  Link
                </Button>
              </li>
            ))}
          </ul>
        ) : candidates.isFetching ? null : (
          <p className="text-xs text-cream-600">No buyers match "{debounced}".</p>
        )
      ) : null}
    </div>
  );
}
