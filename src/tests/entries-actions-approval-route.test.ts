import { beforeEach, describe, expect, it, vi } from 'vitest';

// `after()` only works inside a request scope; run the callback inline so tests can assert on it.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: unknown) => {
    void (typeof task === 'function' ? (task as () => unknown)() : task);
  },
}));

const flushBuyerMembershipsNowMock = vi.fn().mockResolvedValue({});
vi.mock('@/lib/server/buyer-membership-flush', () => ({
  flushBuyerMembershipsNow: (...args: unknown[]) => flushBuyerMembershipsNowMock(...args),
}));
import { NextRequest } from 'next/server';

const getVerifiedClaimsMock = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();
const canAccessDocumentLocationMock = vi.fn();
const queueApprovalResolutionMessageMock = vi.fn();
const callOrder: string[] = [];

vi.mock('@/lib/auth', () => ({
  getVerifiedClaims: (...args: unknown[]) => getVerifiedClaimsMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    schema: () => ({
      from: (...args: unknown[]) => fromMock(...args),
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

vi.mock('@/lib/server/seller-location-access', () => ({
  canAccessDocumentLocation: (...args: unknown[]) => canAccessDocumentLocationMock(...args),
}));

vi.mock('@/lib/server/buyer-approval-notify', () => ({
  queueApprovalResolutionMessage: (...args: unknown[]) => queueApprovalResolutionMessageMock(...args),
}));

import { POST } from '../../app/api/tenant/entries/[id]/actions/route';

const COHORT_ID = '11111111-1111-4111-8111-111111111111';
const PRICE_LIST_ID = '22222222-2222-4222-8222-222222222222';

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/tenant/entries/entry-1/actions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const entryRow = { id: 'entry-1', tenant_id: 'tenant-1', location_id: null, entry_type: 'business_approval' };

function mockEntryLookup(row: Record<string, unknown> = entryRow) {
  fromMock.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  });
}

function approveRpcResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      applied: true,
      replay: false,
      entry: { id: 'entry-1', source_entity_type: 'buyer', source_entity_id: 'buyer-42', metadata: {} },
      buyer_id: 'buyer-42',
      price_source: { name: 'Retail list', source: 'buyer' },
      zoho_sync_status: 'not_required',
      ...overrides,
    },
    error: null,
  };
}

const approveBody = { action: 'approve', cohort_id: COHORT_ID, price_list_id: PRICE_LIST_ID, assignment_confirmed: true };
const params = { params: Promise.resolve({ id: 'entry-1' }) };

describe('POST /api/tenant/entries/[id]/actions — approval actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-1', sub: 'user-1', role: 'seller_admin' });
    mockEntryLookup();
    canAccessDocumentLocationMock.mockReturnValue(true);
    queueApprovalResolutionMessageMock.mockImplementation(async () => {
      callOrder.push('whatsapp');
      return true;
    });
  });

  describe('approve (group + price list, atomic RPC)', () => {
    it('forwards the confirmed group and price list to approve_buyer_access_entry, not apply_entry_action', async () => {
      rpcMock.mockResolvedValue(approveRpcResult());

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(200);
      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcMock).toHaveBeenCalledWith('approve_buyer_access_entry', {
        p_tenant_id: 'tenant-1',
        p_entry_id: 'entry-1',
        p_actor_user_id: 'user-1',
        p_cohort_id: COHORT_ID,
        p_price_list_id: PRICE_LIST_ID,
        p_assignment_confirmed: true,
        p_note: null,
        p_expected_version: null,
      });
      const body = await res.json();
      expect(body.meta).toMatchObject({ applied: true, replay: false, zoho_sync_status: 'not_required' });
    });

    it('sends an explicit "no group" approval as null ids with confirmation', async () => {
      rpcMock.mockResolvedValue(approveRpcResult());

      await POST(makeRequest({ action: 'approve', cohort_id: null, assignment_confirmed: true }), params);

      expect(rpcMock).toHaveBeenCalledWith(
        'approve_buyer_access_entry',
        expect.objectContaining({ p_cohort_id: null, p_price_list_id: null, p_assignment_confirmed: true }),
      );
    });

    it('never treats a missing confirmation as confirmed', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'assignment_confirmation_required' } });

      const res = await POST(makeRequest({ action: 'approve' }), params);

      expect(rpcMock).toHaveBeenCalledWith(
        'approve_buyer_access_entry',
        expect.objectContaining({ p_assignment_confirmed: false }),
      );
      expect(res.status).toBe(400);
      expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
    });

    it('queues the approved WhatsApp only AFTER the approval RPC has committed', async () => {
      rpcMock.mockImplementation(async (name: string) => {
        callOrder.push(`rpc:${name}`);
        return approveRpcResult();
      });

      await POST(makeRequest(approveBody), params);

      expect(callOrder).toEqual(['rpc:approve_buyer_access_entry', 'whatsapp']);
      expect(queueApprovalResolutionMessageMock).toHaveBeenCalledWith(
        expect.anything(), 'tenant-1', 'buyer-42', 'approved', { missingFields: undefined },
      );
    });

    it('does not queue any WhatsApp when the RPC fails (nothing was approved)', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'invalid_price_list' } });

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(422);
      expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
    });

    it('an idempotent replay returns 200 but sends no second WhatsApp and no Zoho dispatch', async () => {
      rpcMock.mockResolvedValue(approveRpcResult({ applied: false, replay: true, zoho_sync_status: 'pending' }));

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(200);
      expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
      expect(rpcMock).not.toHaveBeenCalledWith('dispatch_buyer_zoho_pushes', expect.anything());
    });

    it('dispatches the Zoho push after approval when the tenant is on Zoho, and still succeeds if dispatch fails', async () => {
      rpcMock.mockImplementation(async (name: string) => {
        if (name === 'dispatch_buyer_zoho_pushes') return { data: null, error: { message: 'pg_net down' } };
        return approveRpcResult({ zoho_sync_status: 'pending' });
      });

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(200);
      expect(rpcMock).toHaveBeenCalledWith('dispatch_buyer_zoho_pushes', { p_entry_id: 'entry-1', p_limit: 1 });
      expect(queueApprovalResolutionMessageMock).toHaveBeenCalled();
    });

    it('does not dispatch Zoho for a non-Zoho tenant', async () => {
      rpcMock.mockResolvedValue(approveRpcResult({ zoho_sync_status: 'not_required' }));

      await POST(makeRequest(approveBody), params);

      expect(rpcMock).not.toHaveBeenCalledWith('dispatch_buyer_zoho_pushes', expect.anything());
    });

    it('still returns success when the notify call throws (non-critical, fire-and-forget)', async () => {
      rpcMock.mockResolvedValue(approveRpcResult());
      queueApprovalResolutionMessageMock.mockRejectedValue(new Error('whatsapp outage'));

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(200);
    });

    it('rejects non-uuid group / price list ids before the RPC', async () => {
      const res = await POST(makeRequest({ action: 'approve', cohort_id: 'nope', assignment_confirmed: true }), params);

      expect(res.status).toBe(400);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it('rejects approve on a non-approval entry', async () => {
      mockEntryLookup({ ...entryRow, entry_type: 'new_enquiry' });

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(400);
      expect(rpcMock).not.toHaveBeenCalled();
    });
  });

  describe('admin-only', () => {
    it.each(['approve', 'decline', 'request_more_info', 'add_note', 'retry_zoho_sync'])(
      'seller_assistant gets 404 for %s on an approval entry and never reaches the RPC',
      async (action) => {
        getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-1', sub: 'asst-1', role: 'seller_assistant' });

        const res = await POST(makeRequest({ ...approveBody, action, note: 'x', metadata: { missing_fields: ['address'] } }), params);

        expect(res.status).toBe(404);
        expect(rpcMock).not.toHaveBeenCalled();
        expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
      },
    );

    it('seller_assistant can still act on non-approval entries', async () => {
      getVerifiedClaimsMock.mockResolvedValue({ tenant_id: 'tenant-1', sub: 'asst-1', role: 'seller_assistant' });
      mockEntryLookup({ ...entryRow, entry_type: 'new_enquiry' });
      rpcMock.mockResolvedValue({ data: { id: 'entry-1', metadata: {} }, error: null });

      const res = await POST(makeRequest({ action: 'add_note', note: 'hello' }), params);

      expect(res.status).toBe(200);
      expect(rpcMock).toHaveBeenCalledWith('apply_entry_action', expect.objectContaining({ p_action: 'add_note' }));
    });

    it('maps the RPC-level admin_only_entry_action to 403 (defence in depth)', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'admin_only_entry_action' } });

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(403);
    });
  });

  describe('decline / request_more_info still use apply_entry_action', () => {
    it('forwards decline with the note', async () => {
      rpcMock.mockResolvedValue({
        data: { id: 'entry-1', source_entity_type: 'buyer', source_entity_id: 'buyer-42', metadata: {} },
        error: null,
      });

      await POST(makeRequest({ action: 'decline', note: 'GST mismatch' }), params);

      expect(rpcMock).toHaveBeenCalledWith('apply_entry_action', expect.objectContaining({ p_action: 'decline', p_note: 'GST mismatch' }));
      expect(queueApprovalResolutionMessageMock).toHaveBeenCalledWith(
        expect.anything(), 'tenant-1', 'buyer-42', 'declined', { missingFields: undefined },
      );
    });

    it('reads missing_fields back from the RPC response metadata for request_more_info, not the request body', async () => {
      rpcMock.mockResolvedValue({
        data: {
          id: 'entry-1',
          source_entity_type: 'buyer',
          source_entity_id: 'buyer-42',
          metadata: { missing_fields: ['gst_certificate', 'address'] },
        },
        error: null,
      });

      await POST(makeRequest({ action: 'request_more_info', metadata: { missing_fields: ['this_should_be_ignored'] } }), params);

      expect(queueApprovalResolutionMessageMock).toHaveBeenCalledWith(
        expect.anything(), 'tenant-1', 'buyer-42', 'needs_more_info', { missingFields: ['gst_certificate', 'address'] },
      );
    });

    it('does not call queueApprovalResolutionMessage for a non-approval action', async () => {
      rpcMock.mockResolvedValue({
        data: { id: 'entry-1', source_entity_type: 'buyer', source_entity_id: 'buyer-42', metadata: {} },
        error: null,
      });

      await POST(makeRequest({ action: 'start' }), params);

      expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
    });

    it('rejects an action outside the allowed enum before hitting the RPC', async () => {
      const res = await POST(makeRequest({ action: 'not_a_real_action' }), params);

      expect(res.status).toBe(400);
      expect(rpcMock).not.toHaveBeenCalled();
    });
  });

  describe('retry_zoho_sync', () => {
    it('calls retry_buyer_zoho_sync for an admin and skips WhatsApp', async () => {
      rpcMock.mockResolvedValue({ data: { id: 'entry-1', external_sync_status: 'pending' }, error: null });

      const res = await POST(makeRequest({ action: 'retry_zoho_sync' }), params);

      expect(res.status).toBe(200);
      expect(rpcMock).toHaveBeenCalledWith('retry_buyer_zoho_sync', {
        p_tenant_id: 'tenant-1', p_entry_id: 'entry-1', p_actor_user_id: 'user-1',
      });
      expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
    });
  });

  describe('RPC error mapping', () => {
    it.each([
      ['approval_buyer_not_found', 409],
      ['version_mismatch', 409],
      ['entry_action_not_allowed', 409],
      ['invalid_cohort', 422],
      ['cohort_not_manual', 422],
      ['price_list_inactive', 422],
      ['assignment_confirmation_required', 400],
    ])('maps %s to %i', async (message, status) => {
      rpcMock.mockResolvedValue({ data: null, error: { message } });

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(status);
      expect((await res.json()).error).not.toBe('Entry not found');
      expect(queueApprovalResolutionMessageMock).not.toHaveBeenCalled();
    });

    it('still maps a genuine entry_not_found RPC error to 404', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'entry_not_found' } });

      const res = await POST(makeRequest(approveBody), params);

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Entry not found');
    });
  });
});
