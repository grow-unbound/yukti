import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
const pushMock = vi.fn();
const replaceMock = vi.fn();
const setSessionMock = vi.fn().mockResolvedValue({});
const useBuyerMeMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useBuyerMe', () => ({
  useBuyerMe: () => useBuyerMeMock(),
}));

vi.mock('@/lib/supabase-browser', () => ({
  supabaseBrowser: { auth: { setSession: (...args: unknown[]) => setSessionMock(...args) } },
}));

vi.mock('@/lib/auth-device-login', () => ({
  markLoggedInOnDevice: vi.fn(),
}));

vi.mock('@/components/brand/YuktiLogo', () => ({
  YuktiLogo: () => <div data-testid="logo" />,
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

const RESUBMISSION_DATA = {
  missing_fields: ['contact_name', 'address'],
  profile: {
    full_name: 'Old Name',
    email: '',
    is_business: true,
    business_name: 'Acme Traders',
    gstin: '29AAVIC9992H1Z0',
    phone: '9990000001',
    address_line1: '1 Old Street',
    address_line2: '',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
  },
  documents: { shop_image_id: 'doc-shop-1', gst_certificate_id: 'doc-gst-1' },
};

describe('/resubmit-documents page', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
    setSessionMock.mockClear();
    useBuyerMeMock.mockReset();
    useBuyerMeMock.mockReturnValue({
      data: {
        mode: 'pending',
        tenant: { id: 'tenant-1', name: 'VBS Group' },
        pending: { seller_whatsapp_number: '9876500000' },
      },
      isLoading: false,
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/buyer/onboarding/resubmission-profile') {
        return Promise.resolve(jsonResponse(RESUBMISSION_DATA));
      }
      if (url === '/api/buyer/onboarding/intake') {
        return Promise.resolve(jsonResponse({ success: true }));
      }
      return Promise.resolve(jsonResponse({}));
    });
  });

  it('always starts on the phone step, never trusting an existing session', async () => {
    const { default: ResubmitDocumentsPage } = await import('../../app/resubmit-documents/page');
    render(<ResubmitDocumentsPage />);
    expect(await screen.findByText('Verify your number')).toBeInTheDocument();
    // The resubmission-profile fetch must NOT happen before OTP is verified.
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/buyer/onboarding/resubmission-profile');
  });

  it('goes phone -> otp -> form only after a real verify() success, and pre-fills with only flagged fields editable', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/phone-otp/send') {
        return Promise.resolve(jsonResponse({ registered: true, ref_id: 'ref-1', outcome: 'otp_sent' }));
      }
      if (url === '/api/auth/phone-otp/verify') {
        return Promise.resolve(
          jsonResponse({
            success: true,
            session: { access_token: 'at', refresh_token: 'rt' },
            redirect: '/pending',
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { default: ResubmitDocumentsPage } = await import('../../app/resubmit-documents/page');
    render(<ResubmitDocumentsPage />);

    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9990000001' } });
    fireEvent.click(screen.getByText('Send OTP'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/phone-otp/send',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('Enter OTP')).toBeInTheDocument();

    const digitInputs = screen.getAllByRole('textbox').filter((el) => el.getAttribute('maxlength') === '1');
    expect(digitInputs).toHaveLength(6);
    '123456'.split('').forEach((digit, i) => {
      fireEvent.change(digitInputs[i], { target: { value: digit } });
    });
    fireEvent.click(screen.getByText('Verify OTP'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/phone-otp/verify',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Session must be set from the verify response before showing the form.
    await waitFor(() => {
      expect(setSessionMock).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' });
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/buyer/onboarding/resubmission-profile');
    });

    expect(await screen.findByText('A few things need fixing')).toBeInTheDocument();

    // Flagged field (contact_name) is editable and pre-filled.
    const fullNameInput = screen.getByLabelText(/Full name/) as HTMLInputElement;
    expect(fullNameInput.value).toBe('Old Name');
    expect(fullNameInput).not.toBeDisabled();

    // Non-flagged field (business_name / gstin) renders read-only with existing value.
    const businessNameInput = screen.getByLabelText(/Business name/) as HTMLInputElement;
    expect(businessNameInput.value).toBe('Acme Traders');
    expect(businessNameInput).toBeDisabled();

    const gstinInput = screen.getByLabelText(/^GSTIN/) as HTMLInputElement;
    expect(gstinInput).toBeDisabled();

    // Flagged group (address) is editable.
    const addressLine1Input = screen.getByLabelText('Address line 1') as HTMLInputElement;
    expect(addressLine1Input.value).toBe('1 Old Street');
    expect(addressLine1Input).not.toBeDisabled();

    // Document fields not flagged in missing_fields must not render at all.
    expect(screen.queryByText(/Shop image/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GST certificate/)).not.toBeInTheDocument();

    global.fetch = originalFetch;
  });

  it('shows "nothing to resubmit" when the profile route 404s (no missing_fields to act on)', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/phone-otp/send') {
        return Promise.resolve(jsonResponse({ registered: true, ref_id: 'ref-1', outcome: 'otp_sent' }));
      }
      if (url === '/api/auth/phone-otp/verify') {
        return Promise.resolve(
          jsonResponse({ success: true, session: { access_token: 'at', refresh_token: 'rt' }, redirect: '/pending' }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/buyer/onboarding/resubmission-profile') {
        return Promise.resolve(jsonResponse({ error: 'Not found' }, false, 404));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { default: ResubmitDocumentsPage } = await import('../../app/resubmit-documents/page');
    render(<ResubmitDocumentsPage />);

    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9990000001' } });
    fireEvent.click(screen.getByText('Send OTP'));
    await screen.findByText('Enter OTP');

    const digitInputs = screen.getAllByRole('textbox').filter((el) => el.getAttribute('maxlength') === '1');
    '123456'.split('').forEach((digit, i) => {
      fireEvent.change(digitInputs[i], { target: { value: digit } });
    });
    fireEvent.click(screen.getByText('Verify OTP'));

    expect(await screen.findByText('Nothing to resubmit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /contact VBS Group on WhatsApp/i })).toBeInTheDocument();

    global.fetch = originalFetch;
  });

  it('shows a WhatsApp contact CTA for buyer questions', async () => {
    const openMock = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(openMock);

    const { default: ResubmitDocumentsPage } = await import('../../app/resubmit-documents/page');
    render(<ResubmitDocumentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /contact VBS Group on WhatsApp/i }));

    expect(openMock).toHaveBeenCalledWith(
      expect.stringContaining('phone=919876500000'),
      '_blank',
      'noopener,noreferrer',
    );
  });
});
