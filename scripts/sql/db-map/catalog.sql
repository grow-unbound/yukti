-- Catalog snapshot for scripts/db-map.mjs. Metadata only (no row data). One row, one jsonb column.
-- Run against DEV with an authenticated CLI, e.g.
--   supabase db query --workdir <tmp dir linked to yukti-dev> --linked --file scripts/sql/db-map/catalog.sql --output-format json > /tmp/db-catalog.json
set statement_timeout = '20s';
select jsonb_build_object(
  'generated_at', now(),
  'tables', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', c.relname, 'kind', c.relkind::text,
      'rls', c.relrowsecurity,
      'comment', obj_description(c.oid, 'pg_class'),
      'est_rows', c.reltuples::bigint,
      'columns', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'n', a.attname, 't', format_type(a.atttypid, a.atttypmod), 'nn', a.attnotnull,
          'c', col_description(c.oid, a.attnum)) order by a.attnum), '[]'::jsonb)
        from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'pk', (
        select coalesce(jsonb_agg(a.attname order by array_position(i.indkey::int2[], a.attnum)), '[]'::jsonb)
        from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = c.oid and i.indisprimary),
      'fks', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'cols', (select jsonb_agg(att.attname) from unnest(k.conkey) u(x) join pg_attribute att on att.attrelid = k.conrelid and att.attnum = u.x),
          'ref', rn.nspname || '.' || rc.relname,
          'del', k.confdeltype::text)), '[]'::jsonb)
        from pg_constraint k join pg_class rc on rc.oid = k.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
        where k.conrelid = c.oid and k.contype = 'f'),
      'triggers', (
        select coalesce(jsonb_agg(jsonb_build_object('name', t.tgname, 'fn', tp.proname, 'def', pg_get_triggerdef(t.oid))), '[]'::jsonb)
        from pg_trigger t join pg_proc tp on tp.oid = t.tgfoid
        where t.tgrelid = c.oid and not t.tgisinternal),
      'policies', (select count(*) from pg_policy p where p.polrelid = c.oid)
    ) order by n.nspname, c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'catalog') and c.relkind in ('r', 'p', 'v', 'm')
      and not c.relispartition),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', p.proname,
      'args', pg_get_function_identity_arguments(p.oid),
      'returns', pg_get_function_result(p.oid),
      'volatility', p.provolatile::text, 'definer', p.prosecdef, 'lang', l.lanname,
      'comment', obj_description(p.oid, 'pg_proc')) order by n.nspname, p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname in ('app', 'catalog') and p.prokind in ('f', 'p')),
  'cron', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', j.jobname, 'schedule', j.schedule, 'active', j.active, 'command', left(j.command, 160))
      order by j.jobname), '[]'::jsonb)
    from cron.job j),
  'enums', (
    select coalesce(jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', t.typname,
      'values', (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid))), '[]'::jsonb)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and n.nspname in ('app', 'catalog'))
) as catalog;
