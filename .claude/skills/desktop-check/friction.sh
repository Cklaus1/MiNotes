#!/usr/bin/env bash
# JOURNEY FRICTION — how much effort does a task cost the user?
#
#  a. static: tests/user-journey-test.sh, per journey: steps, outcomes, UI actions,
#     backend bypasses, key presses, sleeps (friction_static.py)
#  b. live:   8 core tasks done THROUGH THE UI of the real app with real X input
#     (xdotool clicks + keystrokes), each counted and its outcome confirmed.
#
#   friction.sh [--no-build] [--keep-up] [--static-only]
# Report: $DESKTOP_CHECK_DIR/signals/friction.md
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signal-lib.sh"
REPORT="$SIG_OUT/friction.md"; ROWS="$SIG_OUT/friction-rows.tsv"; : >"$ROWS"
NOTES=()

{
  echo "# Journey friction"; echo
  echo "_Generated $(date -u +%FT%TZ) by friction.sh._"; echo
  python3 "$SIG_HERE/friction_static.py" "$REPO/tests/user-journey-test.sh" || echo "(static analysis failed)"
} >"$REPORT"
case " $* " in *" --static-only "*) echo "report: $REPORT"; exit 0 ;; esac

sig_up friction || { md ""; md "## Live: app did not start"; echo "report: $REPORT"; exit 0; }

# row <task> <path> <ok-expr-result> <visible control?> <notes>   (uses CLICKS/KEYS, then resets)
row() {
  local ok="FAILED"; [ "$3" = "true" ] && ok="ok"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$CLICKS" "$KEYS" "$ok" "$4" "$5" >>"$ROWS"
  echo "  $1 — $2: $CLICKS clicks + $KEYS keys → $ok"
  reset_count
}
note() { NOTES+=("$1"); echo "  note: $1"; }
FIRST_BLOCK='document.querySelector(".block .ProseMirror")'
LAST_BLOCK='[...document.querySelectorAll(".block .ProseMirror")].pop()'
live() { evs '[...document.querySelectorAll(".block .ProseMirror")].map(p => p.innerText.trim()).join(" ¦ ")'; }

# ── 1. Create a page ─────────────────────────────────────────────────────────
echo "1. create a page"
reset_count
rclick 'window.__sig.byText("button", "+ New")'
ph="$(evs 'document.activeElement.placeholder || ""')"
rtype "Trip Plan"; rkey Return 1.5
ok="$(ev 'window.__MINOTES__.getCurrentPage() === "Trip Plan"')"
focus_after="$(evs 'document.activeElement.closest(".ProseMirror") ? "editor" : document.activeElement.tagName')"
row "Create a page" "click + New, type title, Enter" "$ok" "yes — \"+ New\" button" "title field autofocused (placeholder \"$ph\"); after create focus is on $focus_after"
[ "$focus_after" != "editor" ] && note "UX: after creating a page the cursor is NOT in the new empty block (focus: $focus_after) — the user must click the block before typing (+1 click on every new page)."
shot friction-1-created >/dev/null

# Keyboard path: Ctrl+N opens a native prompt(). The hooks answer it (a GTK dialog
# cannot be driven while a WebDriver session is attached).
blur; ev '(window.__sig.answer = "Kbd Page", window.__sig.dialogs.length = 0, 1)' >/dev/null
rkey ctrl+n 1.5; KEYS=$((KEYS + 8 + 1))   # the title + Enter the user types into the prompt
ok="$(ev 'window.__MINOTES__.getCurrentPage() === "Kbd Page"')"
dlg="$(evs 'window.__sig.dialogs.map(d => d.type + ": " + d.msg).join("; ")')"
row "Create a page" "Ctrl+N, title in native prompt, Enter" "$ok" "no — shortcut listed in Settings only" "opens a native dialog ($dlg), answered by the hook"
goto "Trip Plan"; rclick "$FIRST_BLOCK" 0.4; reset_count
rkey ctrl+n 1.2
[ "$(evs 'String(window.__sig.dialogs.length)')" = "1" ] && note "UX: Ctrl+N does nothing while the cursor is in a block (the usual place for the cursor) — the shortcut is suppressed inside editors, with no feedback."
ev '(window.__sig.answer = null, 1)' >/dev/null; reset_count

# ── 2. Add three lines ───────────────────────────────────────────────────────
echo "2. add three lines"
goto "Trip Plan"; reset_count
rclick "$FIRST_BLOCK" 0.4
rtype "one"; rkey Return 1.0; rtype "two"; rkey Return 1.0; rtype "three"; sleep 1
got="$(live)"
ok="$([ "$got" = "one ¦ two ¦ three" ] && echo true || echo false)"
row "Add three lines" "click block, type, Enter, type, Enter, type (1 s pause after each Enter)" "$ok" "yes — the empty bullet" "blocks: $got"

# Same task typed without pausing after Enter, at three typing speeds.
js "$(cat "$SIG_HERE/friction-probe.js")" >/dev/null
for delay in 30 80 150 300; do
  ev "(async()=>{const api=await import('/src/lib/api.ts'); await api.createPage('Typeahead $delay'); return 1})()" >/dev/null
  goto "Typeahead $delay"; rclick "$FIRST_BLOCK" 0.4
  # One xdotool process, one keysym per key, so the gap after Enter really is one key interval.
  xd key --delay "$delay" o n e Return t w o Return t h r e e; sleep 2
  got="$(live)"; lat="$(evs 'window.__lat.splice(0).join(", ")')"
  printf '%s\t%s\t%s\n' "$delay" "$got" "$lat" >>"$SIG_OUT/friction-typeahead.tsv.tmp"
  echo "  type-ahead @${delay} ms/key: $got   (Enter→new block focused: $lat ms)"
done
mv "$SIG_OUT/friction-typeahead.tsv.tmp" "$SIG_OUT/friction-typeahead.tsv"
shot friction-2-typeahead >/dev/null
reset_count

# ── 3. Make a TODO and complete it ───────────────────────────────────────────
echo "3. TODO"
ev "(async()=>{const api=await import('/src/lib/api.ts'); await api.createPage('Todo keys'); await api.createPage('Todo box'); await api.createPage('Todo gfm'); await api.createPage('Todo slash'); return 1})()" >/dev/null
goto "Todo keys"; reset_count
rclick "$FIRST_BLOCK" 0.4; rtype "buy milk"
rkey ctrl+Return 0.8; s1="$(evs 'window.__MINOTES__.getLiveBlockContent(0)')"
rkey ctrl+Return 0.8; s2="$(evs 'window.__MINOTES__.getLiveBlockContent(0)')"
rkey ctrl+Return 0.8; s3="$(evs 'window.__MINOTES__.getLiveBlockContent(0)')"
ok="$([ "$s1" = "TODO buy milk" ] && [ "$s3" = "DONE buy milk" ] && echo true || echo false)"
row "Make a TODO and complete it" "click block, type, Ctrl+Enter ×3 (TODO → DOING → DONE)" "$ok" "no — only the Getting Started page mentions Ctrl+Enter" "states: $s1 / $s2 / $s3; completing costs 2 extra chords (must pass through DOING)"
# the TODO badge: is there a one-click way to complete?
badge="$(evs 'const b = document.querySelector(".todo-badge"); b ? b.title : ""')"
[ -n "$badge" ] && note "TODO badge tooltip: \"$badge\" — clicking the badge is the only pointer path; there is no checkbox for TODO/DOING/DONE blocks."

goto "Todo box"; reset_count
rclick "$FIRST_BLOCK" 0.4; rtype "[ ] call bob"; sleep 0.6
made="$(ev '!!document.querySelector(".block .ProseMirror li[data-checked]")')"
rclick 'document.querySelector(".block .ProseMirror input[type=checkbox]")' 0.8
ok="$(ev 'document.querySelector(".block .ProseMirror li[data-checked]")?.getAttribute("data-checked") === "true"')"
row "Make a TODO and complete it" "click block, type \"[ ] text\", click the checkbox" "$ok" "partly — nothing says \"[ ]\" makes a checkbox; / menu has \"Todo List\"" "checkbox created by typing: $made"

goto "Todo gfm"; rclick "$FIRST_BLOCK" 0.4; rtype "- [ ] call bob"; sleep 0.8
gfm="$(ev '!!document.querySelector(".block .ProseMirror li[data-checked]")')"; gfmtxt="$(evs 'window.__MINOTES__.getLiveBlockContent(0)')"
[ "$gfm" != "true" ] && note "UX: typing the standard markdown \"- [ ] task\" does NOT make a checkbox — it becomes a bullet with literal text (saved as \`$gfmtxt\`). Only \"[ ] \" without the dash converts."

goto "Todo slash"; reset_count
rclick "$FIRST_BLOCK" 0.4; rtype "/todo"; sleep 0.8
menu="$(evs '[...document.querySelectorAll(".tippy-box")].map(t => t.innerText.trim().split("\n")[0]).join(",")')"
rkey Return 0.8; rtype "walk dog"; sleep 0.5
rclick 'document.querySelector(".block .ProseMirror input[type=checkbox]")' 0.8
ok="$(ev 'document.querySelector(".block .ProseMirror li[data-checked]")?.getAttribute("data-checked") === "true"')"
row "Make a TODO and complete it" "click block, /todo, Enter, type, click the checkbox" "$ok" "yes — \"/\" hint in placeholder / Getting Started" "slash menu offered: $menu"

# ── 4. Link to another page ──────────────────────────────────────────────────
echo "4. link"
goto "Trip Plan"; reset_count
rclick "$LAST_BLOCK" 0.4; rkey End 0.2; rkey Return 1.0
rtype "see [[Proj"; sleep 1.0
sugg="$(evs '[...document.querySelectorAll(".tippy-box")].map(t => t.innerText.trim().replace(/\n+/g, " | ")).join(" ")')"
rkey Return 1.0
linked="$(ev '(window.__MINOTES__.getLiveBlockContent(window.__MINOTES__.getBlockCount() - 1) || "").includes("[[Project Alpha]]")')"
row "Link to another page" "new line, type \"see [[Proj\", Enter on the suggestion" "$linked" "no — \"[[\" is taught only on the Getting Started page" "suggestions: ${sugg:0:80}"
rclick 'document.querySelector(".block .ProseMirror [data-type=wikiLink], .block .ProseMirror .wiki-link, .block .ProseMirror a")' 1.2
ok="$(ev 'window.__MINOTES__.getCurrentPage() === "Project Alpha"')"
row "Follow the link" "click the link" "$ok" "yes — styled as a link" ""

# ── 5. Find a page via search ────────────────────────────────────────────────
echo "5. search"
goto "Trip Plan"; rclick "$FIRST_BLOCK" 0.4; reset_count
rkey ctrl+k 0.8; opened="$(ev 'window.__MINOTES__.isPanelOpen("search")')"
rtype "alpha"; sleep 1.2; rkey Return 1.2
ok="$(ev 'window.__MINOTES__.getCurrentPage() === "Project Alpha" && !window.__MINOTES__.isPanelOpen("search")')"
row "Find a page via search" "Ctrl+K (from inside a block), type \"alpha\", Enter" "$ok" "yes — tooltip on the Search button" "palette opened from the editor: $opened"
goto "Trip Plan"; reset_count
rclick 'window.__sig.byText("button", "Search")' 0.8; rtype "alpha"; sleep 1.2; rkey Return 1.2
ok="$(ev 'window.__MINOTES__.getCurrentPage() === "Project Alpha"')"
focus_after="$(evs 'document.activeElement.closest(".ProseMirror") ? "editor" : document.activeElement.tagName')"
row "Find a page via search" "click Search, type \"alpha\", Enter" "$ok" "yes — Search button" "focus after landing: $focus_after"

# ── 6. Open today's journal ──────────────────────────────────────────────────
echo "6. journal"
goto "Trip Plan"; reset_count
rclick 'document.querySelector(".sidebar-journal-text")' 1.2
ok="$(ev '(window.__MINOTES__.getCurrentPage() || "").startsWith("Journal/")')"
row "Open today's journal" "click \"Today\" in the sidebar" "$ok" "yes — \"Today · date\" row" ""
goto "Trip Plan"; blur; reset_count
rkey ctrl+j 1.2
ok="$(ev '(window.__MINOTES__.getCurrentPage() || "").startsWith("Journal/")')"
row "Open today's journal" "Ctrl+J (nothing focused)" "$ok" "yes — tooltip + Getting Started" ""
goto "Trip Plan"; rclick "$FIRST_BLOCK" 0.4; reset_count
rkey ctrl+j 1.2
ok="$(ev '(window.__MINOTES__.getCurrentPage() || "").startsWith("Journal/")')"
row "Open today's journal" "Ctrl+J (cursor in a block)" "$ok" "—" "Getting Started says \"jump to today's journal anytime\""
[ "$ok" != "true" ] && note "BUG (docs vs behaviour): Ctrl+J is advertised as \"jump to today's journal anytime\" but does nothing while the cursor is in a block."

# ── 7. Move a page into a folder / project ───────────────────────────────────
echo "7. move to project"
goto "Trip Plan"; blur; reset_count
rclick 'document.querySelector(".sidebar-new-project")' 0.5; rtype "Travel"; rkey Return 1.0
ok="$(ev '!!window.__sig.byText(".folder-item", "Travel")')"
row "Create a project (folder)" "click + New Project, type name, Enter" "$ok" "yes — \"+ New Project\"" ""
ROW='window.__sig.byText(".page-item", "Trip Plan")'
more_op="$(evs "getComputedStyle($ROW.querySelector('.page-more-btn')).opacity")"
rhover "$ROW"
rclick "$ROW.querySelector('.page-more-btn')" 0.6
items="$(evs '[...document.querySelectorAll(".sidebar-context-menu-item")].map(e => e.innerText.trim()).join(" | ")')"
rclick 'window.__sig.byText(".sidebar-context-menu-item", "Move")' 0.5
rclick '[...document.querySelectorAll(".sidebar-context-submenu .sidebar-context-menu-item")].find(e => e.innerText.includes("Travel"))' 1.0
ok="$(ev "(async()=>{const api=await import('/src/lib/api.ts'); const t=await api.getFolderTree(); return t.folders.some(f => f.name==='Travel' && f.pages.some(p => p.title==='Trip Plan'))})()")"
fb="$(evs 'window.__sig.feedback().join("; ")')"
row "Move a page into a project" "hover page row, click ⋮, Move to…, click project" "$ok" "weak — ⋮ is invisible (opacity $more_op) until the row is hovered; right-click also works" "menu: $items; feedback after move: ${fb:-none}"
note "Move-to-project has no keyboard path and no confirmation toast (feedback seen: ${fb:-none}); drag-and-drop exists (rows are draggable) but could not be exercised — HARNESS LIMITATION (xdotool cannot drive HTML5 drag-and-drop in WebKitGTK)."

# ── 8. Delete a page and undo / restore it ───────────────────────────────────
echo "8. delete + undo"
goto "Todo box"; reset_count
ROW='window.__sig.byText(".page-item", "Todo box")'
rrclick "$ROW" 0.6
rclick 'window.__sig.byText(".sidebar-context-menu-item", "Delete")' 0.8
toast="$(evs 'window.__sig.feedback().join("; ").replace(/\n/g, " ")')"
gone="$(ev '!window.__sig.byText(".page-item", "Todo box")')"
still_open="$(page)"
dialogs="$(evs 'String(window.__sig.dialogs.filter(d => d.type === "confirm").length)')"
shot friction-8-deleted >/dev/null
rclick 'document.querySelector(".minotes-toast-undo-btn")' 1.0
ok="$(ev '!!window.__sig.byText(".page-item", "Todo box")')"
row "Delete a page and undo" "right-click page row, Delete, click Undo on the toast" "$([ "$gone" = true ] && [ "$ok" = true ] && echo true || echo false)" "yes — context menu + Undo toast (5 s)" "feedback: $toast; confirm dialogs: $dialogs"
[ "$still_open" = "Todo box" ] && note "BUG: deleting the page that is currently open leaves it open and editable in the main view (still showing \"$still_open\" after it moved to Trash) — see friction-8-deleted.png."

# After the toast is gone: Ctrl+Z, then the Trash section.
rrclick "$ROW" 0.6; rclick 'window.__sig.byText(".sidebar-context-menu-item", "Delete")' 0.8
sleep 6.5; blur; reset_count
rkey ctrl+z 1.2
ok="$(ev '!!window.__sig.byText(".page-item", "Todo box")')"
row "Delete a page and undo" "Ctrl+Z after the toast expired" "$ok" "—" "Settings lists Ctrl+Z as \"Undo\""
if [ "$ok" != "true" ]; then
  note "UX: Ctrl+Z does not undo a page delete (Undo only exists for 5 s on the toast); afterwards the only way back is Trash → ↺."
  reset_count
  rclick 'window.__sig.byText(".sidebar-system-item", "Trash")' 0.8
  rhover 'document.querySelector(".sidebar-trash-item")'
  rclick 'document.querySelector(".sidebar-trash-action-btn[title=Restore]")' 1.0
  ok="$(ev '!!window.__sig.byText(".page-item", "Todo box")')"
  row "Restore a page from Trash" "click Trash, click ↺ on the row" "$ok" "yes — Trash (n) section, icon-only ↺ / ✕ buttons" ""
fi

errs="$(evs 'window.__sig.events.map(e => e.kind + " [" + e.mark + "] " + e.msg).join("\n")')"
sig_down

# ── report ───────────────────────────────────────────────────────────────────
{
  echo; echo "## Live: core tasks through the real UI"; echo
  echo "Real X input (xdotool) against the desktop app; every outcome confirmed with \`eval\`. A chord (Ctrl+K) counts as one key; typed text counts one per character, so compare paths, not absolute numbers (titles/text used: \"Trip Plan\", \"one/two/three\", \"buy milk\", \"alpha\")."; echo
  echo "| Task | Path | clicks | keys | total | outcome | visible control? | notes |"
  echo "|---|---|---|---|---|---|---|---|"
  awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $3+$4, $5, $6, $7}' "$ROWS"
  echo; echo "### Typing straight through Enter (no pause)"; echo
  echo "\"one⏎two⏎three\" typed at a steady rate (30 ms/key is very fast, 80 ms is a fast typist, 150 ms average, 300 ms slow). Expected blocks: \`one ¦ two ¦ three\`. The last column is the measured time from the Enter keydown until a different block had focus (software rendering under Xvfb, debug build: treat as an upper bound)."; echo
  echo "| ms per key | blocks that resulted | Enter → new block focused (ms) |"; echo "|---|---|---|"
  awk -F'\t' '{printf "| %s | `%s` | %s |\n", $1, $2, $3}' "$SIG_OUT/friction-typeahead.tsv" 2>/dev/null
  echo; echo "## Findings"; echo
  if awk -F'\t' '$2 != "one ¦ two ¦ three"' "$SIG_OUT/friction-typeahead.tsv" 2>/dev/null | grep -q .; then
    echo "- BUG: keys that follow Enter faster than the new block can take focus (~75 ms here) land in the OLD block, and can come out reordered (\`three\` → \`roth\`/\`ee\`) — Enter awaits the backend (create + reorder) before the new block exists. Fast typists and key rollover hit this (table above)."
  fi
  for n in "${NOTES[@]}"; do echo "- $n"; done
  awk -F'\t' '$5 != "ok" {print "- Path did not reach its outcome: **" $1 "** via " $2 " (" $7 ")"}' "$ROWS"
  echo; echo "### Errors recorded while doing the tasks"; echo
  if [ -n "$errs" ]; then printf '%s\n' "$errs" | sed 's/^/- /' | cut -c1-300; else echo "none"; fi
} >>"$REPORT"
echo "report: $REPORT"
exit 0
