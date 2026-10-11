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
