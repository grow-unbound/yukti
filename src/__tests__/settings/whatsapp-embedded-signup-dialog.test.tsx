import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiPostMock } = vi.hoisted(() => ({ apiPostMock: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
}));

import { WhatsAppEmbeddedSignupDialog } from '@/components/seller/settings/WhatsAppEmbeddedSignupDialog';

const loginMock = vi.fn();

function renderDialog() {
  return render(
    <WhatsAppEmbeddedSignupDialog
      open
      onOpenChange={vi.fn()}
      metaAppId="meta-app-id"
      configId="embedded-signup-config-id"
      onConnected={vi.fn()}
    />,
  );
}

async function startSignup() {
  renderDialog();
  const continueButton = screen.getByRole('button', { name: 'Continue with Facebook' });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(continueButton).toBeEnabled());
  fireEvent.click(continueButton);
  expect(loginMock).toHaveBeenCalledTimes(1);
  return loginMock.mock.calls[0][0] as (response: { authResponse?: { code?: string } }) => void;
}

function sendSignupMessage(origin: string, event: string, data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', {
    origin,
    data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data }),
  }));
}

describe('WhatsAppEmbeddedSignupDialog', () => {
  beforeEach(() => {
    loginMock.mockReset();
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Test stopped after request capture' } }),
    });
    window.FB = {
      init: vi.fn(),
      login: loginMock,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.FB;
  });

  it('moves to PIN entry when the OAuth code arrives and keeps accepting session data', async () => {
    const loginCallback = await startSignup();

    expect(loginMock.mock.calls[0][1]).toMatchObject({
      config_id: 'embedded-signup-config-id',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    });

    act(() => loginCallback({ authResponse: { code: 'oauth-code' } }));
    expect(await screen.findByLabelText('6-digit PIN')).toBeInTheDocument();

    act(() => sendSignupMessage('https://web.facebook.com', 'FINISH', {
      waba_id: 'waba-id',
      phone_number_id: 'phone-id',
      business_id: 'business-id',
    }));

    expect(screen.queryByText(/did not return a business account/i)).not.toBeInTheDocument();
  });

  it('waits for the OAuth code when a finish variant arrives first', async () => {
    const loginCallback = await startSignup();

    act(() => sendSignupMessage('https://www.facebook.com', 'FINISH_CLOUD_API_ONBOARDING', {
      waba_id: 'waba-id',
      phone_number_id: 'phone-id',
      businessId: 'business-id',
    }));
    expect(screen.getByText('Waiting for Facebook login to complete…')).toBeInTheDocument();

    act(() => loginCallback({ authResponse: { code: 'oauth-code' } }));

    expect(await screen.findByLabelText('6-digit PIN')).toBeInTheDocument();
  });

  it('ignores embedded-signup messages from untrusted origins', async () => {
    const loginCallback = await startSignup();

    act(() => sendSignupMessage('https://facebook.com.example.test', 'FINISH', {
      waba_id: 'attacker-waba-id',
      phone_number_id: 'attacker-phone-id',
    }));

    act(() => sendSignupMessage('https://www.facebook.com', 'FINISH', {
      waba_id: 'waba-id',
      phone_number_id: 'phone-id',
    }));
    act(() => loginCallback({ authResponse: { code: 'oauth-code' } }));

    expect(await screen.findByLabelText('6-digit PIN')).toBeInTheDocument();
  });

  it('continues with server-side asset discovery when Meta only returns the OAuth code', async () => {
    const loginCallback = await startSignup();

    act(() => loginCallback({ authResponse: { code: 'oauth-code' } }));

    expect(await screen.findByLabelText('6-digit PIN')).toBeInTheDocument();
    expect(screen.queryByText(/did not return a business account/i)).not.toBeInTheDocument();
  });

  it('does not silently choose the first WABA when Meta returns multiple account IDs', async () => {
    const loginCallback = await startSignup();
    act(() => sendSignupMessage('https://www.facebook.com', 'FINISH', {
      waba_ids: ['waba-1', 'waba-2'],
    }));
    act(() => loginCallback({ authResponse: { code: 'oauth-code' } }));

    fireEvent.change(await screen.findByLabelText('6-digit PIN'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/api/settings/integrations/whatsapp/oauth/callback',
      expect.objectContaining({ code: 'oauth-code', waba_id: '', phone_number_id: '' }),
    ));
  });

  it('shows the error returned by Meta and ends the attempt', async () => {
    await startSignup();

    act(() => sendSignupMessage('https://www.facebook.com', 'ERROR', {
      error_message: 'This phone number cannot be connected.',
    }));

    expect(await screen.findByText('This phone number cannot be connected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Facebook' })).toBeInTheDocument();
  });

  it('recovers when Meta never returns a callback or session event', async () => {
    renderDialog();
    const continueButton = screen.getByRole('button', { name: 'Continue with Facebook' });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(continueButton).toBeEnabled());

    vi.useFakeTimers();
    fireEvent.click(continueButton);
    act(() => vi.advanceTimersByTime(120_000));

    expect(screen.getByText(/Facebook login did not complete/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Facebook' })).toBeInTheDocument();
  });
});
