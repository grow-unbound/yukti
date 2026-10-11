#!/usr/bin/env python3
"""Tenant case-study pipeline (deterministic parts). No secrets are stored or printed.

  init     render parameterised SQL templates into a run directory
  posthog  fetch product/usage analytics from PostHog (REST HogQL) and render the view-join SQL
  build    render internal / tenant / portfolio reports (HTML + Markdown) from saved query results

Run directory layout (default ~/projects/yukti-case-studies/<label>_<start>_<end>/ — outside the public repo):
  meta.json  sql/qNN_*.sql  data/qNN.json  data/posthog.json  reports/*
"""
import argparse, json, re, sys, urllib.request, urllib.error
from datetime import date, datetime, timedelta
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
REPO = SKILL.parents[2]
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ROLES = ("buyer_admin", "buyer_assistant", "buyer_pending")


def parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def load_meta(run):
    return json.loads((Path(run) / "meta.json").read_text())


def render(sql, meta):
    tenants = ",".join(f"'{t}'" for t in meta["tenant_ids"])
    return (sql.replace("{{TENANTS}}", tenants).replace("{{START}}", meta["start"])
               .replace("{{END_EXCL}}", meta["end_excl"]).replace("{{END}}", meta["end"]))


# ---------------------------------------------------------------------------- init
def cmd_init(a):
    ids = [t.strip().lower() for t in a.tenants.split(",") if t.strip()]
    bad = [t for t in ids if not UUID.match(t)]
    if not ids or bad:
        sys.exit(f"tenant ids must be UUIDs, got: {bad or a.tenants!r}")
    start, end = parse_date(a.start), parse_date(a.end)
    if end < start:
        sys.exit("end must be >= start")
    label = re.sub(r"[^a-z0-9-]+", "-", (a.label or ("portfolio" if len(ids) > 1 else ids[0][:8])).lower()).strip("-")
    out = Path(a.out or Path.home() / "projects" / "yukti-case-studies" / f"{label}_{start}_{end}").expanduser()
    meta = {"tenant_ids": ids, "start": str(start), "end": str(end), "end_excl": str(end + timedelta(days=1)),
            "label": label, "created": datetime.now().isoformat(timespec="seconds")}
    (out / "sql").mkdir(parents=True, exist_ok=True)
    (out / "data").mkdir(exist_ok=True)
    (out / "reports").mkdir(exist_ok=True)
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    for f in sorted((SKILL / "sql").glob("q*.sql")):
        (out / "sql" / f.name).write_text(render(f.read_text(), meta))
    print(f"run dir: {out}")
    print("SQL to run against yukti-prod (read-only), save each result to data/<qNN>.json:")
    for f in sorted((out / "sql").glob("q*.sql")):
        print(f"  {f.name}  ->  data/{f.name.split('_')[0]}.json")


# ---------------------------------------------------------------------------- posthog
def ph_config(env_path):
    env = {}
    for line in Path(env_path).read_text().splitlines():
        m = re.match(r"^(POSTHOG_PERSONAL_API_KEY|POSTHOG_PROJECT_ID|NEXT_PUBLIC_POSTHOG_HOST)=(.*)$", line.strip())
        if m:
            env[m.group(1)] = m.group(2).strip().strip("\"'")
    missing = {"POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID", "NEXT_PUBLIC_POSTHOG_HOST"} - set(env)
    if missing:
        sys.exit(f"missing in {env_path}: {sorted(missing)}")
    host = env["NEXT_PUBLIC_POSTHOG_HOST"].replace(".i.posthog.com", ".posthog.com").rstrip("/")
    return host, env["POSTHOG_PROJECT_ID"], env["POSTHOG_PERSONAL_API_KEY"]


def hogql(cfg, query):
    host, pid, key = cfg
    req = urllib.request.Request(f"{host}/api/projects/{pid}/query/",
                                 data=json.dumps({"query": {"kind": "HogQLQuery", "query": query}}).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))["results"]
    except urllib.error.HTTPError as e:
        sys.exit(f"PostHog HTTP {e.code}: {e.read().decode()[:300]}")


def cmd_posthog(a):
    meta = load_meta(a.run)
    cfg = ph_config(a.env or REPO / ".env.local")
    lo = f"toDateTime('{meta['start']} 00:00:00','Asia/Kolkata')"
    hi = f"toDateTime('{meta['end_excl']} 00:00:00','Asia/Kolkata')"
    roles = ",".join(f"'{r}'" for r in ROLES)
    out, values = {}, []
    for tid in meta["tenant_ids"]:
        W = f"timestamp >= {lo} and timestamp < {hi} and properties.tenant_id='{tid}'"
        PV = f"{W} and event='$pageview' and properties.role in ({roles})"
        monthly = hogql(cfg, f"select toStartOfMonth(toTimeZone(timestamp,'Asia/Kolkata')) m, count(distinct properties.buyer_id) from events where {PV} group by m order by m")
        weekly = hogql(cfg, f"select toStartOfWeek(toTimeZone(timestamp,'Asia/Kolkata'),1) w, count(distinct properties.buyer_id) from events where {PV} group by w order by w")
        dau = hogql(cfg, f"select toStartOfMonth(d) m, round(avg(b),1), max(b) from (select toDate(toTimeZone(timestamp,'Asia/Kolkata')) d, count(distinct properties.buyer_id) b from events where {PV} group by d) group by m order by m")
        prods = hogql(cfg, (
            f"select v.pid, v.viewers, v.views, coalesce(c.carters,0) from "
            f"(select properties.tenant_product_id pid, count(distinct properties.buyer_id) viewers, count() views from events where {W} and event='product_viewed' "
            f"and properties.role in ({roles}) and properties.buyer_id is not null group by pid) v "
            f"left join (select properties.tenant_product_id pid, count(distinct properties.buyer_id) carters from events where {W} "
            f"and event in ('catalog_item_added_to_cart','buyer_cart_item_quantity_changed') and properties.buyer_id is not null group by pid) c on v.pid=c.pid "
            f"order by v.viewers desc limit 300"))
        inq = hogql(cfg, f"select count(), count(distinct properties.buyer_id) from events where {W} and event='inquiry_created'")
        first_pv = hogql(cfg, f"select min(timestamp) from events where {W} and event='product_viewed'")
        d10 = lambda x: str(x)[:10]
        out[tid] = {
            "monthly": [{"month": d10(r[0])[:7], "buyers": r[1]} for r in monthly],
            "weekly": [{"wk": d10(r[0]), "buyers": r[1]} for r in weekly],
            "dau": [{"month": d10(r[0])[:7], "avg": r[1], "peak": r[2]} for r in dau],
            "products": [{"pid": r[0], "viewers": r[1], "views": r[2], "carters": r[3]} for r in prods if r[0]],
            "inquiry": {"events": inq[0][0], "buyers": inq[0][1]} if inq else {},
            "first_product_view": d10(first_pv[0][0]) if first_pv and first_pv[0][0] else None,
        }
        for p in out[tid]["products"][: a.top]:
            if p["viewers"] >= a.min_viewers and UUID.match(str(p["pid"])):
                values.append(f"('{tid}'::uuid,'{p['pid']}'::uuid,{int(p['viewers'])},{int(p['views'])},{int(p['carters'])})")
    run = Path(a.run)
    (run / "data").mkdir(exist_ok=True)
    (run / "data" / "posthog.json").write_text(json.dumps(out, indent=1))
    if values:
        tpl = (SKILL / "sql" / "q09_views.sql.tpl").read_text().replace("{{PH_VALUES}}", ",\n  ".join(values))
        (run / "sql" / "q09_views.sql").write_text(render(tpl, meta))
        print(f"posthog.json written; sql/q09_views.sql rendered with {len(values)} products -> run it, save to data/q09.json")
    else:
        print("posthog.json written; no product-view rows (skip q09)")


# ---------------------------------------------------------------------------- build
def cmd_build(a):
    sys.path.insert(0, str(Path(__file__).parent))
    import report
    report.build(Path(a.run), audience=a.audience, anonymize=a.anonymize_buyers, tenant_share=not a.no_tenant_share, prepaid=a.prepaid)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init"); i.add_argument("--tenants", required=True, help="comma-separated tenant UUIDs")
    i.add_argument("--start", required=True); i.add_argument("--end", required=True)
    i.add_argument("--label", help="slug for the run folder, e.g. acme"); i.add_argument("--out")
    i.set_defaults(f=cmd_init)
    h = sub.add_parser("posthog"); h.add_argument("--run", required=True); h.add_argument("--env")
    h.add_argument("--top", type=int, default=60); h.add_argument("--min-viewers", type=int, default=5)
    h.set_defaults(f=cmd_posthog)
    b = sub.add_parser("build"); b.add_argument("--run", required=True)
    b.add_argument("--audience", choices=["both", "internal", "tenant"], default="both")
    b.add_argument("--anonymize-buyers", action="store_true", help="hide buyer names in the tenant report")
    b.add_argument("--no-tenant-share", action="store_true", help="omit 'share of all invoiced estimates' from the tenant report")
    b.add_argument("--prepaid", action="store_true", help="tenant is mostly upfront-payment: add that framing to the payments section")
    b.set_defaults(f=cmd_build)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
