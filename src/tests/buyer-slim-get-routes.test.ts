import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function handlerSource(file: string, method: 'GET' | 'POST'): string {
  const source = readFileSync(join(root, file), 'utf8');
  const start = source.indexOf(`export async function ${method}(`);
  expect(start, `${method} handler in ${file}`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport async function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('buyer read routes use the cached slim profile', () => {
  it.each([
    'app/api/buyer/estimates/route.ts',
    'app/api/buyer/invoices/route.ts',
    'app/api/buyer/orders/route.ts',
    'app/api/buyer/estimates/[id]/route.ts',
    'app/api/buyer/invoices/[id]/route.ts',
    'app/api/buyer/orders/[id]/route.ts',
    'app/api/buyer/nearest-location/route.ts',
  ])('%s GET reads the slim profile', (file) => {
    expect(handlerSource(file, 'GET')).toMatch(/requireBuyerAccessProfile\((request|req), \{ slim: true \}\)/);
  });

  it.each(['app/api/buyer/estimates/route.ts', 'app/api/buyer/orders/route.ts'])(
    '%s POST keeps the live buyer read (a disabled buyer must be cut off immediately on writes)',
    (file) => {
      expect(handlerSource(file, 'POST')).not.toContain('slim: true');
    },
  );
});

describe('catalog route', () => {
  it('echoes the catalog switcher list on the first page only and revalidates via ETag', () => {
    const source = readFileSync(join(root, 'app/api/buyer/catalog/route.ts'), 'utf8');
    expect(source).toContain('...(offset === 0 ? { catalogs: context.catalogs } : {})');
    expect(source).toContain('jsonWithEtag(req,');
  });
});
