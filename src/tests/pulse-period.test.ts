import { describe, expect, it } from 'vitest';
import { resolvePulsePeriod, pulsePeriodQuery, PULSE_ACTIVITY_MAX_DAYS } from '@/lib/pulse/period';

// 2026-10-18 10:00 IST
const NOW = new Date('2026-10-18T04:30:00Z');

function resolve(input: Parameters<typeof resolvePulsePeriod>[0], now = NOW) {
  const r = resolvePulsePeriod(input, now);
  if (!r.ok) throw new Error(r.error);
  return r.period;
}

describe('resolvePulsePeriod', () => {
  it('defaults to MTD and compares the same elapsed days of the previous month', () => {
    const p = resolve({});
    expect(p.key).toBe('mtd');
    expect(p.window).toEqual({ from: '2026-10-01', toExcl: '2026-10-19' });
    expect(p.compare).toEqual({ from: '2026-09-01', toExcl: '2026-09-19' });
    expect(p.thin).toBe(false);
  });

  it('caps the MTD compare at the end of a shorter previous month', () => {
    const p = resolve({ period: 'mtd' }, new Date('2026-03-30T05:00:00Z'));
    expect(p.compare).toEqual({ from: '2026-02-01', toExcl: '2026-03-01' });
  });

  it('treats the first days of a month as thin and suppresses compare', () => {
    const p = resolve({ period: 'mtd' }, new Date('2026-11-02T05:00:00Z'));
    expect(p.thin).toBe(true);
    expect(p.compare).toBeNull();
  });

  it('uses the IST date, not UTC, around midnight', () => {
    // 2026-10-31 20:00 UTC is already 2026-11-01 01:30 IST
    const p = resolve({ period: 'mtd' }, new Date('2026-10-31T20:00:00Z'));
    expect(p.window.from).toBe('2026-11-01');
  });

  it('QTD compares the same elapsed days of the previous quarter', () => {
    const p = resolve({ period: 'qtd' });
    expect(p.window).toEqual({ from: '2026-10-01', toExcl: '2026-10-19' });
    expect(p.compare).toEqual({ from: '2026-07-01', toExcl: '2026-07-19' });
  });

  it('rolling presets compare the equal-length window just before', () => {
    expect(resolve({ period: '7d' }).window).toEqual({ from: '2026-10-12', toExcl: '2026-10-19' });
    expect(resolve({ period: '7d' }).compare).toEqual({ from: '2026-10-05', toExcl: '2026-10-12' });
    expect(resolve({ period: 'today' }).compare).toEqual({ from: '2026-10-17', toExcl: '2026-10-18' });
    expect(resolve({ period: '30d' }).days).toBe(30);
  });

  it('last month is the full prior month vs the month before', () => {
    const p = resolve({ period: 'last_month' });
    expect(p.window).toEqual({ from: '2026-09-01', toExcl: '2026-10-01' });
    expect(p.compare).toEqual({ from: '2026-08-01', toExcl: '2026-09-01' });
  });

  it('custom range is inclusive, clamps the end to today and caps length', () => {
    const p = resolve({ period: 'custom', from: '2026-10-01', to: '2026-10-10' });
    expect(p.window).toEqual({ from: '2026-10-01', toExcl: '2026-10-11' });
    expect(p.compare).toEqual({ from: '2026-09-21', toExcl: '2026-10-01' });
    expect(resolve({ period: 'custom', from: '2026-10-01', to: '2027-01-01' }).window.toExcl).toBe('2026-10-19');
    expect(resolvePulsePeriod({ period: 'custom', from: '2025-01-01', to: '2026-10-10' }, NOW)).toEqual({ ok: false, error: 'range_too_long' });
    expect(resolvePulsePeriod({ period: 'custom', from: '2026-10-10', to: '2026-10-01' }, NOW)).toEqual({ ok: false, error: 'invalid_range' });
    expect(resolvePulsePeriod({ period: 'custom', from: 'x', to: 'y' }, NOW)).toEqual({ ok: false, error: 'invalid_range' });
  });

  it('flags windows longer than the activity cap and honours compare=false', () => {
    expect(resolve({ period: 'custom', from: '2026-06-01', to: '2026-10-10' }).activityCapped).toBe(true);
    expect(resolve({ period: '30d' }).activityCapped).toBe(false);
    expect(PULSE_ACTIVITY_MAX_DAYS).toBe(92);
    expect(resolve({ period: '30d', compare: false }).compare).toBeNull();
  });

  it('falls back to MTD for an unknown preset and builds a stable query string', () => {
    expect(resolve({ period: 'bogus' }).key).toBe('mtd');
    expect(pulsePeriodQuery({ period: 'custom', from: '2026-10-01', to: '2026-10-05', compare: false })).toBe('period=custom&from=2026-10-01&to=2026-10-05&cmp=0');
    expect(pulsePeriodQuery({ period: '7d' })).toBe('period=7d');
  });
});
