export type AuthSurface = 'supplier_workspace' | 'buyer_catalog' | 'tenant_buyer_catalog';

export interface AuthSurfaceInfo {
  surface: AuthSurface;
  tenantSlug: string | null;
  sellerLoginHref: string;
  buyerLoginHref: string;
}

const RESERVED_SUBDOMAINS = new Set(['app', 'catalog', 'www']);

function splitHost(host: string): { hostname: string; port: string } {
  const trimmed = host.trim();
  if (!trimmed) return { hostname: '', port: '' };
  const hasIpv6 = trimmed.startsWith('[');
  if (hasIpv6) return { hostname: trimmed, port: '' };
  const [hostname, port = ''] = trimmed.split(':');
  return { hostname: hostname ?? '', port };
}

function withPort(hostname: string, port: string): string {
  return port ? `${hostname}:${port}` : hostname;
}

export function getFirstHostLabel(host: string): string | null {
  const { hostname } = splitHost(host);
  const [first] = hostname.split('.');
  return first || null;
}

export function resolveAuthSurface(host: string, protocol = 'https:'): AuthSurfaceInfo {
  const { hostname, port } = splitHost(host);
  if (!hostname) {
    return {
      surface: 'supplier_workspace',
      tenantSlug: null,
      sellerLoginHref: '/login',
      buyerLoginHref: '/login',
    };
  }
  const labels = hostname.split('.').filter(Boolean);
  const first = labels[0] ?? '';
  const hasSubdomain = labels.length > 1;
  const surface: AuthSurface =
    first === 'app'
      ? 'supplier_workspace'
      : first === 'catalog'
        ? 'buyer_catalog'
        : hasSubdomain && !RESERVED_SUBDOMAINS.has(first)
          ? 'tenant_buyer_catalog'
          : 'supplier_workspace';

  const suffixLabels = hasSubdomain ? labels.slice(1) : labels;
  const suffix = suffixLabels.join('.');
  const sellerHost = suffix ? withPort(`app.${suffix}`, port) : withPort(hostname, port);
  const buyerHost = suffix ? withPort(`catalog.${suffix}`, port) : withPort(hostname, port);

  return {
    surface,
    tenantSlug: surface === 'tenant_buyer_catalog' ? first : null,
    sellerLoginHref: `${protocol}//${sellerHost}/login`,
    buyerLoginHref: `${protocol}//${buyerHost}/login`,
  };
}

export function resolveBrowserAuthSurface(): AuthSurfaceInfo {
  if (typeof window === 'undefined') {
    return resolveAuthSurface('');
  }
  return resolveAuthSurface(window.location.host, window.location.protocol);
}
