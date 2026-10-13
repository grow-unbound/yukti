#!/usr/bin/env python3
"""Permission classifier for Supabase MCP calls (PreToolUse + PostToolUse).

Replaces "ask on every call that names prod" with "ask once per session, then auto-allow
read-only calls", matching the rule in CLAUDE.md:

  prod reads  -> one approval per session covers SELECT / EXPLAIN / catalog / logs / advisors / list_*
  prod writes -> ask every time (apply_migration, DDL/DML, DO, side-effect functions, deploy, ...)
  dev reads   -> allowed without a prompt; dev writes fall through to the normal permission flow

How "once per session" works without hook state: the first prod read-class call asks (PreToolUse
returns `ask`). PostToolUse only fires after the call actually ran, i.e. the user approved it, so it
writes a marker file keyed by session_id. Later read-class prod calls in that session find the marker
and are allowed. A write-class call never creates or consumes the marker.

Fails closed: any parse problem -> `ask`. stdlib only (no jq/pip).

Usage: prod_sql_guard.py pre|post   (hook JSON on stdin)
"""
import json
import os
import re
import sys
import tempfile
import time

PROD_REF = "cckmurgapnkytbzxqesp"
DEV_REF = "hcpzbnmumbykdqveyjhr"
MARKER_TTL_SECONDS = 12 * 3600
MAX_STATEMENT_TIMEOUT_MS = 20_000

# Tools that only read. execute_sql additionally needs the SQL classifier below.
READ_TOOLS = {
    "query_logs", "get_advisors", "list_tables", "list_extensions", "list_migrations",
    "list_edge_functions", "get_edge_function", "list_branches", "generate_typescript_types",
    "get_project", "get_organization", "list_projects", "list_organizations", "get_project_url",
    "search_docs", "get_cost",
}

# Schema-qualified calls we know are read-only. Anything else in app/catalog could write.
SAFE_APP_FN = re.compile(r"^(resolve_price|resolve_prices_batch|find_|get_|search_|derive_)")
DENY_SCHEMA_CALLS = {"net", "vault", "auth", "cron", "extensions", "supabase_migrations", "storage"}

DENY_WORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call|do|perform|"
    r"execute|lock|comment|refresh|reindex|cluster|listen|notify|reset|into|begin|commit|rollback|"
    r"savepoint|prepare|deallocate|discard|import|security|merge|upsert)\b"
)
DENY_FUNCS = re.compile(
    r"\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_advisory\w*|pg_notify|"
    r"pg_reload_conf|pg_read_\w+|pg_ls_\w+|pg_stat_reset\w*|lo_\w+|dblink\w*|http_post|http_get|"
    r"http_delete|http_put|pg_switch_wal|pg_create_\w+|pg_drop_\w+)\s*\("
)
FOR_LOCK = re.compile(r"\bfor\s+(no\s+key\s+)?(update|share)\b")
SENSITIVE = re.compile(
    r"(decrypted_secrets|\bvault\.|\bauth\.(users|identities|sessions|refresh_tokens|mfa_\w+|"
    r"one_time_tokens)\b|otp_sessions|password|secret|api_key|credential|access_token|refresh_token|"
    r"encrypted)"
)
AGGREGATE = re.compile(
    r"\b(count|sum|avg|min|max|string_agg|array_agg|bool_and|bool_or|json_agg|jsonb_agg)\s*\("
)
CATALOG = re.compile(r"\b(pg_[a-z_]+|information_schema)\b")
ALLOWED_START = re.compile(r"^(select|with|explain|show|values|table)\b|^set\s+(local\s+)?statement_timeout\b")
QUALIFIED_CALL = re.compile(r"\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(")
TIMEOUT = re.compile(r"statement_timeout\s*(?:=|to)\s*'?\s*(\d+)\s*(ms|min|s)?\s*'?")


def _sanitize(sql: str) -> str:
    """Drop comments and string/dollar-quoted bodies so keywords inside data cannot trip the scan
    (e.g. reason = 'buyers_update'). Quotes are kept as '' so structure stays intact."""
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        two = sql[i:i + 2]
        if two == "--":
            j = sql.find("\n", i)
            i = n if j == -1 else j
            continue
        if two == "/*":
            j = sql.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if c == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'" and sql[j + 1:j + 2] == "'":
                    j += 2
                    continue
                if sql[j] == "'":
                    break
                j += 1
            out.append("''")
            i = j + 1
            continue
        if c == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                out.append("$$ ")  # a dollar-quoted body is code (DO/CREATE FUNCTION): flag it
                out.append("do ")
                i = n if j == -1 else j + len(tag)
                continue
        out.append(c)
        i += 1
    return "".join(out)


def classify_sql(sql: str):
    """Return (True, "") when the SQL is a bounded, read-only query, else (False, reason)."""
    if not isinstance(sql, str) or not sql.strip():
        return False, "empty query"
    code = _sanitize(sql).lower()
    statements = [s.strip() for s in code.split(";") if s.strip()]
    if not statements:
        return False, "empty query"
    for s in statements:
        if not ALLOWED_START.match(s):
            return False, f"statement is not a SELECT/EXPLAIN/SHOW: '{s[:40]}'"
    body = " ".join(s for s in statements if not s.startswith("set "))
    if not body:
        return False, "no read statement"
    m = DENY_WORDS.search(body)
    if m:
        # `explain analyze select` is fine; ANALYZE is not in DENY_WORDS.
        return False, f"contains write/side-effect keyword '{m.group(1)}'"
    if DENY_FUNCS.search(body):
        return False, "calls a side-effect function"
    if FOR_LOCK.search(body):
        return False, "row-locking select"
    if SENSITIVE.search(body):
        return False, "touches secrets/PII-sensitive objects"
    for schema, fn in QUALIFIED_CALL.findall(body):
        if schema in DENY_SCHEMA_CALLS:
            return False, f"calls {schema}.{fn}()"
        if schema in ("app", "catalog") and not SAFE_APP_FN.match(fn):
            return False, f"calls {schema}.{fn}() which may have side effects"
    # Read the timeout from the raw text: sanitizing blanks out the quoted '15s' literal.
    t = TIMEOUT.search(sql.lower())
    if not t:
        return False, "no statement_timeout (<= 20s) set"
    value, unit = int(t.group(1)), t.group(2) or "ms"
    ms = value * {"ms": 1, "s": 1000, "min": 60000}[unit]
    if ms > MAX_STATEMENT_TIMEOUT_MS:
        return False, "statement_timeout above 20s"
    if not ("limit" in re.findall(r"\b[a-z_]+\b", body) or AGGREGATE.search(body) or CATALOG.search(body)):
        return False, "unbounded select: add LIMIT or aggregate"
    return True, ""


def _tool_suffix(tool_name: str) -> str:
    return tool_name.split("__")[-1] if tool_name else ""


def classify_call(tool_name: str, tool_input: dict):
    """-> (is_read, reason)"""
    suffix = _tool_suffix(tool_name)
    if suffix == "execute_sql":
        return classify_sql(tool_input.get("query", ""))
    if suffix in READ_TOOLS:
        return True, ""
    return False, f"{suffix or 'tool'} can change production state"


def _marker_path(session_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id or "") or "nosession"
    return os.path.join(tempfile.gettempdir(), f"yukti-prod-read-ok-{safe}")


def _marker_valid(session_id: str) -> bool:
    try:
        return time.time() - os.path.getmtime(_marker_path(session_id)) < MARKER_TTL_SECONDS
    except OSError:
        return False


def _emit(decision: str, reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}))


def _project_of(tool_input: dict, raw: str) -> str:
    pid = tool_input.get("project_id") if isinstance(tool_input, dict) else None
    if pid in (PROD_REF, DEV_REF):
        return pid
    if PROD_REF in raw:
        return PROD_REF
    return pid or ""


def pre(data: dict) -> None:
    tool = data.get("tool_name", "")
    if not tool.startswith("mcp__"):
        return  # Bash etc: handled by guard-prod.sh
    tool_input = data.get("tool_input") or {}
    raw = json.dumps(tool_input)
    project = _project_of(tool_input, raw)
    is_read, why = classify_call(tool, tool_input)

    if project == PROD_REF:
        if not is_read:
            _emit("ask", f"Production write/unsafe call ({why}). CLAUDE.md: explicit authorization "
                         "naming this exact action, every time.")
        elif _marker_valid(data.get("session_id", "")):
            _emit("allow", "Read-only prod call; prod reads were approved earlier this session.")
        else:
            _emit("ask", "First production read this session (project yukti-prod). Approve once: "
                         "later read-only calls (SELECT/EXPLAIN/catalog/logs/advisors/list_*) in this "
                         "session run without a prompt; writes always ask.")
    elif project == DEV_REF and is_read:
        _emit("allow", "Read-only call on yukti-dev.")
    # anything else (dev writes, unknown project): fall through to the normal permission flow


def post(data: dict) -> None:
    tool = data.get("tool_name", "")
    if not tool.startswith("mcp__"):
        return
    tool_input = data.get("tool_input") or {}
    if _project_of(tool_input, json.dumps(tool_input)) != PROD_REF:
        return
    is_read, _ = classify_call(tool, tool_input)
    if not is_read:
        return
    try:
        with open(_marker_path(data.get("session_id", "")), "w") as fh:
            fh.write(str(int(time.time())))
    except OSError:
        pass


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "pre"
    try:
        data = json.load(sys.stdin)
    except Exception:
        if mode == "pre":
            _emit("ask", "Could not parse hook input; failing closed.")
        return
    try:
        (pre if mode == "pre" else post)(data)
    except Exception as exc:  # fail closed
        if mode == "pre":
            _emit("ask", f"Prod guard error ({type(exc).__name__}); failing closed.")


if __name__ == "__main__":
    main()
