import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
  api_host: '/ingest',
  ui_host: 'https://us.posthog.com',
  defaults: '2026-01-30',
  capture_pageview: false,
  // PostHog's own exception capture stays off — Sentry is the error-monitoring
  // system of record (longer retention than Supabase/Vercel's 7-day logs).
  capture_exceptions: false,
  disable_surveys: true,
  debug: process.env.NODE_ENV === 'development',
});

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  // Error-only for now: no tracing (no OpenTelemetry span overhead) and no
  // Session Replay (no DOM-mutation buffering / compression worker running
  // on every session). Both can be turned back on later — this is the
  // lightest-weight config that still captures every exception.
  tracesSampleRate: 0,
  // Host (tenant storefront subdomain) on every event, so a user complaint
  // like "wineyard.<domain> shows an error" can be searched directly.
  initialScope: {
    tags: { host: typeof window === 'undefined' ? undefined : window.location.host },
  },
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
    'AbortError',
    // Next.js App Router control-flow signals (redirect()/notFound()), not errors.
    /^NEXT_REDIRECT/,
    /^NEXT_NOT_FOUND/,
    // Browser denies a permission-gated API call (WebOTP, credential autofill,
    // clipboard, etc.) — user/browser choice, not an app bug.
    'SecurityError',
    // Client-side fetch failing outright (offline, flaky mobile network, DNS) —
    // not actionable server-side; the fetch call site's own error UI handles it.
    'TypeError: network error',
    'TypeError: Failed to fetch',
    'TypeError: NetworkError when attempting to fetch resource.',
    'TypeError: Load failed',
  ],
  denyUrls: [/extensions\//i, /^chrome-extension:\/\//i, /^moz-extension:\/\//i],
  beforeSend(event) {
    if (event.request?.headers) {
      delete event.request.headers['Authorization'];
      delete event.request.headers['Cookie'];
    }
    return event;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
