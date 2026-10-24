import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

import {
  attachParentContactId,
  createZohoAdapter,
  getZohoPhasePlan,
} from '../../../supabase/functions/_shared/integrations-zoho';

describe('zoho transactional sync windowing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the request-path contact id to scoped contact-person records', () => {
    expect(attachParentContactId([
      { contact_person_id: 'CP-1', first_name: 'Asha' },
      { contact_person_id: 'CP-2', contact_id: 'CUST-PROVIDER' },
    ], 'CUST-PATH')).toEqual([
      { contact_person_id: 'CP-1', first_name: 'Asha', contact_id: 'CUST-PATH' },
      { contact_person_id: 'CP-2', contact_id: 'CUST-PROVIDER' },
    ]);
  });

  it('keeps estimates, orders, and invoices in the transactional phase plan', () => {
    const phaseIds = getZohoPhasePlan('zoho_books', 'transactional').map((phase) => phase.id);

    expect(phaseIds).toEqual(['estimates', 'orders', 'invoices']);
  });

  it('runs transaction line-item hydration after invoices in the orchestrator transaction group', () => {
    const orchestratorSource = readFileSync('src/lib/integrations/sync-orchestration.ts', 'utf8');
    // dispatchPhase (the transaction_line_items -> sync-transaction-line-items
    // function-name mapping) lives in sync-coordinator-actions.ts; sinceForPhase
    // is now called from sync-coordinator's dispatch_next_phase action, since
    // integrations-sync no longer precreates/dispatches any phase itself.
    const dispatchSource = readFileSync('supabase/functions/_shared/sync-coordinator-actions.ts', 'utf8');
    const coordinatorSource = readFileSync('supabase/functions/sync-coordinator/index.ts', 'utf8');
    const syncFnSource = readFileSync('supabase/functions/integrations-sync/index.ts', 'utf8');

    expect(orchestratorSource).toContain("export const TRANSACTIONAL_PHASES = [");
    expect(orchestratorSource).toContain("'transaction_line_items'");
    expect(orchestratorSource).toContain("transactional: TRANSACTIONAL_PHASES");
    expect(dispatchSource).toContain("transaction_line_items: 'sync-transaction-line-items'");
    expect(coordinatorSource).toContain('sinceForPhase');
    expect(syncFnSource).toContain('sync_run_id');
  });

  it('scopes line-item hydration to the same transaction date window', () => {
    const source = readFileSync('supabase/functions/sync-transaction-line-items/index.ts', 'utf8');

    expect(source).toContain("since_date: opts.sinceDate ?? null");
    expect(source).toContain("query.gte(dateColumn, sinceDate)");
    expect(source).toContain("estimate_date");
    expect(source).toContain("order_date");
    expect(source).toContain("invoice_date");
  });

  it.each([
    ['estimates', 'estimates'],
    ['orders', 'salesorders'],
    ['invoices', 'invoices'],
  ] as const)('passes the selected since window through to %s sync requests', async (phaseId, itemKey) => {
    const seenUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      seenUrls.push(url);

      if (url.pathname.includes('/oauth/v2/token')) {
        return new Response(JSON.stringify({ access_token: 'token-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        [itemKey]: [],
        page_context: { has_more_page: false },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const adapter = createZohoAdapter('zoho_books', {
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'refresh-token',
      organization_id: 'org-1',
      accounts_base_url: 'https://accounts.zoho.in',
      api_base_url: 'https://www.zohoapis.in/books/v3',
    });

    const phase = getZohoPhasePlan('zoho_books', 'transactional').find((entry) => entry.id === phaseId);
    expect(phase).toBeTruthy();
    if (!phase) return;

    await adapter.fetchPhasePage(phase, null, '2026-06-01');

    const dataRequest = seenUrls.find((url) => !url.pathname.includes('/oauth/v2/token'));
    expect(dataRequest).toBeTruthy();
    expect(dataRequest?.searchParams.get('date_start')).toBe('2026-06-01');
  });

  it('normalizes Postgres timestamptz since values to YYYY-MM-DD for date_start', async () => {
    const seenUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      seenUrls.push(url);

      if (url.pathname.includes('/oauth/v2/token')) {
        return new Response(JSON.stringify({ access_token: 'token-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        invoices: [],
        page_context: { has_more_page: false },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const adapter = createZohoAdapter('zoho_books', {
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'refresh-token',
      organization_id: 'org-1',
      accounts_base_url: 'https://accounts.zoho.in',
      api_base_url: 'https://www.zohoapis.in/books/v3',
    });

    const phase = getZohoPhasePlan('zoho_books', 'transactional').find((entry) => entry.id === 'invoices');
    expect(phase).toBeTruthy();
    if (!phase) return;

    await adapter.fetchPhasePage(phase, null, '2026-07-02 00:00:00+00', 'incremental');

    const dataRequest = seenUrls.find((url) => !url.pathname.includes('/oauth/v2/token'));
    expect(dataRequest?.searchParams.get('date_start')).toBe('2026-07-02');
  });

  it.each([
    ['fetchEstimateById', 'estimate', '/books/v3/estimates/EST-1', 'EST-1'],
    ['fetchSalesOrderById', 'salesorder', '/books/v3/salesorders/SO-1', 'SO-1'],
    ['fetchInvoiceById', 'invoice', '/books/v3/invoices/INV-1', 'INV-1'],
  ] as const)('fetches Zoho transaction details via %s', async (methodName, responseKey, expectedPath, externalId) => {
    const seenUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      seenUrls.push(url);

      if (url.pathname.includes('/oauth/v2/token')) {
        return new Response(JSON.stringify({ access_token: 'token-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        [responseKey]: { id: externalId, line_items: [{ item_id: 'SKU-1' }] },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const adapter = createZohoAdapter('zoho_books', {
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'refresh-token',
      organization_id: 'org-1',
      accounts_base_url: 'https://accounts.zoho.in',
      api_base_url: 'https://www.zohoapis.in/books/v3',
    });

    const detail = await adapter[methodName](externalId);

    expect(detail).toMatchObject({ id: externalId });
    const dataRequest = seenUrls.find((url) => !url.pathname.includes('/oauth/v2/token'));
    expect(dataRequest?.pathname).toBe(expectedPath);
    expect(dataRequest?.searchParams.get('organization_id')).toBe('org-1');
  });
});
