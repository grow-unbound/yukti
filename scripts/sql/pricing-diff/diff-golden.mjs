#!/usr/bin/env node
// Usage: node diff-golden.mjs before.json after.json
// Each file is the JSON from `supabase db query --output-format json --file golden.sql`
// (possibly preceded by pnpm banner lines). Exits 1 on any difference or if either side is empty.
import { readFileSync } from 'node:fs';

function load(path) {
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return parsed.rows ?? [];
}
const key = (r) => `${r.fn}|${r.buyer_id ?? ''}|${r.tenant_product_id}`;
const [beforePath, afterPath] = process.argv.slice(2);
const before = new Map(load(beforePath).map((r) => [key(r), String(r.unit_price)]));
const after = new Map(load(afterPath).map((r) => [key(r), String(r.unit_price)]));
if (before.size === 0 || after.size === 0) {
  console.error('empty dump: refusing to call that a pass');
  process.exit(1);
}
let diffs = 0;
for (const [k, v] of before) {
  if (!after.has(k)) { diffs += 1; if (diffs <= 20) console.log('missing after:', k); }
  else if (after.get(k) !== v) { diffs += 1; if (diffs <= 20) console.log('price differs:', k, v, '->', after.get(k)); }
}
for (const k of after.keys()) if (!before.has(k)) { diffs += 1; if (diffs <= 20) console.log('new row:', k); }
console.log(`rows before=${before.size} after=${after.size} diffs=${diffs}`);
process.exit(diffs === 0 ? 0 : 1);
