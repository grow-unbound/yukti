import type { Metadata } from 'next';
import { Baloo_2, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { TenantProvider } from '@/contexts/TenantContext';
import { PostHogProvider } from '@/components/providers/PostHogProvider';
import { PostHogRouteCapture } from '@/components/providers/PostHogRouteCapture';
import { ReactQueryProvider } from '@/components/providers/ReactQueryProvider';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600', '700', '800'],
  display: 'optional',
  fallback: ['system-ui', 'arial'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
  display: 'optional',
  fallback: ['ui-monospace', 'monospace'],
});

const baloo2 = Baloo_2({
  subsets: ['latin'],
  variable: '--font-wordmark',
  weight: ['600'],
  display: 'optional',
  fallback: ['system-ui', 'arial'],
});

export const metadata: Metadata = {
  title: {
    default: 'Yukti | Distributor Command Center',
    template: '%s | Yukti',
  },
  description: 'Manage multibrand catalogs, publish cohort pricing, capture orders.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/favicon.svg', type: 'image/svg+xml' },
      { url: '/brand/app-icon-dark.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/brand/favicon.svg',
    apple: '/brand/app-icon-light.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${baloo2.variable}`}>
      <body>
        <PostHogProvider>
          <ReactQueryProvider>
            <AuthProvider>
              <TenantProvider>
                <PostHogRouteCapture />
                {children}
              </TenantProvider>
            </AuthProvider>
          </ReactQueryProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
