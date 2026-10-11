#!/usr/bin/env bash
# DEAD ENDS — can the user always get back out?
#
# Opens every view / panel / modal / menu it knows how to open in the real app and,
# for each, checks three exits independently (re-opening the view in between):
#   Escape            real key event (WebDriver; xdotool as second opinion)
#   visible control   a visible button/link whose text, aria-label, title or class
#                     says close / back / cancel / done / × — clicked with the real pointer
#   click outside     real click on a point outside the view (overlays and menus)
# and, after closing: are we on the same page, and where did keyboard focus go?
#
#   dead-ends.sh [--no-build] [--keep-up] [--only '<substring>']
# Report: $DESKTOP_CHECK_DIR/signals/dead-ends.md  (+ de-*.png for every exit that failed)
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signal-lib.sh"
REPORT="$SIG_OUT/dead-ends.md"; ROWS="$SIG_OUT/dead-ends.tsv"; : >"$ROWS"
ONLY=""; prev=""; for a in "$@"; do [ "$prev" = "--only" ] && ONLY="$a"; prev="$a"; done
rm -f "$SIG_OUT"/de-*.png
HOME_PAGE="Dead End Home"
FIRST_BLOCK='document.querySelector(".block .ProseMirror")'
press() { "$D" press "$1" 2>/dev/null; sleep "${2:-0.9}"; }

sig_up deadends || { printf '# Dead ends\n\napp did not start\n' >"$REPORT"; echo "report: $REPORT"; exit 0; }
PDF="$("$D" fixture-pdf)"
ev "(async()=>{const api=await import('/src/lib/api.ts');
  const p=await api.createPage('$HOME_PAGE'); const a=await api.createBlock(p.id,'# Heading for the outline');
  const b=await api.createBlock(p.id,'parent block with [[Project Alpha]] link'); await api.createBlock(p.id,'child block',b.id);
  await api.createBlock(p.id,'TODO a task for the kanban'); await api.createBlock(p.id,'last block');
  const f=await api.createFolder('Dead End Project'); const q=await api.createPage('Filed page'); await api.movePageToFolder(q.id,f.id);
  const t=await api.createPage('Binned page'); await api.trashPage(t.id);
  window.__MINOTES__.refreshSidebar(); return 1})()" >/dev/null
sleep 1

FOCUS_JS='(() => { const a = document.activeElement; if (!a || a === document.body) return "nothing (body)"; const pm = a.closest(".ProseMirror"); if (pm) return "block editor #" + [...document.querySelectorAll(".block .ProseMirror")].indexOf(pm); return a.tagName.toLowerCase() + (a.className ? "." + String(a.className).split(" ")[0] : "") + (a.placeholder ? "[" + a.placeholder.slice(0, 18) + "]" : ""); })()'
# Force everything shut between attempts (test API + synthetic Escapes; not counted as an exit).
recover() {
  js 'const T = window.__MINOTES__; T.closePanel(); const pc = document.querySelector(".pdf-close-btn"); if (pc) pc.click();
      for (let i = 0; i < 2; i++) { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); await window.__sig.sleep(120); }
      document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true})); document.body.dispatchEvent(new MouseEvent("click", {bubbles: true}));
      const fs = document.querySelector(".folder-settings-header button"); if (fs) fs.click();
      document.querySelectorAll(".sidebar input").forEach(i => { i.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); });
      if (window.__MINOTES__.getCurrentPage() === "'"$HOME_PAGE"'" && /[\/\[]\s*$|\/ \/|\[\[/.test(window.__MINOTES__.getBlockContent(0) || "")) window.__MINOTES__.setBlockContent(0, "# Heading for the outline");
      if (document.activeElement) document.activeElement.blur(); window.__sig.answer = null; return 1' >/dev/null
  sleep 0.3
}
is_open() { [ "$(ev "!!($CONT)")" = "true" ]; }
# prep <start>: get to the home page with focus either in a block or nowhere
prep() {
  recover; park
  [ "$(page)" = "$HOME_PAGE" ] || goto "$HOME_PAGE"
  if [ "$1" = "editor" ]; then rclick "$FIRST_BLOCK" 0.4; else blur; fi
}
open_it() { eval "$OPEN" >/dev/null 2>&1; sleep 0.5; is_open; }
after() { # → "same|<page>" TAB focus
  local p; p="$(page)"; [ "$p" = "$HOME_PAGE" ] && p="same"
  printf '%s\t%s' "$p" "$(evs "$FOCUS_JS")"
}

# probe <name> <start: editor|neutral> <outside: yes|no> <open command> <container JS expr>
probe() {
  local name="$1" start="$2" outside="$3"; OPEN="$4"; CONT="$5"; CTRL="${6:-}"
  [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && return 0
  local slug; slug="$(echo "$name" | tr -c 'A-Za-z0-9' '-' | tr -s '-' | cut -c1-36)"
  local esc="–" ctl="–" ctl_label="none found" out="n/a" same="–" focus_before="–" focus_after="–" how=""
  prep "$start"; focus_before="$(evs "$FOCUS_JS")"
  if ! open_it; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "COULD NOT OPEN" "–" "–" "–" "–" "–" "$focus_before" "–" >>"$ROWS"
    echo "  $name: could not open"; shot "de-$slug-noopen" >/dev/null; return 0
  fi
  # 1. Escape
  press Escape 0.8
  if ! is_open; then esc="closes"
  else
    xd key Escape; sleep 0.8
    if ! is_open; then esc="closes (xdotool only)"
    else press Escape 0.8; if ! is_open; then esc="closes on 2nd/3rd Escape"; else esc="NO"; shot "de-$slug-escape" >/dev/null; fi; fi
  fi
  if [ "$esc" != "NO" ]; then IFS=$'\t' read -r same focus_after < <(after); how="Escape"; fi
  # 2. visible close/back control
  prep "$start"
  if is_open || open_it; then
    local c; c="$(js "const c = $CONT; if (!c || !c.querySelectorAll) return null; const override = ${CTRL:-null};
      const vis = window.__sig.visible;
      const els = [...c.querySelectorAll('button,[role=button],a,[class*=close],[class*=back]')].filter(vis);
      const lab = el => (el.getAttribute('aria-label') || el.title || el.innerText || '').trim();
      const hit = els.find(el => /^(×|✕|✖|✗|x|close|back|cancel|done|esc|←)/i.test(lab(el)) || /close|back to|dismiss/i.test(lab(el)) || /(^|[-_ ])(close|back)([-_ ]|\$)/i.test(String(el.className)));
      const h2 = override || hit; if (!h2) return null; const r = h2.getBoundingClientRect(); const hit_ = h2;
      const text = (hit_.innerText || '').trim(); const named = !!(hit_.getAttribute('aria-label') || hit_.title);
      return (override ? 'toggle/nav: ' : '') + (lab(hit_).slice(0, 24) || '(unlabelled)') + (text.length <= 1 && !named ? ' [glyph only, no title/aria-label]' : '') + '\t' + Math.round(r.left + r.width / 2) + '\t' + Math.round(r.top + r.height / 2);" | python3 -c 'import json,sys
try: v=json.load(sys.stdin)
except Exception: v=None
print(v or "")')"
    if [ -n "$c" ]; then
      local cx cy; IFS=$'\t' read -r ctl_label cx cy <<<"$c"
      rclickxy "$cx" "$cy" 0.8
      if ! is_open; then ctl="closes"; [ -z "$how" ] && { IFS=$'\t' read -r same focus_after < <(after); how="control"; }
      else ctl="NO (clicked, still open)"; shot "de-$slug-control" >/dev/null; fi
    else ctl="none"; fi
  fi
  # 3. click outside
  if [ "$outside" = "yes" ]; then
    prep "$start"
    if is_open || open_it; then
      local pt; pt="$(js "const c = $CONT; const r = c.getBoundingClientRect ? c.getBoundingClientRect() : {left: 0, top: 0, right: 0, bottom: 0};
        const cands = [[1150, 770], [900, 700], [640, 780], [1150, 120], [640, 20]];
        const inside = (p) => p[0] >= r.left - 4 && p[0] <= r.right + 4 && p[1] >= r.top - 4 && p[1] <= r.bottom + 4;
        const p = cands.find(p => !inside(p) && p[0] < innerWidth && p[1] < innerHeight); return p ? p.join(' ') : '';" | tr -d '"')"
      if [ -n "$pt" ]; then
        rclickxy $pt 0.8
        if ! is_open; then out="closes"; [ -z "$how" ] && { IFS=$'\t' read -r same focus_after < <(after); how="click outside"; }
        else out="NO"; fi
      else out="no outside area"; fi
    fi
  fi
  local v=()
  [ "$esc" = "NO" ] && v+=("Escape does nothing")
  { [ "$ctl" = "none" ] || [[ "$ctl" == NO* ]]; } && v+=("no visible close control")
  local verdict; verdict="$(IFS=';'; echo "${v[*]:-ok}" | sed 's/;/; /g')"
  if [ "$esc" = "NO" ] && { [ "$ctl" = "none" ] || [[ "$ctl" == NO* ]]; } && [ "$out" != "closes" ]; then verdict="DEAD END"; shot "de-$slug-DEADEND" >/dev/null; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$esc" "$ctl" "$ctl_label" "$out" "$same" "$focus_after" "$focus_before" "$verdict" >>"$ROWS"
  echo "  $name: esc=$esc | control=$ctl ($ctl_label) | outside=$out | page=$same | focus $focus_before → $focus_after | $verdict"
}

# helpers used by the open commands
palette_cmd() { press Control+k 0.7; xd type --delay 25 -- ">$1"; sleep 0.6; xd key Return; sleep 0.9; }
answer() { ev "(window.__sig.answer = $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"), 1)" >/dev/null; }
PAGE_ROW='window.__sig.byText(".page-item", "Project Alpha")'
FOLDER_ROW='window.__sig.byText(".folder-item", "Dead End Project")'

echo "probing views…"
probe "Search palette (Ctrl+K)"            editor  yes 'press Control+k' 'document.querySelector(".command-palette-overlay .command-palette")'
probe "Command mode (Ctrl+K, >)"           editor  yes 'press Control+k; xd type ">"' '(document.querySelector(".command-palette-overlay input")?.value || "").startsWith(">") ? document.querySelector(".command-palette") : null'
probe "Settings (Ctrl+,)"                  editor  yes 'press Control+,' 'document.querySelector(".settings-slide-panel")'
probe "SQL query panel (Ctrl+Q)"           neutral yes 'press Control+q' 'document.querySelector(".query-panel")'
probe "Flashcard review (Ctrl+R)"          neutral yes 'press Control+r' 'document.querySelector(".review-panel")'
probe "Plugins (palette command)"          neutral yes 'palette_cmd Plugins' 'document.querySelector(".plugin-manager")'
probe "Sync (palette command)"             neutral yes 'palette_cmd Sync' 'document.querySelector(".sync-panel")'
probe "CSS snippets (palette command)"     neutral yes 'palette_cmd CSS' 'window.__sig.byText(".command-palette", "Snippet")'
probe "Graph view (Ctrl+G)"                neutral no  'press Control+g 1.5' '(document.querySelector(".canvas-mode-btn.active")?.innerText || "").includes("Graph") ? document.querySelector(".canvas-layer") : null'
probe "Mind map (Ctrl+M)"                  neutral no  'press Control+m 1.5' '(document.querySelector(".canvas-mode-btn.active")?.innerText || "").includes("Mind") ? document.querySelector(".canvas-layer") : null'
probe "Kanban (Ctrl+Shift+K)"              neutral no  'press Control+Shift+K 1.5' '(document.querySelector(".canvas-mode-btn.active")?.innerText || "").includes("Kanban") ? document.querySelector(".canvas-layer") : null'
probe "Whiteboard / Draw (Ctrl+W)"         neutral no  'press Control+w 2' '(document.querySelector(".canvas-mode-btn.active")?.innerText || "").includes("Draw") ? document.querySelector(".canvas-layer") : null'
probe "Whiteboard, a drawing tool armed"   neutral no  'press Control+w 2; rclick "window.__sig.byText(\".canvas-layer button\", \"Box\")" 0.5' '(document.querySelector(".canvas-mode-btn.active")?.innerText || "").includes("Draw") ? document.querySelector(".canvas-layer") : null'
probe "All pages (sidebar button)"         neutral no  'rclick "window.__sig.byText(\".stats-mode-btn\", \"Pages\")" 1.2' '(document.querySelector(".canvas-mode-btn.active")?.innerText || "").includes("Pages") ? document.querySelector(".canvas-layer") : null'
probe "PDF viewer (Ctrl+P)"                neutral no  "answer '$PDF'; press Control+p 2.5" 'document.querySelector(".pdf-viewer")'
probe "PDF viewer, missing file"           neutral no  "answer '/no/such.pdf'; press Control+p 2.5" 'document.querySelector(".pdf-viewer")'
probe "Block context menu (right-click)"   editor  yes 'rrclick "document.querySelectorAll(\".block .ProseMirror\")[1]"' 'document.querySelector(".block-context-menu")'
probe "Sidebar page menu (right-click)"    neutral yes "rrclick '$PAGE_ROW'" 'document.querySelector(".sidebar-context-menu-item")?.parentElement'
probe "Sidebar page menu (⋮ button)"       neutral yes "rhover '$PAGE_ROW'; rclick '$PAGE_ROW.querySelector(\".page-more-btn\")'" 'document.querySelector(".sidebar-context-menu-item")?.parentElement'
probe "Project menu (right-click)"         neutral yes "rrclick '$FOLDER_ROW'" 'document.querySelector(".sidebar-context-menu-item")?.parentElement'
probe "Project settings panel"             neutral yes "rrclick '$FOLDER_ROW'; rclick 'window.__sig.byText(\".sidebar-context-menu-item\", \"Settings\")'" 'document.querySelector(".folder-settings-header")?.parentElement'
probe "Slash menu (/ in a block)"          editor  yes 'xd key End; xd type " /"; sleep 0.6' 'document.querySelector(".slash-menu")'
probe "Page-link menu ([[ in a block)"     editor  yes 'xd key End; xd type " [["; sleep 0.8' '[...document.querySelectorAll(".tippy-box")].find(t => window.__sig.visible(t)) || null'
probe "Page info panel (ℹ button)"         neutral no  'rclick "document.querySelector(\".prop-toggle-btn[title=\\\"Page info\\\"]\")"' 'document.querySelector(".page-properties, .page-info-panel, .page-aliases")' 'document.querySelector(".prop-toggle-btn[title*=info]")'
probe "Outline / table of contents"        neutral no  'rclick "document.querySelector(\".prop-toggle-btn[title=\\\"Table of contents\\\"]\")"' '(() => { const t = document.querySelector(".toc-right-panel"); return t && window.__sig.visible(t) ? t : null; })()' 'document.querySelector(".prop-toggle-btn[title*=contents]")'
probe "New page field (+ New)"             neutral yes 'rclick "window.__sig.byText(\"button\", \"+ New\")"' 'document.querySelector(".sidebar-actions input[placeholder^=Page]")?.parentElement'
probe "New project field"                  neutral yes 'rclick "document.querySelector(\".sidebar-new-project\")"' 'document.querySelector("input[placeholder^=Project]")?.parentElement'
probe "Page title rename field"            neutral yes 'rclick "document.querySelector(\".main-header h2\")"' 'document.querySelector(".page-title-input")'
probe "Sidebar rename field (menu → Rename)" neutral yes "rrclick '$PAGE_ROW'; rclick 'window.__sig.byText(\".sidebar-context-menu-item\", \"Rename\")'" 'document.querySelector(".sidebar-rename-input")'
probe "Calendar (sidebar ▾)"               neutral no  'rclick "document.querySelector(\".sidebar-journal-row .sidebar-section-chevron\")"' 'document.querySelector(".cal-widget")' 'document.querySelector(".sidebar-journal-row .sidebar-section-chevron")'
probe "Trash list (sidebar)"               neutral no  'rclick "window.__sig.byText(\".sidebar-system-item\", \"Trash\")"' 'document.querySelector(".sidebar-trash-list")' 'window.__sig.byText(".sidebar-system-item", "Trash")'
probe "Zoomed into a block (Alt+→)"        editor  no  'xd key alt+Right; sleep 0.6' 'document.querySelector(".breadcrumb-bar")' 'document.querySelector(".breadcrumb-bar .breadcrumb-item")'
probe "Multi-block selection"              neutral no  'ev "window.__MINOTES__.selectBlocks(0, 2)"' 'window.__MINOTES__.getSelectedCount() > 0 ? document.querySelector(".page-view") : null'
probe "Block property field (+ on a block)" neutral yes 'rhover "document.querySelector(\".block\")"; rclick "document.querySelector(\".block .prop-add-btn\")"' 'document.querySelector(".block input[placeholder=key]")?.parentElement'
probe "Right sidebar (Shift+click a link)" neutral no  'p="$(center "document.querySelector(\".block .ProseMirror .wiki-link\")")"; xd mousemove $p; xd keydown shift; xd click 1; xd keyup shift; sleep 1' 'document.querySelector(".right-sidebar")'
probe "Future journal day (Next →)"        neutral no  'ev "window.__MINOTES__.openJournal()"; sleep 1.2; rclick "window.__sig.byText(\"button\", \"Next\")" 1.2' 'document.querySelector(".pending-journal")' 'document.querySelector(".sidebar-journal-text")'

recover
errs="$(evs 'window.__sig.events.map(e => e.kind + " [" + e.mark + "] " + e.msg).join("\n")')"
sig_down

{
  echo "# Dead ends"; echo
  echo "_Generated $(date -u +%FT%TZ) by dead-ends.sh — real key and pointer input against the desktop app._"; echo
  echo "Each exit was tried on a freshly opened view. **Escape**: real key event. **Visible control**: a visible close/back/cancel/× control inside the view, clicked. **Click outside**: only meaningful for overlays and menus (n/a for full views). **Same page**: still on the starting page after closing. **Focus**: where the keyboard focus was before opening → after closing (first exit that worked)."; echo
  echo "| View | Escape | Visible control | Click outside | Same page | Focus before → after | Verdict |"
  echo "|---|---|---|---|---|---|---|"
  awk -F'\t' '{ctl = $3; if ($4 != "none found" && $4 != "–") ctl = ctl " — `" $4 "`"; printf "| %s | %s | %s | %s | %s | %s → %s | %s |\n", $1, $2, ctl, $5, $6, $8, $7, $9}' "$ROWS"
  echo; echo "## Findings"; echo
  awk -F'\t' '$9 == "DEAD END" {print "- DEAD END: **" $1 "** — Escape: " $2 ", control: " $3 ", click outside: " $5}' "$ROWS"
  awk -F'\t' '$2 == "COULD NOT OPEN" {print "- Could not be opened by the tool: **" $1 "** (check whether the entry point is broken or the tool is — see de-*-noopen.png)"}' "$ROWS"
  awk -F'\t' '$2 == "NO" && $9 != "DEAD END" {print "- Escape does not close **" $1 "** (exit: " ($3 ~ /^closes/ ? "control `" $4 "`" : "click outside") ")"}' "$ROWS"
  awk -F'\t' '($3 == "none" || $3 ~ /^NO/) && $9 != "DEAD END" && $2 != "COULD NOT OPEN" {print "- No visible close/back control in **" $1 "** (exit: " ($2 != "NO" ? "Escape" : "") ($5 == "closes" ? " / click outside" : "") ")"}' "$ROWS"
  awk -F'\t' '$4 ~ /glyph only/ {print "- Close control of **" $1 "** is a bare glyph with no title/aria-label: `" $4 "`"}' "$ROWS"
  awk -F'\t' '$6 != "same" && $6 != "–" {print "- Closing **" $1 "** does not return to the starting page (ends on \"" $6 "\")"}' "$ROWS"
  awk -F'\t' '$8 ~ /block editor/ && $7 !~ /block editor/ && $7 != "–" {print "- Focus is not restored after closing **" $1 "**: was in " $8 ", ends on " $7}' "$ROWS"
  echo; echo "### Errors recorded while probing"; echo
  if [ -n "$errs" ]; then printf '%s\n' "$errs" | sort | uniq -c | sort -rn | sed 's/^ *//; s/^/- ×/' | cut -c1-260 | head -25; else echo "none"; fi
} >"$REPORT"
echo "report: $REPORT"
exit 0
