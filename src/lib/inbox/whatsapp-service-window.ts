export type ServiceWindowTone = 'neutral' | 'warning';

export interface ServiceWindowState {
  /** True when a free-form reply is not allowed (closed or unknown). */
  expired: boolean;
  /** Short pill text. */
  label: string;
  /** One sentence for the composer area. */
  detail: string;
  tone: ServiceWindowTone;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Under this much time left, the pill switches to a warning tone. */
const CLOSING_SOON_MS = 2 * HOUR_MS;

function formatClosedAt(expiry: number): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(expiry));
}

/**
 * Customer-service window state for a WhatsApp thread. WhatsApp only allows
 * free-form replies within 24 hours of the buyer's last message; afterwards only
 * approved templates (not available in the inbox yet) can be sent.
 */
export function getServiceWindowState(expiresAt: string | null | undefined, now: number = Date.now()): ServiceWindowState {
  const expiry = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  if (!Number.isFinite(expiry)) {
    return {
      expired: true,
      label: 'Reply window unknown',
      detail: "We can't confirm the 24-hour reply window for this chat, so replies are paused.",
      tone: 'warning',
    };
  }

  const remaining = expiry - now;
  if (remaining <= 0) {
    return {
      expired: true,
      label: 'Reply window closed',
      detail: `The 24-hour reply window closed on ${formatClosedAt(expiry)}. You can reply again once the buyer messages you; template replies are not available yet.`,
      tone: 'warning',
    };
  }

  const hours = Math.floor(remaining / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  const left = hours >= 1 ? `${hours}h ${minutes}m left` : minutes >= 1 ? `${minutes}m left` : 'Under 1m left';
  return {
    expired: false,
    label: `Reply window: ${left}`,
    detail: `You can reply freely for ${hours >= 1 ? `${hours}h ${minutes}m` : minutes >= 1 ? `${minutes}m` : 'less than a minute'} more.`,
    tone: remaining <= CLOSING_SOON_MS ? 'warning' : 'neutral',
  };
}
