#!/usr/bin/env python3
"""Render silent-errors.json (written by silent-errors.sh) as markdown on stdout."""
import json
import re
import sys

d = json.load(open(sys.argv[1]))
scen = [dict(id=s["id"], **s["result"]) for s in d["scenarios"]]
events = d["events"]
by_mark = {}
for e in events:
    by_mark.setdefault(e["mark"], []).append(e)
dialog_marks = {s["name"] for s in scen if s.get("dialogs")}


def cell(x, n=150):
    x = re.sub(r"\s+", " ", str(x)).replace("|", "\\|")
    return x if len(x) <= n else x[: n - 1] + "…"


def told(e):
    seen = (e.get("seenNow") or []) + (e.get("seenLater") or [])
    if seen:
        return seen[0]
    if e["mark"] in dialog_marks:
        return "native dialog"
    return ""


def norm(msg):  # collapse ids / long payloads so repeats group together
    msg = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<id>", msg)
    return re.sub(r"(.)\1{20,}", r"\1…", msg)


hidden = [e for e in events if not told(e)]
shown = [e for e in events if told(e)]
print("# Silent errors\n")
print(f"{len(scen)} scenarios run against the real desktop app; **{len(events)} problems recorded, "
      f"{len(hidden)} of them with nothing on screen to tell the user** (no toast, banner, inline error or dialog "
      f"within 1.5 s). IPC hook active: {d['invokeHooked']}. Problems before the first scenario (startup/seed): "
      f"{d['startupEvents']}.\n")
print("Kinds: `invoke-rejected` = a Tauri command returned an error; `console.error/warn`; `uncaught`; "
      "`unhandledrejection`; `resource-failed` = img/script failed to load; `csp` = blocked by the Content Security "
      "Policy; `fetch-failed`.\n")

print("## Errors the user never sees\n")
if not hidden:
    print("none\n")
else:
    groups = {}
    for e in hidden:
        g = groups.setdefault((e["kind"], norm(e["msg"])), {"marks": [], "n": 0})
        g["n"] += 1
        if e["mark"] not in g["marks"]:
            g["marks"].append(e["mark"])
    print("| kind | error | × | triggered by |")
    print("|---|---|---|---|")
    for (kind, msg), g in sorted(groups.items(), key=lambda kv: (kv[0][0] != "invoke-rejected", kv[0][0], -kv[1]["n"])):
        marks = "; ".join(g["marks"][:5]) + (f" (+{len(g['marks']) - 5} more)" if len(g["marks"]) > 5 else "")
        print(f"| {kind} | {cell(msg, 190)} | {g['n']} | {cell(marks, 200)} |")
    print()

print("## Errors the user was told about\n")
if not shown:
    print("none\n")
else:
    print("| kind | error | triggered by | what the user saw |")
    print("|---|---|---|---|")
    seen_rows = set()
    for e in shown:
        row = (e["kind"], norm(e["msg"]), e["mark"])
        if row in seen_rows:
            continue
        seen_rows.add(row)
        print(f"| {e['kind']} | {cell(norm(e['msg']), 150)} | {cell(e['mark'], 60)} | {cell(told(e), 110)} |")
    print()

print("## Every scenario\n")
print("*problems* = hook events during the scenario (hidden/total). *feedback* = new toast/banner/inline error/"
      "dialog visible when it finished. A row with an odd outcome, 0 problems and no feedback is a **silent no-op "
      "or silent side effect** — read the outcome column.\n")
print("| id | scenario | what the user ends up with | problems (hidden/total) | feedback |")
print("|---|---|---|---|---|")
for s in scen:
    evs = by_mark.get(s["name"], [])
    hid = sum(1 for e in evs if not told(e))
    fb = list(s.get("feedback") or []) + [f"dialog {x['type']}: {x['msg']}" for x in s.get("dialogs") or []]
    print(f"| {s['id']} | {cell(s['name'], 60)} | {cell(s['outcome'], 170)} | {hid}/{len(evs)} | {cell('; '.join(fb) or '—', 120)} |")
threw = [s for s in scen if s["outcome"].startswith(("SCENARIO THREW", "(WebDriver"))]
if threw:
    print("\n### Scenarios the harness could not complete (HARNESS LIMITATION, not app findings)\n")
    for s in threw:
        print(f"- {s['name']}: {cell(s['outcome'], 200)}")
other = [e for e in events if e["mark"] not in {s["name"] for s in scen}]
if other:
    print("\n### Problems outside any scenario (startup / seeding)\n")
    for e in other[:15]:
        print(f"- {e['kind']}: {cell(norm(e['msg']), 200)} — user saw: {told(e) or 'nothing'}")
