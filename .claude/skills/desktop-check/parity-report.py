#!/usr/bin/env python3
"""Turn parity.json (from parity.js) into parity.md.

usage: parity-report.py <parity.json> <parity-notes.json> <tests/user-journey-test.sh>

parity-notes.json holds the human verdicts, keyed by check id:
  {"pg13": {"rank": 1, "tag": "TEST-FIDELITY GAP", "right": "real",
            "note": "...", "journeys": "J12 relies on ..."}}
A divergence with no note is listed as UNREVIEWED; a note on a check that is
now SAME is listed under "Notes that no longer apply" so stale verdicts surface.
A note with "suspect": true on a SAME check lists it under "Same on both sides,
but the behaviour itself looks wrong".
"""
import json, os, re, sys

res_path, notes_path, journey_path = sys.argv[1:4]
data = json.load(open(res_path))
results = data["results"]
notes = json.load(open(notes_path)) if os.path.exists(notes_path) else {}
journey = open(journey_path, encoding="utf-8", errors="replace").read().split("\n") if os.path.exists(journey_path) else []

def j(v, limit=None):
    s = json.dumps(v, ensure_ascii=False, sort_keys=True)
    s = s.replace("|", "\\|").replace("\n", " ")
    return s if limit is None or len(s) <= limit else s[: limit - 1] + "…"

def journey_hits(patterns):
    lines = []
    for p in patterns or []:
        try: rx = re.compile(p)
        except re.error: continue
        lines += [i + 1 for i, l in enumerate(journey) if rx.search(l)]
    return sorted(set(lines))

def hits_cell(r):
    h = journey_hits(r.get("grep"))
    if not h: return "–"
    return f"{len(h)} lines (e.g. L{', L'.join(map(str, h[:3]))})"

diff = [r for r in results if not r["same"]]
same = [r for r in results if r["same"]]
order = lambda r: (notes.get(r["id"], {}).get("rank", 500), -r["impact"], r["id"])
diff.sort(key=order)

out = []
w = out.append
w("# Mock vs real backend parity\n")
w(f"{len(results)} checks ran ({data.get('defined', len(results))} defined): **{len(same)} SAME, {len(diff)} DIFFERENT**"
  + (f" ({sum(1 for r in diff if r.get('incomplete'))} could not finish on one side — see HARNESS_ERROR)" if any(r.get("incomplete") for r in diff) else "") + ".\n")
w("Each check runs the same operations against the in-memory mock (browser journeys) and the real Rust/SQLite backend, "
  "inside the real app. Ids and timestamps are normalised away; \"both threw\" counts as SAME regardless of wording.\n")
w("| Area | Checks | Same | Different |\n|---|---|---|---|")
areas = []
for r in results:
    if r["area"] not in areas: areas.append(r["area"])
for a in areas:
    rs = [r for r in results if r["area"] == a]
    w(f"| {a} | {len(rs)} | {sum(r['same'] for r in rs)} | {sum(not r['same'] for r in rs)} |")
tags = {}
for r in diff:
    t = notes.get(r["id"], {}).get("tag", "UNREVIEWED"); tags[t] = tags.get(t, 0) + 1
w("\nDivergences by verdict: " + ", ".join(f"{k}: {v}" for k, v in sorted(tags.items(), key=lambda kv: -kv[1])) + ".\n")

w("## Ranked divergences\n")
w("Ranked by the reviewer's `rank` in parity-notes.json, then by a-priori impact (3 = data loss / wrong data, 1 = edge). "
  "\"Journey lines\" = lines of tests/user-journey-test.sh that touch the same API (a grep, not proof of dependence; the note says what was verified).\n")
w("| # | Check | Operation | Inputs | Mock | Real | Verdict | Journey lines |\n|---|---|---|---|---|---|---|---|")
for i, r in enumerate(diff, 1):
    n = notes.get(r["id"], {})
    verdict = f"**{n.get('tag', 'UNREVIEWED')}**" + (f" — right side: {n['right']}" if n.get("right") else "")
    w(f"| {i} | {r['id']} | `{r['op']}` | {r['inputs'].replace('|', '/')} | `{j(r['mock'], 110)}` | `{j(r['real'], 110)}` | {verdict} | {hits_cell(r)} |")

w("\n## Divergence details\n")
for i, r in enumerate(diff, 1):
    n = notes.get(r["id"], {})
    w(f"### {i}. {r['id']} — {r['op']}: {r['inputs']}\n")
    w(f"- impact (a priori): {r['impact']}  |  verdict: **{n.get('tag', 'UNREVIEWED')}**" + (f"  |  right side: **{n['right']}**" if n.get("right") else ""))
    if n.get("note"): w(f"- {n['note']}")
    if n.get("journeys"): w(f"- journeys: {n['journeys']}")
    h = journey_hits(r.get("grep"))
    if h: w(f"- journey lines touching this API: {len(h)} (L{', L'.join(map(str, h[:8]))}{'…' if len(h) > 8 else ''})")
    w(f"- mock: `{j(r['mock'], 1500)}`")
    w(f"- real: `{j(r['real'], 1500)}`\n")

suspects = [r for r in same if notes.get(r["id"], {}).get("suspect")]
if suspects:
    w("## Same on both sides, but the behaviour itself looks wrong\n")
    for r in suspects:
        n = notes[r["id"]]
        w(f"- **{r['id']}** `{r['op']}` — {r['inputs']}: `{j(r['real'], 300)}` — **{n.get('tag', '')}** {n.get('note', '')}")
    w("")

stale = [k for k in notes if k in {r["id"] for r in same} and not notes[k].get("suspect")]
if stale:
    w("## Notes that no longer apply (check is now SAME)\n")
    w(", ".join(sorted(stale)) + "\n")

wording = [r for r in same if r.get("mockErrors") and r["mockErrors"] != r["realErrors"]]
if wording:
    w("## Both throw, with different wording\n")
    w("Only matters to a test that asserts on the message text.\n")
    w("| Check | Operation | Mock message | Real message |\n|---|---|---|---|")
    for r in wording:
        w(f"| {r['id']} | `{r['op']}` | {j(r['mockErrors'], 140)} | {j(r['realErrors'], 140)} |")
    w("")

w("## All checks\n")
w("| Check | Area | Operation | Inputs | Mock result | Real result | |\n|---|---|---|---|---|---|---|")
for r in results:
    w(f"| {r['id']} | {r['area']} | `{r['op']}` | {r['inputs'].replace('|', '/')} | `{j(r['mock'], 140)}` | `{j(r['real'], 140)}` | {'SAME' if r['same'] else '**DIFFERENT**'} |")
print("\n".join(out))
