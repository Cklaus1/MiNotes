#!/usr/bin/env bash
# Deterministic variant of ux-tour.sh for visual-diff.sh: the same views, the
# same seed, but screenshots only (no audit), with the clock frozen and motion
# disabled (visual-freeze.js), the pointer parked off-content, and a fixed settle
# time per view. Keep the view list in step with ux-tour.sh: the names are the
# baseline file names.
#
#   visual-tour.sh <out-dir> [--no-build]     writes <out-dir>/NN-name.png + freeze.json
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/desktop.sh"
OUTDIR="${1:?usage: visual-tour.sh <out-dir> [--no-build]}"; shift
mkdir -p "$OUTDIR"
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
SETTLE="${VISUAL_SETTLE:-1.5}"

"$D" up --webdriver --profile visual-tour ${1:+$1} >/dev/null || { echo "launch failed" >&2; exit 1; }
freeze() { "$D" js "$(cat "$HERE/visual-freeze.js")" 2>/dev/null; }
freeze >"$OUTDIR/freeze.json"
"$D" seed-demo >/dev/null
e() { "$D" eval "$1" 2>/dev/null | tr -d '"'; }
# Same messy notebook as ux-tour.sh.
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

N=0
park() { "$D" click 1279 899 >/dev/null 2>&1 || true; }   # bottom-right corner: no hover target
parkmove() { DISPLAY="localhost:${DESKTOP_CHECK_DISPLAY:-97}" timeout 5 xdotool mousemove 1279 899 2>/dev/null || true; }
visit() {
  N=$((N+1)); local id; id=$(printf '%02d-%s' "$N" "$1")
  [ -n "$2" ] && "$D" eval "$2" >/dev/null 2>&1
  "$D" wait "${3:-true}" 10 2>/dev/null
  parkmove; sleep "$SETTLE"
  # wait for fonts/images, then two frames
  "$D" js 'await document.fonts.ready; await Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return 1' >/dev/null 2>&1
  "$D" wshot "visual-tmp-$id" >/dev/null 2>&1 && mv "$DESKTOP_CHECK_DIR/shots/visual-tmp-$id.png" "$OUTDIR/$id.png"
  echo "  $id"
}
nav() { echo "window.__MINOTES__.navigateTo('$1')"; }
on() { echo "window.__MINOTES__.getCurrentPage()==='$1'"; }
key() { "$D" press "$1" 2>/dev/null; sleep 1; }
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
"$D" down >/dev/null
echo "visual tour: $N views in $OUTDIR"
