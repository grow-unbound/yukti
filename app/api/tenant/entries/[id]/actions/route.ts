import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getVerifiedClaims } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { canAccessDocumentLocation } from '@/lib/server/seller-location-access';
import { captureWhatsAppInboxEvent, secondsSince } from '@/lib/server/whatsapp-inbox-analytics';
import { queueApprovalResolutionMessage } from '@/lib/server/buyer-approval-notify';
import { flushBuyerMembershipsNow } from '@/lib/server/buyer-membership-flush';

export const dynamic = 'force-dynamic';

const ActionSchema = z.object({
  action: z.enum([
    'open',
    'start',
    'add_note',
    'remind_later',
    'dismiss',
    'ignore',
    'mark_converted_manually',
    'reopen',
    'approve',
    'decline',
    'request_more_info',
    'retry_zoho_sync',
  ]),
  note: z.string().trim().max(2000).optional(),
  remind_at: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // approve only: the seller's confirmed customer group / price list decision.
  // cohort_id null = explicit "No group - use default pricing".
  cohort_id: z.string().uuid().nullable().optional(),
  price_list_id: z.string().uuid().nullable().optional(),
  assignment_confirmed: z.boolean().optional(),
  expected_version: z.number().int().optional(),
});

const APPROVAL_ENTRY_TYPES = new Set(['business_approval', 'new_user_login']);

// RPC error message -> HTTP response. Order matters (specific before generic `not_found`).
const RPC_ERROR_MAP: Array<{ match: string; status: number; message: string }> = [
  { match: 'admin_only_entry_action', status: 403, message: 'Only an admin can act on buyer access requests' },
  { match: 'version_mismatch', status: 409, message: 'This request changed since you opened it. Refresh and try again.' },
  { match: 'entry_action_not_allowed', status: 409, message: 'This request can no longer be actioned in its current state' },
  { match: 'approval_buyer_not_found', status: 409, message: 'The buyer linked to this entry could not be found' },
  { match: 'invalid_cohort', status: 422, message: 'The selected customer group is not available' },
  { match: 'cohort_not_manual', status: 422, message: 'This customer group adds members automatically. Pick a group with manually managed members.' },
  { match: 'invalid_price_list', status: 422, message: 'The selected price list is not available' },
  { match: 'price_list_inactive', status: 422, message: 'The selected price list is inactive or outside its validity window' },
  { match: 'assignment_confirmation_required', status: 400, message: 'Confirm the customer group and price list before approving' },
  { match: 'approval_assignment_required', status: 400, message: 'Confirm the customer group and price list before approving' },
  { match: 'zoho_retry_not_applicable', status: 409, message: 'There is no failed Zoho sync to retry for this request' },
];

const APPROVAL_ACTIONS = new Set(['approve', 'decline', 'request_more_info'] as const);
type ApprovalAction = 'approve' | 'decline' | 'request_more_info';

function resolutionForApprovalAction(action: ApprovalAction): 'approved' | 'declined' | 'needs_more_info' {
  if (action === 'approve') return 'approved';
  if (action === 'decline') return 'declined';
  return 'needs_more_info';
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const claims = await getVerifiedClaims(request);
    if (!claims.tenant_id || !claims.sub) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!claims.role?.startsWith('seller_')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const parsed = ActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid action' }, { status: 400 });
    }

    const { data: entry, error: entryError } = await (supabaseAdmin as any)
      .schema('app')
      .from('entries')
      .select('id, tenant_id, location_id, entry_type, status, metadata')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();

    if (entryError || !entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }
    if (entry.tenant_id !== claims.tenant_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (entry.location_id && !canAccessDocumentLocation(claims, entry.location_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const isApprovalEntry = APPROVAL_ENTRY_TYPES.has(entry.entry_type);
    // Approval-request entries are seller_admin only. Assistants get a 404 so the
    // existence of the request is not revealed (they cannot see it in the Inbox either).
    // The RPCs re-check the actor's role from app.tenant_users (defence in depth).
    if (isApprovalEntry && claims.role !== 'seller_admin') {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    const action = parsed.data.action;
    if (action === 'approve' && !isApprovalEntry) {
      return NextResponse.json({ error: 'unsupported action for this entry' }, { status: 400 });
    }
    if (action === 'retry_zoho_sync' && !isApprovalEntry) {
      return NextResponse.json({ error: 'unsupported action for this entry' }, { status: 400 });
    }

    const rpcName = action === 'approve' ? 'approve_buyer_access_entry'
      : action === 'retry_zoho_sync' ? 'retry_buyer_zoho_sync'
      : 'apply_entry_action';
    const rpcArgs = action === 'approve'
      ? {
          p_tenant_id: claims.tenant_id,
          p_entry_id: id,
          p_actor_user_id: claims.sub,
          p_cohort_id: parsed.data.cohort_id ?? null,
          p_price_list_id: parsed.data.price_list_id ?? null,
          p_assignment_confirmed: parsed.data.assignment_confirmed === true,
          p_note: parsed.data.note ?? null,
          p_expected_version: parsed.data.expected_version ?? null,
        }
      : action === 'retry_zoho_sync'
        ? { p_tenant_id: claims.tenant_id, p_entry_id: id, p_actor_user_id: claims.sub }
        : {
            p_tenant_id: claims.tenant_id,
            p_entry_id: id,
            p_actor_user_id: claims.sub,
            p_action: action,
            p_note: parsed.data.note ?? null,
            p_remind_at: parsed.data.remind_at ?? null,
            p_metadata: parsed.data.metadata ?? {},
          };

    const { data: rpcData, error } = await (supabaseAdmin as any)
      .schema('app')
      .rpc(rpcName, rpcArgs);

    if (error) {
      const msg = String(error.message ?? '').toLowerCase();
      const mapped = RPC_ERROR_MAP.find((entryMap) => msg.includes(entryMap.match));
      if (mapped) {
        return NextResponse.json({ error: mapped.message }, { status: mapped.status });
      }
      if (msg.includes('not_found')) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
      if (msg.includes('required') || msg.includes('unsupported')) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      console.error('[POST /api/tenant/entries/[id]/actions] apply_entry_action failed', error);
      return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 });
    }

    // Time from the buyer's message to the seller first opening it (new -> opened only,
    // so re-opens and reminders do not distort the metric).
    if (action === 'open' && entry.entry_type === 'whatsapp_buyer_message' && entry.status === 'new') {
      captureWhatsAppInboxEvent('whatsapp_entry_first_opened', claims.tenant_id, claims.sub, {
        entry_id: id,
        seconds_since_inbound: secondsSince(
          typeof entry.metadata?.last_inbound_at === 'string' ? entry.metadata.last_inbound_at : null,
        ),
      });
    }

    // approve returns { applied, replay, entry, ... }; the other actions return the entry row.
    const approveResult = action === 'approve'
      ? (rpcData as { applied: boolean; replay: boolean; entry: Record<string, unknown>; price_source: unknown; zoho_sync_status: string })
      : null;
    const data = approveResult ? approveResult.entry : rpcData;

    if (action === 'retry_zoho_sync') {
      return NextResponse.json({ data });
    }

    // The WhatsApp/Zoho side effects run only AFTER the transaction has committed, and only
    // when this call actually applied the approval (an idempotent replay does neither).
    if (approveResult && approveResult.applied && approveResult.zoho_sync_status === 'pending') {
      try {
        // Fire the Zoho push now; the 5-minute pg_cron sweep retries if this misses or fails.
        const { error: dispatchRpcError } = await (supabaseAdmin as any)
          .schema('app')
          .rpc('dispatch_buyer_zoho_pushes', { p_entry_id: id, p_limit: 1 });
        if (dispatchRpcError) {
          console.error('[POST /api/tenant/entries/[id]/actions] zoho dispatch rpc failed (sweep will retry)', dispatchRpcError);
        }
      } catch (dispatchError) {
        console.error('[POST /api/tenant/entries/[id]/actions] zoho dispatch failed (sweep will retry)', dispatchError);
      }
    }

    if (APPROVAL_ACTIONS.has(action as ApprovalAction) && (!approveResult || approveResult.applied)) {
      const resolvedEntry = data as { source_entity_type?: string; source_entity_id?: string; metadata?: Record<string, unknown> } | null;
      const buyerId = resolvedEntry?.source_entity_type === 'buyer' ? resolvedEntry.source_entity_id : null;
      if (buyerId) {
        const missingFields = action === 'request_more_info'
          ? ((resolvedEntry?.metadata?.missing_fields as string[] | undefined) ?? undefined)
          : undefined;
        if (action === 'approve') {
          // Approval enables the buyer app: join campaign audiences now, not at the next tick.
          const tenantId = claims.tenant_id;
          after(() => flushBuyerMembershipsNow(supabaseAdmin as any, tenantId, [buyerId]));
        }
        // Non-critical: notify failures must not fail an already-successful
        // entry-action request (same fire-and-forget contract as the intake
        // route's queueAccessRequestReceivedMessages call).
        try {
          await queueApprovalResolutionMessage(
            supabaseAdmin,
            claims.tenant_id,
            buyerId,
            resolutionForApprovalAction(action as ApprovalAction),
            { missingFields },
          );
        } catch (notifyError) {
          console.error('[POST /api/tenant/entries/[id]/actions] approval-resolution notify failed', notifyError);
        }
      } else {
        console.error('[POST /api/tenant/entries/[id]/actions] approval action resolved without a linked buyer', {
          entryId: id,
          action,
        });
      }
    }

    return NextResponse.json(
      approveResult
        ? { data, meta: { applied: approveResult.applied, replay: approveResult.replay, price_source: approveResult.price_source, zoho_sync_status: approveResult.zoho_sync_status } }
        : { data },
    );
  } catch (error) {
    console.error('[POST /api/tenant/entries/[id]/actions]', error);
    return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 });
  }
}
