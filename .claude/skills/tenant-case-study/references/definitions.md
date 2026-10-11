# Metric definitions, schema facts and pitfalls

Learned building the first case study (Aug–Oct 2026, one live distributor tenant).

## Attribution
- Tenants with an accounting integration (Zoho) have thousands of imported estimates per month (`source='zoho_import'`, ~70% `draft`). They are not Yukti usage. Headline = `is_buyer_app_estimate` only; "other" group is context for share-of-invoiced.
- An August 2026 sync/overwrite bug flipped `source` to `zoho_import` on some buyer-app estimates while `is_buyer_app_estimate` stayed true. q02 reports `src_mismatch`; findings flag it. Check before publishing.
- `estimates.converted_to_invoice_id` is never set. Conversion = status `invoiced`. Invoice links exist only via `invoices.estimate_id` for buyer-app auto-invoices (first seen 2026-09-27 on that tenant); older invoiced estimates may have no invoice row → "no invoice record".

## Activity
- `buyer_app_activity.qualifies_for_engagement` events: `session_started`, `catalog_viewed`, `home_viewed`, `estimate_created` (+ legacy `activity_viewed`). `catalog_viewed.metadata.search` is logged per keystroke (typeahead) — not a search-term analysis.
- `buyers.last_login_at` is barely populated — do not use it.
- PostHog events (filter `properties.tenant_id`, roles `buyer_admin|buyer_assistant|buyer_pending`): `$pageview`, `product_viewed` (from ~10 Aug 2026), `catalog_item_added_to_cart`, `buyer_cart_item_quantity_changed`, `inquiry_created` (server-side, ~94% of estimates). Product ids are `tenant_product_id`. PostHog counts pending-approval buyers, so it runs a little higher than the DB.
- PostHog MCP needs OAuth by the user; the skill uses the REST HogQL API with the personal key instead.

## Estimates lifecycle
Statuses seen: draft, sent, accepted, invoiced, expired, declined, void. Buyer-app estimates are valid 30 days. If no recent estimate has ever expired, the expiry sweep may have stopped — "open" is then overstated (finding is auto-raised via `valid_until < current_date`).

## Tenant context to ask the user
- Prepaid vs credit mix (affects how to frame payment status).
- Deliberate buyer onboarding batches (explains step changes in WAU/estimates).
- Whether the tenant also invoices outside the buyer app.

## Money
`total_amount` is the document total as recorded (do not assume tax-inclusive). Product/category/brand values use `estimate_items.line_total`, so they will not sum to estimate totals.

## Pulse (`/pulse`) vs this skill — verified 2026-10-07 on one live tenant
- `/pulse` Contribution cards call `app.get_landing_metrics_v4(page 'buyer_app', period 'this_quarter')` → `metrics_landing_kpi_snapshot`. Demand and access cards read `metrics_tenant_period_summary` / `metrics_tenant_now_summary`; the invoiced-sales card reads raw `invoices` directly (`is_buyer_app_invoice`, GMV statuses, `invoice_date`). Period summaries are written from raw tables by `_metrics_v4_refresh_claimed_periods` (15-min cron `metrics-refresh-tick`), so they are derived from raw, not from other aggregates.
- Closed months match raw exactly (counts, ₹, buyers). The current period lags raw by up to one refresh (~15 min).
- Gaps: no engagement metrics in `metrics_*`; the invoiced tile only sees invoices created by the in-app flow (flag exists from the first in-app invoice onward); `now_summary.active_buyer_count` = master-active buyers; demand buyer count adds estimate-buyers + order-buyers; `metrics_tenant_daily` is a stale v2 table.
