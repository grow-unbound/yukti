# docs/db — agent-readable database map

Start at [INDEX.md](INDEX.md). Knowledge you can't derive from the catalog: [recipes.md](recipes.md).

## What's generated vs hand-written
| File | Source |
|---|---|
| `INDEX.md`, `<domain>.md`, `cron.md` | **generated** by `scripts/db-map.mjs` (catalog snapshot + migration headers) — do not edit |
| `purposes.json` | hand-written one-liners (precedence: DB `COMMENT ON` > this file > migration header) |
| `recipes.md`, `README.md` | hand-written |
| `.claude/hooks/safe_functions.json` | generated alongside: STABLE/IMMUTABLE functions the prod-read hook may auto-allow |

## Regenerate (after a migration that adds/changes tables, columns, functions, triggers or cron)
```bash
# 1. snapshot catalog metadata from DEV (never prod; metadata only). Authenticated CLI, temp workdir linked to yukti-dev:
supabase db query --workdir "$DEV_WORKDIR" --linked --file scripts/sql/db-map/catalog.sql --output-format json > /tmp/db-catalog.json
# 2. build
node scripts/db-map.mjs --catalog /tmp/db-catalog.json
# 3. staleness check (CI / /wrap): exits 1 if docs/db or safe_functions.json differ from the snapshot
node scripts/db-map.mjs --catalog /tmp/db-catalog.json --check
```
Dev must have the migration applied first (the map reflects the snapshot, not the repo).

## Keeping purposes good
New table/function? Put the purpose in the migration: `COMMENT ON TABLE app.x IS '...'; COMMENT ON FUNCTION ...;`
It then shows in the map (and in the Supabase dashboard / `list_tables`) with no extra file to maintain.
Entries prefixed `~` in the map are inferred from migration header comments — verify before relying on them.
