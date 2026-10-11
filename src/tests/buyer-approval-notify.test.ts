import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupApprovedTemplateMetaMock = vi.fn();
const enqueueWhatsAppMessageMock = vi.fn();
const triggerWhatsAppDispatchMock = vi.fn();

vi.mock('@/lib/server/whatsapp-enqueue', () => ({
  lookupApprovedTemplateMeta: (...args: unknown[]) => lookupApprovedTemplateMetaMock(...args),
  enqueueWhatsAppMessage: (...args: unknown[]) => enqueueWhatsAppMessageMock(...args),
  triggerWhatsAppDispatch: (...args: unknown[]) => triggerWhatsAppDispatchMock(...args),
}));

import {
  queueAccessRequestReceivedMessages,
  queueApprovalResolutionMessage,
} from '@/lib/server/buyer-approval-notify';

// Real validator — the whole point of this suite is to prove the payloads
// this module builds actually pass it (Task 8 brief requirement), so it is
// deliberately NOT mocked.
import { assertTemplatePayloadValid } from '@/lib/server/whatsapp-template-validation';

interface FakeBuyerRow {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  custom_fields: Record<string, unknown> | null;
}

interface FakeTenantRow {
  id: string;
  business_name: string;
  settings: Record<string, unknown> | null;
}

// Test-only fake phone numbers, matching this codebase's existing test
// convention (see src/tests/buyer-access.test.ts et al.) rather than any
// real subscriber number — nothing here ever reaches Meta since
// enqueueWhatsAppMessage/triggerWhatsAppDispatch are mocked above.
const FAKE_BUYER_PHONE = '9876543210';
const FAKE_SELLER_PHONE = '9876500000';

function buildDb(buyer: FakeBuyerRow | null, tenant: FakeTenantRow | null) {
  return {
    schema: (schemaName: string) => {
      if (schemaName !== 'app') throw new Error(`unexpected schema ${schemaName}`);
      return {
        from: (table: string) => {
          if (table === 'buyers') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: buyer, error: null }),
            };
          }
          if (table === 'tenants') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: tenant, error: null }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
    },
  };
}

const businessBuyer: FakeBuyerRow = {
  id: 'buyer-1',
  business_name: 'Alpha Retail',
  contact_name: 'Asha Kumar',
  phone: FAKE_BUYER_PHONE,
  custom_fields: { is_business: true },
};

const individualBuyer: FakeBuyerRow = {
  id: 'buyer-2',
  business_name: 'Customer 9876543210',
  contact_name: 'Ravi Shankar',
  phone: FAKE_BUYER_PHONE,
  custom_fields: { is_business: false },
};

const tenant: FakeTenantRow = {
  id: 'tenant-1',
  business_name: 'WineYard Test',
  settings: {
    buyer_app: {
      whatsapp_number: FAKE_SELLER_PHONE,
      whatsapp_display_name: 'WineYard Team',
    },
  },
};

describe('buyer-approval-notify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupApprovedTemplateMetaMock.mockResolvedValue({ id: 'tmpl-1', locale: 'en' });
    enqueueWhatsAppMessageMock.mockResolvedValue({ messageId: 'msg-1', enqueued: true });
    triggerWhatsAppDispatchMock.mockResolvedValue({ ok: true, dispatched: 1, failed: 0, skipped: 0 });
  });

  it('sends access_request_received_buyer + access_request_received_seller_business for a business buyer', async () => {
    const db = buildDb(businessBuyer, tenant);
    const result = await queueAccessRequestReceivedMessages(db, 'tenant-1', 'buyer-1');

    expect(result).toEqual({ buyerSent: true, sellerSent: true });
    expect(enqueueWhatsAppMessageMock).toHaveBeenCalledTimes(2);

    const [buyerCall, sellerCall] = enqueueWhatsAppMessageMock.mock.calls.map((call) => call[0]);

    expect(buyerCall.sendPayload.meta_template_name).toBe('access_request_received_buyer');
    expect(buyerCall.sendPayload.button_params).toBeUndefined();
    expect(() => assertTemplatePayloadValid(
      { meta_template_name: 'access_request_received_buyer', variables: [] },
      buyerCall.sendPayload,
    )).not.toThrow();

    expect(sellerCall.sendPayload.meta_template_name).toBe('access_request_received_seller_business');
    // "Review Request" deep-links to /inbox/{buyerId} — InboxDetailClient groups these entries
    // by buyer_id (always set here), so the button param must be the buyer id, not the entry id.
    expect(sellerCall.sendPayload.button_params).toEqual([{ type: 'url', index: '0', text: 'buyer-1' }]);
    expect(() => assertTemplatePayloadValid(
      {
        meta_template_name: 'access_request_received_seller_business',
        variables: [],
        buttons_config: [{ type: 'url', index: '0', variable_source: 'buyer_id' }],
      },
      sellerCall.sendPayload,
    )).not.toThrow();
  });

  it('sends access_request_received_seller_individual for a non-business buyer', async () => {
    const db = buildDb(individualBuyer, tenant);
    const result = await queueAccessRequestReceivedMessages(db, 'tenant-1', 'buyer-2');

    expect(result).toEqual({ buyerSent: true, sellerSent: true });
    const sellerCall = enqueueWhatsAppMessageMock.mock.calls[1][0];

    expect(sellerCall.sendPayload.meta_template_name).toBe('access_request_received_seller_individual');
    expect(sellerCall.sendPayload.button_params).toEqual([{ type: 'url', index: '0', text: 'buyer-2' }]);
    expect(() => assertTemplatePayloadValid(
      {
        meta_template_name: 'access_request_received_seller_individual',
        variables: [],
        buttons_config: [{ type: 'url', index: '0', variable_source: 'buyer_id' }],
      },
      sellerCall.sendPayload,
    )).not.toThrow();
  });

  it('sends access_request_approved_buyer with a validating payload', async () => {
    const db = buildDb(businessBuyer, tenant);
    const sent = await queueApprovalResolutionMessage(db, 'tenant-1', 'buyer-1', 'approved');

    expect(sent).toBe(true);
    const call = enqueueWhatsAppMessageMock.mock.calls[0][0];
    expect(call.sendPayload.meta_template_name).toBe('access_request_approved_buyer');
    expect(() => assertTemplatePayloadValid(
      { meta_template_name: 'access_request_approved_buyer', variables: [] },
      call.sendPayload,
    )).not.toThrow();
  });

  it('sends access_more_info_needed_buyer with a human-readable missing_fields string', async () => {
    const db = buildDb(businessBuyer, tenant);
    const sent = await queueApprovalResolutionMessage(db, 'tenant-1', 'buyer-1', 'needs_more_info', {
      missingFields: ['gst_certificate', 'address'],
    });

    expect(sent).toBe(true);
    const call = enqueueWhatsAppMessageMock.mock.calls[0][0];
    expect(call.sendPayload.meta_template_name).toBe('access_more_info_needed_buyer');
    const missingFieldsParam = call.sendPayload.body_params.find(
      (p: { parameter_name?: string }) => p.parameter_name === 'missing_fields',
    );
    expect(missingFieldsParam.text).toBe('GST certificate, address');
    expect(() => assertTemplatePayloadValid(
      { meta_template_name: 'access_more_info_needed_buyer', variables: [] },
      call.sendPayload,
    )).not.toThrow();
  });

  it('sends access_request_declined_buyer with the seller phone number', async () => {
    const db = buildDb(businessBuyer, tenant);
    const sent = await queueApprovalResolutionMessage(db, 'tenant-1', 'buyer-1', 'declined');

    expect(sent).toBe(true);
    const call = enqueueWhatsAppMessageMock.mock.calls[0][0];
    expect(call.sendPayload.meta_template_name).toBe('access_request_declined_buyer');
    const phoneParam = call.sendPayload.body_params.find(
      (p: { parameter_name?: string }) => p.parameter_name === 'seller_phone_number',
    );
    expect(phoneParam.text).toBe(FAKE_SELLER_PHONE);
    expect(() => assertTemplatePayloadValid(
      { meta_template_name: 'access_request_declined_buyer', variables: [] },
      call.sendPayload,
    )).not.toThrow();
  });

  it('does not send when the buyer has no valid phone', async () => {
    const db = buildDb({ ...businessBuyer, phone: null }, tenant);
    const sent = await queueApprovalResolutionMessage(db, 'tenant-1', 'buyer-1', 'approved');

    expect(sent).toBe(false);
    expect(enqueueWhatsAppMessageMock).not.toHaveBeenCalled();
  });
});
