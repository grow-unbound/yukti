import { firstNameFromValue, formatWhatsappDestination, isValidIndianMobile } from '@/lib/phone';
import { MISSING_FIELD_LABELS } from '@/lib/inbox/missing-field-labels';
import { resolveBuyerDisplayName } from '@/lib/server/buyer-app-enable-notify';
import { buildSellerContextFromTenant } from '@/lib/server/whatsapp-seller-context';
import {
  enqueueWhatsAppMessage,
  lookupApprovedTemplateMeta,
  triggerWhatsAppDispatch,
  type WhatsAppSendPayload,
} from '@/lib/server/whatsapp-enqueue';
import { assertTemplatePayloadValid } from '@/lib/server/whatsapp-template-validation';

/**
 * Buyer-approval-flow WhatsApp sends. Mirrors buyer-app-enable-notify.ts's
 * shape (build payload -> validate -> enqueue -> dispatch) but for the
 * public-signup approval flow: Yukti_Public-Signup_Backend-Plan_v1.md §5
 * (as amended by §0b — header+multiline body structure, corrected 5.1/5.2/5.5
 * copy). All five templates here are Utility category, calm/factual tone —
 * distinct from the Marketing-category `buyer_app_enabled` template in
 * buyer-app-enable-notify.ts, which fires on a different trigger (a seller
 * manually flipping a known buyer's access) per §5.3's explicit note not to
 * conflate the two.
 */

export const ACCESS_REQUEST_RECEIVED_BUYER_TEMPLATE = 'access_request_received_buyer';
export const ACCESS_REQUEST_RECEIVED_SELLER_BUSINESS_TEMPLATE = 'access_request_received_seller_business';
export const ACCESS_REQUEST_RECEIVED_SELLER_INDIVIDUAL_TEMPLATE = 'access_request_received_seller_individual';
export const ACCESS_REQUEST_APPROVED_BUYER_TEMPLATE = 'access_request_approved_buyer';
export const ACCESS_MORE_INFO_NEEDED_BUYER_TEMPLATE = 'access_more_info_needed_buyer';
export const ACCESS_REQUEST_DECLINED_BUYER_TEMPLATE = 'access_request_declined_buyer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

interface BuyerRow {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  custom_fields: Record<string, unknown> | null;
}

interface TenantRow {
  id: string;
  business_name: string;
  settings: Record<string, unknown> | null;
}

export type ApprovalResolution = 'approved' | 'declined' | 'needs_more_info';

interface QueueApprovalResolutionExtra {
  missingFields?: string[];
}

function formatMissingFields(fields: string[] | undefined | null): string {
  const labels = (fields ?? [])
    .map((field) => MISSING_FIELD_LABELS[field] ?? field.replace(/_/g, ' ').trim())
    .filter((label) => label.length > 0);
  return labels.length > 0 ? labels.join(', ') : 'a few more details';
}

function isBusinessBuyer(buyer: Pick<BuyerRow, 'custom_fields'>): boolean {
  return buyer.custom_fields?.is_business === true;
}

/** Buyer's own display name as it should appear to the seller (§5.2 {{2}}). */
function resolveBuyerNameForSeller(buyer: BuyerRow): string {
  if (isBusinessBuyer(buyer)) {
    return buyer.business_name;
  }
  return buyer.contact_name?.trim() || buyer.business_name;
}

async function loadBuyer(db: DbClient, tenantId: string, buyerId: string): Promise<BuyerRow | null> {
  const { data, error } = await db
    .schema('app')
    .from('buyers')
    .select('id, business_name, contact_name, phone, custom_fields')
    .eq('id', buyerId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('[buyer-approval-notify] buyer load failed', error);
    return null;
  }
  return data as BuyerRow;
}

async function loadTenant(db: DbClient, tenantId: string): Promise<TenantRow | null> {
  const { data, error } = await db
    .schema('app')
    .from('tenants')
    .select('id, business_name, settings')
    .eq('id', tenantId)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('[buyer-approval-notify] tenant load failed', error);
    return null;
  }
  return data as TenantRow;
}

async function sendTemplateMessage(options: {
  metaTemplateName: string;
  variables: { key: string }[];
  bodyValues: Array<{ key: string; text: string }>;
  destinationPhone: string;
  tenantId: string;
  buyerId: string | null;
  triggerSource: 'access_request_received' | 'access_request_resolved';
  /** Dynamic "Review Request" button — only the seller-received templates set this. Deep-links
   * to `/inbox/{{1}}`, which InboxDetailClient groups entries by buyer_id, so this must be the
   * buyer id, not the entry id (buyer_id is always set on these entries — an entry-id value
   * here would never match InboxDetailClient's grouping filter). */
  reviewRequestButtonBuyerId?: string;
}): Promise<boolean> {
  const {
    metaTemplateName,
    bodyValues,
    destinationPhone,
    tenantId,
    buyerId,
    triggerSource,
    reviewRequestButtonBuyerId,
  } = options;

  const templateMeta = await lookupApprovedTemplateMeta(metaTemplateName);
  if (!templateMeta) {
    console.error('[buyer-approval-notify] approved template not found', { metaTemplateName });
    return false;
  }

  const destination = formatWhatsappDestination(destinationPhone);
  if (!destination) return false;

  const sendPayload: WhatsAppSendPayload = {
    meta_template_name: metaTemplateName,
    locale: templateMeta.locale,
    body_params: bodyValues.map((value) => ({ text: value.text, parameter_name: value.key })),
    ...(reviewRequestButtonBuyerId
      ? { button_params: [{ type: 'url' as const, index: '0', text: reviewRequestButtonBuyerId }] }
      : {}),
  };

  try {
    assertTemplatePayloadValid(
      {
        meta_template_name: metaTemplateName,
        variables: options.variables,
        // "Review Request" (seller-received templates) is the only button here that carries a
        // dynamic {{1}} — Login/none on the other templates need no button_params at send time.
        buttons_config: reviewRequestButtonBuyerId
          ? [{ type: 'url', index: '0', variable_source: 'buyer_id' }]
          : undefined,
      },
      sendPayload,
    );
  } catch (error) {
    console.error('[buyer-approval-notify] payload validation failed', {
      metaTemplateName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  const result = await enqueueWhatsAppMessage({
    tenantId,
    buyerId,
    recipientPhone: destination,
    metaCategory: 'utility',
    triggerSource,
    sendPayload,
  });

  if (!result.enqueued || !result.messageId) {
    if (result.skipped !== 'duplicate') {
      console.error('[buyer-approval-notify] enqueue failed', { metaTemplateName, skipped: result.skipped });
    }
    return result.skipped === 'duplicate';
  }

  await triggerWhatsAppDispatch([result.messageId]);
  return true;
}

/**
 * Fired once, right after `app.submit_buyer_intake` succeeds: notifies the
 * buyer their request was received (5.1) and the seller that a request is
 * waiting on them (5.2). Fire-and-forget from the caller's point of view —
 * every failure path here logs and returns `false` rather than throwing, so
 * a WhatsApp outage never fails the intake submission itself.
 */
export async function queueAccessRequestReceivedMessages(
  db: DbClient,
  tenantId: string,
  buyerId: string,
): Promise<{ buyerSent: boolean; sellerSent: boolean }> {
  const [buyer, tenant] = await Promise.all([
    loadBuyer(db, tenantId, buyerId),
    loadTenant(db, tenantId),
  ]);

  if (!buyer || !tenant) {
    console.error('[buyer-approval-notify] queueAccessRequestReceivedMessages: buyer or tenant not found', {
      tenantId,
      buyerId,
    });
    return { buyerSent: false, sellerSent: false };
  }

  const sellerContext = buildSellerContextFromTenant(tenant);
  const buyerDisplayName = resolveBuyerDisplayName(buyer);

  let buyerSent = false;
  if (buyer.phone && isValidIndianMobile(buyer.phone)) {
    buyerSent = await sendTemplateMessage({
      metaTemplateName: ACCESS_REQUEST_RECEIVED_BUYER_TEMPLATE,
      variables: [{ key: 'buyer_name' }, { key: 'seller_name' }],
      bodyValues: [
        { key: 'buyer_name', text: firstNameFromValue(buyer.contact_name) ?? buyerDisplayName },
        { key: 'seller_name', text: sellerContext.sellerName },
      ],
      destinationPhone: buyer.phone,
      tenantId,
      buyerId,
      triggerSource: 'access_request_received',
    });
  } else {
    console.error('[buyer-approval-notify] buyer has no valid phone, skipping buyer template', { tenantId, buyerId });
  }

  let sellerSent = false;
  if (sellerContext.sellerPhone && isValidIndianMobile(sellerContext.sellerPhone)) {
    // Two distinct template names, not a blank-vs-populated variable — Meta rejects
    // blank template variables, and a template body cannot conditionally include/omit
    // a clause per-send. See Yukti_Public-Signup_Backend-Plan_v1.md §5.2's own fallback:
    // "if [an empty-string variable] not [acceptable], split into two template names."
    const isBusiness = isBusinessBuyer(buyer);
    sellerSent = await sendTemplateMessage({
      metaTemplateName: isBusiness
        ? ACCESS_REQUEST_RECEIVED_SELLER_BUSINESS_TEMPLATE
        : ACCESS_REQUEST_RECEIVED_SELLER_INDIVIDUAL_TEMPLATE,
      variables: [{ key: 'seller_name' }, { key: 'buyer_name' }],
      bodyValues: [
        { key: 'seller_name', text: sellerContext.sellerName },
        { key: 'buyer_name', text: resolveBuyerNameForSeller(buyer) },
      ],
      destinationPhone: sellerContext.sellerPhone,
      tenantId,
      buyerId,
      triggerSource: 'access_request_received',
      reviewRequestButtonBuyerId: buyerId,
    });
  } else {
    console.error('[buyer-approval-notify] tenant has no valid WhatsApp number, skipping seller template', { tenantId });
  }

  return { buyerSent, sellerSent };
}

/**
 * Fired after `app.apply_entry_action` resolves an `approve` / `decline` /
 * `request_more_info` action on a `business_approval` or `new_user_login`
 * entry: notifies the buyer of the outcome (5.3 / 5.4 / 5.5). Same
 * fire-and-forget contract as queueAccessRequestReceivedMessages above.
 */
export async function queueApprovalResolutionMessage(
  db: DbClient,
  tenantId: string,
  buyerId: string,
  resolution: ApprovalResolution,
  extra: QueueApprovalResolutionExtra = {},
): Promise<boolean> {
  const [buyer, tenant] = await Promise.all([
    loadBuyer(db, tenantId, buyerId),
    loadTenant(db, tenantId),
  ]);

  if (!buyer || !tenant) {
    console.error('[buyer-approval-notify] queueApprovalResolutionMessage: buyer or tenant not found', {
      tenantId,
      buyerId,
      resolution,
    });
    return false;
  }

  if (!buyer.phone || !isValidIndianMobile(buyer.phone)) {
    console.error('[buyer-approval-notify] buyer has no valid phone, skipping resolution template', {
      tenantId,
      buyerId,
      resolution,
    });
    return false;
  }

  const sellerContext = buildSellerContextFromTenant(tenant);
  const buyerDisplayName = firstNameFromValue(buyer.contact_name) ?? resolveBuyerDisplayName(buyer);

  if (resolution === 'approved') {
    return sendTemplateMessage({
      metaTemplateName: ACCESS_REQUEST_APPROVED_BUYER_TEMPLATE,
      variables: [{ key: 'buyer_name' }, { key: 'seller_name' }],
      bodyValues: [
        { key: 'buyer_name', text: buyerDisplayName },
        { key: 'seller_name', text: sellerContext.sellerName },
      ],
      destinationPhone: buyer.phone,
      tenantId,
      buyerId,
      triggerSource: 'access_request_resolved',
    });
  }

  if (resolution === 'needs_more_info') {
    return sendTemplateMessage({
      metaTemplateName: ACCESS_MORE_INFO_NEEDED_BUYER_TEMPLATE,
      variables: [{ key: 'buyer_name' }, { key: 'seller_name' }, { key: 'missing_fields' }],
      bodyValues: [
        { key: 'buyer_name', text: buyerDisplayName },
        { key: 'seller_name', text: sellerContext.sellerName },
        { key: 'missing_fields', text: formatMissingFields(extra.missingFields) },
      ],
      destinationPhone: buyer.phone,
      tenantId,
      buyerId,
      triggerSource: 'access_request_resolved',
    });
  }

  // resolution === 'declined'
  if (!sellerContext.sellerPhone || !isValidIndianMobile(sellerContext.sellerPhone)) {
    console.error('[buyer-approval-notify] tenant has no valid WhatsApp number for decline template', { tenantId });
    return false;
  }

  return sendTemplateMessage({
    metaTemplateName: ACCESS_REQUEST_DECLINED_BUYER_TEMPLATE,
    variables: [{ key: 'buyer_name' }, { key: 'seller_name' }, { key: 'seller_phone_number' }],
    bodyValues: [
      { key: 'buyer_name', text: buyerDisplayName },
      { key: 'seller_name', text: sellerContext.sellerName },
      { key: 'seller_phone_number', text: sellerContext.sellerPhone },
    ],
    destinationPhone: buyer.phone,
    tenantId,
    buyerId,
    triggerSource: 'access_request_resolved',
  });
}
