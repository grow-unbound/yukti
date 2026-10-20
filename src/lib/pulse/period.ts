// Pulse period math. All dates are IST calendar days as 'YYYY-MM-DD'; windows are half-open [from, toExcl).
// Compare rule (assessment §4): MTD/QTD compare the same elapsed days of the previous month/quarter; every other
// preset compares the equal-length window immediately before. Very early MTD/QTD (< 3 elapsed days) is "thin":
// the delta is suppressed rather than shown against a partial/noisy base.

export type PulsePeriodKey = 'today' | '7d' | '30d' | 'mtd' | 'qtd' | 'last_month' | 'custom';

export const PULSE_PERIOD_KEYS: PulsePeriodKey[] = ['today', '7d', '30d', 'mtd', 'qtd', 'last_month', 'custom'];
export const PULSE_DEFAULT_PERIOD: PulsePeriodKey = 'mtd';
export const PULSE_MAX_WINDOW_DAYS = 366;
/** Activity-heavy bands (funnel strip) cap here; the UI shows a notice instead of silently shrinking. */
export const PULSE_ACTIVITY_MAX_DAYS = 92;
export const PULSE_THIN_ELAPSED_DAYS = 3;

export interface PulseWindow {
  from: string;
  toExcl: string;
}

export interface PulsePeriod {
  key: PulsePeriodKey;
  label: string;
  window: PulseWindow;
  compare: PulseWindow | null;
  days: number;
  /** True for MTD/QTD with fewer than PULSE_THIN_ELAPSED_DAYS elapsed days: compare is suppressed. */
  thin: boolean;
  /** True when the window is longer than the activity cap, so the funnel strip is skipped. */
  activityCapped: boolean;
}

export type PulsePeriodInput = { period?: string | null; from?: string | null; to?: string | null; compare?: boolean };
export type PulsePeriodResult = { ok: true; period: PulsePeriod } | { ok: false; error: string };

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * DAY_MS);
}

export function diffDays(fromDay: string, toDay: string): number {
  return Math.round((parseDay(toDay) - parseDay(fromDay)) / DAY_MS);
}

export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function monthStart(day: string, monthsBack = 0): string {
  const [y, m] = day.split('-').map(Number);
  return formatDay(Date.UTC(y, m - 1 - monthsBack, 1));
}

function quarterStart(day: string, quartersBack = 0): string {
  const [y, m] = day.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) - quartersBack;
  return formatDay(Date.UTC(y, q * 3, 1));
}

function previousSamePeriod(start: string, prevStart: string, elapsedDays: number): PulseWindow {
  // Same elapsed days, but never beyond the end of the previous period.
  const prevEnd = start; // previous period ends where the current one starts
  const toExcl = addDays(prevStart, elapsedDays);
  return { from: prevStart, toExcl: diffDays(toExcl, prevEnd) < 0 ? prevEnd : toExcl };
}

function equalLengthBefore(window: PulseWindow): PulseWindow {
  const len = diffDays(window.from, window.toExcl);
  return { from: addDays(window.from, -len), toExcl: window.from };
}

const LABELS: Record<PulsePeriodKey, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  mtd: 'This month',
  qtd: 'This quarter',
  last_month: 'Last month',
  custom: 'Custom range',
};

export function resolvePulsePeriod(input: PulsePeriodInput = {}, now: Date = new Date()): PulsePeriodResult {
  const key = (PULSE_PERIOD_KEYS as string[]).includes(input.period ?? '') ? (input.period as PulsePeriodKey) : PULSE_DEFAULT_PERIOD;
  const today = istToday(now);
  const tomorrow = addDays(today, 1);
  const wantCompare = input.compare !== false;

  let window: PulseWindow;
  let compare: PulseWindow | null = null;
  let thin = false;

  switch (key) {
    case 'today':
      window = { from: today, toExcl: tomorrow };
      compare = equalLengthBefore(window);
      break;
    case '7d':
      window = { from: addDays(today, -6), toExcl: tomorrow };
      compare = equalLengthBefore(window);
      break;
    case '30d':
      window = { from: addDays(today, -29), toExcl: tomorrow };
      compare = equalLengthBefore(window);
      break;
    case 'mtd': {
      const start = monthStart(today);
      window = { from: start, toExcl: tomorrow };
      const elapsed = diffDays(start, tomorrow);
      thin = elapsed < PULSE_THIN_ELAPSED_DAYS;
      compare = previousSamePeriod(start, monthStart(today, 1), elapsed);
      break;
    }
    case 'qtd': {
      const start = quarterStart(today);
      window = { from: start, toExcl: tomorrow };
      const elapsed = diffDays(start, tomorrow);
      thin = elapsed < PULSE_THIN_ELAPSED_DAYS;
      compare = previousSamePeriod(start, quarterStart(today, 1), elapsed);
      break;
    }
    case 'last_month': {
      const start = monthStart(today);
      window = { from: monthStart(today, 1), toExcl: start };
      compare = { from: monthStart(today, 2), toExcl: monthStart(today, 1) };
      break;
    }
    case 'custom': {
      const from = input.from ?? '';
      const to = input.to ?? '';
      if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return { ok: false, error: 'invalid_range' };
      if (diffDays(from, to) < 0) return { ok: false, error: 'invalid_range' };
      const toExcl = addDays(to > today ? today : to, 1);
      if (diffDays(from, toExcl) <= 0) return { ok: false, error: 'invalid_range' };
      window = { from, toExcl };
      if (diffDays(window.from, window.toExcl) > PULSE_MAX_WINDOW_DAYS) return { ok: false, error: 'range_too_long' };
      compare = equalLengthBefore(window);
      break;
    }
  }

  const days = diffDays(window.from, window.toExcl);
  return {
    ok: true,
    period: {
      key,
      label: LABELS[key],
      window,
      compare: wantCompare && !thin ? compare : null,
      days,
      thin,
      activityCapped: days > PULSE_ACTIVITY_MAX_DAYS,
    },
  };
}

/** Query string for the Pulse API routes / page URL. */
export function pulsePeriodQuery(input: PulsePeriodInput): string {
  const params = new URLSearchParams();
  if (input.period) params.set('period', input.period);
  if (input.period === 'custom' && input.from && input.to) {
    params.set('from', input.from);
    params.set('to', input.to);
  }
  if (input.compare === false) params.set('cmp', '0');
  return params.toString();
}

export function pulsePeriodInputFromSearch(search: URLSearchParams): PulsePeriodInput {
  return {
    period: search.get('period'),
    from: search.get('from'),
    to: search.get('to'),
    compare: search.get('cmp') !== '0',
  };
}
