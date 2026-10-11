#!/usr/bin/env python3
"""Static journey-friction analysis of tests/user-journey-test.sh.

For every `journey "…"` section count: steps, outcomes (pass assertions),
actions that go through the UI path (key presses, clicks, window.__MINOTES__
acting methods), actions that BYPASS the UI (direct api.* mutations — the
journey could not, or did not, do it the way a user would), reads, key presses
and sleeps. Prints a markdown section to stdout.

usage: friction_static.py <path/to/user-journey-test.sh>
"""
import re
import sys

src = open(sys.argv[1], encoding="utf-8").read().split("\n")

UI_API = ("navigateTo setBlockContent typeInBlock pressEnterInBlock focusBlock openJournal openSearch "
          "openSettings closePanel createPage createBlockInCurrentPage toggleCheckbox splitBlockAt "
          "mergeWithPrevious toggleTodoInBlock toggleCollapseBlock selectBlocks").split()
UI_API_RE = re.compile(r"__MINOTES__\??\.(%s)\(|\bapi \"(%s)\(" % ("|".join(UI_API), "|".join(UI_API)))
# api.* calls on the imported backend module: anything that is not a read mutates data behind the UI's back.
BACKEND_RE = re.compile(r"\bapi\.([a-zA-Z]+)\(")
READ_PREFIX = ("get", "list", "search", "is", "has", "count", "archivedCount", "gitSyncStatus", "gitAvailable", "export", "run")
CLICK_RE = re.compile(r"\.click\(\)|new (Mouse|Keyboard|Pointer|Input|Clipboard|Drag)Event\(|dispatchEvent\(")
PRESS_RE = re.compile(r"(^|[;&|]\s*)press\s+\"?([^\";]+)")
SLEEP_RE = re.compile(r"\bsleep\s+([0-9.]+)")
READ_RE = re.compile(r"__MINOTES__\??\.(get\w+|isPanelOpen)\(|\bapi \"(get\w+|isPanelOpen)\(|\bsnapi?\b|querySelector")

journeys = []
cur = None
for line in src:
    m = re.match(r'^journey "(.*)"', line)
    if m:
        cur = dict(name=m.group(1), steps=0, outcomes=0, ui=0, bypass=0, reads=0, presses=0, clicks=0,
                   sleeps=0, sleep_s=0.0, bypass_calls={}, keys=[])
        journeys.append(cur)
        continue
    if cur is None or line.lstrip().startswith("#"):
        continue
    if re.match(r"^\s*step ", line):
        cur["steps"] += 1
    cur["outcomes"] += len(re.findall(r"(?<![\w-])pass \"", line))
    n_ui = len(UI_API_RE.findall(line))
    n_click = len(CLICK_RE.findall(line))
    presses = [m.group(2).strip() for m in PRESS_RE.finditer(line)]
    cur["ui"] += n_ui + n_click + len(presses)
    cur["clicks"] += n_click
    cur["presses"] += len(presses)
    cur["keys"] += presses
    for name in BACKEND_RE.findall(line):
        if name.startswith(READ_PREFIX):
            cur["reads"] += 1
        else:
            cur["bypass"] += 1
            cur["bypass_calls"][name] = cur["bypass_calls"].get(name, 0) + 1
    cur["reads"] += len(READ_RE.findall(line))
    for s in SLEEP_RE.findall(line):
        cur["sleeps"] += 1
        cur["sleep_s"] += float(s)

for j in journeys:
    j["actions"] = j["ui"] + j["bypass"]
    j["apo"] = j["actions"] / max(j["outcomes"], 1)
    j["bypass_pct"] = 100 * j["bypass"] / max(j["actions"], 1)

def split(name):
    m = re.match(r"(\d+)\. (.*)", name)
    return (m.group(1), m.group(2)) if m else ("–", name)


tot = lambda k: sum(j[k] for j in journeys)
print("## Static: what each journey costs (tests/user-journey-test.sh)\n")
print(f"{len(journeys)} journeys, {tot('steps')} steps, {tot('outcomes')} outcomes asserted, {tot('actions')} actions "
      f"({tot('ui')} through the UI path — {tot('presses')} key presses, {tot('clicks')} clicks/events, "
      f"{tot('ui') - tot('presses') - tot('clicks')} test-API calls — and **{tot('bypass')} that bypass the UI** "
      f"by calling the backend directly), {tot('sleeps')} sleeps = {tot('sleep_s'):.0f} s of fixed waiting.\n")
print("Columns: *actions* = UI + bypass; *act/outcome* = actions per asserted outcome (higher = more effort per "
      "thing the user gets); *bypass %* = share of the journey's actions the test could only do through the "
      "backend API (no UI path exercised).\n")
print("| # | Journey | steps | outcomes | actions | UI | keys | clicks | bypass | bypass % | act/outcome | sleeps (s) |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for j in sorted(journeys, key=lambda j: (-j["apo"], -j["actions"])):
    num, title = split(j["name"])
    print(f"| {num} | {title[:58]} | {j['steps']} | {j['outcomes']} | {j['actions']} | {j['ui']} | {j['presses']} | "
          f"{j['clicks']} | {j['bypass']} | {j['bypass_pct']:.0f} | {j['apo']:.2f} | {j['sleeps']} ({j['sleep_s']:.0f}) |")

print("\n### Journeys the test suite can only perform by bypassing the UI\n")
print("A journey whose mutations all go through `api.*` says nothing about how hard the task is for a user — "
      "and usually means the UI path is awkward to automate (context menu, drag-drop, native prompt).\n")
print("| # | Journey | bypass calls |")
print("|---|---|---|")
for j in sorted(journeys, key=lambda j: -j["bypass"]):
    if j["bypass"] < 3:
        continue
    num, title = split(j["name"])
    calls = ", ".join(f"{k}×{v}" for k, v in sorted(j["bypass_calls"].items(), key=lambda kv: -kv[1]))
    print(f"| {num} | {title[:58]} | {calls} |")

keys = {}
for j in journeys:
    for k in j["keys"]:
        keys[k] = keys.get(k, 0) + 1
print("\n### Shortcuts the journeys actually press\n")
print(", ".join(f"`{k}`×{v}" for k, v in sorted(keys.items(), key=lambda kv: -kv[1])) or "none")
no_ui = [split(j["name"])[0] if split(j["name"])[0] != "–" else j["name"] for j in journeys if j["ui"] == 0]
print(f"\nJourneys with **zero** UI-path actions (pure backend/source checks): {', '.join(no_ui) or 'none'}")
