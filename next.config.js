import bundleAnalyzer from '@next/bundle-analyzer';
import { withSentryConfig } from '@sentry/nextjs/config';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['*.localhost'],
  // Turbopack otherwise infers the workspace root by walking up for the
  // nearest lockfile, which picks the wrong directory when this project is
  // checked out as a git worktree alongside a sibling checkout that also has
  // a pnpm-lock.yaml — breaking internal module resolution (e.g. next/font).
  // Pinning to this file's own directory makes it correct from any checkout.
  turbopack: {
    root: __dirname,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Seller layouts (app/(seller)/<entity>/layout.tsx) call headers() via
    // requireSellerServerTenantId(), making them dynamic. Next's default
    // dynamic staleTime is 0, so every client navigation between /<entity>
    // and /<entity>/[id] refetches+remounts the whole layout subtree —
    // including the list component — wiping its local search/filter state
    // even though the URL only changed a leaf segment. Middleware already
    // gates auth on every request (see middleware.ts x-verified-* headers),
    // so caching this dynamic render client-side for a short window doesn't
    // weaken the auth check — it only avoids remounting on same-layout nav.
    staleTimes: {
      dynamic: 30,
    },
    optimizePackageImports: [
      'lucide-react',
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-popover',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toast',
      '@radix-ui/react-tooltip',
    ],
  },
  // Required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.r2.cloudflarestorage.com',
      },
      {
        protocol: 'https',
        hostname: 'assets.yukti.so',
      },
    ],
  },
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_WHATSAPP_PHONE_NUMBER_ID: process.env.NEXT_PUBLIC_WHATSAPP_PHONE_NUMBER_ID,
    NEXT_PUBLIC_ZOHO_DOMAIN: process.env.NEXT_PUBLIC_ZOHO_DOMAIN,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
  // Static header list — evaluated once by Next/Vercel's edge, not per-request app
  // code, so this adds no runtime auth/DB cost. CSP is intentionally permissive on
  // script/style (Next.js hydration + Tailwind/shadcn inline styles need
  // 'unsafe-inline'; 'unsafe-eval' only matters in dev) rather than risk breaking
  // the app — connect-src allowlists Supabase, PostHog (proxied via /ingest, plus
  // the direct ingest hosts as a fallback), Google Maps, and Cloudflare R2.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://maps.googleapis.com https://maps.gstatic.com https://challenges.cloudflare.com https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com https://assets.yukti.so https://maps.gstatic.com https://maps.googleapis.com https://www.facebook.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://us.i.posthog.com https://us-assets.i.posthog.com https://maps.googleapis.com https://places.googleapis.com https://*.r2.cloudflarestorage.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://challenges.cloudflare.com https://graph.facebook.com https://www.facebook.com https://connect.facebook.net",
      "frame-src 'self' https://www.google.com https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/today',
        destination: '/inbox',
        permanent: false,
      },
      {
        source: '/today/:path*',
        destination: '/inbox/:path*',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    // Tenant-scoped guest-ISR routing (plan #4). Deliberately a next.config.js
    // rewrite, NOT a middleware NextResponse.rewrite() — a middleware-computed
    // rewrite defeats Next's Full Route Cache/ISR for the destination
    // (confirmed: vercel/next.js#83862 — Next matches the PRE-rewrite pathname
    // against the dynamic-route regex table to decide cacheability, so a
    // middleware rewrite always falls back to `private, no-store`; verified
    // empirically against this exact route with next build + next start).
    // A config-level rewrite is resolved natively by Next's router before
    // dynamic-route matching, so ISR applies correctly.
    //
    // middleware.ts still owns the auth-dependent decision (see its
    // GUEST_CATALOG_ISR_ENABLED branch in handleTenantHost): for an
    // authenticated buyer, or with the kill switch off, middleware rewrites
    // the pathname to the EXISTING dynamic tree (/buy/home/...) itself,
    // before these rules ever run — so these rules only ever see (and only
    // ever fire for) a pathname middleware deliberately left unmodified,
    // i.e. an already-vetted true-guest request on a live, real tenant host.
    //
    // Suffixes must stay in sync with src/lib/storefront-host.ts's
    // CANONICAL_STOREFRONT_SUFFIX / LEGACY_STOREFRONT_SUFFIX /
    // LOCAL_STOREFRONT_SUFFIX (can't import that .ts module here — this file
    // runs directly under Node, not through Next's bundler).
    const GUEST_ISR_HOST_SUFFIX_PATTERNS = [
      'useyukti\\.in',
      'yukti\\.so',
      'localhost(:\\d+)?', // local dev Host header carries the port
    ];
    const hostHasRule = (suffix) => ({
      type: 'host',
      value: `^(?<slug>[^.]+)\\.${suffix}$`,
    });

    // Home ('/') must be `beforeFiles` — a literal app/page.tsx exists at the
    // root (the app host's own landing page), which would otherwise shadow
    // an `afterFiles` rule for the same source and the rewrite would never
    // fire. The `has: host` condition still scopes this to tenant subdomains
    // only, so app.<domain>'s own root page is completely unaffected.
    const guestIsrHomeRules = GUEST_ISR_HOST_SUFFIX_PATTERNS.map((suffix) => ({
      source: '/',
      has: [hostHasRule(suffix)],
      destination: '/buy/g/:slug/home',
    }));

    // No filesystem collision for these four — safe as `afterFiles`.
    const GUEST_ISR_ID_ROUTES = [
      { source: '/category/:id([^/.]+)', internalSuffix: '/home/category/:id' },
      { source: '/brand/:id([^/.]+)', internalSuffix: '/home/brand/:id' },
      { source: '/list/:id([^/.]+)', internalSuffix: '/home/list/:id' },
      { source: '/family/:id([^/.]+)', internalSuffix: '/family/:id' },
      { source: '/product/:id([^/.]+)', internalSuffix: '/product/:id' },
    ];
    const guestIsrIdRules = GUEST_ISR_HOST_SUFFIX_PATTERNS.flatMap((suffix) =>
      GUEST_ISR_ID_ROUTES.map(({ source, internalSuffix }) => ({
        source,
        has: [hostHasRule(suffix)],
        destination: `/buy/g/:slug${internalSuffix}`,
      })),
    );

    return {
      beforeFiles: guestIsrHomeRules,
      afterFiles: [
        ...guestIsrIdRules,
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/array/:path*',
          destination: 'https://us-assets.i.posthog.com/array/:path*',
        },
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },
      ],
    };
  },
};

// A copy-pasted-but-unfilled .env.local (still holding the literal
// placeholder from .env.example) must not attempt a source map upload or
// release creation — the Sentry CLI would hit the API with a bogus token
// and fail loudly (401) on every local build. `sourcemaps.disable` and
// `release.create: false` are the plugin's own documented switches for
// this — more reliable than trying to unset SENTRY_AUTH_TOKEN from within
// next.config.js, since Next spawns separate workers per build target
// (Node.js/Edge/Client) and each independently re-reads the OS env rather
// than inheriting this module's in-memory mutations.
if (process.env.SENTRY_AUTH_TOKEN === 'your_sentry_auth_token_here') {
  delete process.env.SENTRY_AUTH_TOKEN;
}
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || undefined;

export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: sentryAuthToken,
  // Only upload source maps / create a release when a real token is present
  // (Vercel prod/preview) — keeps local `npm run build` unaffected.
  silent: !sentryAuthToken,
  sourcemaps: { disable: !sentryAuthToken },
  release: { create: !!sentryAuthToken, finalize: !!sentryAuthToken },
  // Default (false) — only uploads source maps for chunks actually referenced
  // by build output, not every emitted file. `true` widens the scan to catch
  // dynamically-loaded chunks Sentry's plugin might otherwise miss, at the
  // cost of scanning/uploading far more files. This app has no such edge
  // case, so leave it narrow — it's the difference between uploading dozens
  // of chunks vs. every .js.map in the output tree.
  widenClientFileUpload: false,
  // No Vercel Cron routes in this repo — automaticVercelMonitors would just
  // be an unused Sentry API call at build time for zero benefit.
  webpack: {
    treeshake: { removeDebugLogging: true },
  },
});
