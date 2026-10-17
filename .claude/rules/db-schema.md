---
paths:
  - "supabase/migrations/**"
  - "supabase/functions/**"
  - "scripts/sql/**"
  - "docs/db/**"
---
# Database map (read before querying or writing SQL)

- **Before any `list_tables` / `information_schema` / guess-the-column query, read `docs/db/INDEX.md`**, then the
  one domain file you need. It lists every `app`/`catalog` table with purpose, columns, FKs, triggers, and every
  RPC with volatility. Gotchas and proven debugging queries: `docs/db/recipes.md`.
- Debugging prod? Check `recipes.md` first (column-name traps, phone formats, WhatsApp/pricing/membership flows).
- When a migration adds or changes a table/function/trigger/cron: add `COMMENT ON ...` with its purpose, then
  regenerate the map (`docs/db/README.md`). `node scripts/db-map.mjs --catalog <snapshot> --check` must pass.
