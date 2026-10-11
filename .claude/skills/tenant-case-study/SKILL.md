---
name: tenant-case-study
description: Build a tenant usage & business-impact report (internal data pack, shareable tenant report, draft highlights note; HTML + Markdown) for one tenant and a date range, or a portfolio snapshot across several tenants. Estimates → invoices by month, DAU/WAU/MAU, retention, funnel, top buyers/products, viewed-but-not-ordered, payment status. Use for case studies, QBRs, "how did tenant X do since <date>".
---
Reads **prod** (yukti-prod, read-only). Output goes **outside the repo** (`~/projects/yukti-case-studies/<label>_<start>_<end>/`) — reports contain tenant business data and this repo is public. Never commit run folders.

## Inputs (ask only for what is missing)
- **Tenant(s):** name/slug → resolve to UUID(s); or "portfolio" = a few named live tenants (never blindly "all" — confirm the list).
- **start_date, end_date** (inclusive, IST). Latest period may be partial; reports label it.
- Optional: `--prepaid` (tenant mostly upfront payment), `--anonymize-buyers` (tenant report), `--no-tenant-share`.

## Prod safety (CLAUDE.md rules apply)
Ask once per session, naming project `yukti-prod` (`cckmurgapnkytbzxqesp`) and what you will read (aggregate SELECTs over estimates, invoices, buyers, activity, products, audit/broadcast counts for the named tenants); a yes covers read-only queries for the session. Only run the rendered `sql/*.sql` files — all are SELECT-only. Never write to prod. PostHog uses `POSTHOG_PERSONAL_API_KEY` from the repo `.env.local`; never print or log it.

## Run
`S=.claude/skills/tenant-case-study/scripts` (relative to repo root)

1. **Resolve tenant** (execute_sql, prod): `select id, business_name, slug, plan from app.tenants where deleted_at is null and business_name ilike '%<name>%';`
   Portfolio candidates: tenants with buyer-app estimates in the window (`select tenant_id, count(*) from app.estimates where is_buyer_app_estimate and estimate_date between '<start>' and '<end>' group by 1 order by 2 desc`).
2. **Init:** `python3 $S/yukti_case.py init --tenants <uuid[,uuid]> --start YYYY-MM-DD --end YYYY-MM-DD --label <slug>` → prints the run dir, writes `meta.json` and `sql/q01…q08, q10, q11` (q09 comes from the PostHog step).
3. **Run each `sql/qNN_*.sql`** with `execute_sql` on prod (they are independent: run in parallel). Each returns one row `d` (jsonb). Save the result as `<run>/data/qNN.json` — the JSON array between the `<untrusted-data…>` tags (`[{"d": …}]`); the loader also accepts the raw tool output. q01–q07 are required for a full report (q02 + q05 minimum); q08 (seller/WhatsApp context), q10 (buyer-app orders) and q11 (reconciliation with the Pulse `metrics_*` aggregates) feed the internal report; q11 also lists data gaps between this report and `/pulse`.
4. **PostHog (optional, recommended):** `python3 $S/yukti_case.py posthog --run <run>` → `data/posthog.json` (independent MAU/WAU/DAU, product views + carts, inquiry events) and renders `sql/q09_views.sql` (top products by viewers). Run q09 → `data/q09.json`. If PostHog fails/unconfigured, skip; sections drop out.
5. **Build:** `python3 $S/yukti_case.py build --run <run> [--audience both|internal|tenant] [--prepaid] [--anonymize-buyers]`. Single tenant → `reports/<slug>-{internal,tenant}.{html,md}` + `<slug>-note.md`. Several → one folder per tenant + `reports/portfolio.{html,md}`.
6. **Review before handing over:** read the internal "findings & data issues" list (auto-detected: source mismatches, stale open quotes, unmatched invoices, partial period, thin seller/WhatsApp use). Edit `<slug>-note.md` (draft highlights/opportunities — numbers are computed, wording is a draft). Send tenant files with `SendUserFile`.

Page/PR rule: the skill itself lives in the repo; follow branch → PR, never push to main.

## Definitions (see `references/definitions.md` for caveats)
- **Yukti-native estimate** = `estimates.is_buyer_app_estimate`. Never use `source = 'buyer_app'` alone (a sync bug can overwrite `source`). Everything else (e.g. Zoho imports, mostly drafts) is "other" and appears only as context.
- **Converted** = `estimates.status = 'invoiced'`; month = `estimate_date` (IST). **Closed** quotes = invoiced + expired + declined; **open** = sent/accepted.
- **Canonical rules** (same as the metrics dictionary / refresh pipeline): day = `app.metric_day_ist(estimate_date, created_at)`; demand excludes `void` (`estimate_status_counts_as_demand`); GMV invoices use `invoice_status_gmv_included`.
- **Active buyer** = distinct `buyer_id` with a qualifying `buyer_app_activity` event; DAU/WAU/MAU on IST dates, Avg DAU over all calendar days of the period.
- **Payment status** = best-match invoice (estimate link, else same buyer+amount within 10 days). Unmatched invoiced estimates are reported, not guessed.

## Honesty rules for the narrative
No causal claims ("Yukti drove…"); say what the data shows. State partial periods, no counterfactual, and non-app invoicing. For prepaid tenants do not headline paid share. Surges can be deliberate onboarding batches — ask the owner before interpreting a jump.

## Files
`scripts/yukti_case.py` (CLI) · `scripts/report.py` (renderer) · `sql/q01–q08, q10, q11` (+ `q09_views.sql.tpl`) · `references/definitions.md`.
