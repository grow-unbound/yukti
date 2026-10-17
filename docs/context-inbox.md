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
