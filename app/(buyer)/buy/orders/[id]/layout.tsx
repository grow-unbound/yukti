import type { Metadata } from 'next';
import { storefrontPageTitle } from '@/lib/server/storefront-metadata';

type LayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

// Static on purpose: the title lookup was a DB read on every open. The client component already
// receives the label in its data payload and sets document.title once that loads.
export function generateMetadata(): Metadata {
  return storefrontPageTitle('Order');
}

export default function OrderDetailLayout({ children }: LayoutProps) {
  return children;
}
