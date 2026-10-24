# Context inbox

Proposals from `/wrap` for the core instruction files. Nothing here is loaded automatically. Review, mark, then run `/context-review`.

Mark each item: `[x] accept` · `[ ]` pending · `[-] reject — <reason>`.

Item format:
```
### YYYY-MM-DD <session/branch> — <one-line title>
- [ ] target: <file>   change: add|edit|remove|move
- text: <exact text>
- why: <reason + evidence (file:line, command, wasted turns)>
- cost: <lines/tokens; always-loaded | path-scoped>
```

## Pending

### 2026-10-24 claude/zoho-webhook-failures-78e279 — Zoho webhook triage facts (retention, soft-deleted rows, no payload on routing errors)
- [ ] target: docs/db/recipes.md   change: add
- text: "Zoho webhook triage (prod): `app.integration_webhook_events` is purged after 7 days, so per-entity daily event counts only reach back a week. Routing failures (`webhook_inactive`) land in `app.integration_webhook_errors` with `integration_webhook_id` but no contact id or payload. `loadWebhookByToken` ignores `deleted_at`, so soft-deleted webhook rows still resolve and can still be live (prod 2026-10-24: the items add_edit row `371b6c09…` was soft-deleted yet `is_active` and receiving events); never add a `deleted_at` filter there before checking `where deleted_at is not null and is_active`. Delivery check: compare events/day for the suspect entity against invoices/estimates; zero vs hundreds means Zoho is not delivering to the active rows, whatever `integration_webhooks.status` says."
- why: Oct 24 review. Without these, `webhook_inactive` looked like harmless noise and the dropped contacts events (zero for 7 days) went unnoticed; the obvious one-line lookup fix would have silently broken items sync.
- cost: 1 paragraph, path-scoped

### 2026-10-24 claude/zoho-webhook-failures-78e279 — Daily Zoho incremental sync window is IST midnight, and "completed, 0 upserted" can mean skipped
- [ ] target: docs/db/recipes.md   change: add
- text: "Incremental Zoho syncs send `last_modified_time=<since date>T00:00:00+0530` (adapter, `integrations-zoho.ts` fetchPage), i.e. 18:30 UTC the previous day, so the 19:00 UTC daily runs overlap ~30 min and leave no coverage gap. A phase can finish `completed` with `records_synced = 0`; read `integration_sync_jobs.summary.note` (e.g. `37 contact persons fetched, 0 upserted` = every record skipped, not 'nothing changed')."
- why: Oct 24: I first reported a 19:00-24:00 UTC coverage gap that did not exist, and contact-persons incremental runs showed healthy for 26 days while upserting nothing.
- cost: 1 paragraph, path-scoped

### 2026-10-23 claude/yukti-prod-io-egress-review-814b17 — Supabase "Cached Egress" is 0 by design; egress = PostgREST payload bytes
- [ ] target: MEMORY.md   change: add
- text: Free-plan egress alarms: Cached Egress stays 0 because every PostgREST/RPC reply is `cf_cache_status: DYNAMIC` (service-role POSTs from Vercel; only Storage CDN is cacheable, images are on R2). The lever is bytes per call: one `load_products_scoped(limit 40)` page is ~56-60 KB (~1.5 KB/row, mostly JSON keys + r2 key columns); `.rpc().select(cols)` trims only ~7%. Bigger wins need per-row dedupe (brand/category/family fields) or fewer/smaller pages.
- why: Oct 23 review (4.67/5 GB; edge logs have no response size, measured with `to_jsonb(row)` byte SELECT on prod).
- cost: 1 line, always-loaded

### 2026-10-23 claude/yukti-prod-io-egress-review-814b17 — buyer-path RPC/table reads: cache whole small sets, not per-page filters
- [ ] target: .claude/rules/data-fetching.md   change: add
- text: under "Caching": "Per-page `WHERE id IN (page ids)` reads of small tenant-wide sets (campaign_items: 12 campaigns, ~940 rows) become one query shape per page. Cache the whole set per (tenant, parent id) with `unstable_cache` + the buyer-context tag and filter in memory (`src/lib/server/campaign-items-cache.ts`)."
- why: Oct 23 edge-log shape query: campaign_items ~380 calls / 30 min in 4 shapes, all page-id filters.
- cost: 1 line, path-scoped

### 2026-10-17 perf/buyer-profile-slim — specs/ and docs/incidents/ are gitignored; say so
- [ ] target: CLAUDE.md ("Where to look" table)   change: edit
- text: append to the `specs/INDEX.md` row: "(`specs/` and `docs/incidents/` are gitignored in this public repo: new specs/logs stay local, don't `git add` them)"
- why: two failed `git add` attempts and a wasted branch/PR step this session (.gitignore:82 `specs/`, `docs/*`).
- cost: ~0 lines, always-loaded

### 2026-10-17 perf/buyer-profile-slim — pre-existing red suite makes scripts/verify.sh always fail
- [ ] target: MEMORY.md   change: add
- text: `src/tests/sales-orders-landing-page.test.ts` fails on clean develop ("The URL must be of scheme file", @sentry/server-utils webpack import); verify.sh reports FAILED whenever it is in the affected set. Confirm with `git stash` + single-file run, then proceed and say so in the PR.
- why: reproduced on origin/develop @ dee02e63; fixing the import/mock would restore a clean gate.
- cost: 1 line, always-loaded (or fix the test and drop this)

### 2026-10-17 perf/buyer-profile-slim — React cache() does not dedupe inside Route Handlers
- [ ] target: .claude/rules/data-fetching.md   change: edit
- text: in the `cache()` bullet add: "`cache()` only memoizes within a React render (Server Components). In `/api/*` Route Handlers it does not dedupe; share reads by passing the value down, or coalesce in-flight reads (see `src/lib/server/buyer-membership.ts`)."
- why: PR1 needed the same buyers/cohort read shared by two helpers inside a route handler; the rule currently suggests `cache()` generically. (Not verified empirically on this Next version; confirm before accepting.)
- cost: 1 line, path-scoped

### 2026-10-13 chore/prod-read-guard-and-db-map — CLAUDE.md should point at the DB map and match what the hook enforces
- [ ] target: CLAUDE.md ("Where to look" table)   change: add
- text: `| Tables, columns, RPCs, cron, query recipes/gotchas | docs/db/INDEX.md → one domain file; docs/db/recipes.md (read before debugging prod) |`
- why: ~14 schema-discovery queries and 6 wrong-column-name failures in the Oct 13 incident; the map is generated (scripts/db-map.mjs) and `.claude/rules/db-schema.md` only auto-loads on migration/SQL paths.
- cost: 1 line, always-loaded

### 2026-10-13 chore/prod-read-guard-and-db-map — prod-reads sentence should describe the hook, not rely on the model
- [ ] target: CLAUDE.md (Prod safety, first bullet)   change: edit
- text: replace "Prod **reads**: ask once per session (name the project); that one yes covers every read in these classes without per-query asks" with "Prod **reads**: `.claude/hooks/guard-prod.sh` (prod_sql_guard.py) asks on the first read-class call of a session and auto-allows later ones (wrapped in a read-only transaction); every write, side-effect function, secret/PII touch, unbounded or timeout-less query asks every time."
- why: the old hook asked on every call naming the prod ref and was stateless, so "ask once" in CLAUDE.md was not enforceable; user approved ~every query.
- cost: net 0 lines, always-loaded

### 2026-10-13 fix/restore-buyer-login-otp-return-to — fire-and-forget after the response is not safe on Vercel
- [ ] target: .claude/rules/data-fetching.md   change: add
- text: `Server work that must happen after a route responds (WhatsApp dispatch, activity logs) goes in after() from next/server; a bare `void promise()` is frozen when the response is sent and silently drops the work.`
- why: app/api/buyer/estimates/route.ts and orders/route.ts used `void sendImmediateTransactionNotifications()`; 8 enquiry_received rows sat `queued` (attempt 0) for ~20h on 2026-10-12 until the daily sweep.
- cost: 1 line, path-scoped

### 2026-10-13 fix/restore-buyer-login-otp-return-to — never ship a release with the auth route tests red
- [ ] target: CLAUDE.md (Workflow)   change: add
- text: `develop→main release PRs: src/tests/auth/buyer-phone-otp-routes.test.ts and login-page tests must be green; a red auth suite on develop already encoded the lost behaviour (app-disabled buyers get OTP; return_to + handoff_url survive the login/verify clients).`
- why: Oct 4-5 auth-surface rewrite shipped 2026-10-11 with 9 failing OTP-route tests; PostHog login_failed `buyer_app_access_disabled` went 0 → 45/day and /pending views fell 275/day → 22/day.
- cost: 1 line, always-loaded

### 2026-10-13 fix/restore-buyer-login-otp-return-to — incident fact for MEMORY.md
- [ ] target: MEMORY.md (project)   change: add
- text: `Oct 11 release regressed buyer login (send route required buyer_app_enabled; LoginForm/Verify dropped return_to + handoff_url). Fixed on fix/restore-buyer-login-otp-return-to; PostHog HogQL via POSTHOG_PERSONAL_API_KEY in .env.local (login_failed failure_type, $pageview /pending). WhatsApp dispatch is app-code synchronous (trigger dropped 2026-07-13); daily sweep is only a backstop.`
- why: avoids re-deriving the PostHog access path and the dispatch architecture next incident.
- cost: 1 line, MEMORY.md

### 2026-09-28 feat/inbox-ui-polish — stage by explicit path in a shared checkout
- [ ] target: CLAUDE.md (Workflow)   change: add
- text: `Other sessions may leave uncommitted edits in the same checkout: stage by explicit path (never git add src/ or -A), and check git show --stat after committing.`
- why: `git add src` swept another session's uncommitted auth/buyer-access files into a commit this session; undone with a soft reset before push.
- cost: 1 line, always-loaded

### 2026-09-28 feat/inbox-ui-polish — entry metadata is a snapshot; nightly refresh failure is silent
- [ ] target: MEMORY.md (project)   change: add
- text: `Inbox entries (app.entries.metadata, e.g. credit_limit_breach outstanding/over_limit) are snapshots written by the nightly refresh (pg_cron job inbox-entries-daily-refresh); detail views recompute live. On dev the job failed 2026-09-24..28 (entries_tenant_external_ref_uk vs soft-deleted rows), fixed by migration 20260928072642 (dev only). Prod not checked: verify cron.job_run_details for the job before trusting prod entry numbers.`
- why: mismatched over-limit numbers traced to a job that failed every night with no alerting; wasted several queries to find.
- cost: ~3 lines in MEMORY index + one memory file; on-demand

### 2026-10-01 feat/existing-buyer-access-request — migration history drift: prod lacks inbox fixes; develop has 4 red tests
- [ ] target: MEMORY.md (project)   change: add
- text: `Migration history drift (checked 2026-10-01): 20260928042731 (sync_entry_from_buyer NULL-guard) and 20260928072642 are unrecorded on dev AND prod; dev's function already has the guard (applied out-of-band), prod does not -> nightly cron inbox-entries-daily-refresh created ~12.3k bogus approval entries on tenant d601c35c (09-27..09-30). db push to dev needs --include-all. Also develop has 4 pre-existing red test files (buyer-access.test.ts, buyer-idle-refetch, catalog-discovery-landing-streaming, sales-orders-landing-page): compare against a stash before blaming a diff.`
- why: cost two queries + a stash run to establish; prod entries are user-visible noise until the migration is applied (needs explicit prod authorization).
- cost: ~3 lines MEMORY index + one memory file; on-demand

### 2026-10-11 fix/zoho-item-gst-rate — Zoho India GST rates live in item_tax_preferences; vitest red masked by Deno guard
- [ ] target: .claude/rules (new or integrations rule, path-scoped to supabase/functions/_shared/integrations-*.ts)   change: add
- text: `Zoho India GST orgs return top-level item tax_percentage=0; real rates are in /items list item_tax_preferences[] (tax_specification intra|inter). Use resolveZohoItemGstRate. No detail fetch needed. Verified against real dev payload 2026-10-11.`
- why: all 459 d601c35c products synced gst_rate=0; assumed a detail fetch was needed until a live probe showed the list already carries it.
- cost: 2 lines, path-scoped
- [ ] target: MEMORY.md (project)   change: add
- text: `Zoho test suites zoho-customer-transaction-sync (3 tests) and zoho-transaction-sync (1) are red on main since before 2026-10-11 (stub lacks .not, R2 source_payload assertions stale, phase plan has 5 not 3 phases); were masked by "Deno is not defined" until sync-log.ts guard.`
- why: wrap gate stays red on any Zoho persist change until these are fixed; costs a stash comparison to prove pre-existing.
- cost: 2 lines MEMORY index + one memory file; on-demand
### 2026-10-11 fix/campaign-visibility-detail-rpc-velocity — campaign price vs resolve_price: where the override lives and why browse and estimate disagreed
- [ ] target: MEMORY.md (project)   change: add
- text: `Campaign pricing (found 2026-10-11): app.resolve_price / resolve_prices_batch know nothing about campaigns. The campaign price is campaign_items.price_override, layered in the app (enrichBuyerProducts, buyer-assemble-catalog-items, checkout resolveAuthoritativePrices) only for campaigns returned by getVisibleBuyerCatalogs, which for cohort scope needs an OPEN cohort_members row. Membership lands via the dirty-work tick (up to 15 min), so a newly enabled buyer saw General in browse but Error on the estimate. inferCampaignIdForBuyerCart trusts a client campaign_id (share links are audience-open). Fix: app.flush_buyer_membership called from getVisibleBuyerCatalogs. Campaign 2b589a49 (tenant d601c35c) is cohort-scoped to 118f6a96, price list Error; cohort->price-list assignment is deliberately NOT used.`
- why: three sessions of tracing (resolve_price, cohort refresh crons, estimates) to establish; estimates with campaign products but NULL campaign_id timestamped 1-7 min before the buyer's cohort_members.valid_from were the proof.
- cost: ~3 lines MEMORY index + one memory file; on-demand

### 2026-10-11 fix/campaign-visibility-detail-rpc-velocity — never send id lists through PostgREST GET filters
- [ ] target: .claude/rules/data-fetching.md (Query construction)   change: add
- text: `Never put an unbounded id list in a GET .in() filter: the request URL limit (~16 KB, about 400 uuids) returns HTTP 400, and any read of a possibly >1000-row set is silently truncated by PostgREST. Resolve membership server-side (join/RPC taking the parent id) or pass ids in an RPC body; return a single jsonb scalar with an explicit cap and a truncated flag, and fail loudly on truncated.`
- why: app/api/tenant/catalogs/[id]/route.ts sent 459 product + 562 estimate uuids -> 400 on /rest/v1/estimate_items, campaign detail page dead for the live campaign; same class already noted in a comment in that route for buyers.
- cost: 3 lines, path-scoped (loads when data-fetching files are read)

### 2026-10-11 fix/campaign-visibility-detail-rpc-velocity — plpgsql behaviour tests on dev without a persistent push
- [ ] target: .claude/rules/supabase-sql.md (Working against yukti-dev)   change: add
- text: `To exercise a new function without a persistent push: one execute_sql call to yukti-dev = BEGIN; CREATE OR REPLACE FUNCTION ...; DO $$ ... RAISE EXCEPTION 'RESULT %', jsonb_result::text; END $$; — the result comes back in the error text and the whole call rolls back. Dev only: DO blocks are writes under the prod read rules.`
- why: gave real plpgsql execution (ambiguity, casts, kill switch, failure/backoff paths) for 3 RPCs in 5 calls with zero residue (verified: no leftover functions/rows); static contract tests alone had missed that the review needed it.
- cost: 2 lines, path-scoped

### 2026-10-13 docs/vercel-cost-review-2026-10 — PDP tier + fresh:true make HTTP max-age bumps a no-op
- [ ] target: .claude/rules/data-fetching.md (Client-side query caching)   change: add
- text: `Product/family detail and PDP recos use BUYER_PDP_QUERY_* (5 min stale), not BUYER_PRICE_* (15 s); cart/list/resolve stay on BUYER_PRICE_*. Detail fetches use fresh:true (no-store), so raising Cache-Control max-age on priced buyer routes saves nothing — the client stale tier is the lever. Load below-fold rails (recos) via useInViewOnce, never on pointerdown prefetch.`
- why: Oct 9 analysis estimated 10-20% from an HTTP max-age bump; src/hooks/useBuyerProducts.ts prefetch uses fresh:true so it would have been a no-op. PDP triple (page + detail + recos) was ~50% of function Active CPU (Vercel Observability, 24h).
- cost: 1-2 lines, path-scoped

### 2026-10-13 docs/vercel-cost-review-2026-10 — no DB reads in generateMetadata for authenticated buyer pages
- [ ] target: .claude/rules/data-fetching.md (Caching)   change: add
- text: `Authenticated buyer pages: generateMetadata returns a static title; the client sets document.title from the payload it already fetches. A per-open DB lookup for a tab title is billed Fluid Active CPU on every navigation (guest ISR *ForTenant loaders are exempt: cached).`
- why: #187/#191 removed title lookups from PDP, orders, estimates, invoices, category, brand pages (app/(buyer)/buy/**/layout.tsx|page.tsx); Active CPU is the metered Vercel cost after the Pro upgrade.
- cost: 1 line, path-scoped

### 2026-10-17 claude/cart-details-gst-inclusive — Zoho API returns ex-GST amounts for inclusive docs
- [ ] target: docs/architecture.md (pricing/integrations)   change: add
- text: `Zoho sync-back stores API sub_total/tax_total/item_total as-is. For is_inclusive_tax docs Zoho returns them ex-GST (item_total 2669.50 for 3 x 1050 @18%) while the Zoho UI shows 3150, so stored line_total/subtotal/tax_amount of synced estimates are ex-GST. Estimate display surfaces derive lines = qty x unit_price, subtotal = sum, tax 0 when tenant gst_inclusive; invoices still read stored values.`
- why: prod EST-019439 (tenant d601c35c): buyer row line_total 3150 soft-deleted 07:30:16, replaced 07:29:58 by sync row 2669.50; live Zoho GET confirmed sub_total 2669.50 / tax_total 480.50 / total 3150.00. Took ~8 turns to establish.
- cost: 2 lines, always-loaded (or path-scoped to architecture.md)

### 2026-10-17 claude/cart-details-gst-inclusive — worktree verify prerequisites
- [ ] target: CLAUDE.md (Workflow, after the verify.sh line)   change: add
- text: `In a worktree, vitest needs Supabase env: run \`set -a; . <main-checkout>/.env.local; set +a\` first (never dummy values, never print it). If tsc fails only inside \`.next/types\`, move that dir to archived/ and rerun.`
- why: scripts/verify.sh failed on stale .next/types/validator.ts and on "Supabase URL and API key are required" in a fresh worktree; cost ~6 turns incl. a rejected dummy-env run.
- cost: 1-2 lines, always-loaded (could instead live in scripts/verify.sh)

### 2026-10-17 claude/cart-details-gst-inclusive — incident fact for MEMORY.md
- [ ] target: MEMORY.md   change: add
- text: `Zoho raw payload inspection: integration_entity_map.source_payload is empty (size limits). With explicit user OK, call Zoho from inside Postgres via pg_net (token refresh at accounts.zoho.in, then GET /books/v3/estimates/{external_ref}) so the vault token never leaves the DB; read back only numeric fields. Vault secret keys: client_id, client_secret, org_id, refresh_token, region.`
- why: user authorized a one-off vault read on 2026-10-17; this kept the token out of the transcript and command text.
- cost: 2 lines, MEMORY.md

### 2026-10-17 docs/pulse-live-aggregation-rules — KPIs computed at request time from raw tables (reverses snapshot-only rule)
- [ ] target: .claude/rules/metrics.md   change: edit (replace the "KPI cards, page headers, dashboard totals ... must read from `app.*_snapshot`, `app.kpi_*_daily`, or a documented aggregate-backed RPC/read model" bullet; keep its "never from a page slice / optimistic cache" sentence)
- text: `KPIs (cards, headers, dashboard totals) are computed at request time from raw tables with indexed, tenant-scoped, period-bounded queries: one RPC per dashboard band, tenant from JWT, location scope in WHERE, flag-gated (UI and RPC). Use the canonical helpers (metric_day_ist, estimate_status_counts_as_demand, invoice_status_gmv_included, order_status_*, invoice_*), never inline status arrays or date math. Each RPC sets statement_timeout ~3 s; the UI shows a per-band error state. Caching is client-side only (React Query stale time, Cache-Control: private); no server-side result tables. Every new or changed RPC ships EXPLAIN (ANALYZE, BUFFERS) evidence on a high-volume fixture. Do not add precomputed aggregate/summary tables or dirty-queue/tick jobs. Only exception: landing tables for external-source data (e.g. PostHog daily imports). Never derive totals from a page slice or optimistic cache.`
- why: Owner decision 2026-10-17 (Pulse evolution assessment, sections 5 and 8): move away from pre-aggregated compute (metrics tick, summary tables), which caused repeated prod stalls and accuracy drift (see MEMORY.md: Oct 1 and Oct 7 incidents). Prod measurement shows raw transaction tables are ms-level when queried through the day index; the one slow path was a vacuum/visibility-map issue, not a missing precompute. Without this edit the current bullet makes the next session refuse the design.
- cost: net ~0-3 lines, path-scoped (metrics files)

### 2026-10-17 docs/pulse-live-aggregation-rules — Pulse spec 2.8 read-path contract and test line
- [ ] target: specs/Yukti_Pulse-Dashboard_Product-Spec_v1.md (section 2.8 "Read-path contract", first two bullets and the new-snapshot-index bullet; test list line "No request-time aggregation over raw transactional/event tables for dashboard headline metrics.")   change: edit
- text: `Read-path contract: headline metrics, opportunity counts and ranked signals are computed at request time by band-scoped RPCs over indexed raw tables (tenant-scoped, period-bounded, one pass per band), using canonical helpers; no precomputed summary tables, snapshots, dirty queues or tick jobs for these; client-side stale time is the only cache. Raw-table reads stay bounded: SQL-side tenant/location filtering, explicit period cap, explicit limit on lists, no N+1, EXPLAIN (ANALYZE, BUFFERS) evidence on a representative high-volume fixture. Budgets unchanged (aggregate read p95 < 100 ms warm, widget endpoint p95 < 300 ms). Test line becomes: "Every headline-metric RPC has query-plan evidence (index use, tenant/location predicates, period bound) and a statement_timeout with per-band error state."` Index bullet: apply the same index-the-actual-filter/sort-columns guidance to raw-table access paths.
- why: same decision as the rules entry above; 2.8 and its test line currently forbid exactly what the owner decided to do. Spec is gitignored (specs/ not tracked), so this is a local edit in the main checkout.
- cost: spec edit only, 0 always-loaded lines

### 2026-10-17 docs/pulse-live-aggregation-rules — Pulse spec 2.5 period discipline: lift "no trend arrows", default MTD
- [ ] target: specs/Yukti_Pulse-Dashboard_Product-Spec_v1.md (section 2.5 lines "Phase 1 uses current quarter to date ..." and "Phase 1 does not show trend arrows.")   change: edit
- text: `Default Pulse period is month-to-date (MTD), with presets and a custom range; cards display the time basis. Trend indicators are allowed under the comparable-window rule: MTD compares with the same elapsed days of the prior month (equal-length prior window for other periods). Apply volume floors and show "too early to compare" when the window is thin (e.g. first days of a month).`
- why: Owner decision 2026-10-17 (assessment section 8, decisions 1 and 3). The comparable-window rule already in 2.5 ("later period comparisons must be comparable") is what lifts the Phase 1 restriction.
- cost: spec edit only

### 2026-10-17 docs/pulse-live-aggregation-rules — specs/INDEX.md pointer to the Pulse evolution decisions
- [ ] target: specs/INDEX.md (Pulse row, near line 39)   change: edit
- text: add to the Pulse row: `Pulse evolution decisions (2026-10-17: default MTD + custom range, client stale-time-only caching, request-time aggregation on raw tables, no new aggregate tables): pulse-evolution-assessment.md sections 5 and 8; read when changing Pulse periods, KPI read paths or metrics rules.` Place or copy the assessment under specs/ (e.g. specs/pulse-evolution-assessment-2026-10-17.md) first, scrubbed of tenant numbers, since the original contains live-tenant data and must not enter this public repo.
- why: next Pulse session needs to find the decisions via INDEX (CLAUDE.md says "don't glob specs/"). specs/ is gitignored, so this stays local.
- cost: 1 line in a non-always-loaded index

### 2026-10-17 claude/cart-details-gst-inclusive — ignore Vercel build cancellations on non-main PRs
- [ ] target: CLAUDE.md (Workflow, near the PR/CI line)   change: add
- text: `PRs not targeting main: a red "Vercel" check whose log says "Canceled from the Vercel Dashboard" is the owner cancelling previews to save build minutes — not a failure. Don't investigate, redeploy or push empty commits; only a real build ERROR needs fixing.`
- why: PR #220 (base develop) got 3 Auto-fix CI events for Vercel "failures"; the deployments (a7cbe175, 55acbcad) were CANCELED by the owner while the merge commit 4c271e6f built READY. Cost ~4 turns of checking.
- cost: 1-2 lines, always-loaded (could instead sit in the Auto-fix/CI guidance)
### 2026-10-17 feat/slim-buyer-activity-ledger — buyer_app_activity is a daily presence ledger; estimates/orders are not mirrored into it
- [ ] target: .claude/rules/metrics.md (new bullet)   change: add
- text: `app.buyer_app_activity is a presence ledger: one row per buyer / event / IST day (idempotency key d:<event>:<buyer>:<day>, ON CONFLICT DO NOTHING). Never write per-request or per-document rows to it and never add triggers on it. Estimates/orders are not mirrored; engagement readers use app.buyer_app_engagement (ledger UNION is_buyer_app estimates/orders by metric day). "Last seen" from the ledger is day-granular.`
- why: before this change the table held 17x more rows than distinct buyer-days, a 152 ms RPC per call, 313 MB WAL (#1 producer, docs/incidents/2026-10-17-prod-state-and-buyer-call-audit.md F4) and mirror triggers on every estimate/order write; the DB was 26 MiB over plan. A reader/writer that reintroduces per-event rows would undo it.
- cost: 1 bullet, path-scoped (rules auto-load on matching files)

### 2026-10-18 fix/display-stored-line-prices-* — saved documents display from line unit_price, never stored line_total/subtotal or current prices
- [ ] target: .claude/rules/ (new path-scoped bullet, e.g. pricing rule)   change: add
- text: `Estimate/order/invoice detail surfaces (buyer + seller, inbox panels) derive lines as qty x unit_price less disc_pct, subtotal = their sum, tax = 0 ("Included in prices") when business_policy.gst_inclusive else the stored tax_amount, total = subtotal - discount_flat + tax + freight + round_off (computeDisplayDocumentTotals / computeLineTaxableAmount in src/lib/gst.ts). Never render stored line_total/subtotal (ex-GST after Zoho sync-back) or the current resolve_prices_batch price on a saved document; resolved price is only a fallback for hidden-price lines. Not covered yet: ModalConfirmSalesOrder, list-row totals, WhatsApp/PDF document output.`
- why: PRs #220/#223/#224/#225 fixed this surface by surface after a release showed ex-GST lines (invoice WYT/26-27/46568) and an inbox table (current price 3,150) disagreeing with its totals (stored 2,700); each surface had its own math.
- cost: 1 bullet, path-scoped

### 2026-10-23 claude/yukti-email-inbox-spec-a7931d — test an unapplied migration on dev without a push
- [ ] target: .claude/rules/supabase-sql.md (Working against the hosted dev project)   change: add
- text: `To test a migration before it is applied, concatenate BEGIN; + the migration file + a behavior-test file (DO blocks that RAISE EXCEPTION on failure, synthetic fixtures via pg_temp helpers) + ROLLBACK; and run it with supabase db query --linked --file. Nothing persists, the migration itself is exercised. See scripts/sql/run-email-inbox-p1-tests.sh.`
- why: caught three SQL/fixture bugs on dev before any `db push` (this session: 17 scenarios, no persistent writes); the existing bullet only says to wrap "mutation-shaped validation".
- cost: 1 bullet, path-scoped

### 2026-10-23 claude/yukti-email-inbox-spec-a7931d — per-tenant PostHog flag targeting
- [ ] target: docs/architecture.md (feature flags)   change: add
- text: `Flags are evaluated per tenant id as the PostHog distinct_id (resolveTenantFlags -> evaluateFlags(tenantId); edge functions POST /decide with distinct_id=tenantId), no groups. To enable one tenant, add a person-property condition {key: distinct_id, type: person, operator: exact, value: [tenant_id]} (verified via /decide). New df_ flags default off: add them to DEFAULT_OFF_FLAGS in src/lib/server/tenant-flags-resolve.ts. The PostHog project is shared by dev and prod; never create a flag at 100%.`
- why: creating df_email_inbox required finding this by experiment; existing df_whatsapp_inbox is a group flag (aggregation_group_type_index 0) that this evaluation path does not pass groups to, so copying its shape would silently evaluate false.
- cost: 1 bullet, on-demand

### 2026-10-23 claude/yukti-email-inbox-spec-a7931d — do not run pnpm in a worktree with a symlinked node_modules
- [ ] target: CLAUDE.md (Workflow)   change: add (fold into the verify line, 0 net lines if shortened)
- text: `Secondary git worktrees (baseline comparisons): run ./node_modules/.bin/vitest, never pnpm exec; pnpm's deps check tries to re-install and aborts with ERR_PNPM_UNSAFE_MODULES_DIR when node_modules is a symlink.`
- why: `pnpm exec vitest` in a baseline worktree attempted `pnpm install` against the symlinked modules dir; refused only by pnpm's safety check (2 wasted turns).
- cost: 1 line, always-loaded (reject if CLAUDE.md budget is tight)

### 2026-10-23 codex/fix-whatsapp-embedded-signup — branch sweeps must use the fetched remote base
- [ ] target: CLAUDE.md (Workflow)   change: add
- text: `For an unmerged-branch sweep, fetch/prune first and compare every local/remote topic branch against the fetched PR base (for example origin/develop), never a possibly stale local develop. Use patch-equivalence (--cherry-pick / range-diff), not ancestry alone, because squash/rebase and stacked branches otherwise look missing; reconcile obsolete branch history only after verifying the current tree contains or supersedes its behavior.`
- why: local `develop` was 117 commits behind `origin/develop`, initially making already-merged work look like dozens of pending commits; stale stacked WhatsApp branches also had different hashes for functionality already merged through PR #204.
- cost: 1-2 lines, always-loaded

### 2026-10-23 codex/fix-whatsapp-v4-phone-resolution — Embedded Signup cannot depend on browser asset IDs
- [ ] target: MEMORY.md (WhatsApp integration incident note)   change: add
- text: `Meta retired WhatsApp Embedded Signup v2/v3 on 2026-10-15. Yukti launches the Facebook Login for Business configuration without sessionInfoVersion and treats browser waba_id/phone_number_id as optional hints: after exchanging the OAuth code, the server resolves granted WABAs from debug_token granular scopes and phone numbers from /{waba_id}/phone_numbers. Never silently choose when multiple phones are available.`
- why: the live app returned a valid OAuth code after Meta confirmation but no usable WA_EMBEDDED_SIGNUP asset event, reproducing “WhatsApp did not return a business account or phone number”; requiring both IDs client-side blocked onboarding even though Graph authorization succeeded.
- cost: 2-3 lines, on-demand MEMORY.md

### 2026-10-23 codex/fix-whatsapp-v4-phone-resolution — FB.login codes are bound to the SDK popup callback
- [ ] target: MEMORY.md (WhatsApp integration incident note)   change: add
- text: `Meta FB.login popup authorization codes are bound to the SDK-generated redirect_uri (currently the dynamic https://staticxx.facebook.com/x/connect/xd_arbiter/ callback, including its fragment). Capture that exact value from the OAuth popup URL and send it in the server-side code exchange; the app page URL, an omitted redirect_uri, or a reconstructed callback produces OAuth subcode 36008. Strictly allowlist the Meta callback host/path before exchange.`
- why: app.yukti.so reached the PIN step but the live develop callback failed at /oauth/access_token with Meta subcode 36008; the deployed app-ID/secret pair independently validated, and Meta's current debug SDK shows permission_oauth_transform replacing redirect_uri with UIServer.xdHandler.
- cost: 2-3 lines, on-demand MEMORY.md

### 2026-10-23 codex/fix-whatsapp-oauth-redirect — server-side tenant flags require PostHog group context
- [ ] target: docs/architecture.md (feature flags)   change: add
- text: `Server-side evaluations of tenant-targeted PostHog flags must pass both the stable tenant distinct ID and the group context \`groups: { tenant: tenantId }\`, matching the browser's \`posthog.group('tenant', tenantId)\`. A 100% tenant rollout still evaluates false with \`no_group_type\` when the group context is omitted.`
- why: `supabase/functions/whatsapp-inbound-webhook/index.ts` passed only `distinct_id`, causing valid MobileHub inbound messages to be skipped as `feature_disabled`; the same live evaluation changed from `no_group_type`/false to `condition_match`/true when the tenant group was supplied.
- cost: 1-2 lines, on-demand architecture.md

### 2026-10-23 codex/fix-whatsapp-v4-phone-resolution — Embedded Signup cannot depend on browser asset IDs
- [ ] target: MEMORY.md (WhatsApp integration incident note)   change: add
- text: `Meta retired WhatsApp Embedded Signup v2/v3 on 2026-10-15. Yukti launches the Facebook Login for Business configuration without sessionInfoVersion and treats browser waba_id/phone_number_id as optional hints: after exchanging the OAuth code, the server resolves granted WABAs from debug_token granular scopes and phone numbers from /{waba_id}/phone_numbers. Never silently choose when multiple phones are available.`
- why: the live app returned a valid OAuth code after Meta confirmation but no usable WA_EMBEDDED_SIGNUP asset event, reproducing “WhatsApp did not return a business account or phone number”; requiring both IDs client-side blocked onboarding even though Graph authorization succeeded.
- cost: 2-3 lines, on-demand MEMORY.md
### 2026-10-24 claude/sentry-errors-triage-rca-8c6da3 — Zoho webhook slowness is DB saturation; reconcile script needs prod env
- [ ] target: MEMORY.md (incident note)   change: add
- text: `Oct 2026 Sentry triage: Zoho webhook persist_timeout/slow persist (Y/Z/17) tracks prod DB saturation bursts (cron "job startup timeout" at the same minute; RPCs 80ms healthy vs 10-23s burst), not lock contention. ~69% of invoice/estimate webhook events are delivered twice <10s apart (dedupe not yet built). Events orphaned in processing_status='received' after a 150s function kill are never retried. A catalog.integration_types row with empty auth_schema.fields crashed /settings/integrations (fixed: fields default []).`
- why: integration_webhook_events stats Oct 22-24, function_logs sync-checkpoint timings, cron.job_run_details 2026-10-23 09:26.
- cost: 3 lines, on-demand MEMORY.md
- [ ] target: .claude/rules/supabase-sql.md   change: add
- text: `scripts/reconcile-zoho-webhooks.ts reads .env.local from the repo root (absent in worktrees) and targets whatever SUPABASE_URL it finds (dev by default); run with --dry-run first and pass prod URL/service key via env only for an authorized prod run.`
- why: session needed to re-register Zoho webhooks on prod; worktree has no .env.local and .env.local points at yukti-dev.
- cost: 1 line, path-scoped

## Applied log
### 2026-10-09 ops/prod-guard-w1 — one session approval covers a named set of read-only prod query classes
- [x] applied 2026-10-09 — target: CLAUDE.md (Prod safety)   change: edit (same line, no new line)
- text: replace the sentence "Prod **reads** (...): ask once per session, naming the project and what you'll look at; a yes covers read-only queries for that session, not writes." with: `Prod **reads**: ask once per session (name the project); that one yes covers every read in these classes without per-query asks: SELECT and EXPLAIN [ANALYZE] of a SELECT, catalog / pg_stat* / cron.* / migration-history lookups, pg_get_functiondef, query_logs, get_advisors, list_*. Conditions: bounded output (LIMIT/count first), set statement_timeout <= 20 s, never read secrets (vault.decrypted_secrets, tokens) or PII row dumps, check health first if a stall is suspected and stop reading if the instance saturates. Anything else (DO/anonymous blocks, functions with side effects, DML/DDL, nextval, cron.alter_job, config, --linked, db push) is a write.`
- why: 2026-10-07/08 prod incident sessions needed dozens of read-only prod queries (triage, log mining, EXPLAIN); per-query/per-topic approvals were friction for the user ("a headache"); user asked for a single approval for query types, writes stay explicit every time. DO blocks excluded because they can write even when meant to roll back.
- cost: 0 net lines (rewrites the same bullet), always-loaded; prod-db-health skill updated to match

### 2026-10-09 ops/prod-guard-w1 — stale memory index line: v4 metrics now have frontend readers
- [x] applied 2026-10-09 — target: MEMORY.md (project)   change: edit
- text: line 1 "v4 backend is live but no frontend reads it" -> `v4 backend is live; 16 seller API routes call get_landing_metrics_v4 (frontend wired); d601c35c is the LIVE tenant; queue has an unresolved wall-budget-timeout bug (see oct7_prod_stall_and_decisions.md).`
- why: git grep over app/ + src/ + prod edge logs (Oct 2-8) show 164-343 get_landing_metrics_v4 calls/day; the stale line misled the first W2 audit (greps missed src/ and nearly reported "no readers").
- cost: 0 lines, on-demand

## Rejected log
