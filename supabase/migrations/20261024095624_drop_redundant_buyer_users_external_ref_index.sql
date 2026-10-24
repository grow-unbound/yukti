-- Sentry YUKTI-APP-A: concurrent Zoho webhook + sync upserts into app.buyer_users
-- intermittently fail with 23505 on buyer_users_buyer_external_ref_upsert.
-- Two unique indexes cover (buyer_id, external_ref): the unfiltered one is the
-- ON CONFLICT arbiter used by app.bulk_persist_jsonb_records; this partial one
-- (WHERE external_ref IS NOT NULL) is redundant (NULLs are distinct in a unique
-- index) and is NOT an arbiter, so a concurrent insert race on it raises a hard
-- error instead of taking the DO UPDATE path. Keeping only the arbiter makes
-- the race resolve through ON CONFLICT.
DROP INDEX IF EXISTS app.buyer_users_buyer_external_ref_upsert;
