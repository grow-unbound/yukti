import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replaceMock = vi.fn();
const useSearchParamsMock = vi.fn();
const useBuyerMeMock = vi.fn();
const apiFetchMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => useSearchParamsMock(),
}));
vi.mock('@/lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/hooks/useBuyerMe', () => ({ useBuyerMe: () => useBuyerMeMock() }));
const setSessionMock = vi.fn();
vi.mock('@/lib/supabase-browser', () => ({ supabaseBrowser: { auth: { signOut: vi.fn(), setSession: (...args: unknown[]) => setSessionMock(...args) } } }));
vi.mock('@/components/brand/YuktiLogo', () => ({ YuktiLogo: () => null }));

function pendingMe(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
  return {
    data: {
      mode: 'pending',
      tenant: { id: 'tenant-1', name: 'VBS Group' },
      buyer_catalog: {
        id: 'catalog-1',
        pricing_mode: 'base_selling_rate',
        access_mode: 'public_link',
        public_browse_allowed: true,
        collect_target_unit_price_range: false,
      },
      pending: {
        intake_submitted: true,
        self_registered: true,
        access_requested: false,
        seller_whatsapp_number: '9876500000',
        onboarding_status: 'pending_approval',
        ...overrides,
      },
      ...dataOverrides,
    },
    isLoading: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
}

describe('BuyerPendingPage', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    useSearchParamsMock.mockReset();
    useSearchParamsMock.mockReturnValue(new URLSearchParams());
    useBuyerMeMock.mockReset();
    apiFetchMock.mockReset();
    setSessionMock.mockReset();
  });

  it('offers a link to browse the public catalog while approval is pending', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe());
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    const cta = screen.getByRole('link', { name: /browse the public catalog/i });
    expect(cta.getAttribute('href')).toBe('/');
  });

  it('hides the public catalog link for approved-buyers-only catalogs', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe({}, {
      buyer_catalog: {
        id: 'catalog-1',
        pricing_mode: 'base_selling_rate',
        access_mode: 'approved_buyers_only',
        public_browse_allowed: false,
        collect_target_unit_price_range: false,
      },
    }));

    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(screen.queryByRole('link', { name: /browse the public catalog/i })).toBeNull();
  });

  it('sends a pending buyer who has not submitted details to /onboarding first', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe({ intake_submitted: false, self_registered: true }));
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(replaceMock).toHaveBeenCalledWith('/onboarding');
    expect(screen.queryByRole('link', { name: /browse the public catalog/i })).toBeNull();
  });

  it('sends a needs_more_info buyer to the resubmission form instead of the request-sent screen', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe({ onboarding_status: 'needs_more_info' }));
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(replaceMock).toHaveBeenCalledWith('/resubmit-documents');
    expect(screen.queryByText(/request sent/i)).toBeNull();
  });

  it('shows a submitted confirmation instead of bouncing back to resubmission after a successful resubmit', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('resubmitted=1'));
    useBuyerMeMock.mockReturnValue(pendingMe({ onboarding_status: 'needs_more_info' }));
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(replaceMock).not.toHaveBeenCalledWith('/resubmit-documents');
    expect(screen.getAllByText('Details resubmitted').length).toBeGreaterThan(0);
    expect(screen.getByText(/we've sent your updated details to VBS Group/i)).toBeTruthy();
    expect(screen.getByText('Current status')).toBeTruthy();
    expect(screen.getByText('Details received, awaiting seller review')).toBeTruthy();
  });

  it('shows first-intake confirmation with fetched pending status', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('intake_submitted=1'));
    useBuyerMeMock.mockReturnValue(pendingMe({ intake_submitted: false, self_registered: true, onboarding_status: 'pending_approval' }));
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(replaceMock).not.toHaveBeenCalledWith('/onboarding');
    expect(screen.getAllByText('Request sent').length).toBeGreaterThan(0);
    expect(screen.getByText(/we've sent your details to VBS Group/i)).toBeTruthy();
    expect(screen.getByText('Pending approval')).toBeTruthy();
  });
  it('lets an existing buyer with disabled access request it instead of sending them to /onboarding', async () => {
    const me = pendingMe({ intake_submitted: false, self_registered: false, onboarding_status: 'approved' });
    useBuyerMeMock.mockReturnValue(me);
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(replaceMock).not.toHaveBeenCalledWith('/onboarding');
    // The button waits for the account lookup so it never offers the wrong account.
    await waitFor(() => expect((screen.getByRole('button', { name: /request access/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /request access/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/buyer/access/request', { method: 'POST' }));
    await waitFor(() => expect(me.refetch).toHaveBeenCalled());
    expect(replaceMock).toHaveBeenCalledWith('/pending?request_sent=1');
  });

  it('shows an error and keeps the button when the access request fails', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe({ intake_submitted: false, self_registered: false, onboarding_status: 'approved' }));
    apiFetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Failed to send your request. Please try again.' }) });
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    await waitFor(() => expect((screen.getByRole('button', { name: /request access/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /request access/i }));
    expect(await screen.findByText(/failed to send your request/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /request access/i })).toBeTruthy();
  });

  it('shows "Request sent" (no button) once an existing buyer has requested access', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe({ intake_submitted: false, self_registered: false, access_requested: true, onboarding_status: 'approved' }));
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(screen.getByText(/request sent/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /request access/i })).toBeNull();
  });

  describe('account picker', () => {
    const acct = (buyer_id: string, business_name: string, state: string, contact_name: string | null = null) => ({
      buyer_id, business_name, contact_name, state,
    });
    const existingBuyer = { intake_submitted: false, self_registered: false, onboarding_status: 'approved' };

    /** GET accounts -> `accounts`; every other call resolves per `others`. */
    function mockApi(accounts: unknown[], others: (url: string, init?: Record<string, unknown>) => unknown = () => ({ ok: true, json: async () => ({ success: true }) })) {
      apiFetchMock.mockImplementation(async (url: string, init?: Record<string, unknown>) => {
        if (url === '/api/buyer/access/accounts') return { ok: true, json: async () => ({ accounts }) };
        return others(url, init);
      });
    }

    it('shows every account with its status and a "multiple accounts" notice when the phone matches several', async () => {
      useBuyerMeMock.mockReturnValue(pendingMe(existingBuyer));
      mockApi([
        acct('a1', 'Shop Active', 'active'),
        acct('b1', 'Shop Off', 'can_request', 'Ravi'),
        acct('c1', 'Shop Sent', 'requested'),
      ]);
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      expect(await screen.findByText(/we found multiple accounts for this number/i)).toBeTruthy();
      expect(screen.getByText('Shop Active')).toBeTruthy();
      expect(screen.getByText('Active')).toBeTruthy();
      expect(screen.getByText('Access off')).toBeTruthy();
      expect(screen.getByText('Ravi')).toBeTruthy();
      expect(screen.getByText('Request sent')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    });

    it('asks for the account the buyer chose, only after they choose one', async () => {
      useBuyerMeMock.mockReturnValue(pendingMe(existingBuyer));
      mockApi([acct('b1', 'Shop One', 'can_request'), acct('b2', 'Shop Two', 'can_request')]);
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      await screen.findByText(/we found multiple accounts for this number/i);
      const requestButton = screen.getByRole('button', { name: /^request access$/i }) as HTMLButtonElement;
      expect(requestButton.disabled).toBe(true);

      fireEvent.click(screen.getByRole('radio', { name: /shop two/i }));
      expect(requestButton.disabled).toBe(false);
      fireEvent.click(requestButton);

      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/buyer/access/request',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ buyer_id: 'b2' }) }),
      ));
    });

    it('preselects the only switched-off account so one tap requests it', async () => {
      useBuyerMeMock.mockReturnValue(pendingMe(existingBuyer));
      mockApi([acct('a1', 'Shop Active', 'active'), acct('b1', 'Shop Off', 'can_request')]);
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      await screen.findByText(/we found multiple accounts for this number/i);
      const requestButton = screen.getByRole('button', { name: /^request access$/i }) as HTMLButtonElement;
      expect(requestButton.disabled).toBe(false);
    });

    it('opens an enabled account instead of forcing a request', async () => {
      const assign = vi.fn();
      Object.defineProperty(window, 'location', { value: { assign }, writable: true });
      useBuyerMeMock.mockReturnValue(pendingMe(existingBuyer));
      mockApi(
        [acct('a1', 'Shop Active', 'active'), acct('b1', 'Shop Off', 'can_request')],
        (url) => (url === '/api/auth/switch-buyer'
          ? { ok: true, json: async () => ({ session: { access_token: 'a', refresh_token: 'r' } }) }
          : { ok: true, json: async () => ({}) }),
      );
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
      expect(apiFetchMock).toHaveBeenCalledWith('/api/auth/switch-buyer', expect.objectContaining({ body: JSON.stringify({ buyer_id: 'a1' }) }));
      expect(setSessionMock).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' });
    });

    it.each([
      ['needs_more_info', 'Resubmit documents', '/resubmit-documents'],
      ['needs_intake', 'Complete details', '/onboarding'],
    ])('takes a %s sibling to the right form via "%s"', async (state, label, path) => {
      const assign = vi.fn();
      Object.defineProperty(window, 'location', { value: { assign }, writable: true });
      useBuyerMeMock.mockReturnValue(pendingMe(existingBuyer));
      mockApi(
        [acct('b1', 'Shop Off', 'can_request'), acct('s1', 'Shop Sibling', state)],
        (url) => (url === '/api/auth/switch-buyer'
          ? { ok: true, json: async () => ({ session: { access_token: 'a', refresh_token: 'r' } }) }
          : { ok: true, json: async () => ({}) }),
      );
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      fireEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith(path));
    });

    it('shows the plain "Request sent" view when every account has already asked', async () => {
      useBuyerMeMock.mockReturnValue(pendingMe({ ...existingBuyer, access_requested: true }));
      mockApi([acct('c1', 'Shop Sent', 'requested')]);
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/buyer/access/accounts'));
      expect(screen.getByText(/request sent/i)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^request access$/i })).toBeNull();
    });

    it('offers the button again for an account approved before and switched off again', async () => {
      useBuyerMeMock.mockReturnValue(pendingMe({ ...existingBuyer, access_requested: false }));
      mockApi([acct('c1', 'Shop Again', 'can_request')]);
      const { default: BuyerPendingPage } = await import('../../app/pending/page');
      render(<BuyerPendingPage />);

      expect(await screen.findByRole('button', { name: /^request access$/i })).toBeTruthy();
      expect(screen.getByText('Shop Again')).toBeTruthy();
    });
  });

  it('lets a buyer on a declined account open another account of the same phone', async () => {
    useBuyerMeMock.mockReturnValue(pendingMe({ onboarding_status: 'declined', self_registered: false }, { buyer_id: 'own-1' }));
    apiFetchMock.mockImplementation(async (url: string) =>
      url === '/api/buyer/access/accounts'
        ? { ok: true, json: async () => ({ current_buyer_id: 'own-1', accounts: [
            { buyer_id: 'own-1', business_name: 'Declined Shop', contact_name: null, state: 'declined' },
            { buyer_id: 'a1', business_name: 'Other Active Shop', contact_name: null, state: 'active' },
          ] }) }
        : { ok: true, json: async () => ({}) });
    const { default: BuyerPendingPage } = await import('../../app/pending/page');
    render(<BuyerPendingPage />);

    expect(screen.getByText(/access declined/i)).toBeTruthy();
    expect(await screen.findByText('Other accounts for this number')).toBeTruthy();
    expect(screen.getByText('Other Active Shop')).toBeTruthy();
    expect(screen.queryByText('Declined Shop')).toBeNull();
  });
});
