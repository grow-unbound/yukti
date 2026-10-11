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

### 2026-10-11 fix/zoho-item-gst-rate — Zoho India GST rates live in item_tax_preferences; vitest red masked by Deno guard
- [ ] target: .claude/rules (new or integrations rule, path-scoped to supabase/functions/_shared/integrations-*.ts)   change: add
- text: `Zoho India GST orgs return top-level item tax_percentage=0; real rates are in /items list item_tax_preferences[] (tax_specification intra|inter). Use resolveZohoItemGstRate. No detail fetch needed. Verified against real dev payload 2026-10-11.`
- why: all 459 d601c35c products synced gst_rate=0; assumed a detail fetch was needed until a live probe showed the list already carries it.
- cost: 2 lines, path-scoped
- [ ] target: MEMORY.md (project)   change: add
- text: `Zoho test suites zoho-customer-transaction-sync (3 tests) and zoho-transaction-sync (1) are red on main since before 2026-10-11 (stub lacks .not, R2 source_payload assertions stale, phase plan has 5 not 3 phases); were masked by "Deno is not defined" until sync-log.ts guard.`
- why: wrap gate stays red on any Zoho persist change until these are fixed; costs a stash comparison to prove pre-existing.
- cost: 2 lines MEMORY index + one memory file; on-demand

## Applied log
## Rejected log
