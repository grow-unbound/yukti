import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const getFlagMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/auth', () => ({ getVerifiedClaims: (...a: unknown[]) => getVerifiedClaimsMock(...a) }));
vi.mock('@/lib/flags', () => ({ getFlag: (...a: unknown[]) => getFlagMock(...a) }));
vi.mock('@/lib/supabase', () => ({ supabaseAdmin: { schema: vi.fn(() => ({ rpc: (...a: unknown[]) => rpcMock(...a) })) } }));

import { GET as getScorecard } from '../../app/api/tenant/pulse/scorecard/route';
import { GET as getActNow } from '../../app/api/tenant/pulse/act-now/route';
import { GET as getActBuyers } from '../../app/api/tenant/pulse/act-now/[group]/route';
import { GET as getFunnel } from '../../app/api/tenant/pulse/funnel/route';

const req = (path: string) => new NextRequest(`http://localhost${path}`);
const admin = { tenant_id: 't-1', role: 'seller_admin' };

describe('Pulse v2 routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerifiedClaimsMock.mockResolvedValue(admin);
    getFlagMock.mockResolvedValue(true);
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it('rejects unauthenticated, non-admin and flag-off callers before touching data', async () => {
    getVerifiedClaimsMock.mockResolvedValueOnce({ tenant_id: null });
    expect((await getScorecard(req('/api/tenant/pulse/scorecard'))).status).toBe(401);
    getVerifiedClaimsMock.mockResolvedValueOnce({ tenant_id: 't-1', role: 'seller_assistant' });
    expect((await getActNow(req('/api/tenant/pulse/act-now'))).status).toBe(403);
    getFlagMock.mockResolvedValueOnce(false);
    expect((await getFunnel(req('/api/tenant/pulse/funnel'))).status).toBe(403);
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
});
