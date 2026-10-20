import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'supabase/migrations');
const name = readdirSync(dir).find((f) => f.endsWith('_buyer_access_readers_direct_from_raw.sql'))!;
const sql = readFileSync(path.join(dir, name), 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

describe('buyer access readers read raw tables, not metrics_* summaries', () => {
  it('references no metrics summary table or column', () => {
    expect(code).not.toMatch(/metrics_buyer_(now|period)_summary/);
    expect(code).not.toContain('v_period_live');
    expect(code).not.toContain('v_summary_at');
  });

  it('search_buyer_app_access_v4 derives last app purchase and month-to-date spend from source tables', () => {
    const fn = code.slice(code.indexOf('FUNCTION app.search_buyer_app_access_v4'), code.indexOf('FUNCTION app.existing_buyer_context_snapshot'));
    expect(fn).toContain('i.is_buyer_app_invoice');
    expect(fn).toContain('o.is_buyer_app_order');
    expect(fn).toContain('app.invoice_status_gmv_included(i.status)');
    expect(fn).toContain('app.estimate_status_counts_as_demand(e.status)');
    expect(fn).toContain("date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')");
    expect(fn).toContain('IN (SELECT id FROM buyers_to_enrich)');
  });

  it('existing_buyer_context_snapshot is always live and returns app engagement', () => {
    const fn = code.slice(code.indexOf('FUNCTION app.existing_buyer_context_snapshot'));
    expect(fn).toContain("'app_engagement'");
    expect(fn).toContain('is_buyer_app_invoice');
    expect(fn).toContain("'period', 'live'");
  });

  it('keeps the function signatures (CREATE OR REPLACE, no DROP)', () => {
    expect(code).not.toMatch(/DROP FUNCTION/i);
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
  });
});
