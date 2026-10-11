# Yukti — Claude Instructions

Sole instruction file. `AGENTS.md` only points here. Detail loads on demand: `.claude/rules/` (auto-loads when matching files are read), `docs/architecture.md`, `specs/INDEX.md`.
Product name is **Yukti** ("DealFlow" was a working title — don't use it in new code, docs or copy; `df_` flag prefixes are legacy, don't rename). Repo is PUBLIC on GitHub — never commit secrets, PII, or confidential business data, even on branches.

## Product & stack (locked — don't debate)
Multi-tenant distributor command center: catalogs, customer-specific pricing, sales documents, buyer ordering, integrations (Indian SMB distributors). Tenant-agnostic: no tenant-specific branches, copy, flags or priorities in code — per-tenant behavior only via tenant settings/flag targeting.
Next.js App Router · React · Tailwind · shadcn/ui · Zod (client+server) · Supabase (Postgres, RLS, Auth, pgvector) · business logic in Postgres RPCs · R2 images · PostHog (analytics+flags) · pg_cron · Vercel · WhatsApp via Meta Cloud API (OTP, broadcasts) · Turnstile · Sentry · **pnpm**.

## Hard rules (always apply)
**Prod safety**
- dev = `yukti-dev` (`hcpzbnmumbykdqveyjhr`). prod = `yukti-prod` (`cckmurgapnkytbzxqesp`). Prod **reads**: ask once per session (name the project); that one yes covers every read in these classes without per-query asks: SELECT and EXPLAIN [ANALYZE] of a SELECT, catalog / `pg_stat*` / `cron.*` / migration-history lookups, `pg_get_functiondef`, `query_logs`, `get_advisors`, `list_*`. Conditions: bounded output (`LIMIT`/`count(*)` first), `statement_timeout` ≤ 20 s, never read secrets (`vault.decrypted_secrets`, tokens) or dump PII rows, health-check first if a stall is suspected and stop reading if the instance saturates. Anything else (DO/anonymous blocks, functions with side effects, DML/DDL, `nextval`, `cron.alter_job`, config, `--linked`, `db push`) is a write. Prod **writes** (SQL, migrations, seeds, function/config/auth/storage changes, `--linked` commands, `db push`): explicit authorization naming the exact action, every time. Earlier write approval never carries over.
- The main checkout may be linked to prod. Before every `--linked` command read the linked ref and require it equals the dev ref; stop on mismatch.
- No Docker/local Supabase (`supabase start`, `db reset --local`, `test db --local`). Never `db reset --linked` or `migration repair` without an explicit documented recovery authorization.
- Persistent `db push --linked` (dev only) needs user approval, after `migration list --linked` and `db push --linked --dry-run`.
- Migrations only via `supabase migration new <name>`. No schema changes in the dashboard.
- Never print, echo, log, inline or commit `SUPABASE_DB_PASSWORD` or any secret.

**Data & security**
- Schema-qualify everything: SQL (`app.`, `catalog.`, `auth.`) and supabase-js (`supabase.schema('app').from(...)`).
- Business tables: uuid PK, `created_at/updated_at/created_by/updated_by`, `deleted_at` soft-delete, `external_ref`, FKs `ON DELETE RESTRICT`. (Metrics V2 operational tables have a narrow exemption — `.claude/rules/supabase-sql.md`.)
- RLS on every `app.*` table. Never trust client `tenant_id`; derive from JWT. New Data API objects: verify schema exposure, grants, RLS.
- Sensitive ops (publish catalog, status change, exports) go through `SECURITY DEFINER` RPCs that re-check role. Features ship behind `df_<module>` flags gating UI **and** RPC.
- KPI numbers come from aggregate snapshots/RPCs, never from a page slice (`.claude/rules/metrics.md`).

**UI/perf one-liners** (full rules auto-load in `.claude/rules/`): seller and buyer apps are both mobile-first and responsive to desktop; style only through tokens in `app/globals.css` (no hardcoded colors/px/font sizes; add a token instead); SPA navigation only (`next/link`); every new `page.tsx` ships a mirroring `loading.tsx`; `next/image` with `unoptimized` + R2 variant; explicit `.limit()` on every list query; buyer GET routes send `Cache-Control: private`.

## Workflow
- Find code with the graph, not grep: `codegraph explore "<question>"`, `codegraph impact <symbol>`, `codegraph callers <symbol>`. Index in `.codegraph/` (gitignored); `codegraph sync` refreshes it.
- Plan mode for changes touching >2 files. Skip brainstorm/plan ceremony when the spec is already clear.
- Verify before saying done: `scripts/verify.sh` (tsc + vitest on tests the graph says are affected by the diff). Widen for auth, middleware, catalog, pricing. Never weaken or delete a test to make it pass.
- Branch → frequent descriptive commits → PR. Never push to main.
- Commits are always signed. Never `--no-gpg-sign` or `commit.gpgsign=false`. If signing hangs or fails: `ssh-add --apple-load-keychain`, retry; still failing → stop and tell the user.
- Before opening a PR or ending a session, run `/wrap`.

## Agents & models (token discipline)
Each subagent restarts cold: it re-pays the full prefix (instructions, tool/skill catalogs) and its own file reads, then the parent pays again for brief + summary. Fan-out costs several × inline.
- **Default inline.** Spawn only when (a) the task would read >10 files or return >5k tokens the parent doesn't need, or (b) tasks are independent and parallel. Max 3 parallel; subagents never spawn subagents.
- Never spawn for edits <3 files, single lookups, or anything already in context. Use `codegraph` before an Explore agent.
- Model: **Sonnet** is the default for all work. **Haiku** for search/summarize/log-triage subagents. **Never use Opus unless the user explicitly asks.**
- Brief = goal, exact paths, output format, size cap ("≤200 words, file:line only"). Return summaries, never file dumps.
- This overrides the global "use subagents for investigation" line.

## Context hygiene
- One task/PR per session. Unrelated task → new session (`/clear`), even if small. Same task → keep going; `/compact` at a natural boundary around 250–300k tokens.
- Bound tool output: `LIMIT`/`count(*)` before `select *` in `execute_sql`; prefer `read_page`/`get_page_text` over screenshots.

## Where to look
| Need | Read |
|---|---|
| Stack, schemas, tenancy, RBAC, flags, pricing, buyer/seller surfaces | `docs/architecture.md` |
| Any spec, plan, audit, execution log | `specs/INDEX.md` (don't glob `specs/`) |
| UI, data-fetching, SQL, metrics rules | `.claude/rules/*.md` (auto) |
| Product/ops incident memory | `MEMORY.md` (auto) |

## Keeping this file alive
`/wrap` proposes context updates into `docs/context-inbox.md` with reasoning; the user reviews and `/context-review` applies. Do not edit this file, `docs/architecture.md`, or `.claude/rules/` directly unless the user asked. Budget: this file ≤100 lines; prefer moving or deleting a line over adding one.
