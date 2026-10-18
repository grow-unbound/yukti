# DB recipes & gotchas (hand-written — keep this file small and verified)

Proven query shapes and traps for debugging prod. Verified 2026-10-13 (login/notification incident). Table/column
detail is in [INDEX.md](INDEX.md). Prod rules: reads only, `set statement_timeout='15s'`, LIMIT or aggregate first,
never read secrets/PII rows (see CLAUDE.md).

## Column-name traps (these were guessed wrong and wasted queries)
| You'd guess | Reality |
|---|---|
| `tenant_products.product_name` / `display_name_override` | no name column: `name_override` (nullable) + `master_product_id` → `catalog.products`; `internal_sku` |
| `whatsapp_templates.name` | `meta_template_name` (+ `display_name`, `approval_status`, `meta_category`) |
| `tenants.status` | none. Has `slug` (storefront host label, e.g. `acme`), `subdomain` (legacy, e.g. `acme.yukti.so`), `settings` |
| `entry_events.event_type` | `action`, `from_status`, `to_status` |
| `tenant_products.gst`/`tax` | `gst_rate`, `hsn_code` |
| buyer phone formats | `buyers.phone`/`buyer_users.phone` = bare 10 digits; `whatsapp_messages.recipient_phone` = `91` + 10 digits → compare with `right(recipient_phone,10)` |

## Access requests / inbox
- Approval requests are `app.entries` with `entry_type in ('business_approval','new_user_login')`; open = `status in ('new','opened')`, done = `resolved`.
- Existing app-disabled buyer asking access → `app.request_buyer_app_access` is **idempotent**: while one is open, a re-request creates no entry and no WhatsApp (so "no new notifications" can mean "already requested").
- Notification trail: `whatsapp_messages.trigger_source in ('access_request_received','access_request_resolved')`; the seller admin gets `access_request_received` per entry.
```sql
select (created_at at time zone 'Asia/Kolkata')::date d, entry_type, status, count(*)
from app.entries where tenant_id = :tenant and entry_type in ('business_approval','new_user_login')
  and created_at >= :since group by 1,2,3 order by 1,2,3;
```

## Login / OTP
- OTP sends are `whatsapp_messages.trigger_source='otp_login'` (platform tenant, not the buyer's tenant). `app.otp_sessions` is purged after use — it cannot tell you who attempted.
- Failed/blocked attempts are **not** in the DB. They are PostHog `login_failed` events: `failure_type` ∈ `unregistered_phone | buyer_app_access_disabled | seller_buyer_app_disabled | buyer_login_moved | otp_send_api_error (429 = 45s cooldown) | network_error | invalid_credentials`. Query via HogQL with `POSTHOG_PERSONAL_API_KEY` (.env.local); `$pageview` on `/pending`, `/onboarding`, `/verify` gives the funnel.
- Login candidates: `app.find_buyer_login_candidates(phone10)` (owner = `buyers`, delegate = `buyer_users`). App-disabled buyers MUST still get an OTP (they land on `/pending`).

## WhatsApp pipeline
- `whatsapp_messages` (1) ↔ (1) `whatsapp_send_queue` (priority 1 transactional, >1 broadcast). Dispatch is synchronous app code (`triggerWhatsAppDispatch`, inside `after()` in buyer routes). Backstops: cron `whatsapp-stuck-transactional-kick` (5 min), daily `whatsapp-queue-sweep` (03:40 UTC).
- Credits: `whatsapp_credit_transactions` (debit/refund/topup, `balance_after`). Failure reason `credit debit failed: insufficient whatsapp credits…`; a top-up requeues last-24h transactional failures (trigger).
- Stuck rows: `whatsapp_messages.status='queued'` older than a few minutes, or queue `status='processing'` with `attempt_count=1` (worker died mid-send).

## Pricing (what a buyer sees)
1. Resolved price = `resolve_prices_batch`: buyer-assigned list > cohort list > `all_buyers` list > `tenant_products.base_selling_price` (needs `price_lists.is_active`, `valid_from <= now()`; **Zoho nightly sync re-stamps `valid_from`**).
2. Campaign layer (app code, not SQL): buyer sees campaigns with `status='published'`, valid window, and scope match (`cohort`: member of `scope_value.cohort_id` via `cohort_members_active`, or `buyers.default_cohort_id`). Unit price = `campaign_items.price_override` when > 0, else resolved. Strike-through shows only when override ≠ resolved.
3. `pricing_source='pricelist'` campaigns: `price_override` is a snapshot of the list price (NULL when the product is not on the list). Refreshed by `refresh_campaign_products_by_id` (time-boundary job 00:05 UTC and on edit).
4. Estimates store the quoted `unit_price` per line and `estimates.campaign_id`.
```sql
-- what buyer :b would be charged for a campaign's items vs list price
select ci.tenant_product_id, ci.price_override campaign_price,
       (select unit_price from app.resolve_prices_batch(array[ci.tenant_product_id], :b, 1) limit 1) resolved
from app.campaign_items ci where ci.campaign_id = :c and ci.deleted_at is null limit 50;
```

## Membership (cohorts / campaign audiences)
- Automatic cohort rules live in `cohorts.rules` (e.g. `{"buyer_app":"enabled"}`); members in `cohort_members` (`cohort_members_active` = current).
- New members arrive via `membership_dirty_work` (`buyer_candidate` rows, state pending→done) drained by cron job 18 every 15 min (`:04,:19,:34,:49`), or immediately by `flush_buyer_membership` (seller enable/approve routes, buyer browse).
- "Buyer sees General instead of campaign price right after being enabled" = not yet in the cohort: check `cohort_members_active` and the buyer's `membership_dirty_work` row.

## Scheduled work (prod)
Zoho daily sync 19:00 UTC (= 00:30 IST: buyers/price lists get `updated_at` bumped then); membership tick every 15 min; inbox entries refresh 21:30 UTC; prod guard tick every 2 min; metrics tick (job 111) is **paused**. Full list: [cron.md](cron.md).
