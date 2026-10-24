export type InboxEntryType =
  | 'business_approval' | 'new_user_login' | 'new_enquiry' | 'new_order_confirmation'
  | 'order_dispatch_needed' | 'invoice_due' | 'invoice_overdue' | 'credit_limit_breach'
  | 'whatsapp_buyer_message' | 'email_buyer_message';
export type InboxEntryStatus = 'new' | 'opened' | 'in_progress' | 'waiting' | 'resolved';
export type InboxTimeBucket = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'this_quarter' | 'previous';

export interface InboxEntry {
  id: string;
  entry_number: number;
  tenant_id: string;
  buyer_id: string | null;
  buyer_name: string;
  buyer_phone: string | null;
  location_id: string | null;
  entry_type: InboxEntryType;
  status: InboxEntryStatus;
  source_channel: string;
  source_entity_type: string;
  source_entity_id: string;
  title: string;
  summary: string;
  amount: number | null;
  currency: string | null;
  priority_at: string;
  remind_at: string | null;
  created_at: string;
  last_actor_id: string | null;
  last_action: string | null;
  last_action_at: string | null;
  external_sync_status: string;
  metadata: Record<string, unknown>;
  allowed_actions: string[];
  time_bucket: InboxTimeBucket;
  customer_entry_count: number;
  /** Last Zoho push error for an approved buyer access request (external_sync_status = 'failed'). */
  external_sync_error?: string | null;
}

export interface InboxGroupedBuyer {
  buyerKey: string; // buyer_id, or entry id for buyer-less entries
  buyerId: string | null;
  buyerName: string;
  timeBucket: InboxTimeBucket;
  entries: InboxEntry[]; // ordered: pinned first, then newest priority_at first
  totalCount: number;
}

export const TIME_BUCKET_ORDER: InboxTimeBucket[] = ['today', 'yesterday', 'this_week', 'this_month', 'this_quarter', 'previous'];
export const TIME_BUCKET_LABEL: Record<InboxTimeBucket, string> = {
  today: 'Today', yesterday: 'Yesterday', this_week: 'This Week',
  this_month: 'This Month', this_quarter: 'This Quarter', previous: 'Previous',
};
