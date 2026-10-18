import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/auth', () => ({ getVerifiedClaims: (...a: unknown[]) => getVerifiedClaimsMock(...a) }));
const tenantRow = { data: { business_name: 'Acme' }, error: null };
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: vi.fn(() => ({
      rpc: (...a: unknown[]) => rpcMock(...a),
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(tenantRow) }) }) }),
    })),
  },
}));

import { GET as getScorecard } from '../../app/api/tenant/pulse/scorecard/route';
import { GET as getActNow } from '../../app/api/tenant/pulse/act-now/route';
import { GET as getActBuyers } from '../../app/api/tenant/pulse/act-now/[group]/route';
import { GET as getFunnel } from '../../app/api/tenant/pulse/funnel/route';
import { GET as getSellThrough } from '../../app/api/tenant/pulse/sellthrough/route';
import { GET as getCustomers } from '../../app/api/tenant/pulse/customers/route';
import { GET as getPatterns } from '../../app/api/tenant/pulse/patterns/route';
import { GET as getReview } from '../../app/api/tenant/pulse/review/route';

const req = (path: string) => new NextRequest(`http://localhost${path}`);
const admin = { tenant_id: 't-1', role: 'seller_admin' };

describe('Pulse v2 routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue(admin);
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it('rejects unauthenticated and non-admin callers before touching data', async () => {
    getVerifiedClaimsMock.mockResolvedValueOnce({ tenant_id: null });
    expect((await getScorecard(req('/api/tenant/pulse/scorecard'))).status).toBe(401);
    getVerifiedClaimsMock.mockResolvedValueOnce({ tenant_id: 't-1', role: 'seller_assistant' });
    expect((await getActNow(req('/api/tenant/pulse/act-now'))).status).toBe(403);
    getVerifiedClaimsMock.mockResolvedValueOnce({ tenant_id: 't-1', role: 'seller_assistant' });
    expect((await getFunnel(req('/api/tenant/pulse/funnel'))).status).toBe(403);
    getVerifiedClaimsMock.mockResolvedValueOnce({ tenant_id: 't-1', role: 'seller_assistant' });
    expect((await getReview(req('/api/tenant/pulse/review'))).status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('scorecard passes the tenant from the claim and the resolved IST windows, never client input', async () => {
    const res = await getScorecard(req('/api/tenant/pulse/scorecard?period=7d&tenant_id=evil'));
    expect(res.status).toBe(200);
    const [name, args] = rpcMock.mock.calls[0];
    expect(name).toBe('get_pulse_scorecard');
    expect(args.p_tenant_id).toBe('t-1');
    expect(args.p_to_excl > args.p_from).toBe(true);
    expect(args.p_cmp_to_excl).toBe(args.p_from);
    const body = await res.json();
    expect(body.period.key).toBe('7d');
  });

  it('omits the compare window when cmp=0', async () => {
    await getScorecard(req('/api/tenant/pulse/scorecard?period=30d&cmp=0'));
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_cmp_from: null, p_cmp_to_excl: null });
  });

  it('returns 400 for an invalid custom range without calling the database', async () => {
    const res = await getActNow(req('/api/tenant/pulse/act-now?period=custom&from=2026-10-10&to=2026-10-01'));
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('pages a group with a bounded limit and computes nextOffset', async () => {
    rpcMock.mockResolvedValueOnce({ data: { id: 'went_quiet', total: 7, value: 100, rows: [{ buyer_id: 'b', name: 'x', value: 1, n: 1, last_day: null }, { buyer_id: 'c', name: 'y', value: 1, n: 1, last_day: null }] }, error: null });
    const res = await getActBuyers(req('/api/tenant/pulse/act-now/went_quiet?limit=999&offset=2'), { params: Promise.resolve({ group: 'went_quiet' }) });
    expect(res.status).toBe(200);
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_group: 'went_quiet', p_limit: 50, p_offset: 2 });
    expect((await res.json()).nextOffset).toBe(4);
  });

  it('404s an unknown group', async () => {
    const res = await getActBuyers(req('/api/tenant/pulse/act-now/bogus'), { params: Promise.resolve({ group: 'bogus' }) });
    expect(res.status).toBe(404);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('funnel skips the database and says so when the window exceeds the activity cap', async () => {
    const res = await getFunnel(req('/api/tenant/pulse/funnel?period=custom&from=2026-01-01&to=2026-10-01'));
    const body = await res.json();
    expect(body).toMatchObject({ capped: true, funnel: null, days: [] });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('maps database errors to a 500 with a generic message', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getScorecard(req('/api/tenant/pulse/scorecard'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
    spy.mockRestore();
  });

  it('sell-through passes the tenant and a whitelisted dimension, defaulting to category', async () => {
    await getSellThrough(req('/api/tenant/pulse/sellthrough?period=7d&by=brand'));
    expect(rpcMock.mock.calls[0][0]).toBe('get_pulse_sellthrough');
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_tenant_id: 't-1', p_dimension: 'brand' });
    await getSellThrough(req('/api/tenant/pulse/sellthrough?period=7d&by=drop%20table'));
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ p_dimension: 'category' });
  });

  it('sell-through skips the database and says so when the window exceeds the 92 day cap', async () => {
    const body = await (await getSellThrough(req('/api/tenant/pulse/sellthrough?period=custom&from=2026-01-01&to=2026-10-01'))).json();
    expect(body).toMatchObject({ capped: true, rows: [], totals: null });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('customers and patterns call their RPCs with the claim tenant', async () => {
    await getCustomers(req('/api/tenant/pulse/customers?tenant_id=evil'));
    await getPatterns(req('/api/tenant/pulse/patterns'));
    expect(rpcMock.mock.calls.map((c) => c[0])).toEqual(['get_pulse_customers', 'get_pulse_patterns']);
    for (const c of rpcMock.mock.calls) expect(c[1].p_tenant_id).toBe('t-1');
  });

  it('review returns a locked-down printable HTML document and survives a failing optional band', async () => {
    rpcMock.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'get_pulse_scorecard'
          ? { data: { window: { from: '2026-10-01', to_excl: '2026-10-19' }, compare_window: null, current: { demand_value: 100, demand_docs: 2, demand_buyers: 1, quotes: { count: 2, converted: 1, lost: 0, open: 1 }, median_quote: 50, avg_lines: 2, app_invoiced_value: 0, app_invoiced_docs: 0, app_invoiced_buyers: 0, total_invoiced_value: 0, total_invoiced_docs: 0, engaged_buyers: 1 }, previous: null, open_quotes: { count: 0, value: 0, oldest_at: null, older_than_48h_count: 0, older_than_48h_value: 0 }, quoting_buyers: { new: 1, returning: 0, reactivated: 0 }, generated_at: '' }, error: null }
          : name === 'get_pulse_customers'
            ? { data: null, error: { message: 'boom' } }
            : { data: { groups: [], rows: [], top: [], totals: null }, error: null },
      ),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getReview(req('/api/tenant/pulse/review?period=mtd&download=1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toContain('Headline');
    spy.mockRestore();
  });
});
