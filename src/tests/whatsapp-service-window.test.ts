import { describe, expect, it } from 'vitest';

import { getServiceWindowState } from '@/lib/inbox/whatsapp-service-window';

const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe('getServiceWindowState', () => {
  it('shows hours and minutes left with a neutral tone while plenty of time remains', () => {
    const state = getServiceWindowState(at(5 * HOUR + 7 * MIN), NOW);
    expect(state.expired).toBe(false);
    expect(state.label).toBe('Reply window: 5h 7m left');
    expect(state.tone).toBe('neutral');
  });

  it('switches to minutes and a warning tone inside the last two hours', () => {
    const state = getServiceWindowState(at(45 * MIN), NOW);
    expect(state.expired).toBe(false);
    expect(state.label).toBe('Reply window: 45m left');
    expect(state.tone).toBe('warning');
  });

  it('handles the last minute without showing 0m', () => {
    const state = getServiceWindowState(at(30 * 1000), NOW);
    expect(state.expired).toBe(false);
    expect(state.label).toBe('Reply window: Under 1m left');
  });

  it('is closed exactly at expiry and after it', () => {
    for (const offset of [0, -1, -3 * HOUR]) {
      const state = getServiceWindowState(at(offset), NOW);
      expect(state.expired).toBe(true);
      expect(state.label).toBe('Reply window closed');
      expect(state.detail).toContain('closed on');
    }
  });

  it('treats a missing or invalid expiry as unknown and paused, not open', () => {
    for (const value of [null, undefined, '', 'not-a-date']) {
      const state = getServiceWindowState(value, NOW);
      expect(state.expired).toBe(true);
      expect(state.label).toBe('Reply window unknown');
    }
  });
});
