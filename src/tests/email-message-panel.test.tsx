import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useEmailThreadMock = vi.fn();
const setRuleMock = vi.fn();

vi.mock('@/hooks/useEmailInbox', () => ({
  useEmailThread: (...args: unknown[]) => useEmailThreadMock(...args),
  useSetEmailSenderRule: () => ({ mutateAsync: setRuleMock, isPending: false }),
}));
vi.mock('@/components/seller/inbox/WhatsAppBuyerLinker', () => ({
  WhatsAppBuyerLinker: ({ channel, resolutionStatus }: { channel?: string; resolutionStatus: string }) => (
    <div data-testid="linker">{`${channel}:${resolutionStatus}`}</div>
  ),
}));

import { EmailMessagePanel } from '@/components/seller/inbox/EmailMessagePanel';
import type { InboxEntry } from '@/lib/inbox/inbox-types';

function entry(metadata: Record<string, unknown>, overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'e1',
    buyer_id: null,
    buyer_name: 'Unknown customer',
    entry_type: 'email_buyer_message',
    metadata,
    ...overrides,
  } as unknown as InboxEntry;
}

const message = {
  id: 'm1',
  from_address: 'buyer@example.test',
  from_name: 'Buyer',
  subject: 'Need 10 pcs',
  text_body: '<script>alert(1)</script> please quote',
  at: '2026-10-23T10:00:00.000Z',
  sender_verified: false,
  attachments: [
    { filename: 'po.pdf', mime_type: 'application/pdf', size_bytes: 2048, scan_status: 'skipped' },
    { filename: 'run.exe', mime_type: null, size_bytes: 10, scan_status: 'blocked' },
  ],
};

describe('EmailMessagePanel', () => {
  beforeEach(() => {
    useEmailThreadMock.mockReset();
    setRuleMock.mockReset();
  });

  it('shows unknown sender with the email linker and supplier/ignore actions', () => {
    useEmailThreadMock.mockReturnValue({ data: [message], isLoading: false, isError: false });
    render(<EmailMessagePanel entry={entry({ resolution_status: 'unknown', sender_address: 'buyer@example.test', auth_verified: false })} />);
    expect(screen.getByText('Unknown sender')).toBeTruthy();
    expect(screen.getByText('Sender not verified')).toBeTruthy();
    expect(screen.getByTestId('linker').textContent).toBe('email:unknown');
    expect(screen.getByText('Mark as supplier')).toBeTruthy();
    expect(screen.getByText('Ignore sender')).toBeTruthy();
  });

  it('renders bodies as inert text and offers no attachment download', () => {
    useEmailThreadMock.mockReturnValue({ data: [message], isLoading: false, isError: false });
    const { container } = render(<EmailMessagePanel entry={entry({ resolution_status: 'unknown' })} />);
    expect(screen.getByText(/please quote/).textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
    expect(screen.getByText('po.pdf')).toBeTruthy();
    expect(screen.getByText(/blocked/)).toBeTruthy();
    expect(screen.getByText(/not downloadable yet/)).toBeTruthy();
  });

  it('hides the linker once the sender is matched and shows the verified pill', () => {
    useEmailThreadMock.mockReturnValue({ data: [message], isLoading: false, isError: false });
    render(
      <EmailMessagePanel
        entry={entry({ resolution_status: 'matched', auth_verified: true, sender_address: 'buyer@example.test' }, { buyer_id: 'b1', buyer_name: 'Alpha Traders' })}
      />,
    );
    expect(screen.getByText('Matched customer')).toBeTruthy();
    expect(screen.getByText('Sender verified')).toBeTruthy();
    expect(screen.getByText('Alpha Traders')).toBeTruthy();
    expect(screen.queryByTestId('linker')).toBeNull();
  });

  it('shows a calm error state when the thread fails to load', () => {
    useEmailThreadMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<EmailMessagePanel entry={entry({ resolution_status: 'ambiguous' })} />);
    expect(screen.getByText(/Couldn.t load this email thread/)).toBeTruthy();
    expect(screen.getByTestId('linker').textContent).toBe('email:ambiguous');
  });
});
