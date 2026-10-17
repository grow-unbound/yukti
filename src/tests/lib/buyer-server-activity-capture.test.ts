import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureMock = vi.fn();
const flushMock = vi.fn(() => Promise.resolve());

vi.mock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture: captureMock, flush: flushMock }),
}));

import { captureBuyerServerActivity } from '@/lib/server/buyer-posthog-events';

const req = (headers: Record<string, string> = {}) => ({ headers: new Headers(headers) }) as never;

describe('captureBuyerServerActivity', () => {
  beforeEach(() => {
    captureMock.mockClear();
    flushMock.mockClear();
  });

  it('captures session_started with server-resolved role and personless fallback', () => {
    captureBuyerServerActivity({ event: 'session_started', tenantId: 't1', buyerId: 'b1', role: 'buyer_admin', path: '/api/x' });
    const arg = captureMock.mock.calls[0][0];
    expect(arg.event).toBe('session_started');
    expect(arg.distinctId).toBe('b1');
    expect(arg.properties).toMatchObject({ tenant_id: 't1', buyer_id: 'b1', role: 'buyer_admin', source: 'server', $process_person_profile: false });
  });

  it('reuses the browser distinct id and keeps the person profile when provided', () => {
    captureBuyerServerActivity({ request: req({ 'x-posthog-distinct-id': 'browser-1' }), event: 'session_started', tenantId: 't1', buyerId: 'b1' });
    const arg = captureMock.mock.calls[0][0];
    expect(arg.distinctId).toBe('browser-1');
    expect(arg.properties.$process_person_profile).toBeUndefined();
  });

  it('throttles catalog_viewed per buyer within 30 minutes but not session_started', () => {
    const p = { tenantId: 'tt', buyerId: 'bb', role: 'buyer_assistant' };
    captureBuyerServerActivity({ ...p, event: 'catalog_viewed' });
    captureBuyerServerActivity({ ...p, event: 'catalog_viewed' });
    captureBuyerServerActivity({ ...p, event: 'session_started' });
    captureBuyerServerActivity({ ...p, event: 'session_started' });
    expect(captureMock.mock.calls.map((c) => c[0].event)).toEqual(['catalog_viewed', 'session_started', 'session_started']);
  });

  it('never throws when PostHog fails', () => {
    captureMock.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => captureBuyerServerActivity({ event: 'session_started', tenantId: 't', buyerId: 'b' })).not.toThrow();
  });
});
