import { after } from 'next/server';
import { formatWhatsappDestination } from '@/lib/phone';
import { formatSellerPhoneDisplay } from '@/lib/server/whatsapp-seller-context';
import {
  enqueueWhatsAppMessage,
  getPlatformTenantId,
  lookupApprovedTemplateMeta,
  triggerWhatsAppDispatch,
  type WhatsAppSendPayload,
  type WhatsAppTemplateSendPayload,
} from '@/lib/server/whatsapp-enqueue';
import type { WhatsAppTriggerSource } from '@/lib/server/whatsapp-ledger';
import { assertTemplatePayloadValid, type WhatsAppTemplateValidationShape } from '@/lib/server/whatsapp-template-validation';

export interface WhatsappNotificationContext {
  sellerPhone: string;
  sellerName: string;
  sellerLocation: string;
  buyerFacingSellerName: string;
  buyerPhone: string;
  buyerName: string;
  etaHours: number;
  tenantId?: string;
  buyerId?: string;
}

interface WhatsappTemplateBodyParam {
  text: string;
  parameterName?: string;
}

const WHATSAPP_OTP_TEMPLATE_LOCALE = 'en_US';
const WHATSAPP_LOGIN_PRODUCT_NAME = 'Login to Yukti';
const WHATSAPP_ACTIVATION_PRODUCT_NAME = 'Set up Yukti';
const WHATSAPP_RESET_PRODUCT_NAME = 'Reset Yukti';
const FALLBACK_TEMPLATE_LOCALE = 'en';

function buildSellerTeamActivationUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return '/activate';
  try {
    return new URL('/activate', appUrl).toString();
  } catch {
    return '/activate';
  }
}

const SELLER_TEAM_ACTIVATION_URL = buildSellerTeamActivationUrl();
const TRANSACTIONAL_TEMPLATE_SHAPES: Record<string, WhatsAppTemplateValidationShape> = {
  order_received_seller: {
    meta_template_name: 'order_received_seller',
    variables: [
      { key: 'seller_location' },
      { key: 'buyer_name' },
      { key: 'buyer_phone_number' },
      { key: 'order_number' },
      { key: 'total_amount' },
      { key: 'item_count' },
      { key: 'eta' },
    ],
    buttons_config: [{ type: 'url', index: '0', variable_source: 'order_id' }],
  },
  order_received_buyer: {
    meta_template_name: 'order_received_buyer',
    variables: [
      { key: 'buyer_name' },
      { key: 'item_count' },
      { key: 'order_number' },
      { key: 'total_amount' },
      { key: 'seller_name' },
      { key: 'eta' },
    ],
    buttons_config: [{ type: 'url', index: '0', variable_source: 'order_id' }],
  },
  request_received_seller: {
    meta_template_name: 'request_received_seller',
    variables: [
      { key: 'seller_location' },
      { key: 'buyer_name' },
      { key: 'buyer_phone_number' },
      { key: 'request_number' },
      { key: 'total_amount' },
      { key: 'item_count' },
      { key: 'eta' },
    ],
    buttons_config: [{ type: 'url', index: '0', variable_source: 'estimate_id' }],
  },
  request_received_buyer: {
    meta_template_name: 'request_received_buyer',
    variables: [
      { key: 'buyer_name' },
      { key: 'item_count' },
      { key: 'estimate_number' },
      { key: 'total_amount' },
      { key: 'seller_name' },
      { key: 'eta' },
    ],
    buttons_config: [{ type: 'url', index: '0', variable_source: 'estimate_id' }],
  },
  request_update_buyer: {
    meta_template_name: 'request_update_buyer',
    variables: [
      { key: 'buyer_name' },
      { key: 'request_number' },
      { key: 'total_amount' },
      { key: 'item_count' },
      { key: 'seller_name' },
      { key: 'seller_phone_number' },
    ],
    buttons_config: [{ type: 'url', index: '0', variable_source: 'estimate_id' }],
  },
  invoice_update_buyer: {
    meta_template_name: 'invoice_update_buyer',
    variables: [
      { key: 'buyer_name' },
      { key: 'invoice_number' },
      { key: 'total_amount' },
      { key: 'item_count' },
      { key: 'seller_name' },
      { key: 'seller_phone_number' },
    ],
    buttons_config: [{ type: 'url', index: '0', variable_source: 'invoice_id' }],
  },
  buyer_payment_reminder: {
    meta_template_name: 'buyer_payment_reminder',
    variables: [
      { key: 'buyer_name' },
      { key: 'seller_name' },
      { key: 'due_invoice_count' },
      { key: 'outstanding_amount' },
      { key: 'due_status' },
      { key: 'seller_phone_number' },
    ],
    buttons_config: [],
  },
  invite_user_seller: {
    meta_template_name: 'invite_user_seller',
    variables: [
      { key: 'seller_user' },
      { key: 'seller_name' },
    ],
    buttons_config: [{ type: 'url', index: '0', url_template: SELLER_TEAM_ACTIVATION_URL }],
  },
};

/** Buyer-app totals are stored in whole rupees — Meta body params expect the same scale. */
export function formatWhatsappInrAmount(amount: number): string {
  return String(Math.round(amount));
}

async function resolveTemplateLocale(templateName: string): Promise<string> {
  const meta = await lookupApprovedTemplateMeta(templateName);
  return meta?.locale ?? FALLBACK_TEMPLATE_LOCALE;
}

interface EnqueueTemplateContext {
  tenantId: string;
  buyerId?: string;
  metaCategory: 'marketing' | 'utility' | 'authentication' | 'service';
  triggerSource: WhatsAppTriggerSource;
  relatedEntityType?: 'estimates' | 'orders' | 'invoices';
  relatedEntityId?: string;
}

function buildSendPayload(
  templateName: string,
  locale: string,
  bodyParams: WhatsappTemplateBodyParam[],
  buttonParam?: string,
): WhatsAppTemplateSendPayload {
  return {
    meta_template_name: templateName,
    locale,
    body_params: bodyParams.map((p) => ({
      text: p.text,
      ...(p.parameterName ? { parameter_name: p.parameterName } : {}),
    })),
    ...(buttonParam ? { button_params: [{ type: 'url', index: '0', text: buttonParam }] } : {}),
  };
}

function validateTransactionalPayload(templateName: string, payload: WhatsAppTemplateSendPayload) {
  const shape = TRANSACTIONAL_TEMPLATE_SHAPES[templateName];
  if (!shape) return;
  assertTemplatePayloadValid(shape, payload);
}

async function enqueueWhatsappTemplate(
  to: string,
  templateName: string,
  locale: string,
  bodyParams: WhatsappTemplateBodyParam[],
  buttonParam: string | undefined,
  ctx: EnqueueTemplateContext,
): Promise<boolean> {
  const destination = formatWhatsappDestination(to);
  if (!destination) {
    console.error('[whatsapp] invalid destination', {
      templateName,
      triggerSource: ctx.triggerSource,
      relatedEntityId: ctx.relatedEntityId ?? null,
    });
    return false;
  }
  const sendPayload = buildSendPayload(templateName, locale, bodyParams, buttonParam);
  try {
    validateTransactionalPayload(templateName, sendPayload);
  } catch (error) {
    console.error('[whatsapp] local payload validation failed', {
      templateName,
      triggerSource: ctx.triggerSource,
      relatedEntityId: ctx.relatedEntityId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const result = await enqueueWhatsAppMessage({
    tenantId: ctx.tenantId,
    buyerId: ctx.buyerId ?? null,
    recipientPhone: destination,
    metaCategory: ctx.metaCategory,
    triggerSource: ctx.triggerSource,
    sendPayload,
    relatedEntityType: ctx.relatedEntityType ?? null,
    relatedEntityId: ctx.relatedEntityId ?? null,
  });

  if (result.skipped === 'duplicate') return true;
  if (!result.enqueued || !result.messageId) {
    console.error('[whatsapp] enqueue failed', {
      templateName,
      triggerSource: ctx.triggerSource,
      relatedEntityId: ctx.relatedEntityId ?? null,
      skipped: result.skipped ?? null,
    });
    return false;
  }

  const dispatch = await triggerWhatsAppDispatch([result.messageId]);
  if (!dispatch?.ok || dispatch.dispatched === 0) {
    console.error('[whatsapp] dispatch failed', {
      templateName,
      triggerSource: ctx.triggerSource,
      relatedEntityId: ctx.relatedEntityId ?? null,
      messageId: result.messageId,
      dispatch,
    });
  }
  return Boolean(dispatch?.ok && dispatch.dispatched > 0);
}

export async function sendOrderReceivedSeller(
  ctx: WhatsappNotificationContext,
  orderId: string,
  orderNumber: string,
  totalAmount: number,
  itemCount: number,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('order_received_seller');
  return enqueueWhatsappTemplate(
    ctx.sellerPhone,
    'order_received_seller',
    locale,
    [
      { text: ctx.sellerLocation, parameterName: 'seller_location' },
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: ctx.buyerPhone, parameterName: 'buyer_phone_number' },
      { text: orderNumber, parameterName: 'order_number' },
      { text: formatWhatsappInrAmount(totalAmount), parameterName: 'total_amount' },
      { text: String(itemCount), parameterName: 'item_count' },
      { text: String(ctx.etaHours), parameterName: 'eta' },
    ],
    orderId,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'order_placed',
      relatedEntityType: 'orders',
      relatedEntityId: orderId,
    },
  );
}

export async function sendOrderReceivedBuyer(
  ctx: WhatsappNotificationContext,
  orderId: string,
  orderNumber: string,
  totalAmount: number,
  itemCount: number,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('order_received_buyer');
  return enqueueWhatsappTemplate(
    ctx.buyerPhone,
    'order_received_buyer',
    locale,
    [
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: String(itemCount), parameterName: 'item_count' },
      { text: orderNumber, parameterName: 'order_number' },
      { text: formatWhatsappInrAmount(totalAmount), parameterName: 'total_amount' },
      { text: ctx.buyerFacingSellerName, parameterName: 'seller_name' },
      { text: String(ctx.etaHours), parameterName: 'eta' },
    ],
    orderId,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'order_placed',
      relatedEntityType: 'orders',
      relatedEntityId: orderId,
    },
  );
}

export async function sendRequestReceivedSeller(
  ctx: WhatsappNotificationContext,
  estimateId: string,
  estimateNumber: string,
  totalAmount: number,
  itemCount: number,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('request_received_seller');
  return enqueueWhatsappTemplate(
    ctx.sellerPhone,
    'request_received_seller',
    locale,
    [
      { text: ctx.sellerLocation, parameterName: 'seller_location' },
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: ctx.buyerPhone, parameterName: 'buyer_phone_number' },
      { text: estimateNumber, parameterName: 'request_number' },
      { text: formatWhatsappInrAmount(totalAmount), parameterName: 'total_amount' },
      { text: String(itemCount), parameterName: 'item_count' },
      { text: String(ctx.etaHours), parameterName: 'eta' },
    ],
    estimateId,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'enquiry_received',
      relatedEntityType: 'estimates',
      relatedEntityId: estimateId,
    },
  );
}

export async function sendRequestReceivedBuyer(
  ctx: WhatsappNotificationContext,
  estimateId: string,
  estimateNumber: string,
  totalAmount: number,
  itemCount: number,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('request_received_buyer');
  return enqueueWhatsappTemplate(
    ctx.buyerPhone,
    'request_received_buyer',
    locale,
    [
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: String(itemCount), parameterName: 'item_count' },
      { text: estimateNumber, parameterName: 'estimate_number' },
      { text: formatWhatsappInrAmount(totalAmount), parameterName: 'total_amount' },
      { text: ctx.buyerFacingSellerName, parameterName: 'seller_name' },
      { text: String(ctx.etaHours), parameterName: 'eta' },
    ],
    estimateId,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'enquiry_received',
      relatedEntityType: 'estimates',
      relatedEntityId: estimateId,
    },
  );
}

export async function sendRequestUpdateBuyer(
  ctx: WhatsappNotificationContext,
  estimateId: string,
  requestNumber: string,
  totalAmount: number,
  itemCount: number,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('request_update_buyer');
  return enqueueWhatsappTemplate(
    ctx.buyerPhone,
    'request_update_buyer',
    locale,
    [
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: requestNumber, parameterName: 'request_number' },
      { text: formatWhatsappInrAmount(totalAmount), parameterName: 'total_amount' },
      { text: String(itemCount), parameterName: 'item_count' },
      { text: ctx.buyerFacingSellerName, parameterName: 'seller_name' },
      { text: formatSellerPhoneDisplay(ctx.sellerPhone), parameterName: 'seller_phone_number' },
    ],
    estimateId,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'estimate_update',
      relatedEntityType: 'estimates',
      relatedEntityId: estimateId,
    },
  );
}

export async function sendInvoiceUpdateBuyer(
  ctx: WhatsappNotificationContext,
  invoiceId: string,
  invoiceNumber: string,
  totalAmount: number,
  itemCount: number,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('invoice_update_buyer');
  return enqueueWhatsappTemplate(
    ctx.buyerPhone,
    'invoice_update_buyer',
    locale,
    [
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: invoiceNumber, parameterName: 'invoice_number' },
      { text: formatWhatsappInrAmount(totalAmount), parameterName: 'total_amount' },
      { text: String(itemCount), parameterName: 'item_count' },
      { text: ctx.buyerFacingSellerName, parameterName: 'seller_name' },
      { text: formatSellerPhoneDisplay(ctx.sellerPhone), parameterName: 'seller_phone_number' },
    ],
    invoiceId,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'invoice_update',
      relatedEntityType: 'invoices',
      relatedEntityId: invoiceId,
    },
  );
}

export async function sendBuyerPaymentReminder(
  ctx: WhatsappNotificationContext,
  invoiceId: string,
  dueInvoiceCount: string,
  outstandingAmount: string,
  dueStatus: string,
): Promise<boolean> {
  if (!ctx.tenantId) return false;
  const locale = await resolveTemplateLocale('buyer_payment_reminder');
  return enqueueWhatsappTemplate(
    ctx.buyerPhone,
    'buyer_payment_reminder',
    locale,
    [
      { text: ctx.buyerName, parameterName: 'buyer_name' },
      { text: ctx.buyerFacingSellerName, parameterName: 'seller_name' },
      { text: dueInvoiceCount, parameterName: 'due_invoice_count' },
      { text: outstandingAmount, parameterName: 'outstanding_amount' },
      { text: dueStatus, parameterName: 'due_status' },
      { text: formatSellerPhoneDisplay(ctx.sellerPhone), parameterName: 'seller_phone_number' },
    ],
    undefined,
    {
      tenantId: ctx.tenantId,
      buyerId: ctx.buyerId,
      metaCategory: 'utility',
      triggerSource: 'payment_reminder',
      relatedEntityType: 'invoices',
      relatedEntityId: invoiceId,
    },
  );
}

/**
 * Enqueues the login OTP template. Billed to WHATSAPP_PLATFORM_TENANT_ID.
 */
export async function sendLoginOtpWhatsapp(phone: string, otp: string): Promise<void> {
  await sendOtpWhatsapp(phone, otp, WHATSAPP_LOGIN_PRODUCT_NAME);
}

export async function sendActivationOtpWhatsapp(phone: string, otp: string): Promise<void> {
  await sendOtpWhatsapp(phone, otp, WHATSAPP_ACTIVATION_PRODUCT_NAME);
}

export async function sendResetOtpWhatsapp(phone: string, otp: string): Promise<void> {
  await sendOtpWhatsapp(phone, otp, WHATSAPP_RESET_PRODUCT_NAME);
}

async function sendOtpWhatsapp(phone: string, otp: string, productName: string): Promise<void> {
  const adminNumber = process.env.WHATSAPP_ADMIN_NUMBER;
  const platformTenantId = getPlatformTenantId();

  if (!adminNumber) {
    throw new Error('Missing WhatsApp OTP configuration');
  }
  if (!platformTenantId) {
    throw new Error('Missing WHATSAPP_PLATFORM_TENANT_ID for OTP billing');
  }

  const destination = formatWhatsappDestination(phone);
  if (!destination) {
    throw new Error('Invalid phone number for OTP');
  }

  const result = await enqueueWhatsAppMessage({
    tenantId: platformTenantId,
    recipientPhone: destination,
    metaCategory: 'authentication',
    triggerSource: 'otp_login',
    sendPayload: {
      meta_template_name: 'login_otp',
      locale: WHATSAPP_OTP_TEMPLATE_LOCALE,
      body_params: [
        { text: otp },
        { text: productName },
        { text: adminNumber },
      ],
      button_params: [{ type: 'url', index: '0', text: otp }],
    },
  });

  if (!result.enqueued && result.skipped !== 'duplicate') {
    throw new Error('Failed to enqueue OTP WhatsApp message');
  }

  // The enqueue above is the durable write — the message row exists and pg_cron's
  // scheduled sweep will pick it up regardless. This immediate dispatch trigger is
  // just a latency optimization (send now instead of waiting for the next cron
  // tick), so it doesn't need to block the OTP response: the request was already
  // blocking on an edge-function round trip that itself waits on Meta's API, which
  // was the dominant cost on every "Send OTP" click. after() keeps it running on
  // Vercel past the point the response is sent (a bare un-awaited call can get cut
  // off). Failures are logged, not surfaced to the user — cron is the safety net.
  if (result.messageId) {
    const messageId = result.messageId;
    after(async () => {
      try {
        const dispatch = await triggerWhatsAppDispatch([messageId]);
        if (!dispatch?.ok || dispatch.dispatched === 0) {
          console.error('[whatsapp] background OTP dispatch did not confirm send', { messageId, dispatch });
        }
      } catch (err) {
        console.error('[whatsapp] background OTP dispatch threw', { messageId, err });
      }
    });
  }
}

export async function sendSellerTeamActivationInviteWhatsapp(input: {
  tenantId: string;
  phone: string;
  fullName: string;
  tenantName: string;
}): Promise<boolean> {
  const locale = await resolveTemplateLocale('invite_user_seller');
  return enqueueWhatsappTemplate(
    input.phone,
    'invite_user_seller',
    locale,
    [
      { text: input.fullName, parameterName: 'seller_user' },
      { text: input.tenantName, parameterName: 'seller_name' },
    ],
    undefined,
    {
      tenantId: input.tenantId,
      metaCategory: 'utility',
      triggerSource: 'seller_team_invite',
    },
  );
}
