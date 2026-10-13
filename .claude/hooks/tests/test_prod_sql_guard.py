"""Run: python3 -m unittest discover -s .claude/hooks/tests -v"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import prod_sql_guard as g  # noqa: E402

PROD = g.PROD_REF
DEV = g.DEV_REF
T = "set statement_timeout='15s'; "


def run(mode, tool, tool_input, session="s-test"):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        (g.pre if mode == "pre" else g.post)({"tool_name": tool, "tool_input": tool_input, "session_id": session})
    text = out.getvalue().strip()
    return json.loads(text)["hookSpecificOutput"]["permissionDecision"] if text else None


class ClassifySql(unittest.TestCase):
    def ok(self, sql):
        okay, why = g.classify_sql(sql)
        self.assertTrue(okay, f"expected read-only, got: {why}\n{sql}")

    def bad(self, sql, needle=""):
        okay, why = g.classify_sql(sql)
        self.assertFalse(okay, f"expected rejection:\n{sql}")
        self.assertIn(needle, why)

    def test_typical_reads_pass(self):
        self.ok(T + "select count(*) from app.buyers where tenant_id='x';")
        self.ok(T + "select id from app.buyers where reason = 'buyers_update' limit 5;")  # keyword inside a string
        self.ok(T + "with a as (select 1) select * from a limit 3;")
        self.ok(T + "select table_name from information_schema.tables where table_schema='app';")
        self.ok(T + "select pg_get_functiondef(p.oid) from pg_proc p limit 1;")
        self.ok(T + "select * from app.resolve_prices_batch(array['a'::uuid], 'b'::uuid, 1) limit 50;")
        self.ok("set statement_timeout=15000; select count(*) from app.entries;")  # bare number = ms
        self.ok(T + "explain analyze select id from app.buyers limit 1;")
        self.ok(T + "select updated_at, deleted_at, created_by from app.buyers limit 1;")  # *_at columns

    def test_writes_rejected(self):
        for stmt in [
            "insert into app.buyers(id) values (1)", "update app.buyers set phone=null",
            "delete from app.entries", "drop table app.buyers", "alter table app.buyers add x int",
            "truncate app.buyers", "create index i on app.buyers(id)", "grant select on app.buyers to x",
        ]:
            self.bad(T + stmt + " limit 1;")

    def test_side_effects_rejected(self):
        self.bad(T + "select app.flush_buyer_membership('a','b') limit 1;", "side effects")
        self.bad(T + "select nextval('s') limit 1;", "side-effect")
        self.bad(T + "select net.http_post(url:='x') limit 1;", "side-effect")
        self.bad(T + "select cron.alter_job(1) limit 1;", "cron.alter_job")
        self.bad(T + "do $$ begin perform 1; end $$;")
        self.bad(T + "select * from app.buyers limit 1 for update;")
        self.bad(T + "select * into app.t from app.buyers limit 1;")
        self.bad(T + "select 1 limit 1; delete from app.buyers;")  # second statement
        self.bad("begin; " + T + "select 1 limit 1; rollback;")  # explicit txn is not read-class

    def test_secrets_rejected(self):
        self.bad(T + "select * from vault.decrypted_secrets limit 1;", "secrets")
        self.bad(T + "select encrypted_password from auth.users limit 1;", "secrets")

    def test_unbounded_and_timeout(self):
        self.bad(T + "select * from app.buyers;", "unbounded")
        self.bad("select * from app.buyers limit 1;", "statement_timeout")
        self.bad("set statement_timeout='60s'; select * from app.buyers limit 1;", "above 20s")
        self.bad("set statement_timeout='1min'; select * from app.buyers limit 1;", "above 20s")


class HookFlow(unittest.TestCase):
    def setUp(self):
        self.session = f"unit-{os.getpid()}-{self._testMethodName}"
        with contextlib.suppress(OSError):
            os.remove(g._marker_path(self.session))

    def tearDown(self):
        with contextlib.suppress(OSError):
            os.remove(g._marker_path(self.session))

    def q(self, project, sql=T + "select count(*) from app.buyers;"):
        return {"project_id": project, "query": sql}

    def test_first_prod_read_asks_then_allows_after_post(self):
        tool = "mcp__x__execute_sql"
        self.assertEqual(run("pre", tool, self.q(PROD), self.session), "ask")
        run("post", tool, self.q(PROD), self.session)  # user approved, call ran
        self.assertEqual(run("pre", tool, self.q(PROD), self.session), "allow")
        # other read tools ride the same approval
        self.assertEqual(run("pre", "mcp__x__query_logs", {"project_id": PROD, "sql": "select 1"}, self.session), "allow")
        self.assertEqual(run("pre", "mcp__x__get_advisors", {"project_id": PROD, "type": "security"}, self.session), "allow")

    def test_prod_writes_always_ask_even_with_marker(self):
        run("post", "mcp__x__execute_sql", self.q(PROD), self.session)
        self.assertEqual(run("pre", "mcp__x__apply_migration", {"project_id": PROD, "name": "n", "query": "select 1"}, self.session), "ask")
        self.assertEqual(run("pre", "mcp__x__execute_sql", self.q(PROD, T + "update app.buyers set phone=null where id=1"), self.session), "ask")
        self.assertEqual(run("pre", "mcp__x__deploy_edge_function", {"project_id": PROD}, self.session), "ask")
        self.assertEqual(run("pre", "mcp__x__get_publishable_keys", {"project_id": PROD}, self.session), "ask")

    def test_write_approval_does_not_grant_read_marker(self):
        run("post", "mcp__x__apply_migration", {"project_id": PROD, "name": "n", "query": "x"}, self.session)
        run("post", "mcp__x__execute_sql", self.q(PROD, T + "delete from app.buyers"), self.session)
        self.assertEqual(run("pre", "mcp__x__execute_sql", self.q(PROD), self.session), "ask")

    def test_marker_is_per_session(self):
        run("post", "mcp__x__execute_sql", self.q(PROD), self.session)
        self.assertEqual(run("pre", "mcp__x__execute_sql", self.q(PROD), self.session + "-other"), "ask")

    def test_dev_reads_allowed_dev_writes_fall_through(self):
        self.assertEqual(run("pre", "mcp__x__execute_sql", self.q(DEV), self.session), "allow")
        self.assertIsNone(run("pre", "mcp__x__apply_migration", {"project_id": DEV, "name": "n", "query": "x"}, self.session))

    def test_non_mcp_is_ignored(self):
        self.assertIsNone(run("pre", "Bash", {"command": "ls"}, self.session))


if __name__ == "__main__":
    unittest.main()
