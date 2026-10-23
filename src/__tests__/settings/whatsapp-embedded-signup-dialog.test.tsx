import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    window.FB = {
      init: vi.fn(),
      login: loginMock,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.FB;
  });

  it('waits for the session event when the OAuth code arrives first', async () => {
    const loginCallback = await startSignup();

    expect(loginMock.mock.calls[0][1]).toMatchObject({
      config_id: 'embedded-signup-config-id',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: '3' },
    });

    act(() => loginCallback({ authResponse: { code: 'oauth-code' } }));
    expect(screen.getByText('Waiting for Facebook login to complete…')).toBeInTheDocument();

    act(() => sendSignupMessage('https://web.facebook.com', 'FINISH', {
      waba_id: 'waba-id',
      phone_number_id: 'phone-id',
      business_id: 'business-id',
    }));

    expect(await screen.findByLabelText('6-digit PIN')).toBeInTheDocument();
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

    act(() => {
      loginCallback({ authResponse: { code: 'oauth-code' } });
      sendSignupMessage('https://facebook.com.example.test', 'FINISH', {
        waba_id: 'attacker-waba-id',
        phone_number_id: 'attacker-phone-id',
      });
    });

    expect(screen.queryByLabelText('6-digit PIN')).not.toBeInTheDocument();

    act(() => sendSignupMessage('https://www.facebook.com', 'FINISH', {
      waba_id: 'waba-id',
      phone_number_id: 'phone-id',
    }));

    expect(await screen.findByLabelText('6-digit PIN')).toBeInTheDocument();
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
