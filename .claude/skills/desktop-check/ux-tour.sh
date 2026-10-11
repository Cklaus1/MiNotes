#!/usr/bin/env bash
# UX tour of the real desktop app: visit every main view, and for each one take
# a screenshot, run the audit (audit.js) and time how long it took to appear.
# Output: $DESKTOP_CHECK_DIR/ux/  — NN-name.png, NN-name.json, and tour.md.
#
# The numbers are signals, not verdicts. Read tour.md, then LOOK at each
# screenshot with the rubric in SKILL.md ("UX review").
#
#   ux-tour.sh            # build first
#   ux-tour.sh --no-build
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/desktop.sh"
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
OUT="$DESKTOP_CHECK_DIR/ux"; rm -rf "$OUT"; mkdir -p "$OUT"
now() { date +%s%3N; }

T0=$(now)
"$D" up --webdriver --profile ux ${1:+$1} >/dev/null || { echo "launch failed"; exit 1; }
STARTUP=$(( $(now) - T0 ))
"$D" seed-demo >/dev/null
e() { "$D" eval "$1" 2>/dev/null | tr -d '"'; }
# A bigger, messier notebook than the demo seed: long titles, deep nesting, many pages.
e "(async()=>{const api=await import('/src/lib/api.ts');
  const long=await api.createPage('A very long page title that keeps going to see how the sidebar and header cope with it — part two');
  let parent; for(let i=0;i<6;i++){const b=await api.createBlock(long.id,'Nesting level '+(i+1)+' with enough text to wrap onto a second line when the indentation gets deep enough to squeeze it',parent);parent=b.id}
  await api.createBlock(long.id,'A line with a verylongunbrokenstringofcharactersthatcannotwrapnaturallyandmightoverflowitscontainer_'+'x'.repeat(120));
  await api.createBlock(long.id,'\`\`\`js\nconst answer = 42; // code block\n\`\`\`');
  await api.createBlock(long.id,'| Col A | Col B |\n|---|---|\n| 1 | 2 |');
  await api.createBlock(long.id,'- [ ] unchecked task\n- [x] done task');
  for(let i=1;i<=30;i++){await api.createPage('Bulk page '+String(i).padStart(2,'0'))}
  const f=await api.createFolder('Work'); const g=await api.createFolder('Personal');
  const ps=await api.listPages(1000); await api.movePageToFolder(ps.find(p=>p.title==='Project Alpha').id,f.id);
  window.__MINOTES__.refreshSidebar(); return 'ok'})()" >/dev/null
sleep 2

N=0; : >"$OUT/tour.md"
LOAD=$("$D" js "const n = performance.getEntriesByType('navigation')[0]; return n ? Math.round(n.domContentLoadedEventEnd) : null" 2>/dev/null)
printf '# MiNotes UX tour\n\nPage load (DOMContentLoaded): **%s ms**. Launch incl. driver setup: %s ms.\n\n| # | View | ms | unlabeled | small targets | low contrast | clipped | no focus ring | font sizes | errors |\n|---|---|---|---|---|---|---|---|---|---|\n' "$LOAD" "$STARTUP" >>"$OUT/tour.md"

# visit <name> <action-js-or-empty> [ready-expr]
visit() {
  N=$((N+1)); local id; id=$(printf '%02d-%s' "$N" "$1"); local t0; t0=$(now)
  [ -n "$2" ] && "$D" eval "$2" >/dev/null 2>&1
  "$D" wait "${3:-true}" 10 2>/dev/null; local ms=$(( $(now) - t0 ))
  sleep 1.2
  "$D" wshot "../ux/$id" >/dev/null 2>&1
  "$D" js "$(cat "$HERE/audit.js")" >"$OUT/$id.json" 2>/dev/null
  python3 - "$OUT/$id.json" "$N" "$1" "$ms" >>"$OUT/tour.md" <<'PY'
import json, sys
try: c = json.load(open(sys.argv[1]))["counts"]; err = json.load(open(sys.argv[1]))["errors"]
except Exception: c = {}; err = "?"
g = lambda k: c.get(k, "?")
print(f"| {sys.argv[2]} | {sys.argv[3]} | {sys.argv[4]} | {g('unlabeled')} | {g('smallTargets')} | {g('lowContrast')} | {g('clippedText')} | {g('noFocusRing')} | {g('fontSizes')} | {err} |")
PY
  echo "  $id (${ms} ms)"
}
nav() { echo "window.__MINOTES__.navigateTo('$1')"; }
on() { echo "window.__MINOTES__.getCurrentPage()==='$1'"; }
key() { "$D" press "$1" 2>/dev/null; sleep 1; }
# Type into the focused/first visible text input the way React expects.
fill() { "$D" js "const el = document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : [...document.querySelectorAll('input[type=text],input:not([type])')].find(i => i.offsetParent); if (!el) throw new Error('no input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '$1'); el.dispatchEvent(new Event('input', {bubbles: true})); return true" >/dev/null 2>&1; sleep 1.5; }

visit journal-today      "window.__MINOTES__.openJournal()" "(window.__MINOTES__.getCurrentPage()||'').startsWith('Journal')"
visit page-rich          "$(nav 'Project Alpha')" "$(on 'Project Alpha')"
visit page-tasks         "$(nav 'Research Notes')" "$(on 'Research Notes')"
visit page-stress        "$(nav 'A very long page title that keeps going to see how the sidebar and header cope with it — part two')" "window.__MINOTES__.getBlockCount()>5"
e "(async()=>{const api=await import('/src/lib/api.ts');await api.createPage('Empty page');return 1})()" >/dev/null
visit page-empty         "$(nav 'Empty page')" "$(on 'Empty page')"
visit editing-focused    "window.__MINOTES__.navigateTo('Project Alpha') && (setTimeout(()=>window.__MINOTES__.focusBlock(1),600), true)" "$(on 'Project Alpha')"
opensearch() { "$D" eval "window.__MINOTES__.isPanelOpen('search') || window.__MINOTES__.openSearch()" >/dev/null 2>&1; "$D" wait "window.__MINOTES__.isPanelOpen('search')" 5 2>/dev/null; sleep 0.5; }
opensearch;              visit search-empty "" "window.__MINOTES__.isPanelOpen('search')"
fill "alpha"; visit search-results "" "true"
key Escape
opensearch; fill "zzzqqq-no-match"; visit search-no-results "" "true"; key Escape
key "Control+,";         visit settings "" "window.__MINOTES__.isPanelOpen('settings')"; key Escape
"$D" eval "$(nav 'Project Alpha')" >/dev/null; sleep 1
key "Control+g";         visit graph "" "true"; key Escape
key "Control+m";         visit mindmap "" "true"; key Escape
key "Control+Shift+K";   visit kanban "" "true"; key Escape
"$D" click 50 22 2>/dev/null; sleep 1
key "Control+w";         visit whiteboard "" "!!document.querySelector('canvas')"; "$D" click 50 22 2>/dev/null; sleep 1
"$D" click 227 780 2>/dev/null; sleep 1.5; visit all-pages "" "true"; "$D" click 50 22 2>/dev/null; sleep 1
"$D" eval "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Bulk page 01');await api.deletePage(t.page.id);window.__MINOTES__.refreshSidebar();return 1})()" >/dev/null 2>&1
"$D" click 57 742 2>/dev/null; sleep 1.5; visit trash "" "true"; key Escape

{
  echo; echo "## Page errors during the tour"; echo
  "$D" errors 2>/dev/null | sed 's/^/- /' | sort | uniq -c | sort -rn | head -20 || true
  echo; echo "## Worst offenders per view"; echo
  for f in "$OUT"/*.json; do
    python3 - "$f" <<'PY'
import json, sys, os
try: d = json.load(open(sys.argv[1]))
except Exception: sys.exit()
out = []
for k, label in [("unlabeled", "no accessible name"), ("smallTargets", "small target"), ("clippedText", "clipped")]:
    out += [f"  - {label}: `{x}`" for x in d.get(k, [])[:4]]
out += [f"  - low contrast {x['ratio']}:1 (needs {x['need']}): `{x['el']}`" for x in d.get("lowContrast", [])[:4]]
if d.get("horizontalOverflow"): out.append("  - page scrolls horizontally")
if out: print(f"**{os.path.basename(sys.argv[1])[:-5]}**\n" + "\n".join(out) + "\n")
PY
  done
} >>"$OUT/tour.md"

"$D" down >/dev/null
echo "tour written to $OUT/tour.md ($N views)"
