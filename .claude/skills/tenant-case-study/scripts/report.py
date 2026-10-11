"""Report builder: reads <run>/data/*.json and writes internal / tenant / note / portfolio reports.
Content is built once as a list of blocks, then rendered to HTML and Markdown. Nothing here is tenant-specific."""
import json, re
from datetime import date, datetime, timedelta
from html import escape
from pathlib import Path

# ----------------------------------------------------------------------------- formatting
def ind(n):
    n = int(round(n)); s = str(abs(n))
    if len(s) > 3:
        head, tail, parts = s[:-3], s[-3:], []
        while len(head) > 2:
            parts.insert(0, head[-2:]); head = head[:-2]
        if head: parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    return ("-" if n < 0 else "") + s

rs = lambda n: "₹" + ind(n)
def short(n):
    n = float(n)
    if n >= 1e7: return f"₹{n/1e7:.2f} Cr"
    if n >= 1e5: return f"₹{n/1e5:.2f} L"
    return "₹" + ind(n)
def pct(a, b, d=0): return f"{100*a/b:.{d}f}%" if b else "–"
def pctv(a, b): return 100 * a / b if b else 0.0
def clean_name(n):
    n = re.sub(r"\s+\d{8,}\s*$", "", n or "").strip()
    n = re.sub(r"\s{2,}", " ", n)
    return n.title() if n.isupper() else n

# ----------------------------------------------------------------------------- loading
def load_json(path):
    t = Path(path).read_text()
    try:
        v = json.loads(t)
    except ValueError:
        m = re.search(r"<untrusted-data-[^>]*>\s*(.*?)\s*</untrusted-data-", t, re.S)
        body = m.group(1) if m else t
        v = json.loads(body[body.index("["): body.rindex("]") + 1])
    if isinstance(v, list) and len(v) == 1 and isinstance(v[0], dict) and "d" in v[0]:
        v = v[0]["d"]
    return v

def load_data(run):
    D = {}
    for p in sorted((run / "data").glob("q*.json")):
        D[p.stem.split("_")[0]] = load_json(p)
    ph = run / "data" / "posthog.json"
    D["posthog"] = json.loads(ph.read_text()) if ph.exists() else {}
    return D

# ----------------------------------------------------------------------------- months
def month_list(start, end):
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        first = date(y, m, 1)
        last = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
        cs, ce = max(first, start), min(last, end)
        partial = cs > first or ce < last
        yr = f" '{str(y)[2:]}" if start.year != end.year else ""
        label = f"{first.strftime('%b')}{yr}" + (f" {cs.day}–{ce.day}" if partial else "")
        out.append({"key": f"{y}-{m:02d}", "label": label, "partial": partial, "days": (ce - cs).days + 1,
                    "name": f"{first.strftime('%B')}{yr}"})
        m += 1
        if m == 13: y, m = y + 1, 1
    return out

# ----------------------------------------------------------------------------- context
def build_ctx(tid, meta, D):
    start, end = date.fromisoformat(meta["start"]), date.fromisoformat(meta["end"])
    months = month_list(start, end)
    keys = [m["key"] for m in months]
    info = next((t for t in D.get("q01", []) if t["tenant_id"] == tid), {"name": tid[:8], "slug": tid[:8]})
    c = {"tid": tid, "name": info["name"], "slug": re.sub(r"[^a-z0-9]+", "-", (info.get("slug") or info["name"]).lower()).strip("-"),
         "info": info, "months": months, "start": start, "end": end}
    est = [r for r in D.get("q02", []) if r["tenant_id"] == tid]
    def arr(grp, f):
        by = {r["month"]: r for r in est if r["grp"] == grp}
        return [by.get(k, {}).get(f, 0) or 0 for k in keys]
    fields = ["n", "v", "buyers", "inv_n", "inv_v", "inv_buyers", "open_n", "open_v", "stale_open_n", "stale_open_v",
              "exp_n", "exp_v", "declined_n", "draft_n", "src_mismatch"]
    c["B"] = {f: arr("buyer_app", f) for f in fields}
    c["S"] = {f: arr("seller", f) for f in fields}
    c["O"] = {f: arr("other", f) for f in fields}
    T = {f: sum(v) for f, v in c["B"].items()}
    T["closed"] = T["inv_n"] + T["exp_n"] + T["declined_n"]
    T["conv_closed"] = pctv(T["inv_n"], T["closed"])
    T["other_v"] = T["v"] - T["inv_v"] - T["open_v"] - T["exp_v"]
    c["T"] = T
    all_inv = [a + b + d for a, b, d in zip(c["B"]["inv_n"], c["S"]["inv_n"], c["O"]["inv_n"])]
    all_inv_v = [a + b + d for a, b, d in zip(c["B"]["inv_v"], c["S"]["inv_v"], c["O"]["inv_v"])]
    c["share_n"] = [pctv(a, b) for a, b in zip(c["B"]["inv_n"], all_inv)]
    c["share_v"] = [pctv(a, b) for a, b in zip(c["B"]["inv_v"], all_inv_v)]
    c["all_inv"], c["all_inv_v"] = all_inv, all_inv_v
    c["has_other"] = sum(c["O"]["n"]) > 0
    c["weekly"] = [r for r in D.get("q03", []) if r["tenant_id"] == tid]
    q4 = D.get("q04", {})
    f = lambda k: [r for r in q4.get(k, []) if r["tenant_id"] == tid]
    c["bsum"] = (f("summary") or [{}])[0]
    c["top"], c["cohorts"], c["ticket"] = f("top"), f("cohorts"), (f("ticket") or [{}])[0]
    c["items"], c["dow"] = f("items"), f("dow")
    q5 = D.get("q05", {})
    g = lambda k: [r for r in q5.get(k, []) if r["tenant_id"] == tid]
    c["act_m"], c["act_w"], c["depth"], c["funnel"] = g("monthly"), g("weekly"), g("depth"), (g("funnel") or [{}])[0]
    amap = {r["month"]: r for r in c["act_m"]}
    c["U"] = {k: [amap.get(m, {}).get(k, 0) or 0 for m in keys] for k in
              ["mau", "new", "returning", "retained_next", "avg_dau", "peak_dau", "sessions", "events", "days_in_window"]}
    q6 = D.get("q06", {})
    h = lambda k: [r for r in q6.get(k, []) if r["tenant_id"] == tid]
    c["prod"], c["lost"], c["cats"], c["brands"] = h("top"), h("lost"), h("cats"), h("brands")
    q7 = D.get("q07", {})
    c["pay_m"] = [r for r in q7.get("by_month", []) if r["tenant_id"] == tid]
    c["auto"] = next((r for r in q7.get("auto", []) if r["tenant_id"] == tid), None)
    q8 = D.get("q08", {})
    c["audit"] = [r for r in q8.get("audit", []) if r["tenant_id"] == tid]
    c["bcast"] = [r for r in q8.get("broadcasts", []) if r["tenant_id"] == tid]
    q11 = D.get("q11") if isinstance(D.get("q11"), dict) else {}
    c["recon"] = [r for r in q11.get("months", []) if r["tenant_id"] == tid]
    c["qtd"] = next((r for r in q11.get("qtd", []) if r["tenant_id"] == tid), None)
    c["tick"] = q11.get("tick", [])
    c["daily_last_day"] = (q11.get("daily_last_day") or {}).get(tid)
    c["app_orders"] = [r for r in D.get("q10", []) if r["tenant_id"] == tid] if isinstance(D.get("q10"), list) else []
    c["ph"] = D["posthog"].get(tid) if D.get("posthog") else None
    c["views"] = [r for r in D.get("q09", []) if r["tenant_id"] == tid] if isinstance(D.get("q09"), list) else []
    return c

# ----------------------------------------------------------------------------- sections (blocks)
BAR = lambda cats, series, fmt, **k: ("bars", cats, series, fmt, k)

def sec_kpis(c):
    T, U = c["T"], c["U"]
    last = len(c["months"]) - 1
    return [("kpis", [
        ("Estimates created", f"{T['n']}", f"{rs(T['v'])} quoted"),
        ("Converted to invoice", f"{T['inv_n']}", f"{rs(T['inv_v'])} · {pct(T['inv_n'], T['n'])} of all created"),
        ("Invoiced, of closed quotes", pct(T['inv_n'], T['closed']), f"{T['inv_n']} invoiced vs {T['exp_n'] + T['declined_n']} expired/declined (open quotes excluded)"),
        ("Buyers active", f"{c['funnel'].get('active', 0)}", f"{c['bsum'].get('inv_buyers', 0)} had an estimate invoiced"),
        ("MAU first → last month", f"{U['mau'][0]} → {U['mau'][last]}", "last month partial" if c["months"][last]["partial"] else "full months"),
        ("Repeat buyers", f"{c['bsum'].get('inv_2plus', 0)} of {c['bsum'].get('inv_buyers', 0)}", "invoiced 2+ times"),
    ])]

def sec_estimates(c):
    M, B, T = c["months"], c["B"], c["T"]
    labels = [m["label"] for m in M]
    head = ["Month", "Created", "Value", "Buyers", "Invoiced", "Invoiced value", "Conv #", "Conv ₹", "Open", "Open value", "Expired", "Expired value"]
    rows = [[labels[i], B["n"][i], rs(B["v"][i]), B["buyers"][i], B["inv_n"][i], rs(B["inv_v"][i]), pct(B["inv_n"][i], B["n"][i]),
             pct(B["inv_v"][i], B["v"][i]), B["open_n"][i], rs(B["open_v"][i]), B["exp_n"][i], rs(B["exp_v"][i])] for i in range(len(M))]
    rows.append(["**Total**", f"**{T['n']}**", f"**{rs(T['v'])}**", f"**{c['bsum'].get('quoters', '–')}†**", f"**{T['inv_n']}**", f"**{rs(T['inv_v'])}**",
                 f"**{pct(T['inv_n'], T['n'])}**", f"**{pct(T['inv_v'], T['v'])}**", f"**{T['open_n']}**", f"**{rs(T['open_v'])}**",
                 f"**{T['exp_n']}**", f"**{rs(T['exp_v'])}**"])
    out = [("h2", "Business impact: estimates → invoices"),
           ("lead", "Every estimate a buyer builds in the Yukti buyer app, and what became an invoice (estimate status = [i]invoiced[/i]). "
                    "Month is the month the estimate was created. Values are document totals as recorded."),
           BAR(labels, [("Quoted (₹)", B["v"], "c3"), ("Invoiced (₹)", B["inv_v"], "c1")], short, md=False),
           ("table", head, rows, None),
           ("note", "† Distinct buyers across the whole window (counted once even if active in several months). \"Open\" = sent to the buyer, "
                    "not yet invoiced or expired; \"Expired\" = not confirmed within its validity period."
                    + (f" Partial periods are labelled with their date range." if any(m["partial"] for m in M) else ""))]
    W = c["weekly"]
    if len(W) > 1:
        def wl(r):
            d = date.fromisoformat(r["wk"]); part = d < c["start"] or d + timedelta(days=6) > c["end"]
            return d.strftime("%b %-d") + ("†" if part else "")
        out += [BAR([wl(r) for r in W], [("Estimates created", [r["n"] for r in W], "c3"), ("Converted to invoice", [r["inv_n"] for r in W], "c1")], lambda v: f"{v:.0f}"),
                ("note", "Weekly view, weeks starting Monday. † = partial week within the window.")]
    conv = ", ".join(f"{pct(B['inv_n'][i], B['n'][i])} ({labels[i]})" for i in range(len(M)) if B["n"][i])
    last_partial = M[-1]["partial"]
    out.append(("callout", f"**Read-out.** {T['n']} estimates worth {short(T['v'])} were created; {T['inv_n']} ({short(T['inv_v'])}) became invoices. "
                f"Created-to-invoiced conversion by month: {conv}" + (" — the latest period is still maturing as open quotes close" if last_partial or B['open_n'][-1] else "") + ". "
                f"Counting only quotes that have closed (invoiced, expired or declined), {pct(T['inv_n'], T['closed'])} ended in an invoice; "
                f"the {T['open_n']} still-open quotes are excluded from that figure.", "ok"))
    return out

def sec_share(c, tenant_view):
    if not c["has_other"]:
        return []
    M = c["months"]; labels = [m["label"] for m in M]
    rows = [[labels[i], f"{c['B']['n'][i] + c['S']['n'][i] + c['O']['n'][i]:,}", short(c['B']['v'][i] + c['S']['v'][i] + c['O']['v'][i]),
             c["all_inv"][i], short(c["all_inv_v"][i]), c["B"]["inv_n"][i], f"{c['share_n'][i]:.0f}%", f"{c['share_v'][i]:.0f}%"] for i in range(len(M))]
    return [("h2", "Context: Yukti share of all estimates"),
            ("lead", "Includes estimates not created in the buyer app (e.g. imported from an accounting system). Buyer-app is the only slice Yukti can claim."),
            ("table", ["Month", "All estimates", "All value", "All invoiced", "All invoiced value", "Buyer-app invoiced", "Share #", "Share ₹"], rows, None),
            ("p", f"Buyer-app share of invoiced estimates: {' → '.join(f'{s:.0f}%' for s in c['share_n'])} by count, {' → '.join(f'{s:.0f}%' for s in c['share_v'])} by value. "
                  "Non-app invoiced volume is the baseline to compare against; additivity is not proven by this data.")]

def sec_payments(c, tenant_view, prepaid):
    P = c["pay_m"]
    if not P:
        return []
    M = c["months"]; lab = {m["key"]: m["label"] for m in M}
    tot = {k: sum(r[k] for r in P) for k in ["inv_est", "matched", "paid_n", "paid_v", "open_n", "outst_v", "matched_v", "nomatch_n", "nomatch_v"]}
    rows = [[lab.get(r["month"], r["month"]), r["inv_est"], r["matched"], r["paid_n"], rs(r["paid_v"]), r["open_n"], rs(r["outst_v"]), r["nomatch_n"]] for r in P]
    rows.append(["**Total**", f"**{tot['inv_est']}**", f"**{tot['matched']}**", f"**{tot['paid_n']}**", f"**{rs(tot['paid_v'])}**", f"**{tot['open_n']}**", f"**{rs(tot['outst_v'])}**", f"**{tot['nomatch_n']}**"])
    out = [("h2", "Invoices & payment status")]
    a = c["auto"]
    explain = "When a buyer's estimate is converted, Yukti raises the invoice."
    if a and a["n"]:
        explain += (f" For buyer-app estimates this is automatic: {a['n']} invoices ({short(a['v'])}) were generated by Yukti directly from buyer submissions"
                    + (f" (median about {a['median_min']:.0f} minutes after the estimate)" if a.get("median_min") is not None else "") + ", without the sales team preparing them.")
    out += [("lead", "**How to read this.** " + explain + " Below is how much of the invoiced value is paid and how much is still open."),
            ("table", ["Month", "Invoiced estimates", "Invoice found", "Paid in full", "Paid value", "Not fully paid", "Outstanding", "No invoice record†"], rows, None)]
    msg = (f"**Read-out.** Of the {tot['matched']} invoices linked to these estimates, {tot['paid_n']} ({pct(tot['paid_n'], tot['matched'])}) are paid in full — "
           f"{short(tot['paid_v'])}, {pct(tot['paid_v'], tot['matched_v'])} of invoice value. {tot['open_n']} invoices have {short(tot['outst_v'])} outstanding. ")
    if tenant_view:
        msg += "Because most buyers pay upfront, near-complete payment is expected; it is shown for completeness. " if prepaid else ""
    else:
        msg += "If the tenant is mostly upfront-payment, a high paid share is expected — not a headline. Confirm the credit mix before using it. "
    out.append(("callout", msg, "ok"))
    out.append(("note", f"† {tot['nomatch_n']} invoiced estimates ({short(tot['nomatch_v'])}) have no matching invoice record in Yukti, so their payment status is not shown. "
                + ("" if tenant_view else "Possibly invoiced outside Yukti or hit by a sync/overwrite bug; verify. ")
                + "Invoice matched by estimate link, or same buyer and amount within 10 days."))
    return out

def sec_usage(c):
    M, U = c["months"], c["U"]; labels = [m["label"] for m in M]
    if not any(U["mau"]):
        return []
    rows = [[labels[i], U["mau"][i], f"{U['avg_dau'][i]:.1f}", U["peak_dau"][i], pct(U["avg_dau"][i], U["mau"][i]), U["sessions"][i], U["new"][i], U["returning"][i]] for i in range(len(M))]
    out = [("h2", "Adoption & engagement"),
           ("lead", "Active = a buyer with any qualifying activity in the buyer app (session, catalog view, estimate). Counts are distinct buyers, IST dates."),
           ("table", ["Month", "MAU", "Avg DAU", "Peak DAU", "DAU/MAU", "Sessions", "New buyers", "Returning"], rows, None),
           ("note", "Partial months are not comparable to full months. \"New\" = first time active within the window; \"Returning\" = active in an earlier month of the window. "
                    "Avg DAU averages over every calendar day of the period.")]
    W = c["act_w"]
    if W:
        def wl(r):
            d = date.fromisoformat(r["wk"]); part = d < c["start"] or d + timedelta(days=6) > c["end"]
            return d.strftime("%b %-d") + ("†" if part else "")
        out += [("h3", "Weekly active buyers (WAU)"), BAR([wl(r) for r in W], [("WAU", [r["wau"] for r in W], "c1")], lambda v: f"{v:.0f}", legend=False),
                ("note", "† partial week within the window.")]
    ret = []
    for i in range(len(M) - 1):
        if U["mau"][i]:
            ret.append((f"{labels[i]} actives also active in the next month", U["retained_next"][i], f"{pct(U['retained_next'][i], U['mau'][i])} of {U['mau'][i]}"
                        + (" (next period partial)" if M[i + 1]["partial"] else "")))
    out.append(("h3", "Returning users"))
    out.append(("hbars", ret, str, max([U["mau"][i] for i in range(len(M))] or [1]), "c1") if ret else ("note", "Not enough months for a retention view."))
    order = {"1": 0, "2-3": 1, "4-7": 2, "8-14": 3, "15+": 4}
    dep = sorted(c["depth"], key=lambda r: order.get(r["bucket"], 9))
    if dep:
        out.append(("h3", "Depth: days active per buyer"))
        out.append(("hbars", [(f"{r['bucket']} day{'s' if r['bucket'] != '1' else ''}", r["n"]) for r in dep], str, max(r["n"] for r in dep), "c2"))
        deep = sum(r["n"] for r in dep if r["bucket"] in ("4-7", "8-14", "15+")); tot = sum(r["n"] for r in dep)
    else:
        deep = tot = 0
    parts = [f"**Read-out.** {c['funnel'].get('active', 0)} distinct buyers used the app. MAU went {' → '.join(str(x) for x in U['mau'])}"
             + (" (last period partial)" if M[-1]["partial"] else "") + "."]
    if ret and U["mau"][0]:
        parts.append(f"{pct(U['retained_next'][0], U['mau'][0])} of {labels[0]} users were active again the next month.")
    if tot:
        parts.append(f"{deep} buyers ({pct(deep, tot)}) were active on 4+ different days.")
    out.append(("callout", " ".join(parts), "ok"))
    return out

def sec_ph_verify(c):
    ph = c["ph"]
    if not ph:
        return []
    M, U = c["months"], c["U"]; keys = [m["key"] for m in M]
    pm = {r["month"]: r["buyers"] for r in ph["monthly"]}; pd = {r["month"]: r["avg"] for r in ph["dau"]}
    rows = [["MAU (DB / PostHog)"] + [f"{U['mau'][i]} / {pm.get(k, 0)}" for i, k in enumerate(keys)],
            ["Avg DAU (DB / PostHog)"] + [f"{U['avg_dau'][i]:.1f} / {pd.get(k, 0)}" for i, k in enumerate(keys)]]
    pw = {r["wk"]: r["buyers"] for r in ph["weekly"]}
    diffs = []
    for r in c["act_w"]:
        d = date.fromisoformat(r["wk"])
        if d >= c["start"] and d + timedelta(days=6) <= c["end"] and r["wau"]:
            diffs.append(abs(pw.get(r["wk"], 0) - r["wau"]) / r["wau"] * 100)
    inq = ph.get("inquiry", {})
    out = [("h2", "PostHog verification"),
           ("lead", "Independent check via PostHog (tenant_id + buyer roles, IST). DB numbers use `buyer_app_activity`."),
           ("table", ["Metric"] + [m["label"] for m in M], rows, None)]
    out.append(("p", (f"Full-week WAU differs by at most {max(diffs):.0f}% (mean {sum(diffs)/len(diffs):.0f}%). " if diffs else "")
                + (f"`inquiry_created` events: {inq.get('events')} from {inq.get('buyers')} buyers vs {c['T']['n']} estimates from {c['bsum'].get('quoters', '–')} buyers in DB. " if inq else "")
                + "PostHog also counts `buyer_pending` browsers, so it can run higher."))
    return out

def sec_app_orders(c):
    O = c["app_orders"]
    if not O or not sum(r["n"] for r in O):
        return []
    lab = {m["key"]: m["label"] for m in c["months"]}
    rows = [[lab.get(r["month"], r["month"]), r["n"], rs(r["v"]), r["buyers"]] for r in O]
    return [("h2", "Orders placed in the buyer app"),
            ("lead", "Buyer-app orders (in-flow statuses) are tracked separately from estimates and are not part of the estimate → invoice funnel above."),
            ("table", ["Month", "Orders", "Value", "Buyers"], rows, None)]

def sec_reconcile(c):
    R, q = c["recon"], c["qtd"]
    if not R:
        return []
    lab = {m["key"]: m["label"] for m in c["months"]}
    last_key = c["months"][-1]["key"]
    rows, bad = [], []
    for r in R:
        ok = (r["agg_est_n"] == r["raw_est_n"] and r["agg_est_v"] == r["raw_est_v"] and r["agg_est_buyers"] == r["raw_est_buyers"]
              and r["agg_inv_n"] == r["raw_inv_n"] and r["agg_inv_v"] == r["raw_inv_v"])
        if r["agg_est_n"] is None:
            verdict = "✗ no aggregate row"
            bad.append(r["month"])
        elif ok:
            verdict = "✓ match"
        elif r["month"] == last_key:
            verdict = f"Δ refresh lag (aggregate computed {str(r['agg_computed_at'])[:16].replace('T', ' ')} UTC)"
        else:
            verdict = "✗ MISMATCH — investigate"; bad.append(r["month"])
        f = lambda a, b: f"{ind(a) if a is not None else '–'} / {ind(b)}"
        rows.append([lab.get(r["month"], r["month"]), f(r["agg_est_n"], r["raw_est_n"]), f(r["agg_est_v"], r["raw_est_v"]), f(r["agg_est_buyers"], r["raw_est_buyers"]),
                     f(r["agg_inv_n"], r["raw_inv_n"]), f(r["agg_inv_v"], r["raw_inv_v"]), verdict])
    out = [("h2", "Reconciliation with Pulse aggregates (metrics_*)"),
           ("lead", "`metrics_tenant_period_summary` is written from the raw tables by the refresh pipeline (same predicates: non-void estimates by `metric_day_ist`, GMV-included invoices). "
                    "The `/pulse` Contribution cards read it through `metrics_landing_kpi_snapshot` (page `buyer_app`, period `this_quarter`). Each cell is aggregate / raw."),
           ("table", ["Month", "App estimates #", "App estimates ₹", "App est. buyers", "All invoices #", "All invoices ₹", "Verdict"], rows, ["l"] + ["r"] * 5 + ["l"])]
    if q and q.get("snapshot"):
        k = {x["id"]: x for x in q["snapshot"]["kpis"]}
        tiles = []
        d, iv, ac = k.get("app_sourced_demand_qtd"), k.get("app_sourced_invoiced_sales_qtd"), k.get("customers_with_access")
        if d: tiles.append(["Demand captured (QTD)", f"{rs(d['value'])} · {d.get('document_count')} docs · {d['entity_count']} buyers", f"{rs(q['raw_demand_v'])} · {q['raw_demand_n']} docs", "✓" if (d["value"] == q["raw_demand_v"] and d.get("document_count") == q["raw_demand_n"]) else "Δ lag (aggregate older than raw)"])
        if iv: tiles.append(["Invoiced from captured demand (QTD)", f"{rs(iv['value'])} · {iv.get('document_count')} invoices · {iv['entity_count']} buyers", f"{rs(q['raw_app_inv_v'])} · {q['raw_app_inv_n']} invoices", "✓" if (iv["value"] == q["raw_app_inv_v"] and iv.get("document_count") == q["raw_app_inv_n"]) else "Δ"])
        if ac: tiles.append(["Customers with Yukti access", str(ac["value"]), str(q["raw_enabled"]), "✓" if ac["value"] == q["raw_enabled"] else "Δ"])
        out += [("h3", f"Pulse tiles for the current quarter (snapshot computed {str(q['snapshot']['computed_at'])[:16].replace('T', ' ')} UTC)"),
                ("table", ["Tile", "Pulse (snapshot)", "Raw tables", "Verdict"], tiles, ["l", "l", "l", "l"])]
    # definition gaps
    gap = []
    for i, m in enumerate(c["months"]):
        r = next((x for x in R if x["month"] == m["key"]), None)
        if r:
            gap.append([m["label"], c["B"]["inv_n"][i], r["raw_app_inv_n"], c["B"]["inv_n"][i] - r["raw_app_inv_n"]])
    out += [("h3", "Definition gaps: this report vs the Pulse invoiced tile"),
            ("table", ["Month", "Estimates with status invoiced (this report)", "Buyer-app invoices (Pulse tile)", "Not visible to Pulse"], gap, None),
            ("note", "This report counts an estimate as converted when its status is `invoiced`. Pulse's invoiced tile counts invoices flagged `is_buyer_app_invoice` (set only by the in-app invoice flow), dated by `invoice_date`. "
                     "Conversions that were invoiced elsewhere (e.g. in the accounting system) are invisible to the tile.")]
    items = []
    if bad:
        items.append(f"**Mismatch in closed period(s) {', '.join(lab.get(b, b) for b in bad)}** — aggregates differ from raw; check `metrics_v4_period_drift_log` and the refresh queue.")
    if any(t.get("job") for t in c["tick"]) and not any(t.get("active") for t in c["tick"]):
        items.append("**`metrics-refresh-tick` is inactive** — aggregates (and Pulse) are frozen at their last refresh.")
    if c["auto"] and c["auto"].get("first_day"):
        items.append(f"**Buyer-app invoice flag starts {c['auto']['first_day']}** — earlier conversions can never appear in Pulse's invoiced tile.")
    items.append("**No engagement metrics in `metrics_*`.** DAU/WAU/MAU, sessions and retention come from `buyer_app_activity` (verified against PostHog), not from any aggregate; Pulse's \"active buyers through Yukti\" is the distinct quoting/ordering buyer count, a different metric.")
    items.append("**Naming trap.** `metrics_tenant_now_summary.active_buyer_count` counts master-active buyers (every active customer), not engaged buyers.")
    if c["daily_last_day"]:
        items.append(f"**`metrics_tenant_daily` (v2) is stale** — last day {c['daily_last_day']}; not used by Pulse, do not use for reporting.")
    if c["app_orders"] and sum(r["n"] for r in c["app_orders"]):
        items.append("**Pulse buyer count may double count.** `app_sourced_demand_qtd` adds estimate-buyers and order-buyers; a buyer with both is counted twice.")
    out.append(("ul", items))
    return out

def sec_funnel(c):
    f, s = c["funnel"], c["bsum"]
    if not f:
        return []
    items = [("Active in app", f.get("active", 0)), ("Browsed the catalog", f.get("browsed", 0)), ("Created an estimate", s.get("quoters", 0)),
             ("Had an estimate invoiced", s.get("inv_buyers", 0)), ("Invoiced 2+ times", s.get("inv_2plus", 0)), ("Invoiced 5+ times", s.get("inv_5plus", 0))]
    out = [("h2", "Buyer funnel"), ("hbars", items, str, max(f.get("active", 1), 1), "c1")]
    txt = (f"{f.get('browsed_no_est', 0)} of {f.get('browsed', 0)} buyers who browsed the catalog have not created an estimate yet. "
           f"Among the {s.get('quoters', 0)} who did, {s.get('quote_2plus', 0)} ({pct(s.get('quote_2plus', 0), s.get('quoters', 0))}) created two or more; "
           f"{pct(s.get('inv_2plus', 0), s.get('inv_buyers', 0))} of buyers with an invoiced estimate have ordered again.")
    co = [r for r in c["cohorts"]]
    lab = {m["key"]: m["label"] for m in c["months"]}
    done = [r for r in co if r["month"] != c["months"][-1]["key"]]
    if done:
        txt += " Buyers whose first estimate was in " + "; ".join(f"{lab.get(r['month'], r['month'])}: {pct(r['quoted_again'], r['buyers'])} ({r['quoted_again']}/{r['buyers']}) quoted again in a later month" for r in done) + "."
    out.append(("p", txt))
    return out

def sec_buyers(c, anonymize):
    if not c["top"]:
        return []
    s = c["bsum"]
    rows = []
    for r in c["top"]:
        nm = f"Buyer {r['rk']}" if anonymize else clean_name(r["name"])
        rows.append([nm, r["n"], r["ni"], rs(r["v"]), rs(r["qv"]), pct(r["ni"], r["n"]), r["days"]])
    share = pct(s.get("top10_inv_v", 0), s.get("inv_v_total", 0))
    return [("h2", "Top 10 buyers"), ("lead", "By invoiced value from buyer-app estimates in the window."),
            ("table", ["Buyer", "Estimates", "Invoiced", "Invoiced value", "Quoted value", "Conv #", "Days with an estimate"], rows, ["l"] + ["r"] * 6),
            ("p", f"The top 10 buyers account for {share} ({short(s.get('top10_inv_v', 0))}) of invoiced value; {s.get('inv_buyers', 0)} buyers in total had at least one estimate invoiced.")]

def sec_products(c):
    P = c["prod"][:10]
    if not P:
        return []
    cats = c["cats"][:6]; brands = c["brands"][:6]
    out = [("h2", "What sold"), ("lead", "Invoiced line value for buyer-app estimates in the window (line totals; units are pieces)."),
           ("h3", "Top 10 products"),
           ("table", ["Product", "Brand", "Units", "Line value", "Buyers", "Conv†"],
            [[p["nm"], p["brand"], int(p["units_inv"]), rs(p["val_inv"]), p["buyers_inv"], f"{p['conv']}%" if p["conv"] is not None else "–"] for p in P], ["l", "l", "r", "r", "r", "r"]),
           ("note", "† Share of that product's closed quotes (invoiced vs expired/declined) that were invoiced."),
           ("h3", "Categories — quoted vs invoiced"),
           BAR([x["name"] for x in cats], [("Quoted", [x["q_val"] for x in cats], "c3"), ("Invoiced", [x["inv_val"] for x in cats], "c1")], short),
           ("h3", "Brands — invoiced value"),
           ("hbars", [(b["name"], b["inv_val"], f"{b['n']} estimates · {b['conv'] if b['conv'] is not None else '–'}% conv") for b in brands], short, None, "c1")]
    tot_inv = c["T"]["inv_v"]
    if brands and tot_inv:
        tb = brands[0]
        out.append(("callout", f"**Read-out.** {tb['name']} accounts for {pct(tb['inv_val'], tot_inv)} of invoiced value ({short(tb['inv_val'])}). "
                    f"The best-selling product, {P[0]['nm']}, was invoiced to {P[0]['buyers_inv']} different buyers.", "ok"))
    return out

def views_split(c):
    V = c["views"]
    notord = [v for v in V if v["q_buyers"] <= 1 and v["viewers"] >= 5][:10]
    notord.sort(key=lambda v: -v["viewers"])
    ordd = sorted([v for v in V if v["inv_buyers"] >= 0.3 * v["viewers"] and v["viewers"] >= 10], key=lambda v: -v["viewers"])[:5]
    return notord, ordd

def sec_views(c):
    ph = c["ph"]
    if not ph or not c["views"]:
        return []
    notord, ordd = views_split(c)
    if not notord:
        return []
    first = ph.get("first_product_view")
    out = [("h2", "Viewed but not ordered"),
           ("lead", "From product-page analytics" + (f" (since {first}, when product-view tracking started)" if first else "") + ". "
                    "Products below get attention but almost no quotes.")]
    out.append(("table", ["Product", "Price", "Buyers who viewed", "Added to cart", "Buyers who quoted", "Buyers invoiced"],
                [[v["nm"], rs(v["price"] or 0), v["viewers"], v["carters"], v["q_buyers"], v["inv_buyers"]] for v in notord], ["l"] + ["r"] * 5))
    if ordd:
        out += [("h3", "For contrast: viewed and ordered"),
                ("table", ["Product", "Buyers who viewed", "Buyers who quoted", "Buyers invoiced"], [[v["nm"], v["viewers"], v["q_buyers"], v["inv_buyers"]] for v in ordd], ["l", "r", "r", "r"])]
    cnt = {}
    for v in notord:
        cnt[v["cat"] or "Uncategorised"] = cnt.get(v["cat"] or "Uncategorised", 0) + 1
    top = ", ".join(k for k, _ in sorted(cnt.items(), key=lambda kv: -kv[1])[:3])
    out.append(("callout", f"**Read-out.** Interest without orders is concentrated in {top}. Check price, stock and spec detail on these, "
                "or run a targeted campaign — buyers are clearly curious.", "ok"))
    return out

def sec_leak(c):
    T, t = c["T"], c["ticket"]
    if not T["n"]:
        return []
    txt = []
    if T["exp_n"]:
        txt.append(f"{T['exp_n']} quotes worth {short(T['exp_v'])} expired without an invoice.")
    if t.get("big_n", 0) >= 5 and t.get("small_n", 0) >= 5:
        txt.append(f"Larger quotes convert less: estimates of ₹50,000+ ({t['big_n']} quotes, {short(t['big_v'])} — {pct(t['big_v'], T['v'])} of quoted value) were invoiced "
                   f"{pct(t['big_inv_n'], t['big_n'])} of the time, versus {pct(t['small_inv_n'], t['small_n'])} for quotes under ₹5,000.")
    cats = [x for x in c["cats"] if x["n"] >= 10 and x["conv"] is not None]
    if cats:
        w = min(cats, key=lambda x: x["conv"])
        txt.append(f"By category, {w['name']} converts least ({w['conv']}% of closed quotes; {pct(w['inv_val'], w['q_val'])} of quoted value invoiced).")
    out = [("h2", "Where quotes did not convert"), ("p", " ".join(txt))]
    if c["lost"]:
        out += [("h3", "Products with the most expired value"),
                ("table", ["Product", "Quotes", "Invoiced", "Expired", "Expired line value"], [[p["nm"], p["est_n"], p["inv_n"], p["exp_n"], rs(p["exp_v"])] for p in c["lost"]], ["l", "r", "r", "r", "r"])]
    return out

def sec_timing(c):
    D = c["dow"]
    if not D:
        return []
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; by = {r["dow"]: r["n"] for r in D}
    vals = [by.get(i + 1, 0) for i in range(7)]; tot = sum(vals) or 1
    rank = sorted(range(7), key=lambda i: -vals[i])
    return [("h2", "When buyers order"), BAR(names, [("Estimates", vals, "c2")], lambda v: f"{v:.0f}", legend=False),
            ("p", f"Busiest days: {', '.join(names[i] for i in rank[:3])}; quietest: {names[rank[-1]]} ({pct(vals[rank[-1]], tot)} of estimates).")]

# ---- opportunities / findings / narrative
def opportunities(c):
    T, t, f = c["T"], c["ticket"], c["funnel"]
    out = []
    if T["open_n"]:
        out.append(f"**Follow up on open quotes.** {T['open_n']} quotes worth {short(T['open_v'])} are still open — a quick call or WhatsApp nudge on the larger ones can pull revenue forward.")
    if t.get("big_n", 0) >= 5 and t.get("small_n", 0) >= 5 and pctv(t["big_inv_n"], t["big_n"]) + 10 < pctv(t["small_inv_n"], t["small_n"]):
        out.append(f"**Large quotes (₹50,000+) need a human touch.** They convert at {pct(t['big_inv_n'], t['big_n'])} vs {pct(t['small_inv_n'], t['small_n'])} for small baskets; a seller callback or a price-list/scheme offer can close the gap.")
    if f.get("browsed_no_est", 0) >= 10:
        out.append(f"**Activate browsers.** {f['browsed_no_est']} buyers browsed the catalog but have not quoted — a targeted campaign on your top-selling lines is the natural first nudge for each new batch of buyers.")
    notord, _ = views_split(c) if c["views"] else ([], [])
    if notord:
        out.append("**Look at the viewed-but-not-ordered list.** Products with high interest and no orders deserve a price, stock or spec check.")
    cats = [x for x in c["cats"] if x["n"] >= 10 and x["conv"] is not None]
    if cats:
        w = min(cats, key=lambda x: x["conv"])
        if w["conv"] < 70:
            out.append(f"**Review {w['name']} pricing and availability.** It converts at {w['conv']}% of closed quotes, the lowest of your main categories.")
    return out

def findings(c, D):
    T, out = c["T"], []
    mm = T["src_mismatch"]
    if mm:
        out.append(f"**Source mismatch.** {mm} buyer-app estimates have `source` ≠ `buyer_app` (likely a sync/overwrite issue). They are counted via `is_buyer_app_estimate`; verify the root cause and other tenants.")
    if T["stale_open_n"]:
        out.append(f"**Open pipeline likely overstated.** {T['stale_open_n']} of {T['open_n']} open estimates ({short(T['stale_open_v'])}) are already past `valid_until`; the expiry sweep may not be running. Verify before quoting pipeline.")
    pay = c["pay_m"]
    if pay:
        nm = sum(r["nomatch_n"] for r in pay)
        if nm:
            out.append(f"**{nm} invoiced estimates have no matching invoice** ({short(sum(r['nomatch_v'] for r in pay))}); `converted_to_invoice_id` is not a reliable link — conversion uses the estimate status.")
        paid = sum(r["paid_n"] for r in pay); mt = sum(r["matched"] for r in pay)
        if mt and paid / mt > 0.9:
            out.append(f"**Paid share is high ({pct(paid, mt)}).** If the tenant is mostly upfront-payment this is expected, not a differentiator — do not headline it.")
    last = c["months"][-1]
    if last["partial"]:
        out.append(f"**Latest period is partial ({last['label']}).** Its MAU/DAU/conversion are not comparable to full months; open quotes are still maturing.")
    items = c["items"]
    if len(items) >= 2:
        out.append("**Basket size trend.** Avg items/estimate: " + " → ".join(f"{r['avg_items']}" for r in items) + "; avg estimate value: "
                   + " → ".join(short(c['B']['v'][i] / c['B']['n'][i]) for i in range(len(c['months'])) if c['B']['n'][i]) + ".")
    if c["audit"]:
        a = ", ".join(f"{r['entity_type']}.{r['action']} ×{r['n']}" for r in c["audit"][:6])
        out.append(f"**Seller-side activity (audit log):** {a}.")
    if c["bcast"]:
        out.append("**WhatsApp broadcasts:** " + "; ".join(f"{r['month']}: {r['n']} broadcast(s), {r['sent']} sent / {r['delivered']} delivered / {r['failed']} failed" for r in c["bcast"]) + ".")
    elif c["info"]:
        out.append("**No WhatsApp broadcasts** in the window — marketing automation is an untapped lever.")
    i = c["info"]
    if i.get("buyers_total"):
        out.append(f"**Penetration.** {i['buyers_total']:,} buyers in master, {i.get('buyers_app_enabled', 0)} app-enabled, {c['funnel'].get('active', 0)} active in the window ({pct(c['funnel'].get('active', 0), i['buyers_total'], 1)} of master).")
    if not c["ph"]:
        out.append("**PostHog not run** — no product-view or independent usage verification in this pack.")
    return out

def narrative(c):
    T, U, M = c["T"], c["U"], c["months"]; last = len(M) - 1
    out = [f"**Headline:** {T['n']} buyer-app estimates, {short(T['v'])} quoted, {T['inv_n']} invoiced for {short(T['inv_v'])}"
           + (f"; buyer-app share of invoiced estimates {' → '.join(f'{s:.0f}%' for s in c['share_n'])}." if c["has_other"] else ".")]
    if U["mau"][0]:
        out.append(f"**Adoption:** {c['funnel'].get('active', 0)} buyers; MAU {' → '.join(str(x) for x in U['mau'])}; {pct(U['retained_next'][0], U['mau'][0])} month-1 retention; {c['bsum'].get('inv_2plus', 0)} repeat buyers.")
    if c["auto"] and c["auto"]["n"]:
        out.append(f"**Speed:** invoices generated by Yukti within ~{(c['auto'].get('median_min') or 0):.0f} minutes of the estimate (do not frame as a payment win for prepaid tenants).")
    out.append("**Honest caveats:** short window, partial latest period, no counterfactual" + (", tenant also invoices outside the buyer app" if c["has_other"] else "") + ".")
    return out

def note_md(c, tenant_share):
    """Draft milestones/opportunities note to send with the report. Numbers computed; wording to be reviewed."""
    T, U, M, B = c["T"], c["U"], c["months"], c["B"]; last = len(M) - 1
    ms = []
    if B["n"][last]:
        base = f"In {M[last]['label']}: {B['n'][last]} estimates, {B['inv_n'][last]} invoiced ({pct(B['inv_n'][last], B['n'][last])}), **{short(B['inv_v'][last])}**"
        full_prev = [i for i in range(last) if not M[i]["partial"] and B["inv_v"][i]]
        if M[last]["partial"] and full_prev:
            p = full_prev[-1]
            base += f" in {M[last]['days']} days — {pct(B['inv_v'][last], B['inv_v'][p])} of {M[p]['name']}'s full-month invoiced value ({short(B['inv_v'][p])})."
        else:
            base += "."
        ms.append(f"**Strong latest period.** {base}")
    if U["mau"][0] and last >= 1:
        ms.append(f"**Buyers come back.** {pct(U['retained_next'][0], U['mau'][0])} of {M[0]['label']}'s active buyers returned the next month; "
                  f"{c['bsum'].get('inv_2plus', 0)} of {c['bsum'].get('inv_buyers', 0)} buyers with an invoiced estimate have ordered more than once.")
    W = c["act_w"]
    g = f"MAU grew {' → '.join(str(x) for x in U['mau'])}"
    if len(W) >= 2:
        fw = [r["wau"] for r in W if date.fromisoformat(r["wk"]) >= c["start"] and date.fromisoformat(r["wk"]) + timedelta(days=6) <= c["end"]]
        if fw:
            g += f"; weekly active buyers ranged {min(fw)}–{max(fw)} across full weeks"
    if tenant_share and c["has_other"] and c["share_n"][-1] > c["share_n"][0]:
        g += f"; buyer-app orders are {c['share_n'][-1]:.0f}% of invoiced estimates in {M[last]['label']} (from {c['share_n'][0]:.0f}% in {M[0]['label']})"
    ms.append(f"**Adoption is scaling.** {g}.")
    ops = opportunities(c)[:3]
    lines = [f"# {c['name']} — note to accompany the report (DRAFT)", "",
             "> Auto-drafted from the data. Edit wording, re-check numbers against the latest data, and drop anything that does not fit this tenant.", "",
             "## Highlights", ""] + [f"{i+1}. {t}" for i, t in enumerate(ms)] + ["", "## Opportunities", ""] + [f"{i+1}. {t}" for i, t in enumerate(ops)]
    return "\n".join(lines) + "\n"

# ----------------------------------------------------------------------------- assemble per audience
def tenant_blocks(c, anonymize, tenant_share, prepaid):
    T, U, M = c["T"], c["U"], c["months"]; last = len(M) - 1
    b = [("tag", f"{c['name']} × Yukti", False),
         ("title", "Your usage of Yukti", f"{c['start'].strftime('%-d %B')} – {c['end'].strftime('%-d %B %Y')} · prepared by Yukti"),
         ("callout", f"**At a glance.** Your buyers created **{T['n']} estimates worth {short(T['v'])}** in the Yukti buyer app, and **{T['inv_n']} of them ({short(T['inv_v'])}) have already become invoices**. "
                     f"Active buyers grew from {U['mau'][0]} in {M[0]['label']} to {U['mau'][last]} in {M[last]['label']}.", "ok")]
    b += sec_kpis(c)
    if tenant_share and c["has_other"] and c["share_n"][-1] > c["share_n"][0]:
        b.append(("callout", f"Buyers ordering through the app account for **{c['share_n'][-1]:.0f}% of your invoiced estimates in {M[last]['label']}**, up from {c['share_n'][0]:.0f}% in {M[0]['label']} "
                             "(share of all invoiced estimates, including those your team creates directly).", "ok"))
    b += sec_estimates(c) + sec_app_orders(c) + sec_payments(c, True, prepaid) + sec_usage(c) + sec_funnel(c) + sec_buyers(c, anonymize) + sec_products(c) + sec_views(c) + sec_leak(c) + sec_timing(c)
    ops = opportunities(c)
    if ops:
        b += [("h2", "Opportunities"), ("ul", ops)]
    b.append(("footer", "Method: data from the Yukti platform; buyer-app estimates in the period (IST). Values are document totals as recorded in Yukti. Conversion is based on estimate status = invoiced. "
                        "\"Closed quotes\" are those invoiced, expired or declined. \"Open\" quotes are not yet invoiced, expired or declined and may include quotes past their validity date. "
                        + ("Product-page views come from Yukti product analytics. " if c["views"] else "") + "Partial periods are labelled."))
    return b

def internal_blocks(c, D, meta):
    T = c["T"]
    b = [("tag", "Internal — do not share", True),
         ("title", f"{c['name']} — Yukti case-study data pack", f"{meta['start']} to {meta['end']} (IST) · tenant {c['tid'][:8]} · plan {c['info'].get('plan', '–')} · generated {meta.get('created', '')[:10]}")]
    cav = (f"**Attribution caveat.** Only buyer-app estimates (`is_buyer_app_estimate`) are Yukti-native; headline numbers use them alone. ")
    if c["has_other"]:
        n_o = sum(c["O"]["n"]); inv_o = sum(c["O"]["inv_n"]); dr = sum(c["O"]["draft_n"])
        cav += f"The tenant also has {n_o:,} other estimates in the window (e.g. accounting-system imports; {pct(dr, n_o)} still draft, {inv_o} invoiced) that Yukti did not create."
    b.append(("callout", cav, "warn"))
    b += sec_kpis(c) + sec_estimates(c) + sec_share(c, False) + sec_app_orders(c) + sec_payments(c, False, False) + sec_usage(c) + sec_ph_verify(c) + sec_reconcile(c)
    b += sec_funnel(c) + sec_buyers(c, False) + sec_products(c) + sec_views(c) + sec_leak(c) + sec_timing(c)
    b += [("h2", "Internal-only findings & data issues"), ("ul", findings(c, D)), ("h2", "Suggested case-study narrative"), ("ul", narrative(c))]
    b.append(("footer", "Sources: yukti-prod read-only SQL (queries in the skill's sql/) and PostHog HogQL. Buyer-app = estimates.is_buyer_app_estimate; invoiced = estimates.status 'invoiced'; "
                        "month by estimate_date (IST); activity = buyer_app_activity.qualifies_for_engagement; DAU/WAU/MAU = distinct buyer_id."))
    return b

def portfolio_blocks(ctxs, meta):
    b = [("tag", "Internal — do not share", True), ("title", "Yukti portfolio snapshot", f"{meta['start']} to {meta['end']} · {len(ctxs)} tenants")]
    rows = []
    agg = {"n": 0, "v": 0, "inv_n": 0, "inv_v": 0, "act": 0, "rep": 0, "invb": 0}
    for c in ctxs:
        T, U = c["T"], c["U"]
        rows.append([c["name"], T["n"], short(T["v"]), T["inv_n"], short(T["inv_v"]), pct(T["inv_n"], T["n"]), pct(T["inv_n"], T["closed"]),
                     c["funnel"].get("active", 0), U["mau"][-1], c["bsum"].get("inv_buyers", 0), c["bsum"].get("inv_2plus", 0),
                     f"{c['share_n'][-1]:.0f}%" if c["has_other"] else "–"])
        agg["n"] += T["n"]; agg["v"] += T["v"]; agg["inv_n"] += T["inv_n"]; agg["inv_v"] += T["inv_v"]; agg["act"] += c["funnel"].get("active", 0)
        agg["invb"] += c["bsum"].get("inv_buyers", 0); agg["rep"] += c["bsum"].get("inv_2plus", 0)
    rows.append(["**Total**", f"**{agg['n']}**", f"**{short(agg['v'])}**", f"**{agg['inv_n']}**", f"**{short(agg['inv_v'])}**", f"**{pct(agg['inv_n'], agg['n'])}**", "–",
                 f"**{agg['act']}**", "–", f"**{agg['invb']}**", f"**{agg['rep']}**", "–"])
    b += [("h2", "Per-tenant summary (buyer-app)"),
          ("table", ["Tenant", "Estimates", "Value", "Invoiced", "Invoiced value", "Conv #", "Conv closed", "Active buyers", "MAU (last)", "Buyers invoiced", "Repeat", "App share of invoiced†"], rows, None),
          ("note", "† Share of all invoiced estimates in the latest period (including non-app estimates). MAU (last) is for the latest, possibly partial, period.")]
    months = sorted({m["key"] for c in ctxs for m in c["months"]})
    mrows = []
    for k in months:
        n = v = inv = iv = mau = 0
        for c in ctxs:
            keys = [m["key"] for m in c["months"]]
            if k in keys:
                i = keys.index(k); n += c["B"]["n"][i]; v += c["B"]["v"][i]; inv += c["B"]["inv_n"][i]; iv += c["B"]["inv_v"][i]; mau += c["U"]["mau"][i]
        mrows.append([k, n, short(v), inv, short(iv), pct(inv, n), mau])
    b += [("h2", "Combined by month"), ("table", ["Month", "Estimates", "Value", "Invoiced", "Invoiced value", "Conv #", "MAU (sum)"], mrows, None),
          ("note", "MAU (sum) adds distinct buyers per tenant; buyers are tenant-scoped, so the sum is not a platform-unique count."),
          ("h2", "Per-tenant reports"), ("ul", [f"**{c['name']}** — `{c['slug']}/` (internal, tenant, note)" for c in ctxs]),
          ("footer", "Each tenant has its own internal and shareable reports in its folder. Review attribution caveats per tenant before comparing.")]
    return b

# ----------------------------------------------------------------------------- renderers
CSS = """:root{--bg:#fafaf7;--card:#fff;--ink:#1c1f23;--mute:#5f6670;--line:#e6e4dc;--grid:#ecebe4;--c1:#2f6f5e;--c2:#d98a2b;--c3:#9aa7b4;--warn:#b4472f;--accent:#e9f2ee}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--card:#1c2024;--ink:#eceef0;--mute:#9aa3ad;--line:#2b3138;--grid:#2a3036;--c1:#5fb59d;--c2:#e8a64f;--c3:#6c7885;--warn:#e07a62;--accent:#1d2b27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px 16px 64px}h1{font-size:30px;line-height:1.2;margin:4px 0 6px}.sub{color:var(--mute);margin:0}
.tag{display:inline-block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:99px;background:var(--accent);color:var(--c1);font-weight:600}.tag.int{background:#f6e3dc;color:var(--warn)}
h2{font-size:21px;margin:42px 0 6px}h3{font-size:16px;margin:24px 0 6px}.lead{color:var(--mute);margin:0 0 14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:18px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kl{font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em}.kv{font-size:28px;font-weight:700;margin:2px 0}.ks{font-size:13px;color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}.chart{width:100%;height:auto;display:block}.ax{font-size:11px;fill:var(--mute)}.vl{font-size:10px;fill:var(--ink)}
.legend{display:flex;gap:16px;font-size:13px;color:var(--mute);margin-top:6px;flex-wrap:wrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);text-align:left}.r{text-align:right;font-variant-numeric:tabular-nums}.l{text-align:left}td.l{white-space:normal}
.hb{display:grid;grid-template-columns:minmax(120px,38%) 1fr 78px;gap:10px;align-items:center;margin:7px 0;font-size:14px}.hl small{display:block;color:var(--mute);font-size:12px}
.ht{background:var(--grid);border-radius:4px;height:14px}.hf{height:14px;border-radius:4px}.hv{text-align:right;font-variant-numeric:tabular-nums}
.note{font-size:13px;color:var(--mute)}.callout{background:var(--accent);border-left:4px solid var(--c1);padding:12px 14px;border-radius:6px;margin:14px 0}
.callout.warn{background:#f6e3dc;border-color:var(--warn);color:#4a2318}@media(prefers-color-scheme:dark){.callout.warn{background:#3a2520;color:#f0d6cd}.tag.int{background:#3a2520}}
ul{padding-left:20px}li{margin:4px 0}@media(max-width:720px){.hb{grid-template-columns:1fr 70px}.hb .ht{grid-column:1/3;order:3}}
footer{margin-top:48px;color:var(--mute);font-size:13px;border-top:1px solid var(--line);padding-top:14px}"""
COL = {"c1": "var(--c1)", "c2": "var(--c2)", "c3": "var(--c3)"}

def inl(s):
    s = escape(str(s))
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    return re.sub(r"\[i\](.+?)\[/i\]", r"<i>\1</i>", s)

def svg_bars(cats, series, fmt, legend=True, w=720, h=270):
    l, r, t, bt = 52, 12, 22, 34
    pw, ph = w - l - r, h - t - bt
    mx = max((max(v) if v else 0) for _, v, _ in series) or 1
    o = [f'<svg viewBox="0 0 {w} {h}" role="img" class="chart">']
    for i in range(5):
        y = t + ph - ph * i / 4
        o.append(f'<line x1="{l}" x2="{w-r}" y1="{y:.1f}" y2="{y:.1f}" stroke="var(--grid)"/><text x="{l-6}" y="{y+4:.1f}" text-anchor="end" class="ax">{escape(fmt(mx*i/4))}</text>')
    gw = pw / max(len(cats), 1); bw = min(34, gw * 0.7 / len(series))
    for ci, cname in enumerate(cats):
        gx = l + gw * ci + gw / 2 - bw * len(series) / 2
        for si, (_, vals, col) in enumerate(series):
            v = vals[ci]; bh = ph * v / mx; x = gx + si * bw
            o.append(f'<rect x="{x:.1f}" y="{t+ph-bh:.1f}" width="{bw-2:.1f}" height="{bh:.1f}" rx="2" fill="{COL[col]}"/>')
            if len(cats) <= 10:
                o.append(f'<text x="{x+bw/2-1:.1f}" y="{t+ph-bh-4:.1f}" text-anchor="middle" class="vl">{escape(fmt(v))}</text>')
        o.append(f'<text x="{l+gw*ci+gw/2:.1f}" y="{h-12}" text-anchor="middle" class="ax">{escape(str(cname))}</text>')
    o.append("</svg>")
    lg = ""
    if legend and len(series) > 1:
        lg = '<div class="legend">' + "".join(f'<span><i style="background:{COL[col]}"></i>{escape(n)}</span>' for n, _, col in series) + "</div>"
    return "".join(o) + lg

def render_html(blocks, title):
    o = []
    for bl in blocks:
        k = bl[0]
        if k == "tag": o.append(f'<header><span class="tag{" int" if bl[2] else ""}">{inl(bl[1])}</span>')
        elif k == "title": o.append(f'<h1>{inl(bl[1])}</h1><p class="sub">{inl(bl[2])}</p></header>')
        elif k == "h2": o.append(f"<h2>{inl(bl[1])}</h2>")
        elif k == "h3": o.append(f"<h3>{inl(bl[1])}</h3>")
        elif k == "lead": o.append(f'<p class="lead">{inl(bl[1])}</p>')
        elif k == "p": o.append(f"<p>{inl(bl[1])}</p>")
        elif k == "note": o.append(f'<p class="note">{inl(bl[1])}</p>')
        elif k == "callout": o.append(f'<div class="callout{" warn" if bl[2] == "warn" else ""}">{inl(bl[1])}</div>')
        elif k == "footer": o.append(f"<footer>{inl(bl[1])}</footer>")
        elif k == "ul": o.append("<ul>" + "".join(f"<li>{inl(x)}</li>" for x in bl[1]) + "</ul>")
        elif k == "kpis":
            o.append('<div class="kpis">' + "".join(f'<div class="kpi"><div class="kl">{inl(a)}</div><div class="kv">{inl(v)}</div><div class="ks">{inl(s)}</div></div>' for a, v, s in bl[1]) + "</div>")
        elif k == "table":
            head, rows, al = bl[1], bl[2], bl[3] or (["l"] + ["r"] * (len(bl[1]) - 1))
            th = "".join(f'<th class="{a}">{inl(h)}</th>' for h, a in zip(head, al))
            tb = "".join("<tr>" + "".join(f'<td class="{a}">{inl(c)}</td>' for c, a in zip(r, al)) + "</tr>" for r in rows)
            o.append(f'<div class="tw"><table><thead><tr>{th}</tr></thead><tbody>{tb}</tbody></table></div>')
        elif k == "bars":
            o.append('<div class="card">' + svg_bars(bl[1], bl[2], bl[3], legend=bl[4].get("legend", True)) + "</div>")
        elif k == "hbars":
            items, fmt, mx, col = bl[1], bl[2], bl[3], bl[4]
            mx = mx or max((i[1] for i in items), default=1) or 1
            rows = "".join(f'<div class="hb"><div class="hl">{inl(i[0])}<small>{inl(i[2] if len(i) > 2 else "")}</small></div><div class="ht"><div class="hf" style="width:{100*i[1]/mx:.1f}%;background:{COL[col]}"></div></div><div class="hv">{inl(fmt(i[1]))}</div></div>' for i in items)
            o.append(f'<div class="card">{rows}</div>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{escape(title)}</title><style>{CSS}</style></head><body><div class=\"wrap\">{''.join(o)}</div></body></html>")

def md_inline(s): return re.sub(r"\[i\](.+?)\[/i\]", r"*\1*", str(s))

def render_md(blocks):
    o = []
    for bl in blocks:
        k = bl[0]
        if k == "tag": o.append(f"> **{md_inline(bl[1])}**\n" if bl[2] else "")
        elif k == "title": o.append(f"# {md_inline(bl[1])}\n\n*{md_inline(bl[2])}*\n")
        elif k == "h2": o.append(f"## {md_inline(bl[1])}\n")
        elif k == "h3": o.append(f"### {md_inline(bl[1])}\n")
        elif k in ("lead", "p"): o.append(md_inline(bl[1]) + "\n")
        elif k == "note": o.append(f"<sub>{md_inline(bl[1])}</sub>\n")
        elif k == "callout": o.append(f"> {md_inline(bl[1])}\n")
        elif k == "footer": o.append(f"---\n<sub>{md_inline(bl[1])}</sub>\n")
        elif k == "ul": o.append("\n".join(f"- {md_inline(x)}" for x in bl[1]) + "\n")
        elif k == "kpis": o.append("\n".join(f"- **{a}:** {v} — {s}" for a, v, s in bl[1]) + "\n")
        elif k == "table":
            head, rows = bl[1], bl[2]
            o.append("\n".join(["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"] + ["| " + " | ".join(md_inline(c) for c in r) + " |" for r in rows]) + "\n")
        elif k == "bars":
            if bl[4].get("md", True):
                names = [n for n, _, _ in bl[2]]
                rows = [[c] + [bl[3](sr[1][i]) for sr in bl[2]] for i, c in enumerate(bl[1])]
                o.append("\n".join(["| " + " | ".join([""] + names) + " |", "|" + "|".join("---" for _ in range(len(names) + 1)) + "|"] + ["| " + " | ".join(r) + " |" for r in rows]) + "\n")
        elif k == "hbars":
            o.append("\n".join(f"- {i[0]}: {bl[2](i[1])}" + (f" ({i[2]})" if len(i) > 2 and i[2] else "") for i in bl[1]) + "\n")
    return "\n".join(o)

# ----------------------------------------------------------------------------- entrypoint
def build(run, audience="both", anonymize=False, tenant_share=True, prepaid=False):
    meta = json.loads((run / "meta.json").read_text())
    D = load_data(run)
    for need in ("q02", "q05"):
        if need not in D:
            raise SystemExit(f"missing data/{need}.json — run the SQL and save results first")
    ctxs = [build_ctx(t, meta, D) for t in meta["tenant_ids"]]
    out = run / "reports"
    for c in ctxs:
        d = out / c["slug"] if len(ctxs) > 1 else out
        d.mkdir(parents=True, exist_ok=True)
        s = c["slug"]
        if audience in ("both", "internal"):
            bl = internal_blocks(c, D, meta)
            (d / f"{s}-internal.html").write_text(render_html(bl, f"{c['name']} on Yukti — internal data pack"))
            (d / f"{s}-internal.md").write_text(render_md(bl))
        if audience in ("both", "tenant"):
            bl = tenant_blocks(c, anonymize, tenant_share, prepaid)
            (d / f"{s}-tenant.html").write_text(render_html(bl, f"{c['name']} on Yukti"))
            (d / f"{s}-tenant.md").write_text(render_md(bl))
            (d / f"{s}-note.md").write_text(note_md(c, tenant_share))
        print(f"{c['name']}: {c['T']['n']} estimates, {c['T']['inv_n']} invoiced -> {d}")
    if len(ctxs) > 1 and audience in ("both", "internal"):
        bl = portfolio_blocks(ctxs, meta)
        (out / "portfolio.html").write_text(render_html(bl, "Yukti portfolio snapshot"))
        (out / "portfolio.md").write_text(render_md(bl))
        print(f"portfolio -> {out}")
