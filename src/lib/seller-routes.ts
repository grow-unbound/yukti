export const SELLER_ROUTES = {
  today: '/inbox',
  pulse: '/pulse',
  sales: {
    root: '/sales',
    invoices: '/sales/invoices',
    orders: '/sales/orders',
    estimates: '/sales/estimates',
  },
  products: {
    root: '/products',
    brands: '/products/brands',
    categories: '/products/categories',
  },
  market: {
    catalogs: '/catalog',
    campaigns: '/campaigns',
    announcements: '/announcements',
    pricing: '/pricing',
    customerGroups: '/customer-groups',
    recommendations: '/recommendations',
  },
  business: {
    root: '/business',
    branches: '/business/branches',
    warehouses: '/business/warehouses',
    team: '/business/team',
  },
  settings: {
    general: '/settings',
    integrations: '/settings/integrations',
    billing: '/settings/billing',
  },
} as const;

export function isSalesPath(pathname: string) {
  return pathname.startsWith('/sales/')
    || pathname.startsWith('/estimates')
    || pathname.startsWith('/sales-orders')
    || pathname.startsWith('/invoices');
}

export function isProductsWorkspacePath(pathname: string) {
  return pathname === '/products'
    || pathname.startsWith('/products/')
    || pathname.startsWith('/brands')
    || pathname.startsWith('/categories');
}

export function isBusinessPath(pathname: string) {
  return pathname.startsWith('/business/')
    || pathname.startsWith('/locations')
    || pathname.startsWith('/warehouses')
    || pathname.startsWith('/settings/team');
}

export function isSettingsPath(pathname: string) {
  return pathname === '/settings'
    || pathname.startsWith('/settings/integrations')
    || pathname.startsWith('/settings/billing');
}
