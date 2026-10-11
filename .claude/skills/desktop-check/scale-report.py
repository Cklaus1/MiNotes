#!/usr/bin/env python3
"""Build scale.md from the scale-<S>.tsv files scale-tour.sh wrote.

usage: scale-report.py <signals-dir>

Each TSV line is `metric <TAB> json`; a metric measured N times has N lines.
The table shows the median per size. Call-outs are computed, not hand-written:
  OVER 1 s      median above 1000 ms at any size
  SUPER-LINEAR  grows faster than the block count between the smallest and largest size
  GROWS         a metric whose work does not depend on graph size (opening the same
                page, typing) but which got >1.5x slower
The reviewer's reading of the code (likely causes) lives in scale-notes.md next
to this script and is appended verbatim.
"""
import json, os, statistics, sys

out_dir = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
ORDER = ["S", "M", "L"]
data = {}
for s in ORDER:
    p = os.path.join(out_dir, f"scale-{s}.tsv")
    if not os.path.exists(p): continue
    d = {}
    for line in open(p, encoding="utf-8"):
        if "\t" not in line: continue
        k, v = line.rstrip("\n").split("\t", 1)
        try: d.setdefault(k, []).append(json.loads(v))
        except Exception: d.setdefault(k, []).append({"ok": False, "error": v[:120]})
    if d: data[s] = d
sizes = [s for s in ORDER if s in data]
if not sizes:
    print("# Scale tour\n\nNo data (no scale-<S>.tsv files)."); sys.exit(0)

med = lambda xs: statistics.median(xs) if xs else None
def samples(s, metric, field):
    xs = []
    for r in data[s].get(metric, []):
        if not isinstance(r, dict): continue
        v = r.get(field)
        if isinstance(v, list): xs += [x for x in v if isinstance(x, (int, float))]
        elif isinstance(v, (int, float)) and r.get("ok", True) is not False: xs.append(v)
    return xs
def one(s, metric, field):
    r = data[s].get(metric, [{}])[0]
    return r.get(field) if isinstance(r, dict) else None

rows = []   # (label, {size: value}, unit, kind, note)   kind: "const" = should not depend on graph size
def add(label, fn, unit="ms", kind="scales", note=""):
    vals = {}
    for s in sizes:
        try: vals[s] = fn(s)
        except Exception: vals[s] = None
    rows.append((label, vals, unit, kind, note))

blocks = {s: (one(s, "stats", "blocks") or 0) for s in sizes}
add("Pages (actual)", lambda s: one(s, "stats", "pages"), "", "info")
add("Blocks (actual)", lambda s: one(s, "stats", "blocks"), "", "info")
add("Links (actual)", lambda s: one(s, "stats", "links"), "", "info")
add("Seed: CLI `import dir`", lambda s: one(s, "seed_ms", "ms"), "ms", "scales", "one CLI process, one autocommit per block")
add("Seed: per block", lambda s: one(s, "seed_ms", "ms") / max(1, blocks[s] - 9), "ms/block", "const", "should be flat if inserts are O(1)")
add("Database file", lambda s: (one(s, "db_bytes", "db") + one(s, "db_bytes", "wal")) / 1e6, "MB", "scales", "default.db + WAL")
add("Database per block", lambda s: (one(s, "db_bytes", "db") + one(s, "db_bytes", "wal")) / max(1, blocks[s]), "bytes/block", "const")
add("Cold start: process start -> window mapped", lambda s: med(samples(s, "cold_direct", "window")), "ms", "const", "direct launch, no WebDriver, private D-Bus session")
add("Cold start: process start -> first non-blank frame", lambda s: med(samples(s, "cold_direct", "painted")), "ms", "const", "screen capture every 250 ms")
add("Cold start: process start -> screen stable", lambda s: med(samples(s, "cold_direct", "stable")), "ms", "const", "two identical captures in a row = first interactive (approx.)")
add("Frontend boot (reload) -> first block + sidebar usable", lambda s: med(samples(s, "boot", "interactive")), "ms", "const",
    "upper bound when the app was already usable at the first poll: " + ", ".join(f"{s}: {sum(1 for r in data[s].get('boot', []) if isinstance(r, dict) and r.get('upperBound'))}/{len(data[s].get('boot', []))}" for s in sizes))
add("Frontend boot: longest main-thread stall", lambda s: med(samples(s, "boot", "freeze")), "ms", "const")
for metric, label, kind, note in [
    ("api_getPageTree_small", "IPC getPageTree (10-20 block page)", "const", ""),
    ("api_getPageTree_big", "IPC getPageTree (2,000-block page)", "const", ""),
    ("api_search_common", "IPC search, common term (limit 20)", "scales", "term is in ~30% of blocks"),
    ("api_search_rare", "IPC search, rare term", "scales", "term is in exactly one block"),
    ("api_getFolderTree", "IPC getFolderTree", "scales", "sidebar"),
    ("api_listPages_200", "IPC listPages(200)", "scales", "sidebar / app"),
    ("api_listPages_all", "IPC listPages(all)", "scales", ""),
    ("api_getGraphData", "IPC getGraphData", "scales", "graph view"),
    ("api_getBacklinks_hub", "IPC getBacklinks (Hub)", "scales", "one row per linking block"),
    ("api_getUnlinkedReferences_hub", "IPC getUnlinkedReferences (Hub)", "scales", "LIKE scan over all blocks"),
    ("api_getPendingTodoCount", "IPC getPendingTodoCount", "scales", "sidebar badge"),
    ("api_getGraphStats", "IPC getGraphStats", "scales", ""),
    ("api_createPage", "IPC createPage (new title)", "const", "backfills links by scanning blocks"),
    ("api_createBlock", "IPC createBlock (small page)", "const", ""),
]:
    add(label, (lambda m: lambda s: med(samples(s, m, "ms")))(metric), "ms", kind, note)
add("Open small page: first block", lambda s: med(samples(s, "open_small", "first")), "ms", "const")
add("Open small page: painted", lambda s: med(samples(s, "open_small", "painted")), "ms", "const")
add("Open small page: IPC calls", lambda s: med(samples(s, "open_small", "ipcTotal")), "calls", "const")
add("Open 2,000-block page: first block", lambda s: med(samples(s, "open_big", "first")), "ms", "const")
add("Open 2,000-block page: all blocks rendered", lambda s: med(samples(s, "open_big", "done")), "ms", "const")
add("Open 2,000-block page: painted", lambda s: med(samples(s, "open_big", "painted")), "ms", "const")
add("Open 2,000-block page: longest main-thread stall", lambda s: med(samples(s, "open_big", "freeze")), "ms", "const")
add("Open 2,000-block page: DOM nodes", lambda s: med(samples(s, "open_big", "nodes")), "nodes", "info")
add("Open 2,000-block page: editor instances", lambda s: med(samples(s, "open_big", "editors")), "editors", "info")
add("Leave 2,000-block page (open a small one): painted", lambda s: med(samples(s, "close_big", "painted")), "ms", "const")
def keys(s, metric, field, agg):
    xs = [k[field] for r in data[s].get(metric, []) if isinstance(r, dict) for k in r.get("keys", []) if isinstance(k.get(field), (int, float))]
    return agg(xs) if xs else None
add("Typing in a small page: key -> DOM (median of keys)", lambda s: keys(s, "type_small", "mut", med), "ms", "const")
add("Typing in a small page: key -> next frame (median)", lambda s: keys(s, "type_small", "frame", med), "ms", "const")
add("Typing in the 2,000-block page: key -> DOM (median)", lambda s: keys(s, "type_big", "mut", med), "ms", "const")
add("Typing in the 2,000-block page: key -> next frame (median)", lambda s: keys(s, "type_big", "frame", med), "ms", "const")
add("Typing in the 2,000-block page: key -> next frame (worst key)", lambda s: keys(s, "type_big", "frame", max), "ms", "const")
def e2e(s, metric, agg):
    xs = [k["queued"] + k["frame"] for r in data[s].get(metric, []) if isinstance(r, dict) for k in r.get("keys", []) if isinstance(k.get("frame"), (int, float)) and isinstance(k.get("queued"), (int, float))]
    return agg(xs) if xs else None
add("Typing in a small page: X key event -> next frame, incl. input queueing (worst key)", lambda s: e2e(s, "type_small", max), "ms", "const", "queued = event age when the app's keydown handler ran")
add("Typing in the 2,000-block page: X key event -> next frame, incl. queueing (median)", lambda s: e2e(s, "type_big", med), "ms", "const", "xdotool types every 15 ms; growing queue = app slower than 15 ms/key")
add("Typing in the 2,000-block page: X key event -> next frame, incl. queueing (worst key)", lambda s: e2e(s, "type_big", max), "ms", "const")
add("Typing in the 2,000-block page: keys that reached the editor", lambda s: len([1 for r in data[s].get("type_big", []) if isinstance(r, dict) for k in r.get("keys", [])]), "of 11", "info")
add("Search panel, common term: results on screen", lambda s: med(samples(s, "search_ui_project", "done")), "ms", "scales", "keystroke -> hits rendered; includes the panel's 150 ms debounce")
add("Search panel, rare term: results on screen", lambda s: med(samples(s, "search_ui_quokkazephyr", "done")), "ms", "scales", "includes the 150 ms debounce")
add("Search panel, common term: hits shown", lambda s: med(samples(s, "search_ui_project", "hits")), "hits", "info")
add("Sidebar refresh: data loaded + rendered", lambda s: med(samples(s, "sidebar_refresh", "settled")), "ms", "scales", "refreshSidebar() -> last IPC reply / sidebar DOM change")
add("Sidebar refresh: IPC calls", lambda s: med(samples(s, "sidebar_refresh", "ipcTotal")), "calls", "scales")
add("Sidebar: DOM nodes", lambda s: med(samples(s, "sidebar_refresh", "sidebarNodes")), "nodes", "scales")
add("Sidebar: page rows rendered", lambda s: med(samples(s, "sidebar_refresh", "pageItems")), "rows", "scales")
add("Graph view: canvas on screen", lambda s: med(samples(s, "open_graph", "done")), "ms", "scales")
add("Graph view: longest stall in the next 3 s", lambda s: med(samples(s, "open_graph", "tailFreeze")), "ms", "scales", "force layout running")
add("Graph view: frames per second in the next 3 s", lambda s: med(samples(s, "open_graph", "tailFps")), "fps", "info")
add("Hub page: first block", lambda s: med(samples(s, "open_hub_backlinks", "first")), "ms", "const")
add("Hub page: all backlinks listed", lambda s: med(samples(s, "open_hub_backlinks", "done")), "ms", "scales")
add("Hub page: backlinks shown", lambda s: med(samples(s, "open_hub_backlinks", "backlinks")), "items", "info")
add("Hub page: IPC calls until backlinks listed", lambda s: med(samples(s, "open_hub_backlinks", "ipcTotal")), "calls", "scales")

def fmt(v, unit):
    if v is None: return "–"
    if unit in ("ms",): return f"{v:,.0f}" if v >= 10 else f"{v:.1f}"
    if unit in ("MB", "ms/block"): return f"{v:.2f}"
    if unit == "fps": return f"{v:.0f}"
    return f"{v:,.0f}"

callouts = []
lo, hi = sizes[0], sizes[-1]
growth = (blocks[hi] / blocks[lo]) if blocks[lo] and len(sizes) > 1 else None
print("# Scale tour\n")
print("Real desktop app on Xvfb (software rendering): **read across a row, not as absolute numbers**. "
      f"Median of the samples taken per size. Sizes: " + ", ".join(f"{s} = {blocks[s]:,} blocks" for s in sizes)
      + (f" (x{growth:.1f} from {lo} to {hi})." if growth else ".") + "\n")
print("| Metric | " + " | ".join(sizes) + " | unit | " + (f"{hi}/{lo}" if growth else "") + " | flag | note |")
print("|---|" + "---|" * (len(sizes) + 4))
for label, vals, unit, kind, note in rows:
    ratio = ""; flags = []
    a, b = vals.get(lo), vals.get(hi)
    if growth and isinstance(a, (int, float)) and isinstance(b, (int, float)) and a > 0 and kind != "info":
        r = b / a; ratio = f"x{r:.1f}"
        # ignore sub-5 ms noise
        if unit in ("ms", "ms/block", "bytes/block", "calls") and (b >= 5 or unit != "ms"):
            if kind == "const" and r > 1.5: flags.append("GROWS")
            if kind == "scales" and r > growth * 1.3: flags.append("SUPER-LINEAR")
    if unit == "ms" and any(isinstance(v, (int, float)) and v > 1000 for v in vals.values()): flags.append("OVER 1 s")
    if flags: callouts.append((label, vals, unit, flags, ratio, note))
    print(f"| {label} | " + " | ".join(fmt(vals.get(s), unit) for s in sizes) + f" | {unit} | {ratio} | {' '.join('**' + f + '**' for f in flags)} | {note} |")

print("\n## Call-outs\n")
if not callouts: print("Nothing over 1 s, nothing growing faster than the graph.\n")
for label, vals, unit, flags, ratio, note in callouts:
    print(f"- **{' + '.join(flags)}** — {label}: " + ", ".join(f"{s} {fmt(vals.get(s), unit)}" for s in sizes) + f" {unit}" + (f" ({ratio} for x{growth:.1f} blocks)" if ratio and growth else ""))
print()
for s in sizes:
    errs = [l for r in data[s].get("errors", []) if isinstance(r, dict) for l in r.get("lines", [])]
    bad = [r for k, rs in data[s].items() for r in rs if isinstance(r, dict) and r.get("ok") is False]
    if errs or bad:
        print(f"### Problems during size {s}\n")
        for l in errs: print(f"- page error: `{l[:200]}`")
        for k, rs in data[s].items():
            for r in rs:
                if isinstance(r, dict) and r.get("ok") is False: print(f"- measurement `{k}` did not complete: {r.get('error', 'timed out inside the page')}")
        print()

notes = os.path.join(here, "scale-notes.md")
if os.path.exists(notes):
    print(open(notes, encoding="utf-8").read())

print("## Raw samples\n")
for s in sizes:
    print(f"### {s}\n")
    for k, rs in data[s].items():
        if k in ("manifest", "stats", "errors"): continue
        for r in rs:
            txt = json.dumps(r, sort_keys=True)
            print(f"- `{k}` {txt if len(txt) < 420 else txt[:420] + '…'}")
    print()
