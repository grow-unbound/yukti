'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    // This boundary renders Next's "Application error: a client-side exception
    // has occurred" page. captureException is subject to the `ignoreErrors`
    // filters in instrumentation-client.ts, so a filtered error (e.g. a
    // SecurityError) would leave a user on this page with no Sentry trace.
    // The marker message below carries no original error text, so it always
    // passes those filters; the real error rides along in `extra`.
    Sentry.withScope((scope) => {
      scope.setLevel('fatal');
      scope.setTag('boundary', 'global-error');
      scope.setExtras({
        errorName: error.name,
        errorMessage: error.message?.slice(0, 500),
        digest: error.digest,
        url: typeof window === 'undefined' ? undefined : window.location.href,
      });
      Sentry.captureException(error);
      Sentry.captureMessage('Global error boundary rendered', 'fatal');
    });
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
