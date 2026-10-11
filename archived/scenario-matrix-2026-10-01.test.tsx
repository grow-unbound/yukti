import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let buyerRow: Record<string, unknown> = {};
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: buyerRow, error: null }) }) }),
      }),
    }),
  },
}));
vi.mock('@/lib/auth', () => ({ getBuyerAppContext: vi.fn() }));

const replaceMock = vi.fn();
const useBuyerMeMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock, push: vi.fn() }) }));
vi.mock('@/hooks/useBuyerMe', () => ({ useBuyerMe: () => useBuyerMeMock() }));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/supabase-browser', () => ({ supabaseBrowser: { auth: { signOut: vi.fn() } } }));
vi.mock('@/components/brand/YuktiLogo', () => ({ YuktiLogo: () => null }));

type S = { name: string; cf: Record<string, unknown>; status: string };
const STATES: S[] = [
  { name: 'S1 new self-reg, no intake', cf: { storefront_self_registered: true }, status: 'pending_approval' },
  { name: 'S2 self-reg, intake filed, awaiting', cf: { storefront_self_registered: true, intake_submitted_at: 'x' }, status: 'pending_approval' },
  { name: 'S3 self-reg, intake filed, needs_more_info', cf: { storefront_self_registered: true, intake_submitted_at: 'x' }, status: 'needs_more_info' },
  { name: 'S4 self-reg, NO intake, needs_more_info', cf: { storefront_self_registered: true }, status: 'needs_more_info' },
  { name: 'S5 self-reg, declined', cf: { storefront_self_registered: true, intake_submitted_at: 'x' }, status: 'declined' },
  { name: 'S6 ERP buyer, app off, no request', cf: {}, status: 'approved' },
  { name: 'S7 ERP buyer, request open', cf: { access_requested_at: 'x' }, status: 'approved' },
  { name: 'S8 ERP buyer, request -> needs_more_info', cf: { access_requested_at: 'x' }, status: 'needs_more_info' },
  { name: 'S9 ERP buyer, resubmitted (intake filed), awaiting', cf: { access_requested_at: 'x', intake_submitted_at: 'x' }, status: 'pending_approval' },
  { name: 'S10 ERP buyer, declined', cf: { access_requested_at: 'x' }, status: 'declined' },
  { name: 'S11 ERP buyer, approved earlier then disabled again', cf: { access_requested_at: 'x' }, status: 'approved' },
];

const rows: string[] = [];

describe('scenario matrix', () => {
  beforeEach(() => { replaceMock.mockReset(); });

  for (const s of STATES) {
    it(s.name, async () => {
      buyerRow = { custom_fields: s.cf, onboarding_status: s.status };
      const { resolvePendingBuyerRedirect } = await import('@/lib/server/buyer-access');
      const { pendingBuyerDestination } = await import('@/lib/buyer-pending-destination');
      const server = await resolvePendingBuyerRedirect('b1', true);

      const pending = {
        intake_submitted: Boolean(s.cf.intake_submitted_at),
        self_registered: s.cf.storefront_self_registered === true,
        access_requested: Boolean(s.cf.access_requested_at),
        onboarding_status: s.status,
        seller_whatsapp_number: '9876500000',
      };
      const me = { mode: 'pending', tenant: { name: 'WY' }, buyer_catalog: { public_browse_allowed: true }, pending };
      const shell = pendingBuyerDestination(me as never);

      useBuyerMeMock.mockReturnValue({ data: me, isLoading: false, refetch: vi.fn() });
      const { default: Page } = await import('../../app/pending/page');
      const { container } = render(<Page />);
      const text = container.textContent ?? '';
      const pageBounce = replaceMock.mock.calls.map((c) => c[0]).join(',') || '-';
      const screen = /Access needed/.test(text) ? 'Access needed + [Request access]'
        : /Request sent/.test(text) ? 'Request sent' + (/browse the public catalog/i.test(text) ? ' + [Browse catalog]' : '')
        : /declin/i.test(text) ? 'Declined screen' : container.innerHTML === '' ? '(renders nothing)' : text.slice(0, 40);
      rows.push(`${s.name}\n   server redirect: ${server}\n   BuyerShell dest: ${shell}\n   /pending page:  bounce=${pageBounce} screen=${screen}`);
      expect(true).toBe(true);
    });
  }

  it('print', () => { console.log('\n' + rows.join('\n')); });
});
