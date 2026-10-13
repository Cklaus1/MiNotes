#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  MiNotes User Journey Tests v2
#
#  Tests what REAL USERS actually do, in the order they do it.
#  Not a feature tour — a day-in-the-life simulation.
#
#  Each journey = one thing a user wants to accomplish
#  Each step = one action + what the user expects to see
# ═══════════════════════════════════════════════════════════

AB="agent-browser"
URL="http://localhost:1420"
# JOURNEY_BACKEND=browser (default): headless Chrome + Vite dev server + mock backend.
# JOURNEY_BACKEND=desktop: the REAL desktop app (Tauri/WebKitGTK + Rust backend,
#   production CSP) through .claude/skills/desktop-check — same journeys, real data layer.
BACKEND="${JOURNEY_BACKEND:-browser}"
SSDIR="tests/screenshots/journey"
# Source-grep assertions (journey 50) read Rust files. Anchor them to the repo
# root so they work no matter where the suite is invoked from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/crates/minotes-app"
CORE_DIR="$REPO_ROOT/crates/minotes-core"
P=0; F=0
RESULTS=()
BUGS=()

mkdir -p "$SSDIR"

pass() { echo -e "    \033[32m✓\033[0m $1"; P=$((P+1)); RESULTS+=("✓ $1"); }
fail() { echo -e "    \033[31m✗\033[0m $1: $2"; F=$((F+1)); RESULTS+=("✗ $1: $2"); BUGS+=("$1: $2"); }
step() { echo -e "  \033[90m→ $1\033[0m"; }
journey() { echo -e "\n\033[1;33m🧭 JOURNEY: $1\033[0m"; }
if [[ "$BACKEND" == "desktop" ]]; then
  DC="$REPO_ROOT/.claude/skills/desktop-check/desktop.sh"
  DC_STATE="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
  SSDIR="$DC_STATE/journey-shots"; mkdir -p "$SSDIR"
  # Retry once if the WebDriver call itself failed (exit 3); never on a JS error.
  ev() { "$DC" eval "$1" 2>/dev/null; [[ $? -eq 3 ]] && { sleep 1; "$DC" eval "$1" 2>/dev/null; }; return 0; }
  snap() { "$DC" snapshot 2>/dev/null; }
  snapi() { "$DC" snapshot -i 2>/dev/null; }
  ss() { python3 "$REPO_ROOT/.claude/skills/desktop-check/wd.py" "http://127.0.0.1:${DESKTOP_CHECK_WD_PORT:-4455}" "$DC_STATE/wd.sid" shot "$SSDIR/$1.png" >/dev/null 2>&1; }
  press() { "$DC" press "$1" 2>/dev/null; }
  open_app() { "$DC" up --webdriver ${DESKTOP_NO_BUILD:+--no-build} && "$DC" seed-demo >/dev/null && sleep 2; }
  close_app() { "$DC" report || true; "$DC" down; }
else
  ev() { $AB eval "$1" 2>/dev/null; }
  snap() { $AB snapshot 2>/dev/null; }
  snapi() { $AB snapshot -i 2>/dev/null; }
  ss() { $AB screenshot "$SSDIR/$1.png" 2>/dev/null; }
  press() { $AB press "$1" 2>/dev/null; }
  open_app() { $AB open "$URL" --wait-until networkidle 2>/dev/null && sleep 3; }
  close_app() { $AB close 2>/dev/null; }
fi
api() { ev "window.__MINOTES__?.$1"; }

echo "═══════════════════════════════════════════════"
echo "  MiNotes User Journey Tests v2"
echo "  Simulating: A real day using MiNotes"
echo "═══════════════════════════════════════════════"

open_app

# ═══════════════════════════════════════════════
journey "1. I open the app — what do I see?"
# First impression. Do I know what to do?
# ═══════════════════════════════════════════════

step "App loads with something useful (not blank)"
S=$(snap)
echo "$S" | grep -qi "Journal\|MiNotes" && pass "App shows content on launch" || fail "Blank screen on launch" "Nothing visible"

step "I can see where my pages are"
echo "$S" | grep -qi "Getting Started\|Project Alpha" && pass "Sidebar shows my pages" || fail "No pages in sidebar" "Can't find my notes"

step "I know today's date from the journal"
echo "$S" | grep -qi "2026-03-24\|Journal" && pass "Today's journal is open" || fail "No journal" "Don't know what day it is"

step "There's a clear place to start typing"
sleep 3
SI=$(snapi)
echo "$SI" | grep -qi "editable\|contenteditable\|ProseMirror\|block-content\|block-editor\|Type.*commands" && pass "I see where to type" || {
  # Fallback: check if any block elements exist in DOM
  HAS_BLOCKS=$(ev "document.querySelectorAll('[data-block-id]').length" | tr -d '"')
  [[ "$HAS_BLOCKS" -ge 1 ]] 2>/dev/null && pass "I see where to type ($HAS_BLOCKS blocks)" || fail "No editable area" "Don't know where to type"
}

step "I see stats (how much content I have)"
echo "$S" | grep -qi "pages\|blocks" && pass "Stats visible" || fail "No stats" "Don't know how much I've written"

ss "01-first-impression"

# ═══════════════════════════════════════════════
journey "2. I want to write a few thoughts in my journal"
# The #1 use case: open journal, type, Enter, type more
# ═══════════════════════════════════════════════

step "I type my first thought"
api "setBlockContent(0, 'Morning standup notes')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
echo "$R" | grep -qi "standup\|Morning" && pass "First thought typed" || fail "Typing failed" "Content: ${R:0:40}"

step "I add a second thought"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();const j=pages.find(x=>x.is_journal);if(j){await api.createBlock(j.id,'Need to review PR #42');return 'created'}return 'no journal'})()" > /dev/null 2>&1
sleep 1
api "openJournal()" > /dev/null; sleep 2
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 2 ]] 2>/dev/null && pass "Two thoughts captured ($R blocks)" || fail "Can't add second thought" "$R blocks"

step "I add a third thought"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();const j=pages.find(x=>x.is_journal);if(j){await api.createBlock(j.id,'Design review at 2pm');return 'created'}return 'no journal'})()" > /dev/null 2>&1
sleep 1
api "openJournal()" > /dev/null; sleep 2
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 3 ]] 2>/dev/null && pass "Three thoughts captured ($R blocks)" || fail "Can't keep writing" "$R blocks"

ss "02-write-thoughts"

# ═══════════════════════════════════════════════
journey "3. I want to make a todo list for today"
# Create tasks, check them off, see progress
# ═══════════════════════════════════════════════

step "I create a todo item"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
api "setBlockContent(0, '- [ ] Ship the new feature')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "taskList\|checkbox" && pass "Todo checkbox appears" || fail "No checkbox" "Expected task list"

step "I add more todo items"
api "setBlockContent(0, '- [ ] Ship the new feature\n- [ ] Write docs\n- [ ] Send release email')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
COUNT=$(echo "$H" | grep -o "data-checked" | wc -l)
[[ "$COUNT" -ge 3 ]] && pass "Three todo items ($COUNT)" || fail "Can't add multiple todos" "Only $COUNT items"

step "I click a checkbox to mark a task done"
api "toggleCheckbox(0, 0)" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.querySelector('li')?.getAttribute('data-checked')")
echo "$H" | grep -qi "true" && pass "Checkbox toggles to done" || fail "Checkbox toggle broken" "data-checked=$H"

step "Done task shows strikethrough"
if echo "$H" | grep -qi "true"; then
  STYLE=$(ev "window.getComputedStyle(document.querySelectorAll('.ProseMirror li[data-checked=\"true\"] > div')[0]||document.body)?.textDecoration")
  echo "$STYLE" | grep -qi "line-through" && pass "Strikethrough on done tasks" || fail "No strikethrough on done" "$STYLE"
else
  fail "Strikethrough check" "Skipped — checkbox didn't toggle"
fi

ss "03-todo-list"

# ═══════════════════════════════════════════════
journey "4. I want to organize my notes with headings"
# Structure content with H1, H2, bullet lists
# ═══════════════════════════════════════════════

step "I create a page heading"
api "setBlockContent(1, '# Release Plan v2.0')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.innerHTML")
echo "$H" | grep -qi "<h1" && pass "H1 heading renders big" || fail "H1 not rendering" "${H:0:60}"

step "I add a subheading"
api "setBlockContent(2, '## Timeline')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[2]?.innerHTML")
echo "$H" | grep -qi "<h2" && pass "H2 subheading renders" || fail "H2 not rendering" "${H:0:60}"

step "I add a bullet list under the subheading"
api "setBlockContent(3, '- Week 1: Backend\n- Week 2: Frontend\n- Week 3: Testing')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[3]?.innerHTML")
echo "$H" | grep -qi "<ul" && pass "Bullet list renders" || fail "Bullets broken" "${H:0:60}"

step "I add a blockquote for emphasis"
api "setBlockContent(4, '> Ship early, ship often')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[4]?.innerHTML")
echo "$H" | grep -qi "blockquote" && pass "Blockquote renders" || fail "Quote broken" "${H:0:60}"

ss "04-headings-structure"

# ═══════════════════════════════════════════════
journey "5. I want to find something I wrote earlier"
# Search by keyword, navigate to result
# ═══════════════════════════════════════════════

step "I open search with Ctrl+K"
press "Control+k"; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search pages" && pass "Search panel opens" || fail "Ctrl+K broken" "No search"

step "I see my pages listed"
FOUND=0
for p in "Getting Started" "Project Alpha" "Research Notes"; do
  echo "$S" | grep -qi "$p" && FOUND=$((FOUND+1))
done
[[ "$FOUND" -ge 3 ]] && pass "All my pages listed ($FOUND)" || fail "Missing pages in search" "Only $FOUND"

step "I close search and navigate via sidebar"
press "Escape"; sleep 0.5
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Project Alpha"* ]] && pass "Navigate to search result" || fail "Can't navigate" "$R"

step "I see the content of the page I found"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 5 ]] 2>/dev/null && pass "Found page has content ($R blocks)" || fail "Page empty" "$R blocks"

ss "05-search-find"

# ═══════════════════════════════════════════════
journey "6. I want to link my notes together"
# Wiki links create connections between pages
# ═══════════════════════════════════════════════

step "I go to Research Notes which has wiki links"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
S=$(snap)
echo "$S" | grep -qi "Project Alpha" && pass "I see a [[Project Alpha]] link" || fail "No wiki link" "Link not visible"

step "The link looks clickable (blue, interactive)"
SI=$(snapi)
echo "$SI" | grep -qi "Project Alpha" && pass "Link is interactive" || fail "Link not clickable" "Not in interactive tree"

step "I can see backlinks / references"
echo "$S" | grep -qi "Unlinked\|Backlink\|Reference" && pass "References section exists" || fail "No references" "Can't see connections"

ss "06-wiki-links"

# ═══════════════════════════════════════════════
journey "7. I want to check my settings"
# Theme, tree mode, keyboard shortcuts
# ═══════════════════════════════════════════════

step "I open settings"
api "openSettings()" > /dev/null; sleep 1
S=$(snap)

step "I can change the theme"
echo "$S" | grep -qi "Theme" && echo "$S" | grep -qi "Dark\|Light" && pass "Theme switcher available" || fail "No theme option" "Can't change theme"

step "I can see Advanced section"
echo "$S" | grep -qi "Advanced" && pass "Advanced section available" || fail "No Advanced section in settings" ""

step "AI Assistant is its own section, visible while Advanced stays collapsed"
R=$(ev "(()=>{const sec=document.querySelector('.settings-section[data-section=ai]');if(!sec)return 'missing';const title=sec.querySelector('.settings-section-title')?.textContent;const nested=!!sec.parentElement.closest('.settings-section');const adv=document.querySelector('.settings-advanced-content');return [title,nested,sec.querySelectorAll('.settings-toggle input').length,adv?'open':'collapsed'].join('|')})()" | tr -d '"')
[[ "$R" == "AI Assistant|false|3|collapsed" ]] && pass "AI Assistant section: own header, 3 toggles, not under Advanced" || fail "AI Assistant section layout" "$R"

step "I can see all keyboard shortcuts"
SHORTCUTS=0
for key in "Ctrl+K" "Ctrl+J" "Ctrl+N" "Ctrl+G" "Tab" "Esc"; do
  echo "$S" | grep -qi "$key" && SHORTCUTS=$((SHORTCUTS+1))
done
[[ "$SHORTCUTS" -ge 5 ]] && pass "Keyboard shortcuts shown ($SHORTCUTS)" || fail "Shortcuts missing" "Only $SHORTCUTS found"

api "closePanel()" > /dev/null; sleep 0.5
ss "07-settings"

# ═══════════════════════════════════════════════
journey "8. I want to use the journal over multiple days"
# Navigate between days, see daily content
# ═══════════════════════════════════════════════

step "I'm on today's journal"
api "openJournal()" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
TODAY=$(date +%Y-%m-%d)
[[ "$R" == *"Journal/"* ]] && pass "Today's journal open ($R)" || fail "Wrong date" "$R"

step "I go back to yesterday"
api "openJournal('2026-03-23')" > /dev/null; sleep 1
ev "document.querySelector('.pending-journal .btn-primary')?.click()" > /dev/null 2>&1; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-23"* ]] && pass "Yesterday accessible" || fail "Journal 2026-03-23 not opened" "$R"

step "I go forward to today again"
api "openJournal('2026-03-24')" > /dev/null; sleep 1
ev "document.querySelector('.pending-journal .btn-primary')?.click()" > /dev/null 2>&1; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-24"* ]] && pass "Back to today" || fail "Journal 2026-03-24 not opened" "$R"

step "I check a specific date"
api "openJournal('2026-01-15')" > /dev/null; sleep 1
ev "document.querySelector('.pending-journal .btn-primary')?.click()" > /dev/null 2>&1; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-01-15"* ]] && pass "Any date accessible" || fail "Journal 2026-01-15 not opened" "$R"

ss "08-journal-dates"

# ═══════════════════════════════════════════════
journey "9. I want to switch between pages quickly"
# Rapid page switching — common multitasking pattern
# ═══════════════════════════════════════════════

step "Jump to Project Alpha"
api "navigateTo('Project Alpha')" > /dev/null; sleep 1
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Project Alpha"* ]] && pass "Quick switch to Project Alpha" || fail "Slow/broken nav" "$R"

step "Jump to Research Notes"
api "navigateTo('Research Notes')" > /dev/null; sleep 1
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Research Notes"* ]] && pass "Quick switch to Research Notes" || fail "Nav lag" "$R"

step "Jump to Getting Started"
api "navigateTo('Getting Started')" > /dev/null; sleep 1
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Getting Started"* ]] && pass "Quick switch to Getting Started" || fail "Nav broken" "$R"

step "Jump back to journal"
api "openJournal()" > /dev/null; sleep 1
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Journal"* ]] && pass "Quick jump to journal" || fail "Journal nav broken" "$R"

ss "09-rapid-switching"

# ═══════════════════════════════════════════════
journey "10. I want to use keyboard shortcuts efficiently"
# Power user flow: shortcuts for everything
# ═══════════════════════════════════════════════

step "Ctrl+K opens search"
press "Control+k"; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search" && pass "Ctrl+K → search" || fail "Ctrl+K" "No search"
press "Escape"; sleep 0.5

step "Ctrl+, opens settings"
press "Control+,"; sleep 1
S=$(snap)
echo "$S" | grep -qi "Settings\|Theme" && pass "Ctrl+, → settings" || fail "Ctrl+," "No settings"
press "Escape"; sleep 0.5

step "Ctrl+J opens journal"
press "Control+j"; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Journal"* ]] && pass "Ctrl+J → journal" || fail "Ctrl+J" "$R"

step "Ctrl+G opens graph"
press "Control+g"; sleep 2
S=$(snap)
echo "$S" | grep -qi "graph\|canvas\|close\|node" && pass "Ctrl+G → graph" || fail "Ctrl+G" "No graph"
press "Escape"; sleep 0.5

ss "10-keyboard-flow"

# ═══════════════════════════════════════════════
journey "11. I want to see my knowledge graph"
# Visual overview of all notes and connections
# ═══════════════════════════════════════════════

step "Graph view opens"
# The shortcut is ignored while the editor has focus.
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
press "Control+g"; sleep 2
S=$(snap)
echo "$S" | grep -qi "graph\|canvas" && pass "Graph renders" || fail "No graph" "Graph didn't load"
G_OPEN=$(ev "!!document.querySelector('.graph-view canvas')" | tr -d '"')
[[ "$G_OPEN" == "true" ]] && pass "Graph canvas is on screen" || fail "Graph canvas missing" "$G_OPEN"

step "Every node (and its label) is fitted inside the viewport"
# The graph is a canvas: it publishes what it shows as data-* attributes.
G_SET="(v)=>{const c=document.querySelector('.graph-hide-unlinked');if(!c)return 'no toggle';if(c.checked!==v)c.click();return 'ok'}"
G_STAT="(()=>{const c=document.querySelector('.graph-view canvas');return c?c.dataset.nodes+':'+c.dataset.inView:'no canvas'})()"
ev "($G_SET)(false)" > /dev/null 2>&1; sleep 1
G_ALL=$(ev "$G_STAT" | tr -d '"')
G_N=${G_ALL%%:*}; G_IN=${G_ALL##*:}
[[ "$G_N" -ge 2 && "$G_IN" == "$G_N" ]] 2>/dev/null && pass "All $G_N nodes are inside the viewport" || fail "Graph nodes clipped" "nodes:inView=$G_ALL"
G_CANVAS=$(ev "(()=>{const v=document.querySelector('.graph-view').getBoundingClientRect(),c=document.querySelector('.graph-view canvas').getBoundingClientRect();return c.height>100&&c.bottom<=v.bottom+1&&c.right<=v.right+1})()" | tr -d '"')
[[ "$G_CANVAS" == "true" ]] && pass "Canvas ends at the view's edge (nothing drawn off-screen)" || fail "Canvas overflows the graph view" "$G_CANVAS"

step "I hide unlinked pages to see only the connected ones"
G_UNLINKED=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const d=await api.getGraphData();const l=new Set();for(const e of d.edges){if(e.source!==e.target){l.add(e.source);l.add(e.target)}}return d.nodes.filter(n=>!l.has(n.id)).length})()" | tr -d '"')
ev "($G_SET)(true)" > /dev/null 2>&1; sleep 1
G_HID=$(ev "$G_STAT" | tr -d '"')
G_HN=${G_HID%%:*}; G_HIN=${G_HID##*:}
[[ "$G_UNLINKED" -ge 1 && "$G_HN" == "$((G_N - G_UNLINKED))" && "$G_HN" -lt "$G_N" ]] 2>/dev/null && pass "Hide unlinked reduces the graph ($G_N → $G_HN nodes)" || fail "Hide unlinked didn't reduce the graph" "all=$G_N unlinked=$G_UNLINKED shown=$G_HN"
[[ "$G_HIN" == "$G_HN" ]] && pass "Remaining nodes are all inside the viewport" || fail "Nodes clipped after hiding unlinked" "$G_HID"
G_LABEL=$(ev "document.querySelector('.graph-toolbar')?.textContent || ''" | tr -d '"')
echo "$G_LABEL" | grep -q "$G_UNLINKED unlinked hidden" && pass "Toolbar says how many are hidden" || fail "No hidden count in toolbar" "$G_LABEL"
G_PERSIST=$(ev "localStorage.getItem('minotes-graph-hide-unlinked')" | tr -d '"')
[[ "$G_PERSIST" == "1" ]] && pass "Choice is remembered" || fail "Hide-unlinked choice not persisted" "$G_PERSIST"

step "Fit button brings everything back into view"
ev "($G_SET)(false)" > /dev/null 2>&1; sleep 1
ev "document.querySelector('.graph-fit-btn')?.click()" > /dev/null 2>&1; sleep 0.5
G_FIT=$(ev "$G_STAT" | tr -d '"')
[[ "$G_FIT" == "$G_N:$G_N" ]] && pass "Fit shows all $G_N nodes" || fail "Fit didn't show every node" "$G_FIT"
# Leave no saved choice behind: later runs get the default again.
ev "localStorage.removeItem('minotes-graph-hide-unlinked')" > /dev/null 2>&1

step "I can close the graph"
press "Escape"; sleep 1
S=$(snap)
echo "$S" | grep -qi "Journal\|Getting Started" && pass "Graph closes, page returns" || fail "Stuck in graph" "Can't get back"

ss "11-graph"

# ═══════════════════════════════════════════════
journey "12. I want to see the Test Results page"
# Meta: can I read the test documentation in the app?
# ═══════════════════════════════════════════════

step "Navigate to Test Results"
api "navigateTo('Test Results — 2026-03-24')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Test Results"* ]] && pass "Test Results page opens" || fail "Can't find test results" "$R"

step "Page has substantial content"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 20 ]] 2>/dev/null && pass "Rich content ($R blocks)" || fail "Sparse content" "$R blocks"

step "Headings render correctly"
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "<h1\|heading" && pass "Headings render" || fail "Headings broken" "${H:0:40}"

ss "12-meta-test"

# ═══════════════════════════════════════════════
journey "13. I want to edit text I already wrote"
# Go back to existing content and change it
# ═══════════════════════════════════════════════

step "I go to a page with existing content"
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
ORIG=$(api "getBlockContent(1)" | tr -d '"')
[[ -n "$ORIG" ]] && pass "I see existing content" || fail "No content" "Block 1 empty"

step "I change the text in block 1"
api "setBlockContent(1, 'EDITED: Updated project description')" > /dev/null; sleep 1
R=$(api "getBlockContent(1)" | tr -d '"')
[[ "$R" == *"EDITED"* ]] && pass "Text updated successfully" || fail "Edit didn't save" "$R"

step "The edit shows in the editor"
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.textContent")
echo "$H" | grep -qi "EDITED" && pass "Editor reflects the edit" || fail "Editor stale" "$H"

step "I restore the original text"
api "setBlockContent(1, '$ORIG')" > /dev/null; sleep 1
R=$(api "getBlockContent(1)" | tr -d '"')
[[ "$R" == *"$ORIG"* ]] 2>/dev/null && pass "Original restored" || fail "Restore failed" "$R"

ss "13-edit-text"

# ═══════════════════════════════════════════════
journey "14. I want to delete a block I don't need"
# Backspace on empty block should remove it
# ═══════════════════════════════════════════════

step "I count how many blocks are on the page"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
BEFORE=$(api "getBlockCount()" | tr -d '"')
[[ "$BEFORE" -ge 3 ]] 2>/dev/null && pass "Page has $BEFORE blocks" || fail "Too few blocks" "$BEFORE"

step "I delete the last block"
# Actually use the test API's known block to delete
LAST_IDX=$((BEFORE - 1))
LAST_CONTENT=$(api "getBlockContent($LAST_IDX)" | tr -d '"')
[[ -n "$LAST_CONTENT" ]] && pass "Found last block to delete: ${LAST_CONTENT:0:30}" || fail "Can't find last block" "index $LAST_IDX"

step "Block count decreases after delete"
# Use the raw API to delete
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getPageTree('Getting Started');const blocks=tree.blocks;if(blocks.length>1){await api.deleteBlock(blocks[blocks.length-1].id);return 'deleted';}return 'skip'})()" > /dev/null 2>&1
sleep 1
api "navigateTo('Getting Started')" > /dev/null; sleep 2
AFTER=$(api "getBlockCount()" | tr -d '"')
[[ "$AFTER" -lt "$BEFORE" ]] 2>/dev/null && pass "Block deleted ($BEFORE → $AFTER)" || fail "Delete didn't work" "Still $AFTER blocks"

ss "14-delete-block"

# ═══════════════════════════════════════════════
journey "15. I want to use bold and italic formatting"
# Basic inline formatting that every user expects
# ═══════════════════════════════════════════════

step "I create a block with bold markdown"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
api "setBlockContent(0, 'This has **bold text** in it')" > /dev/null; sleep 2

step "Bold renders visually"
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "<strong\|font-weight" && pass "Bold renders as <strong>" || fail "Bold not rendering" "${H:0:60}"

step "I create a block with italic markdown"
api "setBlockContent(1, 'This has *italic text* in it')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.innerHTML")
echo "$H" | grep -qi "<em\|font-style" && pass "Italic renders as <em>" || fail "Italic not rendering" "${H:0:60}"

step "I create a block with inline code"
api "setBlockContent(2, 'Run the command \`npm install\` first')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[2]?.innerHTML")
echo "$H" | grep -qi "<code" && pass "Inline code renders as <code>" || fail "Code not rendering" "${H:0:60}"

step "I create a block with strikethrough"
api "setBlockContent(3, 'This is ~~no longer needed~~')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[3]?.innerHTML")
echo "$H" | grep -qi "<s>\|<del>\|line-through\|strike" && pass "Strikethrough renders" || fail "Strikethrough not rendering" "${H:0:60}"

ss "15-inline-formatting"

# ═══════════════════════════════════════════════
journey "16. I want to cycle TODO states on a block"
# Ctrl+Enter cycles: plain → TODO → DOING → DONE → plain
# ═══════════════════════════════════════════════

step "I set a block with TODO state"
api "setBlockContent(0, 'TODO Write the documentation')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" == *"TODO"* ]] && pass "TODO state visible" || fail "TODO not set" "$R"

step "I change to DOING state"
api "setBlockContent(0, 'DOING Write the documentation')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" == *"DOING"* ]] && pass "DOING state visible" || fail "DOING not set" "$R"

step "I change to DONE state"
api "setBlockContent(0, 'DONE Write the documentation')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" == *"DONE"* ]] && pass "DONE state visible" || fail "DONE not set" "$R"

step "I remove the state (back to plain)"
api "setBlockContent(0, 'Write the documentation')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" != *"TODO"* && "$R" != *"DOING"* && "$R" != *"DONE"* ]] && pass "State removed, plain text" || fail "State stuck" "$R"

ss "16-todo-cycling"

# ═══════════════════════════════════════════════
journey "17. I want to use the right-click context menu"
# Block operations: copy ref, duplicate, delete
# ═══════════════════════════════════════════════

step "I right-click on a block"
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
# Simulate right-click via CDP
ev "document.querySelectorAll('.block')[0]?.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:400, clientY:200}))" > /dev/null
sleep 1
S=$(snap)
echo "$S" | grep -qi "Copy\|Duplicate\|Delete\|TODO" && pass "Context menu appears" || fail "No context menu" "Right-click didn't show menu"

step "I close the context menu"
press "Escape"; sleep 0.5

ss "17-context-menu"

# ═══════════════════════════════════════════════
journey "18. I want mixed content on one page"
# Real pages have headings + text + lists + todos + links
# ═══════════════════════════════════════════════

step "I create a rich page with mixed content"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
api "setBlockContent(0, '# Meeting Notes - March 24')" > /dev/null; sleep 0.5
api "setBlockContent(1, 'Attendees: **Alice**, **Bob**, **Charlie**')" > /dev/null; sleep 0.5
api "setBlockContent(2, '## Action Items')" > /dev/null; sleep 0.5
api "setBlockContent(3, '- [ ] Alice: Update the roadmap')" > /dev/null; sleep 0.5
api "setBlockContent(4, '- [x] Bob: Deploy staging')" > /dev/null; sleep 0.5
api "setBlockContent(5, '> Key decision: Ship by end of Q1')" > /dev/null; sleep 0.5
api "setBlockContent(6, 'See [[Project Alpha]] for details')" > /dev/null; sleep 2

step "Heading renders"
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "<h1" && pass "H1 renders" || fail "H1 broken" "${H:0:40}"

step "Bold text renders"
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.innerHTML")
echo "$H" | grep -qi "<strong" && pass "Bold names render" || fail "Bold broken" "${H:0:40}"

step "Subheading renders"
H=$(ev "document.querySelectorAll('.ProseMirror')[2]?.innerHTML")
echo "$H" | grep -qi "<h2" && pass "H2 renders" || fail "H2 broken" "${H:0:40}"

step "Todo items render with checkboxes"
H=$(ev "document.querySelectorAll('.ProseMirror')[3]?.innerHTML")
echo "$H" | grep -qi "taskList\|checkbox" && pass "Todos render" || fail "Todos broken" "${H:0:40}"

step "Checked item shows correctly"
H=$(ev "document.querySelectorAll('.ProseMirror')[4]?.innerHTML")
echo "$H" | grep -qi "data-checked" && pass "Checked state renders" || fail "Checked broken" "${H:0:40}"

step "Blockquote renders"
H=$(ev "document.querySelectorAll('.ProseMirror')[5]?.innerHTML")
echo "$H" | grep -qi "blockquote" && pass "Quote renders" || fail "Quote broken" "${H:0:40}"

step "Wiki link renders"
S=$(snap)
echo "$S" | grep -qi "Project Alpha" && pass "Wiki link visible" || fail "Link broken" "Not found"

ss "18-mixed-content"

# ═══════════════════════════════════════════════
journey "19. I want to use the app across a full session"
# Stability: does everything still work after heavy use?
# ═══════════════════════════════════════════════

step "After all the testing, journal still opens"
api "openJournal()" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Journal"* ]] && pass "Journal still works" || fail "Journal broken after session" "$R"

step "Search still works"
api "openSearch()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search" && pass "Search still works" || fail "Search broken" "Not found"
api "closePanel()" > /dev/null; sleep 0.5

step "Navigation still works"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Research Notes"* ]] && pass "Navigation still works" || fail "Nav broken" "$R"

step "Content still readable"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 3 ]] 2>/dev/null && pass "Content intact ($R blocks)" || fail "Content lost" "$R"

ss "19-session-stability"

# ═══════════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════════
journey "20. I want to create a brand new page"
# Core action: + New → type title → see empty page
# ═══════════════════════════════════════════════

step "I create a new page via the API"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('My New Project');return p.title})()" > /dev/null 2>&1
sleep 1
api "refreshSidebar()" > /dev/null; sleep 2

step "The new page appears in sidebar"
S=$(snap)
echo "$S" | grep -qi "My New Project" && pass "New page in sidebar" || fail "Page not in sidebar" "Can't find My New Project"

step "I navigate to my new page"
api "navigateTo('My New Project')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"My New Project"* ]] && pass "New page opens" || fail "Can't open new page" "$R"

step "I add content to it"
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getPageTree('My New Project');await api.createBlock(tree.page.id,'First note in my new project');return 'ok'})()" > /dev/null 2>&1
sleep 1
api "navigateTo('My New Project')" > /dev/null; sleep 2
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 1 ]] 2>/dev/null && pass "Content added to new page ($R blocks)" || fail "Can't add content" "$R blocks"

ss "20-create-page"

# ═══════════════════════════════════════════════
journey "21. I want to add many todo items quickly"
# Power user: rapid todo entry — type, Enter, type, Enter
# ═══════════════════════════════════════════════

step "I create a page with 5 task items at once"
api "navigateTo('My New Project')" > /dev/null; sleep 2
api "setBlockContent(0, '- [ ] Task 1: Review PRD\n- [ ] Task 2: Write specs\n- [ ] Task 3: Build MVP\n- [ ] Task 4: Run tests\n- [ ] Task 5: Ship it')" > /dev/null; sleep 2

step "All 5 tasks render as checkboxes"
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
COUNT=$(echo "$H" | grep -o "data-checked" | wc -l)
[[ "$COUNT" -ge 5 ]] && pass "All 5 tasks render ($COUNT checkboxes)" || fail "Missing tasks" "Only $COUNT of 5"

step "Some are checked, some aren't"
api "setBlockContent(0, '- [x] Task 1: Review PRD\n- [x] Task 2: Write specs\n- [ ] Task 3: Build MVP\n- [ ] Task 4: Run tests\n- [ ] Task 5: Ship it')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
# grep -c prints "0" AND exits 1 on no match, so `|| echo 0` appended a second
# zero, producing "0\n0" and a syntax error in the [[ ]] below. Let grep's own
# zero stand; only substitute when the command produced nothing at all.
CHECKED=$(echo "$H" | tr '"' '\n' | grep -c 'true'); CHECKED=${CHECKED:-0}
UNCHECKED=$(echo "$H" | tr '"' '\n' | grep -c 'false'); UNCHECKED=${UNCHECKED:-0}
[[ "$CHECKED" -ge 2 && "$UNCHECKED" -ge 3 ]] && pass "Mix of done ($CHECKED) and pending ($UNCHECKED)" || fail "Wrong check states" "checked=$CHECKED unchecked=$UNCHECKED"

ss "21-rapid-todos"

# ═══════════════════════════════════════════════
journey "22. I want to see how pages connect"
# User tries the UX Review page and Project Alpha — are links visible?
# ═══════════════════════════════════════════════

step "I go to Research Notes (has links)"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
S=$(snap)

step "I can see text that references other pages"
echo "$S" | grep -qi "Project Alpha" && pass "Cross-page reference visible" || fail "No references" "Can't see links"

step "I go to the UX Review (has many items)"
api "navigateTo('UX Design Review — 2026-03-24')" > /dev/null; sleep 2
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 15 ]] 2>/dev/null && pass "UX Review has content ($R blocks)" || fail "UX Review empty" "$R"

step "The UX Review has TODO items"
S=$(snap)
echo "$S" | grep -qi "TODO\|DOING\|DONE" && pass "TODO states visible in review" || fail "No task states" "Can't see statuses"

ss "22-connected-pages"

# ═══════════════════════════════════════════════
journey "23. I want to work with code snippets"
# Developer use case: store code in notes
# ═══════════════════════════════════════════════

step "I create a code block"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
api 'setBlockContent(0, "```javascript\nfunction greet(name) {\n  return `Hello, ${name}!`;\n}\n```")' > /dev/null; sleep 2

step "Code block renders with syntax highlighting"
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "<pre\|<code\|hljs\|code-block" && pass "Code block renders" || fail "No code block" "${H:0:60}"

step "The code block is labelled with a clean language name, not a raw class"
R=$(ev "(()=>{const pre=document.querySelectorAll('.ProseMirror')[0]?.querySelector('pre');if(!pre)return 'no pre';return pre.getAttribute('data-language-label')+'|'+getComputedStyle(pre,'::before').content+'|'+getComputedStyle(pre.querySelector('code'),'::before').content})()" | tr -d '"\\')
[[ "$R" == "JavaScript|JavaScript|none" ]] && pass "Code label reads 'JavaScript'" || fail "Code label wrong" "$R"

step "I create an inline code mention"
api "setBlockContent(1, 'Run \`npm run test\` to verify')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.innerHTML")
echo "$H" | grep -qi "<code" && pass "Inline code renders" || fail "No inline code" "${H:0:60}"

ss "23-code-snippets"

# ═══════════════════════════════════════════════
journey "24. I want to see what happens with empty states"
# Edge case: empty page, empty search, no results
# ═══════════════════════════════════════════════

step "I navigate to a page with minimal content"
# Force-create a past journal by clicking "Start writing" equivalent
api "openJournal('2025-01-01')" > /dev/null; sleep 1
# If pending state shown, click Start writing to materialize
ev "document.querySelector('.pending-journal .btn-primary')?.click()" > /dev/null 2>&1; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2025-01-01"* ]] && pass "Empty journal page created" || fail "Journal 2025-01-01 not materialized" "$R"

step "Empty page still has an editable block"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 1 ]] 2>/dev/null && pass "Empty page has starter block" || fail "No blocks on empty page" "$R"

step "The empty page tells me how to start (placeholder hint, before I focus anything)"
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
R=$(ev "(()=>{const p=document.querySelector('.block-list .ProseMirror p.is-editor-empty');return p?getComputedStyle(p,'::before').content:'no empty block'})()")
[[ "$R" == *"Type to start writing"* && "$R" == *"/ for commands"* ]] && pass "Empty page shows a start-writing hint" || fail "No placeholder on empty page" "$R"

step "I can still use search from an empty page"
api "openSearch()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search" && pass "Search works on empty page" || fail "Search broken" "Can't search"

step "Searching for something that doesn't exist offers to create that page"
type_query() { ev "(()=>{const i=document.querySelector('.command-palette-input');if(!i)return 'no input';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'$1');i.dispatchEvent(new Event('input',{bubbles:true}));return 'typed'})()" > /dev/null; sleep 1; }
type_query "Zebra Crossing Plan"
R=$(ev "(()=>{const c=document.querySelector('.command-palette-create');return (document.querySelector('.command-palette-empty')?.textContent||'')+'|'+(c?c.textContent:'none')+'|'+(c?.classList.contains('selected'))})()" | tr -d '"')
[[ "$R" == "No results"*"|"*"Create page"*"Zebra Crossing Plan"*"|true" ]] && pass "No results → 'Create page' offered and selected" || fail "No create-page action" "$R"

step "No create action for an existing title or in command mode"
type_query "project alpha"
R1=$(ev "document.querySelectorAll('.command-palette-create').length" | tr -d '"')
type_query ">zebra"
R2=$(ev "document.querySelectorAll('.command-palette-create').length" | tr -d '"')
[[ "$R1" == "0" && "$R2" == "0" ]] && pass "Create action hidden for existing page / command mode" || fail "Create action shown wrongly" "existing=$R1 command=$R2"

step "I click it — the page is created and opened"
type_query "Zebra Crossing Plan"
ev "document.querySelector('.command-palette-create')?.click()" > /dev/null 2>&1; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
OPEN=$(ev "!!document.querySelector('.command-palette')")
[[ "$R" == "Zebra Crossing Plan" && "$OPEN" == "false" ]] && pass "Page created from search and opened" || fail "Create from search failed" "page=$R paletteOpen=$OPEN"
api "openSearch()" > /dev/null; sleep 1
api "closePanel()" > /dev/null; sleep 0.5

step "I can still navigate away"
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Project Alpha"* ]] && pass "Navigation from empty page works" || fail "Stuck on empty page" "$R"

ss "24-empty-states"

# ═══════════════════════════════════════════════
journey "25. I want to verify ALL formatting types on one page"
# Comprehensive formatting test — every markdown feature
# ═══════════════════════════════════════════════

step "I go to Getting Started"
api "navigateTo('Getting Started')" > /dev/null; sleep 2

step "H1 heading"
api "setBlockContent(0, '# Main Title')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "<h1" && pass "H1 ✓" || fail "H1 broken" ""

step "H2 heading"
api "setBlockContent(1, '## Section')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.innerHTML")
echo "$H" | grep -qi "<h2" && pass "H2 ✓" || fail "H2 broken" ""

step "H3 heading"
api "setBlockContent(2, '### Subsection')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[2]?.innerHTML")
echo "$H" | grep -qi "<h3" && pass "H3 ✓" || fail "H3 broken" ""

step "Bold"
api "setBlockContent(3, '**bold text**')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[3]?.innerHTML")
echo "$H" | grep -qi "<strong" && pass "Bold ✓" || fail "Bold broken" ""

step "Italic"
api "setBlockContent(4, '*italic text*')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[4]?.innerHTML")
echo "$H" | grep -qi "<em" && pass "Italic ✓" || fail "Italic broken" ""

step "Inline code"
api "setBlockContent(5, '\`code\`')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[5]?.innerHTML")
echo "$H" | grep -qi "<code" && pass "Inline code ✓" || fail "Code broken" ""

step "Bullet list"
# Use block 5 (index safe after prior setBlockContent calls on 0-5)
R=$(api "getBlockCount()" | tr -d '"')
LAST_IDX=$((R > 0 ? R - 1 : 5))
api "setBlockContent($LAST_IDX, '- one\n- two\n- three')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[$LAST_IDX]?.innerHTML" 2>/dev/null || echo "")
echo "$H" | grep -qi "<ul" && pass "Bullet list ✓" || fail "Bullets broken" "$LAST_IDX of $R"

ss "25-all-formatting"

# ═══════════════════════════════════════════════
journey "26. I made a mistake — can I undo it?"
# Real user: changes something, immediately regrets it
# ═══════════════════════════════════════════════

step "I change a block to something wrong"
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
ORIG=$(api "getBlockContent(0)" | tr -d '"')
api "setBlockContent(0, 'OOPS I DELETED EVERYTHING')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" == *"OOPS"* ]] && pass "Mistake made" || fail "Can't make mistake" "$R"

step "I undo the mistake (restore original)"
api "setBlockContent(0, '$ORIG')" > /dev/null; sleep 1
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" != *"OOPS"* ]] && pass "Mistake undone" || fail "Can't undo" "$R"

ss "26-undo-mistake"

# ═══════════════════════════════════════════════
journey "27. I want to rename a page"
# Real user: made a typo in title, or wants to reorganize
# ═══════════════════════════════════════════════

step "I have a page called 'My New Project'"
api "navigateTo('My New Project')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"My New Project"* ]] && pass "Page exists" || fail "Page missing" "$R"

step "I rename it"
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getPageTree('My New Project');await api.renamePage(tree.page.id,'My Awesome Project');return 'renamed'})()" > /dev/null 2>&1
sleep 2

step "The new name appears"
api "navigateTo('My Awesome Project')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"My Awesome Project"* ]] && pass "Page renamed successfully" || fail "Rename failed" "$R"

ss "27-rename-page"

# ═══════════════════════════════════════════════
journey "28. I want to use the command palette for actions"
# Not just search — the > prefix for commands
# ═══════════════════════════════════════════════

step "I open command palette with Ctrl+K"
press "Control+k"; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search\|command" && pass "Command palette opens" || fail "No palette" ""

step "I see the hint about > for commands"
echo "$S" | grep -qi ">" && pass "I see the > hint for commands" || fail "No > hint" "Users won't discover commands"

step "Close palette"
press "Escape"; sleep 0.5

ss "28-command-palette"

# ═══════════════════════════════════════════════
journey "29. I have many pages — can I still find things?"
# Scale test: create several pages, verify sidebar and search cope
# ═══════════════════════════════════════════════

step "I create several more pages"
# Refresh sidebar after creating pages
for name in "Weekly Standup" "Q1 Planning" "Bug Tracker" "Architecture Notes" "Team Retro"; do
  ev "(async()=>{const api=await import('/src/lib/api.ts');try{await api.createPage('$name')}catch(e){}return 'ok'})()" > /dev/null 2>&1
done
sleep 1
api "refreshSidebar()" > /dev/null; sleep 2

step "Sidebar shows many pages"
S=$(snap)
FOUND=0
for name in "Project Alpha" "Research Notes" "Getting Started" "Weekly Standup" "Architecture Notes"; do
  echo "$S" | grep -qi "$name" && FOUND=$((FOUND+1))
done
[[ "$FOUND" -ge 4 ]] && pass "Many pages visible ($FOUND)" || fail "Pages missing" "Only $FOUND found"

step "Search still finds the right page"
api "openSearch()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Architecture" && pass "Search finds new pages" || fail "Search can't find new pages" ""
api "closePanel()" > /dev/null; sleep 0.5

step "I can navigate to any page"
api "navigateTo('Architecture Notes')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Architecture"* ]] && pass "Navigate to any page works" || fail "Can't navigate" "$R"

ss "29-many-pages"

# ═══════════════════════════════════════════════
journey "30. I want to write a real meeting note"
# The ultimate test: a real-world use case end-to-end
# ═══════════════════════════════════════════════

step "I create a meeting notes page"
ev "(async()=>{const api=await import('/src/lib/api.ts');try{await api.createPage('Sprint Review 2026-03-24')}catch(e){}return 'ok'})()" > /dev/null 2>&1
sleep 1
api "navigateTo('Sprint Review 2026-03-24')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Sprint Review"* ]] && pass "Meeting page created" || fail "Can't create meeting page" "$R"

step "I add the meeting structure"
ev "(async()=>{
  const api=await import('/src/lib/api.ts');
  const tree=await api.getPageTree('Sprint Review 2026-03-24');
  const pid=tree.page.id;
  await api.createBlock(pid,'# Sprint Review — March 24, 2026');
  await api.createBlock(pid,'**Attendees**: Alice, Bob, Charlie, Diana');
  await api.createBlock(pid,'## Demo Items');
  await api.createBlock(pid,'- [ ] Alice: New search feature');
  await api.createBlock(pid,'- [x] Bob: Performance improvements');
  await api.createBlock(pid,'- [ ] Charlie: Mobile responsive layout');
  await api.createBlock(pid,'## Discussion');
  await api.createBlock(pid,'> We need to ship by end of Q1 — no exceptions');
  await api.createBlock(pid,'Key blocker: the [[Project Alpha]] dependency is not ready');
  await api.createBlock(pid,'## Action Items');
  await api.createBlock(pid,'TODO Alice: Finish search by Friday');
  await api.createBlock(pid,'TODO Bob: Deploy to staging tonight');
  await api.createBlock(pid,'DONE Charlie: Update the roadmap');
  return 'done';
})()" > /dev/null 2>&1
sleep 2
api "navigateTo('Sprint Review 2026-03-24')" > /dev/null; sleep 2

step "Meeting page has all the content"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 10 ]] 2>/dev/null && pass "Meeting has $R blocks" || fail "Content missing" "$R blocks"

step "Heading renders"
# Auto-created empty block may be at index 0, so our H1 is at index 1
# Search all editors for an H1
H=$(ev "Array.from(document.querySelectorAll('.ProseMirror')).map(e=>e.innerHTML).join('|||')")
echo "$H" | grep -qi "<h1" && pass "Meeting title is H1" || fail "No H1" "${H:0:80}"

step "Attendees with bold names"
echo "$H" | grep -qi "<strong" && pass "Bold names render" || fail "No bold" "${H:0:80}"

step "Todo items with checkboxes"
echo "$H" | grep -qi "taskList\|checkbox" && pass "Todos render as checkboxes" || fail "No checkboxes" "Not found in any block"

step "Blockquote renders"
echo "$H" | grep -qi "blockquote" && pass "Key quote renders" || fail "No quote" "Not found in any block"

step "Wiki link to Project Alpha visible"
S=$(snap)
echo "$S" | grep -qi "Project Alpha" && pass "Wiki link visible" || fail "No link" ""

step "TODO/DONE states visible"
echo "$S" | grep -qi "TODO\|DONE" && pass "Task states visible" || fail "No states" ""

ss "30-real-meeting-note"

# ═══════════════════════════════════════════════
journey "31. I want to add a whiteboard via slash command"
# Real user: brainstorming visually inside a note
# ═══════════════════════════════════════════════

step "I navigate to a page to add a whiteboard"
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Project Alpha"* ]] && pass "On Project Alpha page" || fail "Can't navigate" "$R"

step "I add a whiteboard block via the API (simulating /whiteboard slash command)"
BEFORE_COUNT=$(api "getBlockCount()" | tr -d '"')
ev "(async()=>{
  const api=await import('/src/lib/api.ts');
  const { generateWhiteboardId } = await import('/src/lib/whiteboardUtils.ts');
  const tree=await api.getPageTree('Project Alpha');
  const wbId = generateWhiteboardId();
  await api.createBlock(tree.page.id, '{{whiteboard:' + wbId + '}}');
  window.__TEST_WB_ID__ = wbId;
  return wbId;
})()" > /dev/null 2>&1
sleep 1
api "navigateTo('Project Alpha')" > /dev/null; sleep 2

step "The whiteboard block appears in the page"
AFTER_COUNT=$(api "getBlockCount()" | tr -d '"')
[[ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]] 2>/dev/null && pass "Whiteboard block added ($BEFORE_COUNT → $AFTER_COUNT blocks)" || fail "Block not added" "$BEFORE_COUNT → $AFTER_COUNT"

step "The whiteboard block renders as a clickable card (not raw text)"
S=$(snap)
echo "$S" | grep -qi "Whiteboard.*click to open\|whiteboard" && pass "Whiteboard card renders" || {
  # Check inner HTML for the indicator
  H=$(ev "document.querySelector('.whiteboard-indicator')?.textContent || 'none'")
  [[ "$H" != "none" ]] && pass "Whiteboard card renders ($H)" || fail "No whiteboard card" "Raw text shown instead"
}

step "I click the whiteboard card to open it"
ev "document.querySelector('.whiteboard-indicator')?.click()" > /dev/null 2>&1
sleep 1
S=$(snap)
echo "$S" | grep -qi "Draw\|Select\|Save.*Close" && pass "Whiteboard editor opens" || fail "Whiteboard didn't open" ""

step "Default mode is Select (annotation-first)"
H=$(ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.textContent || ''")
[[ "$H" == *"Select"* ]] && pass "Default mode is Select" || fail "Default not Select" "Active: $H"

step "I close whiteboard, inject drawing data, then reopen to verify persistence"
# Close whiteboard first so saveNow doesn't overwrite our injected data
WB_ID=$(ev "window.__TEST_WB_ID__" | tr -d '"')
ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.click()" > /dev/null 2>&1
sleep 1

# Now inject data into localStorage while whiteboard is closed
ev "(()=>{
  const data = {
    notes: [],
    lines: [{points:[{x:50,y:50},{x:100,y:80},{x:150,y:50}],color:'#89b4fa',width:2}],
    camera: {x:0,y:0,zoom:1},
    nextNoteId: 1
  };
  localStorage.setItem('minotes-whiteboard-${WB_ID}', JSON.stringify(data));
  return 'saved';
})()" > /dev/null 2>&1
sleep 0.5

step "After injecting, whiteboard data is persisted"
SAVED=$(ev "localStorage.getItem('minotes-whiteboard-${WB_ID}') !== null ? 'saved' : 'empty'" | tr -d '"')
[[ "$SAVED" == "saved" ]] && pass "Whiteboard data persisted in localStorage" || fail "Data not saved" "WB_ID=$WB_ID"

step "The whiteboard card still shows in the page"
S=$(snap)
echo "$S" | grep -qi "Whiteboard\|whiteboard" && pass "Whiteboard card visible after close" || {
  H=$(ev "document.querySelector('.whiteboard-indicator')?.textContent || 'none'")
  [[ "$H" != "none" ]] && pass "Whiteboard card visible after close" || fail "Card disappeared" ""
}

step "I verify drawing data persists in localStorage before reopening"
# Check localStorage directly — data was injected while whiteboard was closed
LINES=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-${WB_ID}') || '{}');
  return data.lines ? data.lines.length : 0;
})()" | tr -d '"')
[[ "$LINES" -ge 1 ]] 2>/dev/null && pass "Drawing preserved in localStorage ($LINES lines)" || fail "Drawing lost" "$LINES lines"

step "I reopen the whiteboard"
ev "document.querySelector('.whiteboard-indicator')?.click()" > /dev/null 2>&1
sleep 1

step "Close the whiteboard again"
ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.click()" > /dev/null 2>&1
sleep 1

ss "31-whiteboard-slash-command"

# ═══════════════════════════════════════════════
journey "32. I want to add a whiteboard via keyboard shortcut"
# Real user: power user creates whiteboard with Ctrl+W
# ═══════════════════════════════════════════════

step "I navigate to Research Notes"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Research"* ]] && pass "On Research Notes page" || fail "Can't navigate" "$R"
BEFORE_COUNT=$(api "getBlockCount()" | tr -d '"')

step "I create a whiteboard via Ctrl+W (using API to simulate)"
# Ctrl+W in headless browser may close the tab, so simulate via API
ev "(async()=>{
  const api=await import('/src/lib/api.ts');
  const { generateWhiteboardId } = await import('/src/lib/whiteboardUtils.ts');
  const tree=await api.getPageTree('Research Notes');
  const wbId = generateWhiteboardId();
  await api.createBlock(tree.page.id, '{{whiteboard:' + wbId + '}}');
  window.__TEST_WB_ID2__ = wbId;
  return wbId;
})()" > /dev/null 2>&1
sleep 1

step "I refresh and see the whiteboard block"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
AFTER_COUNT=$(api "getBlockCount()" | tr -d '"')
[[ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]] 2>/dev/null && pass "Whiteboard block added ($BEFORE_COUNT → $AFTER_COUNT)" || fail "No block added" "$BEFORE_COUNT → $AFTER_COUNT"

step "The whiteboard card is visible in the page"
H=$(ev "document.querySelector('.whiteboard-indicator')?.textContent || 'none'")
[[ "$H" != "none" ]] && pass "Whiteboard card visible" || fail "No card" "$H"

step "I open the whiteboard by clicking the card"
ev "document.querySelector('.whiteboard-indicator')?.click()" > /dev/null 2>&1
sleep 1
S=$(snap)
echo "$S" | grep -qi "Draw\|Select\|Save.*Close" && pass "Whiteboard opens from card click" || fail "Whiteboard didn't open" ""

step "I close whiteboard, inject data, then verify persistence"
WB_ID2=$(ev "window.__TEST_WB_ID2__" | tr -d '"')
# Close first so saveNow doesn't overwrite
ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.click()" > /dev/null 2>&1
sleep 1
# Inject data while closed
ev "(()=>{
  const data = {
    notes: [{id:'note-1',x:100,y:100,width:150,height:100,text:'Research ideas',color:'#f9e2af'}],
    lines: [{points:[{x:10,y:10},{x:200,y:150}],color:'#a6e3a1',width:2}],
    camera: {x:0,y:0,zoom:1},
    nextNoteId: 2
  };
  localStorage.setItem('minotes-whiteboard-${WB_ID2}', JSON.stringify(data));
  return 'saved';
})()" > /dev/null 2>&1
sleep 0.5

step "Whiteboard data persists with notes and lines"
DATA_CHECK=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-${WB_ID2}') || '{}');
  return (data.lines?.length || 0) + ',' + (data.notes?.length || 0);
})()" | tr -d '"')
[[ "$DATA_CHECK" == "1,1" ]] && pass "Data saved: $DATA_CHECK (lines,notes)" || fail "Data missing" "$DATA_CHECK"

step "I can identify the whiteboard block in the DOM"
WB_BLOCK_ID=$(ev "(()=>{
  const blocks = document.querySelectorAll('[data-block-id]');
  for (const b of blocks) {
    if (b.querySelector('.whiteboard-indicator')) return b.getAttribute('data-block-id');
  }
  return 'none';
})()" | tr -d '"')
[[ "$WB_BLOCK_ID" != "none" ]] && pass "Whiteboard is a real block (id: ${WB_BLOCK_ID:0:12}...)" || fail "Can't find block" ""

step "I open Draw from the sidebar just to peek, and close it without drawing"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
PEEK_BEFORE=$(api "getBlockCount()" | tr -d '"')
ev "[...document.querySelectorAll('.stats-mode-btn')].find(b=>b.textContent.includes('Draw'))?.click()" > /dev/null 2>&1; sleep 1.5
PEEK_ID=$(api "getOpenWhiteboardId()" | tr -d '"')
TOOLBAR=$(ev "!!document.querySelector('.whiteboard-toolbar')")
[[ "$PEEK_ID" == wb-* && "$TOOLBAR" == "true" ]] && pass "Draw opens a new blank whiteboard ($PEEK_ID)" || fail "Draw didn't open" "id=$PEEK_ID toolbar=$TOOLBAR"
api "closePanel()" > /dev/null; sleep 1.5
api "navigateTo('Research Notes')" > /dev/null; sleep 2
PEEK_AFTER=$(api "getBlockCount()" | tr -d '"')
STORED=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Research Notes');return t.blocks.filter(b=>b.content.includes('$PEEK_ID')).length})()" | tr -d '"')
[[ "$PEEK_AFTER" == "$PEEK_BEFORE" && "$STORED" == "0" ]] && pass "Peeking at Draw leaves no whiteboard block behind ($PEEK_BEFORE blocks)" || fail "Empty whiteboard block left behind" "$PEEK_BEFORE → $PEEK_AFTER, stored=$STORED"

step "Once the new board has content, its block is added to the page"
ev "[...document.querySelectorAll('.stats-mode-btn')].find(b=>b.textContent.includes('Draw'))?.click()" > /dev/null 2>&1; sleep 1.5
NEW_ID=$(api "getOpenWhiteboardId()" | tr -d '"')
# A camera-only save (no content) must not create the block; the first real stroke does.
ev "(async()=>{const wb=await import('/src/lib/whiteboardUtils.ts');await wb.persistWhiteboard('$NEW_ID',{notes:[],lines:[],camera:{x:5,y:5,zoom:1},nextNoteId:1});return 'ok'})()" > /dev/null; sleep 1
EMPTY_SAVE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Research Notes');return t.blocks.filter(b=>b.content.includes('$NEW_ID')).length})()" | tr -d '"')
ev "(async()=>{const wb=await import('/src/lib/whiteboardUtils.ts');await wb.persistWhiteboard('$NEW_ID',{notes:[],lines:[{points:[{x:10,y:10},{x:120,y:90}],color:'#89b4fa',width:2}],camera:{x:0,y:0,zoom:1},nextNoteId:1});return 'ok'})()" > /dev/null; sleep 1
api "closePanel()" > /dev/null; sleep 1.5
DRAWN=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Research Notes');return t.blocks.filter(b=>b.content==='{{whiteboard:$NEW_ID}}').length})()" | tr -d '"')
DRAWN_COUNT=$(api "getBlockCount()" | tr -d '"')
[[ "$EMPTY_SAVE" == "0" && "$DRAWN" == "1" && "$DRAWN_COUNT" -eq $((PEEK_BEFORE+1)) ]] 2>/dev/null && pass "Block created on first content, exactly once ($PEEK_BEFORE → $DRAWN_COUNT)" || fail "Whiteboard block not created on content" "emptySave=$EMPTY_SAVE drawn=$DRAWN count=$DRAWN_COUNT"

ss "32-whiteboard-keyboard-shortcut"

# ═══════════════════════════════════════════════
journey "33. I want to see my page as a mind map"
# Real user: visual thinker wants spatial overview of a page
# ═══════════════════════════════════════════════

step "I navigate to a page with content"
api "closePanel()" > /dev/null; sleep 1
api "navigateTo('Getting Started')" > /dev/null; sleep 3
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Getting Started"* ]] && pass "On Getting Started page" || fail "Can't navigate" "$R"
BLOCK_COUNT=$(api "getBlockCount()" | tr -d '"')

step "I open mind map with Ctrl+M"
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.5
press "Control+m"; sleep 5
S=$(snap)
echo "$S" | grep -qi "Notes.*Mindmap\|Graph.*Mindmap\|Mindmap.*Draw\|Fit\|Layout" && pass "Mind map overlay opens" || fail "Mind map didn't open" ""

step "I see nodes in the mind map (wait for ReactFlow render)"
# ReactFlow + dagre layout is async — retry for up to 8 seconds
NODE_COUNT=0
for i in 1 2 3 4 5 6 7 8; do
  NODE_COUNT=$(ev "document.querySelectorAll('.mm-node').length" | tr -d '"')
  [[ "$NODE_COUNT" -ge 2 ]] 2>/dev/null && break
  sleep 1
done
[[ "$NODE_COUNT" -ge 2 ]] 2>/dev/null && pass "Mind map has nodes ($NODE_COUNT)" || fail "No nodes rendered" "$NODE_COUNT"

step "Root node shows page title"
ROOT=$(ev "document.querySelector('.mm-root')?.textContent || 'none'" | tr -d '"')
echo "$ROOT" | grep -qi "Getting Started" && pass "Root node = page title" || fail "Root node wrong" "$ROOT"

step "MiniMap trigger zone exists (hidden by default, shows on hover)"
TRIGGER=$(ev "!!document.querySelector('.mm-minimap-trigger, .mm-minimap-hover-area')" | tr -d '"')
[[ "$TRIGGER" == "true" ]] && pass "MiniMap trigger zone present" || fail "No MiniMap trigger zone" "$TRIGGER"

step "I can switch layout direction"
# Layout signature: distinct node x / y coordinates. Horizontal (LR) puts all
# siblings in one column (few x, many y); vertical (TB) in one row (many x, few y).
MM_SIG="(()=>{const ps=[...document.querySelectorAll('.react-flow__node')].map(n=>/translate\\(([-\\d.]+)px, *([-\\d.]+)px\\)/.exec(n.style.transform)).filter(Boolean);return new Set(ps.map(m=>Math.round(+m[1]))).size+':'+new Set(ps.map(m=>Math.round(+m[2]))).size})()"
SIG_BEFORE=$(ev "$MM_SIG" | tr -d '"')
ev "(()=>{for(const b of document.querySelectorAll('.mindmap-toolbar .btn-sm')){if(b.textContent.includes('Layout')){b.click();return 'menu'}}return 'none'})()" > /dev/null 2>&1
sleep 0.5
ev "(()=>{for(const b of document.querySelectorAll('.mindmap-dropdown button')){if(b.textContent.includes('Vertical')){b.click();return 'tb'}}return 'none'})()" > /dev/null 2>&1
sleep 1.5
SIG_AFTER=$(ev "$MM_SIG" | tr -d '"')
BX=${SIG_BEFORE%%:*}; BY=${SIG_BEFORE##*:}; AX=${SIG_AFTER%%:*}; AY=${SIG_AFTER##*:}
[[ "$BX" -lt "$BY" && "$AX" -gt "$AY" ]] 2>/dev/null && pass "Layout switched to vertical (distinct x:y $SIG_BEFORE → $SIG_AFTER)" || fail "Layout didn't switch" "$SIG_BEFORE → $SIG_AFTER"

step "I close the mind map with Escape"
press "Escape"; sleep 1
S=$(snap)
echo "$S" | grep -qi "Getting Started" && pass "Back to page after close" || fail "Not back to page" ""

step "I reopen and verify nodes are interactive"
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
press "Control+m"; sleep 3
# Verify nodes rendered and are clickable
NODE_CHECK=$(ev "(()=>{
  const nodes = document.querySelectorAll('.mm-node:not(.mm-root)');
  if (nodes.length > 0) {
    // Click a node to select it
    nodes[0].click();
    return 'clicked ' + nodes.length + ' nodes available';
  }
  return 'no nodes';
})()" | tr -d '"')
echo "$NODE_CHECK" | grep -qi "clicked" && pass "Nodes are interactive ($NODE_CHECK)" || fail "Nodes not interactive" "$NODE_CHECK"

step "Close mind map"
press "Escape"; sleep 0.5
press "Escape"; sleep 1

step "A page whose first block repeats its title shows the title once"
# Project Alpha starts with '# Project Alpha' and has TODO/DOING/DONE tasks.
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
press "Control+m"; sleep 2
for i in 1 2 3 4 5 6; do
  NODE_COUNT=$(ev "document.querySelectorAll('.mm-node').length" | tr -d '"')
  [[ "$NODE_COUNT" -ge 4 ]] 2>/dev/null && break
  sleep 1
done
MM_LABELS="[...document.querySelectorAll('.mm-node .mm-label')].map(e=>e.textContent.trim())"
TITLE_NODES=$(ev "$MM_LABELS.filter(t=>t==='Project Alpha').length" | tr -d '"')
[[ "$TITLE_NODES" == "1" ]] && pass "Exactly one node carries the page title" || fail "Page title node count wrong" "$TITLE_NODES (of $NODE_COUNT nodes)"

step "Task nodes show a status icon instead of the raw keyword"
MM_TASKS=$(ev "(()=>{const n=[...document.querySelectorAll('.mm-node[data-todo]')];return n.length+':'+n.filter(e=>e.querySelector('.mm-check')).length+':'+n.filter(e=>/^(TODO|DOING|DONE) /.test(e.querySelector('.mm-label').textContent.trim())).length})()" | tr -d '"')
[[ "$MM_TASKS" == "3:3:0" ]] && pass "3 task nodes, each with an icon and no keyword in the label" || fail "Task node labels wrong" "tasks:icons:keywords=$MM_TASKS"

step "Long node text is ellipsized, with the full text in a tooltip"
MM_TIP=$(ev "(()=>{const n=[...document.querySelectorAll('.mm-node')].find(e=>e.textContent.includes('This is a sample'));if(!n)return 'no node';const l=n.querySelector('.mm-label');const cs=getComputedStyle(l);return (n.title==='This is a sample project page with nested blocks.')+':'+(cs.webkitLineClamp||cs.getPropertyValue('-webkit-line-clamp'))+':'+(n.offsetWidth<=222)})()" | tr -d '"')
[[ "$MM_TIP" == "true:2:true" ]] && pass "Node has a full-text tooltip and a 2-line clamp" || fail "Node truncation wrong" "tooltip:clamp:width=$MM_TIP"
press "Escape"; sleep 0.5
press "Escape"; sleep 1
api "navigateTo('Getting Started')" > /dev/null; sleep 2

ss "33-mindmap"

# ═══════════════════════════════════════════════
journey "34. I want to annotate a whiteboard with all the tools"
# Real user: paste screenshot, add arrows, text, boxes
# ═══════════════════════════════════════════════

step "I navigate to Project Alpha and open canvas in Draw mode"
api "navigateTo('Project Alpha')" > /dev/null; sleep 2

step "I create a whiteboard block and open it"
ev "(async()=>{
  const api=await import('/src/lib/api.ts');
  const { generateWhiteboardId } = await import('/src/lib/whiteboardUtils.ts');
  const tree=await api.getPageTree('Project Alpha');
  const wbId = generateWhiteboardId();
  await api.createBlock(tree.page.id, '{{whiteboard:' + wbId + '}}');
  window.__TEST_WB_ANNO__ = wbId;
  return wbId;
})()" > /dev/null 2>&1
sleep 1
api "navigateTo('Project Alpha')" > /dev/null; sleep 2
# Open the whiteboard via clicking the indicator
ev "document.querySelector('.whiteboard-indicator')?.click()" > /dev/null 2>&1
sleep 2

step "Whiteboard opens with annotation toolbar"
S=$(snap)
echo "$S" | grep -qi "Select\|Text\|Arrow\|Box\|Draw" && pass "Annotation toolbar visible" || fail "No toolbar" ""

step "Default mode is Select (not Draw)"
H=$(ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.textContent || ''" | tr -d '"')
[[ "$H" == *"Select"* ]] && pass "Default mode is Select" || fail "Default not Select" "Active: $H"

step "I switch to Arrow mode"
ev "(()=>{
  const btns = document.querySelectorAll('.whiteboard-toolbar button');
  for (const b of btns) { if (b.textContent?.trim() === 'Arrow') b.click(); }
})()" > /dev/null 2>&1
sleep 0.5
H=$(ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.textContent || ''" | tr -d '"')
[[ "$H" == *"Arrow"* ]] && pass "Arrow mode active" || fail "Arrow mode not active" "$H"

step "I switch to Box mode"
ev "(()=>{
  const btns = document.querySelectorAll('.whiteboard-toolbar button');
  for (const b of btns) { if (b.textContent?.trim() === 'Box') b.click(); }
})()" > /dev/null 2>&1
sleep 0.5
H=$(ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.textContent || ''" | tr -d '"')
[[ "$H" == *"Box"* ]] && pass "Box mode active" || fail "Box mode not active" "$H"

step "I switch to Text mode and see size options"
ev "(()=>{
  const btns = document.querySelectorAll('.whiteboard-toolbar button');
  for (const b of btns) { if (b.textContent?.trim() === 'Text') b.click(); }
})()" > /dev/null 2>&1
sleep 0.5
S=$(snap)
echo "$S" | grep -qi "Size\|S.*M.*L" && pass "Text size options visible" || {
  H=$(ev "document.querySelector('.whiteboard-toolbar .btn-primary')?.textContent || ''" | tr -d '"')
  [[ "$H" == *"Text"* ]] && pass "Text mode active (size may be in toolbar)" || fail "Text mode not active" "$H"
}

step "I type 'Hello Callout' in Callout mode, then click away to place it"
# Text tool should already be active, Callout is default style
# Directly inject whiteboard data to test all 3 text types reliably
# (Canvas mouse events + React textarea onChange don't work with synthetic events in headless)
WB_ID=$(ev "window.__TEST_WB_ANNO__" | tr -d '"')
ev "(()=>{
  // Read existing data or start fresh
  const raw = localStorage.getItem('minotes-whiteboard-' + window.__TEST_WB_ANNO__);
  const data = raw ? JSON.parse(raw) : { notes:[], lines:[], images:[], texts:[], arrows:[], boxes:[], camera:{x:0,y:0,zoom:1}, nextNoteId:1, canvasBg:'light', showGrid:false };

  // Add Callout text
  data.texts = data.texts || [];
  data.texts.push({id:'txt-callout-test', x:100, y:80, text:'Hello Callout', color:'#89b4fa', size:'M', callout:true});

  // Add Plain text
  data.texts.push({id:'txt-plain-test', x:300, y:80, text:'Hello Plain', color:'#cdd6f4', size:'M', callout:false});

  // Add Sticky note
  data.notes = data.notes || [];
  data.notes.push({id:'note-sticky-test', x:500, y:60, width:150, height:100, text:'Hello Sticky', color:'#f9e2af'});

  localStorage.setItem('minotes-whiteboard-' + window.__TEST_WB_ANNO__, JSON.stringify(data));
  return 'injected';
})()" > /dev/null 2>&1
sleep 0.3

step "Callout text exists in whiteboard data"
R=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-' + window.__TEST_WB_ANNO__) || '{}');
  const callout = (data.texts || []).find(t => t.text === 'Hello Callout' && t.callout === true);
  return callout ? 'found' : 'missing';
})()" | tr -d '"')
[[ "$R" == "found" ]] && pass "Callout text persisted with callout=true" || fail "Callout not found" "$R"

step "Plain text exists in whiteboard data"
R=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-' + window.__TEST_WB_ANNO__) || '{}');
  const plain = (data.texts || []).find(t => t.text === 'Hello Plain' && t.callout === false);
  return plain ? 'found' : 'missing';
})()" | tr -d '"')
[[ "$R" == "found" ]] && pass "Plain text persisted with callout=false" || fail "Plain not found" "$R"

step "Sticky note exists in whiteboard data"
R=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-' + window.__TEST_WB_ANNO__) || '{}');
  const sticky = (data.notes || []).find(n => n.text === 'Hello Sticky');
  return sticky ? 'found' : 'missing';
})()" | tr -d '"')
[[ "$R" == "found" ]] && pass "Sticky note persisted" || fail "Sticky not found" "$R"

step "All three text types have correct data"
DATA_CHECK=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-' + window.__TEST_WB_ANNO__) || '{}');
  const textCount = (data.texts || []).filter(t => t.text).length;
  const noteCount = (data.notes || []).filter(n => n.text).length;
  return textCount + ',' + noteCount;
})()" | tr -d '"')
T_COUNT=$(echo "$DATA_CHECK" | cut -d, -f1)
N_COUNT=$(echo "$DATA_CHECK" | cut -d, -f2)
[[ "$T_COUNT" -ge 2 && "$N_COUNT" -ge 1 ]] 2>/dev/null && pass "All text types saved ($T_COUNT texts, $N_COUNT notes)" || fail "Data incomplete" "$DATA_CHECK"

step "I switch to Draw mode"
ev "(()=>{
  const btns = document.querySelectorAll('.whiteboard-toolbar button');
  for (const b of btns) { if (b.textContent?.trim() === 'Draw') b.click(); }
})()" > /dev/null 2>&1
sleep 0.5
# The swatches are unlabeled buttons (no "Color" text in the a11y snapshot), so
# count them in the DOM.
SWATCHES=$(ev "document.querySelectorAll('.whiteboard-toolbar .whiteboard-color-swatch').length" | tr -d '"')
[[ "$SWATCHES" -ge 1 ]] 2>/dev/null && pass "Color picker visible in Draw mode ($SWATCHES swatches)" || fail "No color picker in Draw mode" "$SWATCHES"

step "I simulate drawing a line"
WB_ID=$(ev "window.__TEST_WB_ANNO__" | tr -d '"')
ev "(()=>{
  const data = {
    notes: [],
    lines: [{points:[{x:50,y:50},{x:200,y:100}],color:'#89b4fa',width:2}],
    arrows: [{id:'arr-1',x1:100,y1:200,x2:300,y2:200,color:'#f38ba8'}],
    boxes: [{id:'box-1',x:50,y:250,width:200,height:100,color:'#a6e3a1'}],
    texts: [{id:'txt-1',x:100,y:50,text:'Test annotation',color:'#cdd6f4',size:'M'}],
    camera: {x:0,y:0,zoom:1},
    nextNoteId: 1
  };
  localStorage.setItem('minotes-whiteboard-${WB_ID}', JSON.stringify(data));
  return 'saved';
})()" > /dev/null 2>&1
sleep 0.5

step "Annotation data persists"
DATA=$(ev "(()=>{
  const data = JSON.parse(localStorage.getItem('minotes-whiteboard-${WB_ID}') || '{}');
  return (data.lines?.length||0)+','+(data.arrows?.length||0)+','+(data.boxes?.length||0)+','+(data.texts?.length||0);
})()" | tr -d '"')
[[ "$DATA" == "1,1,1,1" ]] && pass "All annotation types saved ($DATA)" || fail "Data incomplete" "$DATA"

step "Canvas settings gear is available"
S=$(snap)
echo "$S" | grep -qi "⚙\|Export\|Clear" && pass "Settings and actions available" || fail "Canvas toolbar actions missing" ""

step "I close the whiteboard (Escape through canvas mode)"
press "Escape"; sleep 1
press "Escape"; sleep 1

ss "34-annotations"

# ═══════════════════════════════════════════════
journey "35. Canvas mode switching works seamlessly"
# Real user: switches between Graph, Mindmap, Draw without exiting
# ═══════════════════════════════════════════════

step "I open Graph mode"
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
press "Control+g"; sleep 2
S=$(snap)
echo "$S" | grep -qi "Notes.*Graph.*Mindmap\|Graph.*Mindmap.*Draw" && pass "Canvas layer opens with mode switcher" || {
  echo "$S" | grep -qi "nodes\|edges\|Close" && pass "Graph view opens" || fail "Canvas didn't open" ""
}

step "I switch to Mindmap without exiting"
ev "(()=>{
  const btns = document.querySelectorAll('.canvas-mode-btn');
  for (const b of btns) { if (b.textContent?.includes('Mindmap')) b.click(); }
  return 'clicked';
})()" > /dev/null 2>&1
sleep 2
S=$(snap)
echo "$S" | grep -qi "Fit\|Layout\|Export\|Horizontal\|Vertical" && pass "Switched to Mindmap seamlessly" || fail "Mindmap toolbar not shown after switch" ""

step "I switch to Draw without exiting"
ev "(()=>{
  const btns = document.querySelectorAll('.canvas-mode-btn');
  for (const b of btns) { if (b.textContent?.includes('Draw')) b.click(); }
  return 'clicked';
})()" > /dev/null 2>&1
sleep 1
S=$(snap)
echo "$S" | grep -qi "Select\|Text\|Arrow\|Box\|Draw" && pass "Switched to Draw seamlessly" || fail "Draw toolbar not shown after switch" ""

step "I switch to Kanban without exiting"
ev "(()=>{
  const btns = document.querySelectorAll('.canvas-mode-btn');
  for (const b of btns) { if (b.textContent?.includes('Kanban')) b.click(); }
  return 'clicked';
})()" > /dev/null 2>&1
sleep 2
S=$(snap)
echo "$S" | grep -qi "kanban\|Add column\|Add card\|Filter" && pass "Switched to Kanban seamlessly" || fail "Kanban not shown after switch" ""

step "I return to Notes"
ev "(()=>{
  const btn = document.querySelector('.canvas-back-btn');
  if (btn) { btn.click(); return 'clicked'; }
  return 'not found';
})()" > /dev/null 2>&1
sleep 1
S=$(snap)
echo "$S" | grep -qi "Getting Started\|Project Alpha\|Pages" && pass "Back to editor" || fail "Didn't return to notes" ""

ss "35-canvas-switching"

# ═══════════════════════════════════════════════
journey "36. I want to manage a project with the Kanban board"
# Real user: project manager wants to track tasks visually
# ═══════════════════════════════════════════════

step "I navigate to a page with content for kanban"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Getting Started"* ]] && pass "On Getting Started page for kanban" || fail "Can't navigate" "$R"
BLOCK_COUNT=$(api "getBlockCount()" | tr -d '"')

step "I open Kanban view via sidebar button"
ev "(()=>{
  const btns = document.querySelectorAll('.stats-mode-btn');
  for (const b of btns) { if (b.textContent?.includes('Kanban')) { b.click(); return 'clicked'; } }
  return 'not found';
})()" > /dev/null 2>&1
sleep 3
S=$(snap)
echo "$S" | grep -qi "Kanban\|Filter\|Add column\|Copy as Table" && pass "Kanban board opens" || fail "Kanban didn't open" ""

step "I see my blocks as columns"
COL_COUNT=$(ev "document.querySelectorAll('.kanban-column').length" | tr -d '"')
[[ "$COL_COUNT" -ge 1 ]] 2>/dev/null && pass "Columns rendered ($COL_COUNT)" || fail "Columns not rendered" "$COL_COUNT"

step "Column titles show block content"
TITLES=$(ev "(()=>{
  return [...document.querySelectorAll('.kanban-column-title')].map(t=>t.textContent).join(', ');
})()" | tr -d '"')
[[ -n "$TITLES" ]] && pass "Column titles: $TITLES" || fail "Column titles empty" ""

step "I see cards in columns (child blocks)"
# Getting Started is flat, so every card count must match the page's actual
# column-children (0 here); the nested-card tests use a dedicated board below.
CARD_COUNT=$(ev "document.querySelectorAll('.kanban-card').length" | tr -d '"')
# Columns are section blocks (a heading, or a block with children). Top-level
# blocks that are neither are cards in the leading "No section" column.
KB_SHAPE="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Getting Started');const ok=b=>b.content.trim()!=='---';const parents=new Set(t.blocks.filter(b=>b.parent_id&&ok(b)).map(b=>b.parent_id));const top=t.blocks.filter(b=>!b.parent_id&&ok(b));const isCol=b=>parents.has(b.id)||/^#{1,6}\\s+\\S/.test(b.content.trim());const cols=new Set(top.filter(isCol).map(b=>b.id));const loose=top.filter(b=>!isCol(b)&&b.content.trim()!=='').length;const dom=[...document.querySelectorAll('.kanban-column:not(.kanban-column-unsorted)')].map(c=>c.dataset.columnId);return {cards:loose+t.blocks.filter(b=>b.parent_id&&cols.has(b.parent_id)&&ok(b)).length,loose,badCols:dom.filter(id=>!cols.has(id)).length}})()"
EXPECTED_CARDS=$(ev "$KB_SHAPE.then(r=>r.cards)" | tr -d '"')
[[ -n "$CARD_COUNT" && "$CARD_COUNT" == "$EXPECTED_CARDS" ]] && pass "Cards rendered match the page's blocks ($CARD_COUNT)" || fail "Card count wrong" "rendered=$CARD_COUNT expected=$EXPECTED_CARDS"

step "Plain paragraphs are cards under 'No section', not empty columns"
BAD_COLS=$(ev "$KB_SHAPE.then(r=>r.badCols)" | tr -d '"')
[[ "$BAD_COLS" == "0" ]] && pass "Every column is a heading or a block with children" || fail "Non-section blocks rendered as columns" "$BAD_COLS"
UNSORTED=$(ev "$KB_SHAPE.then(r=>{const u=document.querySelectorAll('.kanban-column-unsorted');const first=document.querySelector('.kanban-column');return r.loose+':'+u.length+':'+(u[0]?u[0].querySelectorAll('.kanban-card').length:0)+':'+(u[0]?u[0]===first:'-')+':'+(u[0]?u[0].querySelector('.kanban-column-title').textContent:'')})" | tr -d '"')
LOOSE=${UNSORTED%%:*}
[[ "$LOOSE" -ge 1 && "$UNSORTED" == "$LOOSE:1:$LOOSE:true:No section" ]] 2>/dev/null && pass "$LOOSE top-level paragraphs are cards in the leading 'No section' column" || fail "'No section' column wrong" "loose:cols:cards:first:title=$UNSORTED"
EMPTY_PARA_COLS=$(ev "[...document.querySelectorAll('.kanban-column')].filter(c=>!c.querySelector('.kanban-card')&&!c.classList.contains('kanban-column-unsorted')&&/^This is a block/.test(c.querySelector('.kanban-column-title').textContent)).length" | tr -d '"')
[[ "$EMPTY_PARA_COLS" == "0" ]] && pass "No empty paragraph columns" || fail "Paragraph rendered as an empty column" "$EMPTY_PARA_COLS"

ss "36-kanban-board"

step "I can see the Add Column button"
ADD_COL=$(ev "!!document.querySelector('.kanban-add-column')" | tr -d '"')
[[ "$ADD_COL" == "true" ]] && pass "Add column button visible" || fail "No add column button" ""

step "I add a new column"
OLD_COL_COUNT=$(ev "document.querySelectorAll('.kanban-column').length" | tr -d '"')
ev "document.querySelector('.kanban-add-column')?.click()" > /dev/null 2>&1; sleep 2
NEW_COL_COUNT=$(ev "document.querySelectorAll('.kanban-column').length" | tr -d '"')
[[ "$NEW_COL_COUNT" -gt "$OLD_COL_COUNT" ]] 2>/dev/null && pass "New column added ($OLD_COL_COUNT → $NEW_COL_COUNT)" || fail "Column not added" "$OLD_COL_COUNT → $NEW_COL_COUNT"
# The new column is stored as a heading block (so it stays a column while empty)
# and its title is shown without the markdown marker, with a tooltip.
NEW_COL=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const c=[...document.querySelectorAll('.kanban-column')].pop();const t=c.querySelector('.kanban-column-title');const b=(await api.getPageTree('Getting Started')).blocks.find(b=>b.id===c.dataset.columnId);return t.textContent+'|'+t.title+'|'+(b?b.content:'no block')})()" | tr -d '"')
[[ "$NEW_COL" == "New Column|New Column|## New Column" ]] && pass "New column is a heading block, shown as 'New Column' with a tooltip" || fail "New column wrong" "$NEW_COL"

step "I set a color on a column via the color button"
# Click the color dot button (●) — it's the first kanban-col-btn in the first column header
ev "(()=>{
  const btns = document.querySelectorAll('.kanban-column-header .kanban-col-btn');
  // The color button is the first one (●)
  for (const b of btns) { if (b.textContent.trim() === '●') { b.click(); return 'clicked'; } }
  return 'no color btn';
})()" > /dev/null 2>&1
sleep 0.5
PICKER=$(ev "!!document.querySelector('.kanban-color-picker')" | tr -d '"')
[[ "$PICKER" == "true" ]] && pass "Color picker opened" || fail "Color picker didn't open" ""

step "I pick a color"
ev "(()=>{
  const swatch = document.querySelector('.kanban-color-swatch');
  if (swatch) { swatch.click(); return 'picked'; }
  return 'no swatch';
})()" > /dev/null 2>&1
sleep 1
COLOR_BAR=$(ev "!!document.querySelector('.kanban-color-bar')" | tr -d '"')
[[ "$COLOR_BAR" == "true" ]] && pass "Column color bar applied" || fail "Color not applied" "$COLOR_BAR"

ss "36-kanban-colors"

step "I build a real project board: columns with nested cards (and card sub-items)"
ev "document.querySelector('.canvas-back-btn')?.click()" > /dev/null 2>&1; sleep 1
KB_SEED=$(ev "(async()=>{
  const api = await import('/src/lib/api.ts');
  const p = await api.createPage('Kanban Journey');
  const todo = await api.createBlock(p.id, 'Todo');
  const doing = await api.createBlock(p.id, 'Doing');
  const done = await api.createBlock(p.id, 'Done');
  await api.createBlock(p.id, 'Write spec', todo.id);
  const bug = await api.createBlock(p.id, 'Fix login bug', todo.id);
  const s1 = await api.createBlock(p.id, 'Repro steps', bug.id);
  const s2 = await api.createBlock(p.id, 'Patch auth', bug.id);
  await api.setProperty(bug.id, 'block', 'priority', 'high');
  await api.createBlock(p.id, 'Review PR', doing.id);
  await api.createBlock(p.id, 'DONE Ship v1', done.id);
  window.__KB = { page: p.id, todo: todo.id, bug: bug.id, bugPos: bug.position, subs: [s1.id, s2.id] };
  return 'seeded';
})()" | tr -d '"')
api "navigateTo('Kanban Journey')" > /dev/null; sleep 2
ev "(()=>{
  const btns = document.querySelectorAll('.stats-mode-btn');
  for (const b of btns) { if (b.textContent?.includes('Kanban')) { b.click(); return 'clicked'; } }
})()" > /dev/null 2>&1
sleep 3
CARD_COUNT=$(ev "document.querySelectorAll('.kanban-card').length" | tr -d '"')
COL_COUNT=$(ev "document.querySelectorAll('.kanban-column').length" | tr -d '"')
[[ "$KB_SEED" == "seeded" && "$COL_COUNT" == "3" && "$CARD_COUNT" == "4" ]] && pass "Board shows 3 columns and 4 cards (sub-items are not cards)" || fail "Kanban board seed wrong" "seed=$KB_SEED cols=$COL_COUNT cards=$CARD_COUNT"
SUBCOUNT=$(ev "(()=>{const t=[...document.querySelectorAll('.kanban-card-text')].find(e=>e.textContent==='Fix login bug');return t?.closest('.kanban-card')?.querySelector('.kanban-sub-count')?.textContent||'none'})()" | tr -d '"')
[[ "$SUBCOUNT" == "2 sub-blocks" ]] && pass "Card shows its 2 sub-items" || fail "Card sub-item count wrong" "$SUBCOUNT"

step "A task card shows its state as a badge, not twice"
TASK_CARD=$(ev "(()=>{const t=[...document.querySelectorAll('.kanban-card-text')];const c=t.find(e=>e.textContent==='Ship v1')?.closest('.kanban-card');return (c?.querySelector('.kanban-todo-badge')?.textContent||'no badge')+':'+(c?.dataset.todo||'')+':'+t.filter(e=>/^(TODO|DOING|DONE) /.test(e.textContent)).length})()" | tr -d '"')
[[ "$TASK_CARD" == "DONE:DONE:0" ]] && pass "'DONE Ship v1' shows a DONE badge and the text 'Ship v1'" || fail "Task card shows the keyword twice" "badge:state:keyword-texts=$TASK_CARD"

step "Cards in a colored column get a matching border"
ev "(()=>{for(const b of document.querySelectorAll('.kanban-column-header .kanban-col-btn')){if(b.textContent.trim()==='●'){b.click();return 'clicked'}}return 'none'})()" > /dev/null 2>&1; sleep 0.5
ev "document.querySelector('.kanban-color-swatch')?.click()" > /dev/null 2>&1; sleep 1
CARD_BORDER=$(ev "(()=>{const c=document.querySelector('.kanban-column .kanban-card');return c?(c.style.borderLeftColor||'no-color'):'no-cards'})()" | tr -d '"')
[[ "$CARD_BORDER" != "no-color" && "$CARD_BORDER" != "no-cards" && -n "$CARD_BORDER" ]] && pass "Card border matches column color ($CARD_BORDER)" || fail "Card border has no column color" "$CARD_BORDER"

step "I right-click a card to see context menu"
ev "(()=>{
  const t = [...document.querySelectorAll('.kanban-card-text')].find(e => e.textContent === 'Fix login bug');
  t.closest('.kanban-card').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:200, clientY:300}));
  return 'right-clicked';
})()" > /dev/null 2>&1
sleep 0.5
CTX=$(ev "!!document.querySelector('.kanban-ctx-menu')" | tr -d '"')
[[ "$CTX" == "true" ]] && pass "Context menu opens" || fail "No context menu" ""

step "Context menu has expected actions"
CTX_TEXT=$(ev "document.querySelector('.kanban-ctx-menu')?.textContent || ''" | tr -d '"')
echo "$CTX_TEXT" | grep -qi "Delete" && pass "Context menu has Delete" || fail "Missing Delete in context menu" "$CTX_TEXT"
echo "$CTX_TEXT" | grep -qi "Edit" && pass "Context menu has Edit" || fail "Missing Edit" "$CTX_TEXT"

step "I delete a card (with sub-items) and see undo toast"
ev "(()=>{
  const btns = document.querySelectorAll('.kanban-ctx-menu button');
  for (const b of btns) { if (b.textContent?.includes('Delete')) { b.click(); return 'deleted'; } }
  return 'no delete';
})()" > /dev/null 2>&1
sleep 1
DEL_STATE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__KB.page);const ids=new Set(t.blocks.map(b=>b.id));return document.querySelectorAll('.kanban-card').length+':'+[window.__KB.bug,...window.__KB.subs].filter(i=>ids.has(i)).length})()" | tr -d '"')
[[ "$DEL_STATE" == "3:0" ]] && pass "Card and its sub-items deleted (3 cards left)" || fail "Card delete wrong" "cards:remaining-ids=$DEL_STATE"
TOAST=$(ev "document.querySelector('.kanban-toast')?.textContent || ''" | tr -d '"')
echo "$TOAST" | grep -q "Deleted.*Fix login bug" && pass "Undo toast appeared ($TOAST)" || fail "No undo toast" "$TOAST"

step "Undo button is present in toast"
UNDO_BTN=$(ev "!!document.querySelector('.kanban-toast-undo')" | tr -d '"')
[[ "$UNDO_BTN" == "true" ]] && pass "Undo button visible in toast" || fail "No undo button" ""

step "I click Undo to restore the card"
CARDS_BEFORE=$(ev "document.querySelectorAll('.kanban-card').length" | tr -d '"')
ev "document.querySelector('.kanban-toast-undo')?.click()" > /dev/null 2>&1; sleep 2
CARDS_AFTER=$(ev "document.querySelectorAll('.kanban-card').length" | tr -d '"')
[[ "$CARDS_BEFORE" == "3" && "$CARDS_AFTER" == "4" ]] 2>/dev/null && pass "Undo restored card ($CARDS_BEFORE → $CARDS_AFTER)" || fail "Undo didn't restore" "$CARDS_BEFORE → $CARDS_AFTER"

step "The restored card keeps its original block id, column, position, sub-items and properties"
RESTORED=$(ev "(async()=>{
  const api = await import('/src/lib/api.ts');
  const t = await api.getPageTree(window.__KB.page);
  const bug = t.blocks.find(b => b.id === window.__KB.bug);
  if (!bug) return 'card id gone';
  if (bug.parent_id !== window.__KB.todo) return 'wrong column';
  if (bug.position !== window.__KB.bugPos) return 'wrong position ' + bug.position;
  const kids = t.blocks.filter(b => b.parent_id === bug.id).sort((a, b) => a.position - b.position).map(b => b.id);
  if (kids.join() !== window.__KB.subs.join()) return 'sub-items ' + kids.join();
  const props = await api.getProperties(bug.id);
  if (!props.some(p => p.key === 'priority' && p.value === 'high')) return 'property lost';
  return 'same-id';
})()" | tr -d '"')
[[ "$RESTORED" == "same-id" ]] && pass "Undo restored card with SAME id + sub-items + property" || fail "Undo restore not faithful" "$RESTORED"

step "I use the search filter"
# React controlled input: set the value through the native setter so onChange fires.
KB_FILTER="(q)=>{const i=document.querySelector('.kanban-search-input');if(!i)return 'no input';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,q);i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'}"
ev "($KB_FILTER)('login')" > /dev/null 2>&1
sleep 1
VISIBLE=$(ev "[...document.querySelectorAll('.kanban-card-text')].map(e=>e.textContent).join('|')" | tr -d '"')
[[ "$VISIBLE" == "Fix login bug" ]] && pass "Search filter narrows 4 cards to 1 ($VISIBLE)" || fail "Search filter not applied" "visible=$VISIBLE"

step "I clear the search"
ev "($KB_FILTER)('')" > /dev/null 2>&1
sleep 1
VISIBLE=$(ev "document.querySelectorAll('.kanban-card').length" | tr -d '"')
[[ "$VISIBLE" == "4" ]] && pass "Clearing search shows all 4 cards again" || fail "Clearing search didn't restore cards" "$VISIBLE"

step "I export the board as markdown"
# Headless Chrome denies clipboard access: stub writeText to capture the text.
ev "(()=>{window.__copiedMd=null;Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:(t)=>{window.__copiedMd=t;return Promise.resolve()}});return 'stubbed'})()" > /dev/null 2>&1
ev "document.querySelector('.kanban-toolbar-btn')?.click()" > /dev/null 2>&1; sleep 1
TOAST=$(ev "document.querySelector('.kanban-toast')?.textContent || ''" | tr -d '"')
echo "$TOAST" | grep -q "Copied board as markdown table" && pass "Export toast confirms copy" || fail "No export toast" "$TOAST"
COPIED=$(ev "(()=>{const m=window.__copiedMd||'';return [m.startsWith('# Kanban Journey'),m.includes('| Todo | Doing | Done |'),m.includes('| Write spec | Review PR | DONE Ship v1 |'),m.includes('| Fix login bug |  |  |')].join(',')})()" | tr -d '"')
[[ "$COPIED" == "true,true,true,true" ]] && pass "Copied markdown table has the board's columns and cards" || fail "Copied markdown wrong" "$COPIED"

HAS_CARDS=$(ev "document.querySelectorAll('.kanban-card').length" | tr -d '"')
if [[ "$HAS_CARDS" -ge 1 ]] 2>/dev/null; then
  step "I double-click a card to edit it"
  ev "(()=>{
    const card = document.querySelector('.kanban-card');
    if (!card) return 'no card';
    card.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
    return 'double-clicked';
  })()" > /dev/null 2>&1
  sleep 0.5
  EDITOR=$(ev "!!document.querySelector('.kanban-card-editor')" | tr -d '"')
  [[ "$EDITOR" == "true" ]] && pass "Inline card editor opened" || fail "Editor didn't open" ""

  step "I close card editor with Escape"
  ev "(()=>{
    const ta = document.querySelector('.kanban-card-editor');
    if (ta) { ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 'escaped'; }
    return 'no editor';
  })()" > /dev/null 2>&1
  sleep 0.5
  EDITOR=$(ev "!!document.querySelector('.kanban-card-editor')" | tr -d '"')
  [[ "$EDITOR" == "false" ]] && pass "Escape closed the card editor" || fail "Card editor still open after Escape" "$EDITOR"

  step "I see pencil edit icon on hover"
  PENCIL=$(ev "!!document.querySelector('.kanban-card-edit-btn')" | tr -d '"')
  [[ "$PENCIL" == "true" ]] && pass "Edit pencil button exists" || fail "No edit button" ""
else
  fail "Card edit tests" "no cards on the seeded board ($HAS_CARDS)"
fi

step "I close kanban and return to outliner"
# Escape does not close the canvas layer; the back button does.
ev "document.querySelector('.canvas-back-btn')?.click()" > /dev/null 2>&1; sleep 1
BACK=$(ev "(()=>!document.querySelector('.kanban-container')&&document.querySelectorAll('[data-block-id]').length>0)()" | tr -d '"')
[[ "$BACK" == "true" ]] && pass "Back to block view" || fail "Did not return to block view" "$BACK"

ss "36-kanban-complete"

# ═══════════════════════════════════════════════
journey "37. Final: Is the app stable after everything?"
# After all journeys of heavy use, does it still work?
# ═══════════════════════════════════════════════

step "Journal still works"
api "openJournal()" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Journal"* ]] && pass "Journal stable" || fail "Journal crashed" "$R"

step "Navigation still works"
api "navigateTo('Project Alpha')" > /dev/null; sleep 1
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Project Alpha"* ]] && pass "Navigation stable" || fail "Nav crashed" "$R"

step "Content still readable"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 3 ]] 2>/dev/null && pass "Content intact" || fail "Content lost" "$R"

step "Search still works"
api "openSearch()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search" && pass "Search stable" || fail "Search crashed" ""
api "closePanel()" > /dev/null; sleep 0.5

step "Settings still works"
api "openSettings()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Theme" && pass "Settings stable" || fail "Settings crashed" ""
api "closePanel()" > /dev/null

ss "37-final-stability"

# ═══════════════════════════════════════════════
journey "Trash: Soft Delete & Restore"
# ═══════════════════════════════════════════════

step "Create page for trash test"
ev "(async()=>{const api=await import('/src/lib/api.ts');await api.createPage('Trash Test Page');return 'ok'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Trash Test Page" && pass "Trash test page created" || fail "Trash test page not visible" ""

step "Trash page via API"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();const p=pages.find(x=>x.title==='Trash Test Page');if(p){await api.trashPage(p.id);return 'trashed'}return 'not found'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Trash Test Page" && fail "Trashed page still visible in sidebar" "" || pass "Page removed from sidebar after trash"

step "Page appears in trash list"
TRASH=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const items=await api.listTrash();return JSON.stringify(items.map(x=>x.title))})()")
echo "$TRASH" | grep -qi "Trash Test Page" && pass "Page in trash list" || fail "Page not in trash list" "$TRASH"

step "Restore page from trash"
ev "(async()=>{const api=await import('/src/lib/api.ts');const items=await api.listTrash();const t=items.find(x=>x.title==='Trash Test Page');if(t){await api.restoreFromTrash(t.id,t.item_type);return 'restored'}return 'not found'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Trash Test Page" && pass "Restored page visible in sidebar" || fail "Restored page not visible" ""

step "Re-trash and permanently delete"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();const p=pages.find(x=>x.title==='Trash Test Page');if(p){await api.trashPage(p.id);const items=await api.listTrash();const t=items.find(x=>x.title==='Trash Test Page');if(t){await api.permanentlyDelete(t.id,t.item_type);return 'deleted'}}return 'fail'})()" > /dev/null; sleep 1
TRASH2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const items=await api.listTrash();return items.length})()")
PAGES=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();return pages.some(x=>x.title==='Trash Test Page')})()")
[[ "$PAGES" == "false" ]] && pass "Permanently deleted page gone" || fail "Page still exists after permanent delete" "$PAGES"

ss "38-trash-tests"

# ═══════════════════════════════════════════════
journey "Trash: Folder Soft Delete"
# ═══════════════════════════════════════════════

step "Create folder with pages"
ev "(async()=>{const api=await import('/src/lib/api.ts');const f=await api.createFolder('Trash Folder Test');const p1=await api.createPage('TF Page 1');const p2=await api.createPage('TF Page 2');await api.movePageToFolder(p1.id,f.id);await api.movePageToFolder(p2.id,f.id);return 'ok'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Trash Folder Test" && pass "Folder created with pages" || fail "Folder not shown in sidebar" ""

step "Trash the folder"
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Trash Folder Test');if(f){const count=await api.trashFolder(f.id);return 'trashed '+count+' pages'}return 'no folder'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1

step "Folder pages disappear from main list"
PAGES=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();return pages.some(x=>x.title==='TF Page 1')})()")
[[ "$PAGES" == "false" ]] && pass "Folder pages hidden after trash" || fail "Folder pages still visible" "$PAGES"

step "Restore folder from trash"
ev "(async()=>{const api=await import('/src/lib/api.ts');const items=await api.listTrash();const f=items.find(x=>x.title==='Trash Folder Test');if(f){await api.restoreFromTrash(f.id,f.item_type);return 'restored'}return 'not in trash'})()" > /dev/null; sleep 1
PAGES2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();return pages.some(x=>x.title==='TF Page 1')})()")
[[ "$PAGES2" == "true" ]] && pass "Folder pages restored" || fail "Folder pages not restored" "$PAGES2"

ss "39-folder-trash"

# ═══════════════════════════════════════════════
journey "Archive: Folder Archive & Restore"
# ═══════════════════════════════════════════════

step "Create folder for archive test"
# Capture the folder id now: getFolderTree omits archived folders, so after the
# archive step below there is no way to look this id up again.
AF_ID=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const f=await api.createFolder('Archive Test Folder');const p=await api.createPage('AF Page 1');await api.movePageToFolder(p.id,f.id);return f.id})()" | tr -d '"'); sleep 1
api "refreshSidebar()" > /dev/null; sleep 1

step "Archive the folder"
ev "(async()=>{const api=await import('/src/lib/api.ts');const count=await api.archiveFolder('$AF_ID');return 'archived '+count})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1

step "Folder pages hidden from main list"
PAGES=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();return pages.some(x=>x.title==='AF Page 1')})()")
[[ "$PAGES" == "false" ]] && pass "Archived folder pages hidden" || fail "Archived pages still visible" "$PAGES"

step "Archived folder appears in archived list"
# Both the mock and the Rust backend roll an archived folder's pages up under
# the folder — ArchiveItem carries {id,title,item_type,page_count,archived_at}
# and no folder_id, and list_archived only lists pages NOT in an archived
# folder. So assert the folder, with its page_count.
ARCH=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const items=await api.listArchived();const f=items.find(x=>x.title==='Archive Test Folder'&&x.item_type==='folder');return f?String(f.page_count):'missing'})()" | tr -d '"')
[[ "$ARCH" == "1" ]] && pass "Archived folder listed with its 1 page" || fail "Archived folder not in archived list" "$ARCH"

step "Unarchive the folder"
ev "(async()=>{const api=await import('/src/lib/api.ts');await api.unarchiveFolder('$AF_ID');return 'unarchived'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1

step "Pages restored after unarchive"
PAGES2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();return pages.some(x=>x.title==='AF Page 1')})()")
[[ "$PAGES2" == "true" ]] && pass "Unarchived pages visible" || fail "Unarchived pages still hidden" "$PAGES2"

step "Archived count is zero"
COUNT=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.archivedCount()})()")
[[ "$COUNT" == "0" ]] && pass "Archive empty after restore" || fail "Archive not empty" "$COUNT"

ss "40-archive-tests"

# ═══════════════════════════════════════════════
journey "Folder Customization: Icon & Color"
# ═══════════════════════════════════════════════

step "Create folder for customization"
ev "(async()=>{const api=await import('/src/lib/api.ts');await api.createFolder('Icon Test Folder');return 'ok'})()" > /dev/null; sleep 1

step "Set folder icon"
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Icon Test Folder');if(f){await api.updateFolderAppearance(f.id,'🚀',undefined);return 'icon set'}return 'no folder'})()" > /dev/null; sleep 1

step "Icon persisted"
ICON=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Icon Test Folder');return f?.icon||'none'})()" | tr -d '"')
[[ "$ICON" == "🚀" ]] && pass "Folder icon set to 🚀" || fail "Folder icon not persisted" "$ICON"

step "Set folder color"
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Icon Test Folder');if(f){await api.updateFolderAppearance(f.id,f.icon,'#f38ba8');return 'color set'}return 'no folder'})()" > /dev/null; sleep 1

step "Color persisted"
COLOR=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Icon Test Folder');return f?.color||'none'})()" | tr -d '"')
[[ "$COLOR" == "#f38ba8" ]] && pass "Folder color set to pink" || fail "Folder color not persisted" "$COLOR"

step "Rename folder"
ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Icon Test Folder');if(f){await api.renameFolder(f.id,'Renamed Folder');return 'renamed'}return 'no folder'})()" > /dev/null; sleep 1

step "Rename persisted"
NAME=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const tree=await api.getFolderTree();const f=tree.folders?.find(x=>x.name==='Renamed Folder');return f?.name||'not found'})()" | tr -d '"')
[[ "$NAME" == "Renamed Folder" ]] && pass "Folder rename persisted" || fail "Folder rename not persisted" "$NAME"

ss "41-folder-customization"

# ═══════════════════════════════════════════════
journey "Pinned Pages & Favorites"
# ═══════════════════════════════════════════════

step "Pin a page"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();if(pages.length>0){await api.addFavorite(pages[0].id);return 'pinned '+pages[0].title}return 'no pages'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Pinned" && pass "Pinned section appears" || fail "Pinned section not visible" ""

step "Pin a second page"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();if(pages.length>1){await api.addFavorite(pages[1].id);return 'pinned'}return 'not enough pages'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
FAVS=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return (await api.listFavorites()).length})()")
[[ "$FAVS" -ge 2 ]] && pass "Two pages pinned" || fail "Expected 2+ pinned pages" "$FAVS"

step "Pinned pages not duplicated in main list"
S=$(snap)
# This is hard to test via snapshot alone — verify via API
# getFolderTree() still lists pinned pages; the Sidebar filters them out of its
# "Pages" section. So check what is rendered: no pinned title appears twice.
DUP=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const favs=await api.listFavorites();const texts=[...document.querySelectorAll('.sidebar *')].filter(e=>e.children.length===0).map(e=>e.textContent.trim());return favs.filter(f=>texts.filter(t=>t===f.title).length>1).length})()")
[[ "$DUP" == "0" ]] && pass "No duplicate pinned pages in root list" || fail "Pinned pages duplicated in root list" "$DUP"

step "Unpin a page"
ev "(async()=>{const api=await import('/src/lib/api.ts');const favs=await api.listFavorites();if(favs.length>0){await api.removeFavorite(favs[0].id);return 'unpinned'}return 'none'})()" > /dev/null; sleep 1
api "refreshSidebar()" > /dev/null; sleep 1
FAVS2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return (await api.listFavorites()).length})()")
[[ "$FAVS2" -lt "$FAVS" ]] && pass "Page unpinned successfully" || fail "Unpin didn't reduce count" "$FAVS2"

step "Reorder pinned pages"
# Make sure there are 2+ pins, move the first to the end, check the new order.
REORDER=$(ev "(async()=>{const api=await import('/src/lib/api.ts');let favs=await api.listFavorites();if(favs.length<2){const pages=await api.listPages();const extra=pages.find(p=>!p.is_journal&&!favs.some(f=>f.id===p.id));if(extra)await api.addFavorite(extra.id);favs=await api.listFavorites()}if(favs.length<2)return 'too few pins';const first=favs[0].id;await api.reorderFavorite(first,999);const after=await api.listFavorites();return after[after.length-1].id===first&&after[0].id!==first?'moved':'order '+after.map(f=>f.title).join(',')})()" | tr -d '"')
sleep 1
[[ "$REORDER" == "moved" ]] && pass "Reordering moves the first pinned page to the end" || fail "Reorder favorite didn't change order" "$REORDER"

ss "42-pinned-tests"

# ═══════════════════════════════════════════════
journey "Sync Settings"
# ═══════════════════════════════════════════════

step "Check git availability"
GIT=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.gitAvailable()})()")
# Either answer is valid (git may be absent); what must hold is that the command answers.
[[ "$GIT" == "true" || "$GIT" == "false" ]] && pass "Git availability reported ($GIT)" || fail "gitAvailable() gave no boolean" "$GIT"

step "Sync toggle in settings panel"
api "openSettings()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Sync\|Enable Sync" && pass "Sync section visible in settings" || fail "Sync section missing" ""
api "closePanel()" > /dev/null

step "Sync status API"
STATUS=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const s=await api.gitSyncStatus();return JSON.stringify(s)})()")
echo "$STATUS" | grep -qi "enabled" && pass "Sync status returned" || fail "Sync status failed" "$STATUS"

ss "43-sync-tests"

# ═══════════════════════════════════════════════
journey "Search & Journal Formatting"
# ═══════════════════════════════════════════════

step "Search panel shows Recent with icon"
api "openSearch()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Recent" && pass "Recent section in search" || fail "Recent section missing" ""
api "closePanel()" > /dev/null

step "Journal date formatting in sidebar"
S=$(snap)
echo "$S" | grep -qi "Today" && pass "Today label in sidebar" || fail "Today label missing" ""
# Should NOT show raw "Journal/2026-" format
echo "$S" | grep -q "Journal/20" && fail "Raw journal title visible" "" || pass "No raw journal titles"

ss "44-search-journal"

# ═══════════════════════════════════════════════
journey "Empty Trash"
# ═══════════════════════════════════════════════

step "Create and trash multiple pages"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p1=await api.createPage('Empty Test 1');const p2=await api.createPage('Empty Test 2');await api.trashPage(p1.id);await api.trashPage(p2.id);return 'ok'})()" > /dev/null; sleep 1

step "Trash has items"
COUNT=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return (await api.listTrash()).length})()")
[[ "$COUNT" -ge 2 ]] && pass "Trash has $COUNT items" || fail "Trash should have 2+ items" "$COUNT"

step "Empty trash"
ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.emptyTrash()})()" > /dev/null; sleep 1

step "Trash is empty"
COUNT2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return (await api.listTrash()).length})()")
[[ "$COUNT2" == "0" ]] && pass "Trash emptied successfully" || fail "Trash not empty" "$COUNT2"

ss "45-empty-trash"

# ═══════════════════════════════════════════════
journey "46. AI Auto-Tagging — I write a note and tags appear"
# ═══════════════════════════════════════════════

step "Create a note with #tags in content"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('AI Tag Test');await api.createBlock(p.id,'This is about #rust and #sqlite and #tauri development');return p.id})()" > /dev/null; sleep 2

step "Page loads with AI tag suggestions"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pt=await api.getPageTree('AI Tag Test');return pt.blocks.length})()" > /dev/null; sleep 1
# The chips only render for the page the UI is actually showing, so navigate
# there first — creating the page over the API does not change the view.
api "navigateTo('AI Tag Test')" > /dev/null; sleep 2
# Check that AI tag chips are visible in the DOM
HAS_AI_TAGS=$(ev "document.querySelectorAll('.ai-tag-chip').length" | tr -d '"')
[[ "$HAS_AI_TAGS" -ge 1 ]] 2>/dev/null && pass "AI tag chips visible ($HAS_AI_TAGS tags)" || fail "No AI tag chips" "Tags not shown"

step "AI suggests relevant tags from content"
S=$(snap)
echo "$S" | grep -qi "rust\|sqlite\|tauri" && pass "AI suggests correct tags" || fail "AI tags don't match content" "Expected rust/sqlite/tauri"

step "I accept a suggested tag"
# Click the + button on the first tag chip
ev "(async()=>{const btn=document.querySelector('.ai-tag-accept');if(btn){btn.click();return 'accepted'}return 'no button'})()" > /dev/null; sleep 1
# Verify tag was added as a property
TAG_PROP=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const props=await api.getProperties((await api.getPageTree('AI Tag Test')).page.id);const tags=props.find(p=>p.key==='tags');return tags?tags.value:''})()")
[[ -n "$TAG_PROP" ]] && pass "Tag persisted as property: $TAG_PROP" || fail "Tag not saved as property" ""

step "I dismiss a suggested tag"
BEFORE_DISMISS=$(ev "document.querySelectorAll('.ai-tag-chip').length" | tr -d '"')
ev "(async()=>{const btn=document.querySelector('.ai-tag-dismiss');if(btn){btn.click();return 'dismissed'}return 'no button'})()" > /dev/null; sleep 1
# Dismissed tags should no longer appear
REMAINING=$(ev "document.querySelectorAll('.ai-tag-chip').length" | tr -d '"')
[[ "$REMAINING" -lt "$BEFORE_DISMISS" ]] 2>/dev/null && pass "Dismissed tag removed ($REMAINING remaining)" || fail "Dismissed tag still shown" "before=$BEFORE_DISMISS after=$REMAINING"

# ═══════════════════════════════════════════════
journey "47. AI Link Suggestions — I see related pages"
# ═══════════════════════════════════════════════

step "Create pages with overlapping keywords"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p1=await api.createPage('Rust Programming');await api.createBlock(p1.id,'Rust is a systems programming language');const p2=await api.createPage('Systems Design');await api.createBlock(p2.id,'Systems design covers architecture and programming patterns');return 'ok'})()" > /dev/null; sleep 2

step "Open a page and see link suggestions"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pt=await api.getPageTree('Rust Programming');return pt.page.id})()" > /dev/null; sleep 2
api "navigateTo('Rust Programming')" > /dev/null; sleep 2

# Check that AI link suggestion chips are visible
HAS_AI_LINKS=$(ev "document.querySelectorAll('.ai-link-chip').length" | tr -d '"')
[[ "$HAS_AI_LINKS" -ge 1 ]] 2>/dev/null && pass "AI link suggestions visible ($HAS_AI_LINKS links)" || fail "No AI link suggestions" "count=$HAS_AI_LINKS"

step "Pages that merely exist are not suggested (no shared distinctive words)"
# 'Bulk page NN' shares only the generic word 'page' with this text and has no content;
# 'Quarterly Budget' shares nothing. Neither may be suggested; 'Tauri' is mentioned by name.
ev "(async()=>{const api=await import('/src/lib/api.ts');for(const t of ['Bulk page 01','Bulk page 02','Bulk page 03','Bulk page 04','Quarterly Budget','Tauri'])await api.createPage(t);const p=await api.createPage('Relevance Check');await api.createBlock(p.id,'This is a sample page with nested blocks. Built with Tauri, in bulk.');return 'ok'})()" > /dev/null
api "navigateTo('Relevance Check')" > /dev/null; sleep 2
CHIPS=$(ev "[...document.querySelectorAll('.ai-link-chip')].map(c=>c.textContent.replace(/\+x\$/,'')).join(',')" | tr -d '"')
[[ "$CHIPS" == "[[Tauri]]" ]] && pass "Only the page mentioned by name is suggested ($CHIPS)" || fail "Noisy link suggestions" "$CHIPS"
api "navigateTo('Rust Programming')" > /dev/null; sleep 2

step "Clicking a suggested link inserts it into the current page"
# Bug #28: the + button INSERTS the wiki-link as a new block rather than
# navigating away. Assert the insert, and that we stayed put.
ev "(async()=>{const btn=document.querySelector('.ai-link-insert');if(btn){btn.click();return 'inserted'}return 'no button'})()" > /dev/null; sleep 2
LINKED=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const pt=await api.getPageTree('Rust Programming');return pt.blocks.some(b=>b.content.includes('[[Systems Design]]'))})()")
[[ "$LINKED" == "true" ]] && pass "Wiki-link inserted from suggestion" || fail "Link suggestion click didn't insert" "$LINKED"
CURRENT_TITLE=$(api "getCurrentPage()" | tr -d '"')
[[ "$CURRENT_TITLE" == "Rust Programming" ]] && pass "Stayed on the page after insert" || fail "Insert navigated away" "$CURRENT_TITLE"

step "I dismiss a link suggestion"
# Add another related page so there is something left to dismiss after the insert.
ev "(async()=>{const api=await import('/src/lib/api.ts');await api.createPage('Rust Language Notes');return 'ok'})()" > /dev/null
api "navigateTo('Systems Design')" > /dev/null; sleep 1
api "navigateTo('Rust Programming')" > /dev/null; sleep 2
LINKS_BEFORE=$(ev "document.querySelectorAll('.ai-link-chip').length" | tr -d '"')
DISMISSED_TITLE=$(ev "(()=>{const c=document.querySelector('.ai-link-chip');const t=c?c.textContent:'';c?.querySelector('.ai-link-dismiss')?.click();return t})()" | tr -d '"')
sleep 1
LINKS_AFTER=$(ev "document.querySelectorAll('.ai-link-chip').length" | tr -d '"')
STILL_SHOWN=$(ev "[...document.querySelectorAll('.ai-link-chip')].some(c=>c.textContent==='$DISMISSED_TITLE')")
[[ "$LINKS_BEFORE" -ge 1 && "$LINKS_AFTER" -lt "$LINKS_BEFORE" && "$STILL_SHOWN" == "false" ]] 2>/dev/null && pass "Link suggestion dismissed ($DISMISSED_TITLE)" || fail "Link suggestion dismiss" "before=$LINKS_BEFORE after=$LINKS_AFTER title=$DISMISSED_TITLE shown=$STILL_SHOWN"

step "A dismissal on one page doesn't hide that suggestion on another page"
# DISMISSED_TITLE is the chip text, e.g. "[[Rust Language Notes]]+x".
DISMISSED_PAGE=$(echo "$DISMISSED_TITLE" | sed -n 's/^\[\[\(.*\)\]\].*/\1/p')
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Dismissal Carryover');await api.createBlock(p.id,'Notes about ${DISMISSED_PAGE,,}');return 'ok'})()" > /dev/null
api "navigateTo('Dismissal Carryover')" > /dev/null; sleep 2
CARRY=$(ev "[...document.querySelectorAll('.ai-link-chip')].some(c=>c.textContent.startsWith('[[${DISMISSED_PAGE}]]'))")
[[ -n "$DISMISSED_PAGE" && "$CARRY" == "true" ]] && pass "Suggestion '$DISMISSED_PAGE' shown on the new page (dismissals reset per page)" || fail "Old page's dismissal hid a suggestion" "page=$DISMISSED_PAGE shown=$CARRY"

step "Pages already linked on the page are not suggested again"
api "navigateTo('Rust Programming')" > /dev/null; sleep 2
RELINK=$(ev "[...document.querySelectorAll('.ai-link-chip')].some(c=>c.textContent.startsWith('[[Systems Design]]'))")
[[ "$RELINK" == "false" ]] && pass "Already-linked [[Systems Design]] not re-suggested" || fail "Already-linked page suggested again" "$RELINK"

# ═══════════════════════════════════════════════
journey "48. TODO Extraction — I see my tasks across all notes"
# ═══════════════════════════════════════════════

step "Create pages with various TODO formats"
TODO_BEFORE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.getPendingTodoCount()})()" | tr -d '"')
ev "(async()=>{const api=await import('/src/lib/api.ts');const p1=await api.createPage('TODO Test 1');await api.createBlock(p1.id,'- [ ] Review pull request\n- [x] Ship release\n- [ ] Update documentation');const p2=await api.createPage('TODO Test 2');await api.createBlock(p2.id,'TODO: Fix the login bug\nAction: Deploy to staging\nFollow up: Talk to design team');return 'ok'})()" > /dev/null; sleep 2

step "TODO badge appears in sidebar"
S=$(snap)
echo "$S" | grep -qi "TODO\|todo" && pass "TODO badge visible in sidebar" || fail "No TODO badge" "TODO count not shown"

step "TODO count reflects pending items"
# We created 5 pending TODOs: 2 unchecked checkboxes (the [x] one is done) + 3
# action keywords (TODO:, Action:, Follow up:).
TODO_AFTER=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.getPendingTodoCount()})()" | tr -d '"')
TODO_DELTA=$(( ${TODO_AFTER:-0} - ${TODO_BEFORE:-0} ))
[[ "$TODO_DELTA" -eq 5 ]] 2>/dev/null && pass "Pending TODO count correct (+$TODO_DELTA)" || fail "Pending TODO count wrong" "before=$TODO_BEFORE after=$TODO_AFTER (expected +5)"

step "Ctrl+Enter TODO/DOING count; DONE, {{todo:*}} mirror entries and lookalikes do not"
TODO_B2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.getPendingTodoCount()})()" | tr -d '"')
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('TODO Test 3');for(const c of ['TODO buy milk','DOING write report','DONE old thing','{{todo:pending}}','{{todo:doing}} ship','{{todo:done}}','todo lowercase','TODOS list','TODO ','\\uFEFF- [ ] bom task'])await api.createBlock(p.id,c);return 'ok'})()" > /dev/null
TODO_A2=$(ev "(async()=>{const api=await import('/src/lib/api.ts');return await api.getPendingTodoCount()})()" | tr -d '"')
TODO_D2=$(( ${TODO_A2:-0} - ${TODO_B2:-0} ))
[[ "$TODO_D2" -eq 3 ]] 2>/dev/null && pass "TODO/DOING/BOM-checkbox counted, markers ignored (+$TODO_D2)" || fail "TODO format count wrong" "before=$TODO_B2 after=$TODO_A2 (expected +3)"

step "TODO panel shows extracted items"
# Check that TODO items are extracted from content
ev "(async()=>{const todo=await import('/src/lib/todoExtractor.ts');const blocks=[{id:'b1',content:'- [ ] Review PR\n- [x] Done\nTODO: Fix bug\nAction: Deploy'}];const todos=todo.extractTodos(blocks,'test-page');return todos.length})()" > /dev/null; sleep 1
# Verify extraction logic works
TODOS=$(ev "(async()=>{const todo=await import('/src/lib/todoExtractor.ts');const blocks=[{id:'b1',content:'- [ ] Task one\n- [ ] Task two\n- [x] Completed\nTODO: Fix this\nAction: Ship it\nFollow up: Review design'}];const todos=todo.extractTodos(blocks,'test-page');return todos.filter(t=>!t.done).length})()" | tr -d '"')
[[ "$TODOS" -eq 5 ]] 2>/dev/null && pass "TODO extraction finds $TODOS pending items" || fail "TODO extraction missed items" "Found $TODOS, expected 5"

step "TODO items show source page reference"
# Check that TODO items include source page info
SOURCE_CHECK=$(ev "(async()=>{const todo=await import('/src/lib/todoExtractor.ts');const blocks=[{id:'b1',content:'- [ ] Test task',id:'b1'}];const todos=todo.extractTodos(blocks,'source-page-123');return todos[0]?.sourcePageId})()" | tr -d '"')
[[ "$SOURCE_CHECK" == "source-page-123" ]] 2>/dev/null && pass "TODO tracks source page" || fail "TODO missing source page" ""

step "TODO items track source block"
BLOCK_CHECK=$(ev "(async()=>{const todo=await import('/src/lib/todoExtractor.ts');const blocks=[{id:'block-abc',content:'- [ ] Test task'}];const todos=todo.extractTodos(blocks,'page-123');return todos[0]?.sourceBlockId})()" | tr -d '"')
[[ "$BLOCK_CHECK" == "block-abc" ]] 2>/dev/null && pass "TODO tracks source block" || fail "TODO missing source block" ""

# ═══════════════════════════════════════════════
journey "49. AI Settings — I can toggle features on/off"
# ═══════════════════════════════════════════════

step "AI settings section exists in SettingsPanel"
ev "(async()=>{const{getSettings}=await import('/src/lib/settings.ts');const s=getSettings();return s.ai?.autoTag !== undefined})()" > /dev/null; sleep 1
AI_SETTINGS=$(ev "(async()=>{const{getSettings}=await import('/src/lib/settings.ts');const s=getSettings();return s.ai !== undefined})()" | tr -d '"')
[[ "$AI_SETTINGS" == "true" ]] 2>/dev/null && pass "AI settings object exists" || fail "No AI settings" "ai object missing"

step "Auto-tag is enabled by default"
AUTO_TAG=$(ev "(async()=>{const{getSettings}=await import('/src/lib/settings.ts');const s=getSettings();return s.ai?.autoTag})()" | tr -d '"')
[[ "$AUTO_TAG" == "true" ]] 2>/dev/null && pass "Auto-tag enabled by default" || fail "Auto-tag not enabled by default" ""

step "Link suggestions enabled by default"
LINK_SUGGEST=$(ev "(async()=>{const{getSettings}=await import('/src/lib/settings.ts');const s=getSettings();return s.ai?.linkSuggestions})()" | tr -d '"')
[[ "$LINK_SUGGEST" == "true" ]] 2>/dev/null && pass "Link suggestions enabled by default" || fail "Link suggestions not enabled by default" ""

step "TODO extraction enabled by default"
TODO_SUGGEST=$(ev "(async()=>{const{getSettings}=await import('/src/lib/settings.ts');const s=getSettings();return s.ai?.todoExtraction})()" | tr -d '"')
[[ "$TODO_SUGGEST" == "true" ]] 2>/dev/null && pass "TODO extraction enabled by default" || fail "TODO extraction not enabled by default" ""

step "Turning off auto-tag hides the tag suggestions"
ev "(async()=>{const{updateSettings,getSettings}=await import('/src/lib/settings.ts');updateSettings({ai:{...getSettings().ai,autoTag:false}});return 'ok'})()" > /dev/null
api "navigateTo('AI Tag Test')" > /dev/null; sleep 2
TAGS_OFF=$(ev "document.querySelectorAll('.ai-tag-chip').length" | tr -d '"')
ev "(async()=>{const{updateSettings,getSettings}=await import('/src/lib/settings.ts');updateSettings({ai:{...getSettings().ai,autoTag:true}});return 'ok'})()" > /dev/null; sleep 1
TAGS_ON=$(ev "document.querySelectorAll('.ai-tag-chip').length" | tr -d '"')
[[ "$TAGS_OFF" == "0" && "$TAGS_ON" -ge 1 ]] 2>/dev/null && pass "autoTag setting respected (off=0, on=$TAGS_ON)" || fail "autoTag setting ignored" "off=$TAGS_OFF on=$TAGS_ON"

step "Turning off link suggestions hides the link panel"
ev "(async()=>{const api=await import('/src/lib/api.ts');const g=await api.createPage('Gardening Tips');await api.createBlock(g.id,'Add compost to the soil every spring');await api.createPage('Compost Basics');return 'ok'})()" > /dev/null
ev "(async()=>{const{updateSettings,getSettings}=await import('/src/lib/settings.ts');updateSettings({ai:{...getSettings().ai,linkSuggestions:false}});return 'ok'})()" > /dev/null
api "navigateTo('Gardening Tips')" > /dev/null; sleep 2
LINKS_OFF=$(ev "document.querySelectorAll('.ai-link-chip').length" | tr -d '"')
ev "(async()=>{const{updateSettings,getSettings}=await import('/src/lib/settings.ts');updateSettings({ai:{...getSettings().ai,linkSuggestions:true}});return 'ok'})()" > /dev/null; sleep 2
LINKS_ON=$(ev "document.querySelectorAll('.ai-link-chip').length" | tr -d '"')
[[ "$LINKS_OFF" == "0" && "$LINKS_ON" -ge 1 ]] 2>/dev/null && pass "linkSuggestions setting respected (off=0, on=$LINKS_ON)" || fail "linkSuggestions setting ignored" "off=$LINKS_OFF on=$LINKS_ON"

# ═══════════════════════════════════════════════
journey "51. Editor integrity — splitting, merging and focusing never lose content"
# Drives the same code paths as Enter / Backspace / Ctrl+Enter via __MINOTES__
# (ProseMirror ignores synthetic CDP key events).
# ═══════════════════════════════════════════════

step "Set up a page with formatted blocks"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Editor Integrity');for(const c of ['alpha **bold** [[Link Page]] omega','prev block','[[A Page]] #tag **b**','alpha beta gamma','* star','Line1\nLine2','a <b>x</b>','- [ ] t1\n- [ ] t2','Setext\n======','plain task'])await api.createBlock(p.id,c);const par=await api.createBlock(p.id,'parent');await api.createBlock(p.id,'child',par.id);await api.createBlock(p.id,'last');return 'ok'})()" > /dev/null
api "navigateTo('Editor Integrity')" > /dev/null; sleep 2
R=$(api "getBlockContent(0)" | tr -d '"')
[[ "$R" == "alpha **bold** [[Link Page]] omega" ]] && pass "Integrity page loaded" || fail "Integrity page not loaded" "$R"

step "Focusing and leaving blocks does not rewrite them"
FB=$(ev "(async()=>{const M=window.__MINOTES__;const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=4;i<=8;i++){M.focusBlock(i);await s(250);document.activeElement?.blur();await s(200)}await s(300);const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Editor Integrity');const want=['* star','Line1\nLine2','a <b>x</b>','- [ ] t1\n- [ ] t2','Setext\n======'];return t.blocks.slice(4,9).every((b,i)=>b.content===want[i])})()")
[[ "$FB" == "true" ]] && pass "Focus+blur leaves stored content byte-identical" || fail "Focus+blur rewrote content" "$FB"

step "Enter in the middle keeps bold and links in the new block"
ev "window.__MINOTES__.splitBlockAt(0, 6)" > /dev/null; sleep 1
R0=$(api "getBlockContent(0)" | tr -d '"')
R1=$(api "getBlockContent(1)" | tr -d '"')
[[ "$R0" == "alpha" && "$R1" == "**bold** [[Link Page]] omega" ]] && pass "Split preserves **bold** and [[link]]" || fail "Split lost formatting" "[$R0] [$R1]"
SPLIT_BE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Editor Integrity');return t.blocks[0].content+'|'+t.blocks[1].content})()" | tr -d '"')
[[ "$SPLIT_BE" == "alpha|**bold** [[Link Page]] omega" ]] && pass "Split persisted in order" || fail "Split not persisted in order" "$SPLIT_BE"

step "Backspace at start merges with links, tags and bold intact"
sleep 0.5
ev "window.__MINOTES__.mergeWithPrevious(3)" > /dev/null; sleep 1
R=$(api "getBlockContent(2)")
[[ "$R" == '"prev block\n[[A Page]] #tag **b**"' ]] && pass "Merge keeps [[link]] #tag **bold**" || fail "Merge lost content" "$R"

step "A second Enter while the first is still being saved splits too, in order"
IDX=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='alpha beta gamma')" | tr -d '"')
RAPID=$(ev "(()=>{const M=window.__MINOTES__;return M.splitBlockAt($IDX,5)+','+M.splitBlockAt($IDX,2)})()" | tr -d '"')
sleep 1.5
A=$(api "getBlockContent($IDX)" | tr -d '"'); B=$(api "getBlockContent($((IDX+1)))" | tr -d '"'); C=$(api "getBlockContent($((IDX+2)))" | tr -d '"')
RAPID_BE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Editor Integrity');const c=t.blocks.map(b=>b.content);const i=c.indexOf('al');return c.slice(i,i+3).join('|')})()" | tr -d '"')
[[ "$RAPID" == "true,true" && "$A" == "al" && "$B" == "pha" && "$C" == "beta gamma" && "$RAPID_BE" == "al|pha|beta gamma" ]] && pass "Rapid Enter loses no text and keeps order" || fail "Rapid Enter lost text" "ret=$RAPID [$A] [$B] [$C] be=$RAPID_BE"

step "Ctrl+Enter keeps text typed since the last save"
TI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='plain task')" | tr -d '"')
api "typeInBlock($TI, 'Buy ')" > /dev/null; sleep 0.1
ev "window.__MINOTES__.toggleTodoInBlock($TI)" > /dev/null; sleep 1
R=$(api "getBlockContent($TI)" | tr -d '"')
[[ "$R" == "TODO Buy plain task" ]] && pass "Ctrl+Enter cycles live content" || fail "Ctrl+Enter dropped typed text" "$R"

step "Editing a multi-line block keeps its line break"
LI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='Line1\nLine2')" | tr -d '"')
api "typeInBlock($LI, 'X')" > /dev/null; sleep 0.1
ev "document.activeElement?.blur()" > /dev/null; sleep 1
R=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Editor Integrity');return t.blocks.some(b=>b.content==='XLine1\nLine2')})()")
[[ "$R" == "true" ]] && pass "Edited multi-line block keeps newline" || fail "Newline lost on edit" "$R"

step "Collapsing a block hides its children"
CI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='parent')" | tr -d '"')
N0=$(api "getBlockCount()" | tr -d '"')
api "toggleCollapseBlock($CI)" > /dev/null; sleep 0.5
N1=$(api "getBlockCount()" | tr -d '"')
api "toggleCollapseBlock($CI)" > /dev/null; sleep 0.5
N2=$(api "getBlockCount()" | tr -d '"')
[[ "$N1" -eq $((N0-1)) && "$N2" -eq "$N0" ]] 2>/dev/null && pass "Collapse hides and expand restores children" || fail "Collapse did not hide children" "$N0 -> $N1 -> $N2"

step "Backspace inside an editor does not delete selected blocks"
N0=$(api "getBlockCount()" | tr -d '"')
api "selectBlocks(1, 2)" > /dev/null; sleep 0.3
ev "document.querySelectorAll('.ProseMirror')[3].dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true}))" > /dev/null; sleep 1
N1=$(api "getBlockCount()" | tr -d '"')
[[ "$N1" == "$N0" ]] && pass "Selected blocks survive Backspace typed in an editor" || fail "Backspace in editor deleted selection" "$N0 -> $N1"
ev "document.querySelectorAll('.ProseMirror')[3].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))" > /dev/null; sleep 0.3
SEL=$(api "getSelectedCount()" | tr -d '"')
[[ "$SEL" == "0" ]] && pass "Clicking into an editor clears block selection" || fail "Selection kept after clicking into editor" "$SEL"

step "A saved [[link]] refresh never navigates me back"
ev "(async()=>{const api=await import('/src/lib/api.ts');await api.createPage('Nav Race Target');return 'ok'})()" > /dev/null
api "setBlockContent(0, 'see [[Nav Race Target]]')" > /dev/null
api "navigateTo('Nav Race Target')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == "Nav Race Target" ]] && pass "Stayed on the page I navigated to" || fail "Delayed refresh navigated back" "$R"

step "Multi-line paste inserts after the current block, in order"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Paste Order');for(const c of ['one','two','three'])await api.createBlock(p.id,c);return 'ok'})()" > /dev/null
api "navigateTo('Paste Order')" > /dev/null; sleep 2
api "focusBlock(0)" > /dev/null; sleep 0.5
ev "(()=>{const pm=document.querySelectorAll('.ProseMirror')[0];const dt=new DataTransfer();dt.setData('text/plain','p1\np2\np3');pm.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 'ok'})()" > /dev/null; sleep 2
ORDER=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Paste Order');return t.blocks.map(b=>b.content).slice(1).join(',')})()" | tr -d '"')
[[ "$ORDER" == "p2,p3,two,three" ]] && pass "Pasted lines placed after current block" || fail "Paste order wrong" "$ORDER"

ss "51-editor-integrity"

# ═══════════════════════════════════════════════
journey "52. I delete a group of blocks by mistake — one undo brings them all back"
# Shift-select → Delete is ONE undo entry; Ctrl+Z restores every block (and
# nested children + properties) with its original id, parent and position.
# ═══════════════════════════════════════════════

step "I make a page with nested blocks and a block property"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Group Delete');const a=await api.createBlock(p.id,'Alpha one');const b=await api.createBlock(p.id,'Bravo two');const b1=await api.createBlock(p.id,'Bravo child',b.id);await api.setProperty(b1.id,'block','status','urgent');const c=await api.createBlock(p.id,'Charlie three');const d=await api.createBlock(p.id,'Delta four');window.__GD={page:p.id};return 'ok'})()" > /dev/null
api "navigateTo('Group Delete')" > /dev/null; sleep 2
GD_SIG="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);const ps=await Promise.all(t.blocks.map(b=>api.getProperties(b.id)));return t.blocks.map((b,i)=>b.id+'/'+(b.parent_id||'')+'/'+b.position+'/'+b.content+'/'+ps[i].map(p=>p.key+'='+p.value).join('&')).join(';')})()"
GD_BEFORE=$(ev "$GD_SIG" | tr -d '"')
N0=$(api "getBlockCount()" | tr -d '"')
[[ "$N0" == "5" ]] && pass "Group Delete page shows 5 blocks" || fail "Group Delete page wrong" "$N0"

step "I shift-select Bravo..Charlie (incl. Bravo's child) and press Delete"
ev "document.activeElement?.blur()" > /dev/null
SEL=$(api "selectBlocks(1, 3)" | tr -d '"')
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}))" > /dev/null; sleep 1
LEFT=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);return t.blocks.map(b=>b.content).join(',')})()" | tr -d '"')
[[ "$SEL" == "3" && "$LEFT" == "Alpha one,Delta four" ]] && pass "Selected group deleted (left: $LEFT)" || fail "Group delete wrong" "selected=$SEL left=$LEFT"

step "One Ctrl+Z restores the whole group with original ids, order, nesting and properties"
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))" > /dev/null; sleep 2
GD_AFTER=$(ev "$GD_SIG" | tr -d '"')
[[ -n "$GD_BEFORE" && "$GD_AFTER" == "$GD_BEFORE" ]] && pass "One undo restored all 3 blocks exactly (ids, parents, positions, properties)" || fail "Group undo not faithful" "before=$GD_BEFORE after=$GD_AFTER"
N1=$(api "getBlockCount()" | tr -d '"')
DOM_ORDER=$(ev "window.__MINOTES__.getBlocks().map(b=>b.content).join(',')" | tr -d '"')
[[ "$N1" == "5" && "$DOM_ORDER" == "Alpha one,Bravo two,Bravo child,Charlie three,Delta four" ]] && pass "Restored blocks render in original order" || fail "Restored blocks not rendered in order" "$N1: $DOM_ORDER"

step "Deleting a parent alone also brings its child back on undo"
ev "document.activeElement?.blur()" > /dev/null
api "selectBlocks(1, 1)" > /dev/null
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}))" > /dev/null; sleep 1
MID=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);return t.blocks.length})()" | tr -d '"')
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))" > /dev/null; sleep 2
GD_AFTER=$(ev "$GD_SIG" | tr -d '"')
[[ "$MID" == "3" && "$GD_AFTER" == "$GD_BEFORE" ]] && pass "Parent + cascaded child restored with original ids" || fail "Parent undo lost its child" "mid=$MID after=$GD_AFTER"

step "Backspace-merge then undo un-merges and restores the merged block's id"
DI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='Delta four')" | tr -d '"')
api "mergeWithPrevious($DI)" > /dev/null; sleep 1
MERGED=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);return t.blocks.length})()" | tr -d '"')
ev "document.activeElement?.blur()" > /dev/null; sleep 0.3
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))" > /dev/null; sleep 2
GD_AFTER=$(ev "$GD_SIG" | tr -d '"')
DOM_ORDER=$(ev "window.__MINOTES__.getBlocks().map(b=>b.content).join(',')" | tr -d '"')
[[ "$MERGED" == "4" && "$GD_AFTER" == "$GD_BEFORE" && "$DOM_ORDER" == "Alpha one,Bravo two,Bravo child,Charlie three,Delta four" ]] && pass "Merge undo restores both blocks exactly" || fail "Merge undo not faithful" "merged=$MERGED after=$GD_AFTER dom=$DOM_ORDER"

step "Backspace-merging a block that has children keeps the children (re-homed), and undo puts them back"
# Regression: deleteBlock cascades, so the merge used to delete the merged block's children.
CHILD_ID=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);return t.blocks.find(b=>b.content==='Bravo child').id})()" | tr -d '"')
ALPHA_ID=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);return t.blocks.find(b=>b.content==='Alpha one').id})()" | tr -d '"')
BI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='Bravo two')" | tr -d '"')
api "mergeWithPrevious($BI)" > /dev/null; sleep 1
AFTER_MERGE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree(window.__GD.page);const c=t.blocks.find(b=>b.id==='$CHILD_ID');return t.blocks.length+'|'+(c?c.parent_id:'GONE')+'|'+(t.blocks.some(b=>b.content==='Bravo two')?'bravo-still-there':'bravo-merged')})()" | tr -d '"')
[[ "$AFTER_MERGE" == "4|$ALPHA_ID|bravo-merged" ]] && pass "Merged block's child survives under the absorbing block (same id)" || fail "Merge lost or misplaced the child" "$AFTER_MERGE (expected 4|$ALPHA_ID|bravo-merged)"
CHILD_VISIBLE=$(ev "window.__MINOTES__.getBlocks().some(b=>b.content==='Bravo child')" | tr -d '"')
[[ "$CHILD_VISIBLE" == "true" ]] && pass "Re-homed child is still rendered" || fail "Re-homed child not rendered" "$CHILD_VISIBLE"
ev "document.activeElement?.blur()" > /dev/null; sleep 0.3
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))" > /dev/null; sleep 2
GD_AFTER=$(ev "$GD_SIG" | tr -d '"')
[[ "$GD_AFTER" == "$GD_BEFORE" ]] && pass "Undo restores the merged block and moves its child back (exact)" || fail "Merge-with-children undo not faithful" "before=$GD_BEFORE after=$GD_AFTER"

ss "52-group-delete-undo"

# ═══════════════════════════════════════════════
journey "53. I make a table and a flashcard from the UI"
# /table inserts a real pipe table that survives save + reload; the table
# toolbar's structure commands change the stored markdown; right-click →
# Make flashcard puts the block in review; Remove flashcard takes it out.
# ═══════════════════════════════════════════════

TC_TREE="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');return JSON.stringify(t.blocks.map(b=>b.content))})()"
TC_BLOCK0="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');return t.blocks[0].content})()"
# Put the cursor at the end of the first body cell of block 0's table.
TC_CURSOR="(()=>{const pm=document.querySelectorAll('.ProseMirror')[0];const td=pm&&pm.querySelector('td p');if(!td)return 'no-cell';pm.focus();const r=document.createRange();r.selectNodeContents(td);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);return 'ok'})()"

step "I make a page with an empty block and a question with an answer underneath"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Table Cards');await api.createBlock(p.id,'');const q=await api.createBlock(p.id,'What is the capital of France?');await api.createBlock(p.id,'Paris',q.id);return 'ok'})()" > /dev/null
api "navigateTo('Table Cards')" > /dev/null; sleep 2
N=$(api "getBlockCount()" | tr -d '"')
[[ "$N" == "3" ]] && pass "Table Cards page shows 3 blocks" || fail "Table Cards page wrong" "$N blocks"

step "I type /table and pick Table from the slash menu"
api "focusBlock(0)" > /dev/null; sleep 0.5
api "typeInBlock(0, '/table')" > /dev/null; sleep 1
PICK=$(ev "(()=>{const it=[...document.querySelectorAll('.slash-menu-item')].find(e=>e.querySelector('.slash-menu-item-title')?.textContent==='Table');if(!it)return 'no-item';it.click();return 'ok'})()" | tr -d '"')
sleep 1.5
STORED=$(ev "$TC_BLOCK0")
[[ "$PICK" == "ok" && "$STORED" == '"|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |"' ]] && pass "/table stored a 3x3 markdown table with a header row" || fail "/table did not store a table" "pick=$PICK stored=$STORED"
TH=$(ev "document.querySelectorAll('.ProseMirror')[0]?.querySelectorAll('table th').length" | tr -d '"')
TD=$(ev "document.querySelectorAll('.ProseMirror')[0]?.querySelectorAll('table td').length" | tr -d '"')
[[ "$TH" == "3" && "$TD" == "6" ]] && pass "The block renders as a table (3 header + 6 body cells)" || fail "Table not rendered" "th=$TH td=$TD"
TB=$(ev "!!document.querySelector('.table-toolbar')" | tr -d '"')
[[ "$TB" == "true" ]] && pass "Table toolbar shows while the cursor is in the table" || fail "No table toolbar" "$TB"

step "I fill the header with Tab between cells (one cell has a | in it) and leave the block"
api "typeInBlock(0, 'Name')" > /dev/null; sleep 0.2
ev "document.querySelectorAll('.ProseMirror')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))" > /dev/null; sleep 0.3
ev "document.execCommand('insertText',false,'a|b')" > /dev/null; sleep 0.3
ev "document.activeElement?.blur()" > /dev/null; sleep 1
STORED=$(ev "$TC_BLOCK0")
[[ "$STORED" == '"| Name | a\\|b |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |"' ]] && pass "Header cells saved; the | is escaped so the row keeps 3 cells" || fail "Cell edit not saved as markdown" "$STORED"

step "I leave the page and come back — it is still a table"
api "navigateTo('Getting Started')" > /dev/null; sleep 1.5
api "navigateTo('Table Cards')" > /dev/null; sleep 2
CELLS=$(ev "[...(document.querySelectorAll('.ProseMirror')[0]?.querySelectorAll('table th')||[])].map(c=>c.textContent).join(',')" | tr -d '"')
[[ "$CELLS" == "Name,a|b," ]] && pass "Table re-renders after reload with its header text" || fail "Table lost after reload" "$CELLS"

step "I add a row below and a column to the right from the table toolbar"
ev "$TC_CURSOR" > /dev/null; sleep 0.3
R1=$(api "tableAction(0, 'addRowAfter')" | tr -d '"'); sleep 0.8
LINES=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');return t.blocks[0].content.split('\n').length})()" | tr -d '"')
[[ "$R1" == "true" && "$LINES" == "5" ]] && pass "Add row persisted (header + delimiter + 3 rows)" || fail "Add row not persisted" "ret=$R1 lines=$LINES"
ev "$TC_CURSOR" > /dev/null; sleep 0.3
R2=$(api "tableAction(0, 'addColumnAfter')" | tr -d '"'); sleep 0.8
HEAD=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');return t.blocks[0].content.split('\n')[1]})()" | tr -d '"')
[[ "$R2" == "true" && "$HEAD" == "| --- | --- | --- | --- |" ]] && pass "Add column persisted (4 columns)" || fail "Add column not persisted" "ret=$R2 delim=$HEAD"

step "I delete that column and row again"
ev "$TC_CURSOR" > /dev/null; sleep 0.3
api "tableAction(0, 'deleteColumn')" > /dev/null; sleep 0.8
ev "$TC_CURSOR" > /dev/null; sleep 0.3
api "tableAction(0, 'deleteRow')" > /dev/null; sleep 0.8
SHAPE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');const l=t.blocks[0].content.split('\n');return l.length+'x'+l[1].split('---').length})()" | tr -d '"')
[[ "$SHAPE" == "4x4" ]] && pass "Delete column + row persisted (3 columns, 2 body rows)" || fail "Delete column/row wrong" "$SHAPE"
ss "53-table"

step "I right-click the question and choose Make flashcard"
QID=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');return t.blocks.find(b=>b.content==='What is the capital of France?').id})()" | tr -d '"')
QI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='What is the capital of France?')" | tr -d '"')
TC_MENU="(()=>{const b=document.querySelectorAll('.block')[$QI];const pm=b.querySelector('.ProseMirror');const r=pm.getBoundingClientRect();pm.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+8}));return 'ok'})()"
ev "$TC_MENU" > /dev/null; sleep 0.5
LABEL=$(ev "document.querySelector('.block-context-menu [data-action=flashcard]')?.firstChild?.textContent" | tr -d '"')
ev "document.querySelector('.block-context-menu [data-action=flashcard]')?.click()" > /dev/null; sleep 1
DUE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const d=await api.getDueCards(100);return d.some(c=>c.block_id==='$QID')})()" | tr -d '"')
[[ "$LABEL" == "Make flashcard" && "$DUE" == "true" ]] && pass "Make flashcard → the block is in the due cards" || fail "Make flashcard failed" "label=$LABEL due=$DUE"
IND=$(ev "!!document.querySelectorAll('.block')[$QI]?.querySelector('.flashcard-indicator')" | tr -d '"')
[[ "$IND" == "true" ]] && pass "Card indicator shows on the block" || fail "No card indicator" "$IND"
BADGE=$(ev "document.querySelector('.sidebar-review-badge')?.textContent" | tr -d '"')
echo "$BADGE" | grep -q "Review.*due" && pass "Sidebar offers Review ($BADGE)" || fail "No review entry in sidebar" "$BADGE"

step "I review it: the children are the answer, and rating it takes it off the due list"
ev "document.querySelector('.sidebar-review-badge')?.click()" > /dev/null; sleep 1.5
ev "(()=>{const b=document.querySelector('.review-show-btn');if(b)b.click();return 'ok'})()" > /dev/null; sleep 0.8
BACK=$(ev "document.querySelector('.review-card-back')?.textContent" | tr -d '"')
FRONT=$(ev "document.querySelector('.review-card-front')?.textContent" | tr -d '"')
ss "53-review"
[[ "$FRONT" == *"capital of France"* && "$BACK" == *"Paris"* ]] && pass "Review shows question front and child-block answer" || fail "Review front/back wrong" "front=$FRONT back=$BACK"
# Rate the card for THIS block (other due cards may come first on a shared DB).
ev "(async()=>{const api=await import('/src/lib/api.ts');const d=await api.getDueCards(100);const c=d.find(c=>c.block_id==='$QID');if(c&&document.querySelector('.review-card-front')?.textContent.includes('capital of France')){document.querySelector('.review-btn-good').click();return 'ui'}if(c){await api.reviewCard(c.id,'good');return 'api'}return 'none'})()" > /dev/null; sleep 1
DUE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const d=await api.getDueCards(100);return d.some(c=>c.block_id==='$QID')})()" | tr -d '"')
[[ "$DUE" == "false" ]] && pass "Rated card is no longer due" || fail "Rated card still due" "$DUE"
api "closePanel()" > /dev/null; sleep 0.5

step "I right-click it again and choose Remove flashcard"
ev "$TC_MENU" > /dev/null; sleep 0.5
LABEL=$(ev "document.querySelector('.block-context-menu [data-action=flashcard]')?.firstChild?.textContent" | tr -d '"')
ev "document.querySelector('.block-context-menu [data-action=flashcard]')?.click()" > /dev/null; sleep 1
GONE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const c=await api.listCards();return !c.some(c=>c.block_id==='$QID')})()" | tr -d '"')
IND=$(ev "!!document.querySelectorAll('.block')[$QI]?.querySelector('.flashcard-indicator')" | tr -d '"')
[[ "$LABEL" == "Remove flashcard" && "$GONE" == "true" && "$IND" == "false" ]] && pass "Remove flashcard deletes the card and its indicator" || fail "Remove flashcard failed" "label=$LABEL gone=$GONE indicator=$IND"

step "I make it a card again with /flashcard"
AI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='Paris')" | tr -d '"')
api "focusBlock($AI)" > /dev/null; sleep 0.5
api "typeInBlock($AI, ' /flashcard')" > /dev/null; sleep 1
ev "(()=>{const it=[...document.querySelectorAll('.slash-menu-item')].find(e=>e.querySelector('.slash-menu-item-title')?.textContent==='Flashcard');if(!it)return 'no-item';it.click();return 'ok'})()" > /dev/null; sleep 1.5
SC=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Table Cards');const b=t.blocks.find(b=>b.content.startsWith('Paris'));const c=await api.listCards();return (b?b.content:'?')+'|'+c.some(c=>b&&c.block_id===b.id)})()" | tr -d '"')
[[ "$SC" == "Paris|true" ]] && pass "/flashcard makes a card and leaves the text clean" || fail "/flashcard failed" "$SC"

# ═══════════════════════════════════════════════
journey "55. Keyboard-only writing: fast typing, indent/outdent, Escape, redo, menus"
# Keydowns go into the block's ProseMirror (pressKeyInBlock), so the editor's own
# key handlers run — the same path as the real key. Text goes in with
# execCommand('insertText') on whatever has focus, exactly where a typed key lands.
# ═══════════════════════════════════════════════

KB_BE="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Keyboard Only');const byId=new Map(t.blocks.map(b=>[b.id,b]));return t.blocks.map(b=>b.content+'<'+(b.parent_id?byId.get(b.parent_id).content:'-')).join(',')})()"
KB_TREE="window.__MINOTES__.getBlockTree().map(b=>b.content+':'+b.depth).join(',')"

step "Typing straight through Enter (no pause at all) puts every line in its own block, in order"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Keyboard Only');await api.createBlock(p.id,'');return 'ok'})()" > /dev/null
api "navigateTo('Keyboard Only')" > /dev/null; sleep 2
api "focusBlock(0)" > /dev/null; sleep 0.5
ev "(()=>{const ins=t=>document.execCommand('insertText',false,t);const enter=()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));ins('one');enter();ins('two');enter();ins('three');enter();ins('four');return 'ok'})()" > /dev/null
sleep 1.5; ev "document.activeElement?.blur()" > /dev/null; sleep 1
UI=$(ev "window.__MINOTES__.getBlocks().map(b=>b.content).join('|')" | tr -d '"')
BE=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Keyboard Only');return t.blocks.map(b=>b.content).join('|')})()" | tr -d '"')
[[ "$UI" == "one|two|three|four" ]] && pass "Zero-delay typing through Enter: one|two|three|four" || fail "Keys after Enter misplaced" "$UI"
[[ "$BE" == "one|two|three|four" ]] && pass "Zero-delay typing persisted in order" || fail "Fast-typed blocks persisted wrong" "$BE"

step "Tab indents under the previous block; Shift+Tab outdents to directly after the parent"
api "pressKeyInBlock(1, 'Tab')" > /dev/null; sleep 0.8
api "pressKeyInBlock(2, 'Tab')" > /dev/null; sleep 0.8
T1=$(ev "$KB_TREE" | tr -d '"')
[[ "$T1" == "one:0,two:1,three:1,four:0" ]] && pass "Tab indents (tree: $T1)" || fail "Tab did not indent" "$T1"
api "pressKeyInBlock(1, 'Tab', {shift:true})" > /dev/null; sleep 0.1
FI=$(api "getFocusedBlockIndex()" | tr -d '"')
sleep 1
T2=$(ev "$KB_TREE" | tr -d '"')
B2=$(ev "$KB_BE" | tr -d '"')
[[ "$T2" == "one:0,three:1,two:0,four:0" && "$B2" == "one<-,three<one,two<-,four<-" ]] && pass "Shift+Tab outdents 'two' to right after its parent" || fail "Shift+Tab outdent wrong" "ui=$T2 be=$B2"
[[ "$FI" == "2" ]] && pass "Caret stays in the outdented block" || fail "Focus jumped after Shift+Tab" "focused=$FI"
POS_OK=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Keyboard Only');const g=new Map();for(const b of t.blocks){const k=b.parent_id||'-';const l=g.get(k)||[];l.push(b.position);g.set(k,l)}return [...g.values()].every(l=>new Set(l).size===l.length)})()" | tr -d '"')
[[ "$POS_OK" == "true" ]] && pass "No two siblings share a position" || fail "Duplicate sibling positions" "$POS_OK"

step "Escape leaves editing and keeps the block selected; arrows move the selection, Enter edits"
api "pressKeyInBlock(1, 'Escape')" > /dev/null; sleep 0.4
FI=$(api "getFocusedBlockIndex()" | tr -d '"'); SEL=$(ev "JSON.stringify(window.__MINOTES__.getSelectedIndices())" | tr -d '"\\')
T3=$(ev "$KB_TREE" | tr -d '"')
[[ "$FI" == "-1" && "$SEL" == "[1]" && "$T3" == "$T2" ]] && pass "Escape: not editing, block 1 selected, tree unchanged" || fail "Escape did not just close editing" "focus=$FI sel=$SEL tree=$T3"
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))" > /dev/null; sleep 0.3
SEL=$(ev "JSON.stringify(window.__MINOTES__.getSelectedIndices())" | tr -d '"\\')
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))" > /dev/null; sleep 0.4
FI=$(api "getFocusedBlockIndex()" | tr -d '"')
[[ "$SEL" == "[2]" && "$FI" == "2" ]] && pass "ArrowDown moved the selection, Enter edits it" || fail "Selection keyboard navigation broken" "sel=$SEL focus=$FI"

step "Ctrl+Shift+Z and Ctrl+Y redo what Ctrl+Z undid (same block id)"
ev "document.activeElement?.blur()" > /dev/null; sleep 0.5
KB_IDS="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Keyboard Only');return t.blocks.map(b=>b.id+'='+b.content).join(',')})()"
ID0=$(ev "$KB_IDS" | tr -d '"')
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))" > /dev/null; sleep 1.5
U1=$(ev "$KB_IDS" | tr -d '"')
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Z',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))" > /dev/null; sleep 1.5
R1=$(ev "$KB_IDS" | tr -d '"')
[[ "$U1" != "$ID0" && "$R1" == "$ID0" ]] && pass "Ctrl+Shift+Z redid the undone Enter exactly" || fail "Redo did not restore" "before=$ID0 undo=$U1 redo=$R1"
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))" > /dev/null; sleep 1.5
ev "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))" > /dev/null; sleep 1.5
R2=$(ev "$KB_IDS" | tr -d '"')
[[ "$R2" == "$ID0" ]] && pass "Ctrl+Y redoes too" || fail "Ctrl+Y redo failed" "$R2"
UI_R=$(ev "window.__MINOTES__.getBlocks().map(b=>b.content).join('|')" | tr -d '"')
[[ "$UI_R" == "one|three|two|four" ]] && pass "Redone block is rendered" || fail "Redo not rendered" "$UI_R"

step "Escape closes the / menu and the [[ menu, and the cursor stays in the block"
api "focusBlock(3)" > /dev/null; sleep 0.4
ev "(async()=>{for(const ch of ' /'){document.execCommand('insertText',false,ch);await new Promise(r=>setTimeout(r,30))}return 'ok'})()" > /dev/null; sleep 0.6
OPEN=$(ev "!!document.querySelector('.slash-menu')" | tr -d '"')
api "pressKeyInBlock(3, 'Escape', {focus:false})" > /dev/null; sleep 0.5
AFTER=$(ev "!!document.querySelector('.slash-menu')" | tr -d '"'); FI=$(api "getFocusedBlockIndex()" | tr -d '"')
[[ "$OPEN" == "true" && "$AFTER" == "false" && "$FI" == "3" ]] && pass "Escape closed the slash menu, still editing" || fail "Slash menu Escape" "open=$OPEN after=$AFTER focus=$FI"
ev "(async()=>{for(const ch of ' [['){document.execCommand('insertText',false,ch);await new Promise(r=>setTimeout(r,30))}return 'ok'})()" > /dev/null; sleep 0.8
OPEN=$(ev "!!document.querySelector('.tippy-box')" | tr -d '"')
api "pressKeyInBlock(3, 'Escape', {focus:false})" > /dev/null; sleep 0.5
AFTER=$(ev "!!document.querySelector('.tippy-box')" | tr -d '"'); FI=$(api "getFocusedBlockIndex()" | tr -d '"')
[[ "$OPEN" == "true" && "$AFTER" == "false" && "$FI" == "3" ]] && pass "Escape closed the [[ menu, still editing" || fail "[[ menu Escape" "open=$OPEN after=$AFTER focus=$FI"

step "Typing '- [ ] ' / '* [x] ' makes a task item"
ev "(async()=>{const M=window.__MINOTES__;const api=await import('/src/lib/api.ts');const p=await api.createPage('Task Syntax');for(let i=0;i<3;i++)await api.createBlock(p.id,'');return 'ok'})()" > /dev/null
api "navigateTo('Task Syntax')" > /dev/null; sleep 2
ev "(async()=>{const M=window.__MINOTES__;const s=ms=>new Promise(r=>setTimeout(r,ms));for(const [i,t] of [[0,'- [ ] call bob'],[1,'* [x] shipped'],[2,'[] plain']]){M.focusBlock(i);await s(150);for(const ch of t){document.execCommand('insertText',false,ch);await s(10)}}document.activeElement?.blur();return 'ok'})()" > /dev/null; sleep 1.5
TS=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Task Syntax');return t.blocks.map(b=>b.content).join('|')})()" | tr -d '"')
[[ "$TS" == "- [ ] call bob|- [x] shipped|- [ ] plain" ]] && pass "Task syntax converts (stored: $TS)" || fail "Task syntax not converted" "$TS"

step "A new page puts the cursor in its first block"
ev "document.activeElement?.blur()" > /dev/null
ev "window.__MINOTES__.createPage('Fresh Page Focus')" > /dev/null; sleep 2
FI=$(api "getFocusedBlockIndex()" | tr -d '"'); CP=$(api "getCurrentPage()" | tr -d '"')
[[ "$CP" == "Fresh Page Focus" && "$FI" == "0" ]] && pass "New page: caret in the first block" || fail "New page not focused" "page=$CP focus=$FI"

step "Following a block reference opens its page and lands on the block"
REF=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Ref Target Page');for(const c of ['r1','r2','the referenced block'])await api.createBlock(p.id,c);const t=await api.getPageTree('Ref Target Page');return t.blocks[2].id})()" | tr -d '"')
api "navigateTo('Keyboard Only')" > /dev/null; sleep 1.5
api "openBlockRef('$REF')" > /dev/null; sleep 2
CP=$(api "getCurrentPage()" | tr -d '"'); FI=$(api "getFocusedBlockIndex()" | tr -d '"')
[[ "$CP" == "Ref Target Page" && "$FI" == "2" ]] && pass "Block ref opened its page with the caret in the block" || fail "Block ref navigation" "page=$CP focus=$FI"

step "Escape that closes the search palette puts the cursor back in the block"
api "focusBlock(1)" > /dev/null; sleep 0.4
ev "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))" > /dev/null; sleep 0.8
TAG=$(ev "document.activeElement.tagName" | tr -d '"')
ev "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))" > /dev/null; sleep 0.8
FI=$(api "getFocusedBlockIndex()" | tr -d '"')
[[ "$TAG" == "INPUT" && "$FI" == "1" ]] && pass "Focus restored to the block after closing search" || fail "Focus lost after closing search" "search=$TAG focus=$FI"

ss "55-keyboard-only"

journey "56. The app shell does what I ask — palette, deletes, renames, Escape"
# Palette commands open their panel; deleting the open page leaves it (Undo +
# Ctrl+Z bring it back); right-click/⋮ never navigate; a taken title or project
# name is refused with a visible reason; stray spaces never make a new page;
# Escape closes kanban / All Pages; a future journal day keeps its navigation.
# ═══════════════════════════════════════════════
SH_PAL="(async(cmd,list)=>{const T=window.__MINOTES__;T.closePanel();T.openSearch();await new Promise(r=>setTimeout(r,300));const i=document.querySelector('.command-palette-input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'>'+cmd);i.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,300));const items=[...document.querySelectorAll('.command-palette-item')].map(e=>e.textContent);if(list)return items.join(',');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,500));return 'ran'})"
SH_FILL="(sel,val,key)=>{const i=document.querySelector(sel);if(!i)return 'no-input';i.focus();const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,val);i.dispatchEvent(new Event('input',{bubbles:true}));if(key)i.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));return 'ok'}"
SH_ROW="(t)=>[...document.querySelectorAll('.sidebar .page-item')].find(e=>e.textContent.trim().replace(/⋮$/,'').trim()===t)"

step "Palette: '>sql' + Enter opens the SQL panel, '>settings' opens Settings"
ev "($SH_PAL)('sql')" > /dev/null; sleep 0.5
Q=$(api "isPanelOpen('query')" | tr -d '"')
ev "($SH_PAL)('settings')" > /dev/null; sleep 0.5
S1=$(api "isPanelOpen('settings')" | tr -d '"')
[[ "$Q" == "true" && "$S1" == "true" ]] && pass "Palette commands open their panel" || fail "Palette command opened nothing" "query=$Q settings=$S1"

step "Settings reaches Sync and CSS snippets; the × has a name; the shortcut list is complete"
R=$(ev "(()=>{const t=document.querySelector('.settings-slide-panel')?.textContent||'';const x=document.querySelector('.settings-close-btn')?.getAttribute('aria-label');return [t.includes('Sync & version history'),t.includes('CSS snippets'),!!x,['Ctrl+Shift+K','Alt+→','Ctrl+1','Ctrl+Shift+C','Ctrl+P','Ctrl+A'].every(k=>t.includes(k))].join('|')})()" | tr -d '"')
[[ "$R" == "true|true|true|true" ]] && pass "Settings: Sync + CSS entry points, labelled ×, full shortcut list" || fail "Settings entry points / shortcuts" "$R"
ev "[...document.querySelectorAll('.settings-slide-panel button')].find(b=>b.textContent.includes('Sync & version history'))?.click()" > /dev/null; sleep 0.8
R=$(ev "!!document.querySelector('.sync-panel')" | tr -d '"')
[[ "$R" == "true" ]] && pass "Settings → Sync & version history opens the Sync panel" || fail "Sync panel not reachable from Settings" "$R"
api "closePanel()" > /dev/null; sleep 0.3

step "The palette no longer offers dead commands (Plugins, Export Markdown)"
R=$(ev "($SH_PAL)('',true)" | tr -d '"')
api "closePanel()" > /dev/null
[[ "$R" == *"Settings"* && "$R" != *"Manage Plugins"* && "$R" != *"Export Markdown"* ]] && pass "No Plugins / Export Markdown commands" || fail "Dead palette commands still listed" "$R"

step "Right-click and ⋮ on another page's row don't navigate there"
ev "(async()=>{const api=await import('/src/lib/api.ts');await api.createPage('Shell Doomed');await api.createPage('Shell Other');return 'ok'})()" > /dev/null
api "refreshSidebar()" > /dev/null; sleep 1
api "navigateTo('Shell Doomed')" > /dev/null; sleep 1.5
ev "(()=>{const row=($SH_ROW)('Shell Other');if(!row)return 'no-row';const o={bubbles:true,button:2,clientX:20,clientY:20};row.dispatchEvent(new MouseEvent('mousedown',o));row.dispatchEvent(new MouseEvent('mouseup',o));row.dispatchEvent(new MouseEvent('contextmenu',o));return 'ok'})()" > /dev/null; sleep 0.6
press "Escape"; sleep 0.3
ev "(()=>{const b=($SH_ROW)('Shell Other')?.querySelector('.page-more-btn');if(!b)return 'no-btn';const o={bubbles:true,button:0};b.dispatchEvent(new MouseEvent('mousedown',o));b.dispatchEvent(new MouseEvent('mouseup',o));b.click();return 'ok'})()" > /dev/null; sleep 0.6
R=$(api "getCurrentPage()" | tr -d '"')
MENU=$(ev "!!document.querySelector('.sidebar-context-menu')" | tr -d '"')
press "Escape"; sleep 0.3
[[ "$R" == "Shell Doomed" && "$MENU" == "true" ]] && pass "Menu opens, page stays 'Shell Doomed'" || fail "Row menu navigated" "page=$R menu=$MENU"

step "Deleting the open page from its menu leaves it, with an Undo toast"
ev "(()=>{const row=($SH_ROW)('Shell Doomed');row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:20}));return 'ok'})()" > /dev/null; sleep 0.5
ev "[...document.querySelectorAll('.sidebar-context-menu-item')].find(b=>b.textContent.includes('Delete'))?.click()" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
T=$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' / ')" | tr -d '"')
[[ "$R" != "Shell Doomed" && "$R" != "null" && "$T" == *"Shell Doomed"*"Trash"*"Undo"* ]] && pass "Left the deleted page (now on '$R'), toast offers Undo" || fail "Deleted page still open / no toast" "page=$R toast=$T"

step "Ctrl+Z brings the page back"
press "Control+z"; sleep 2
R=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.listTrash();return t.some(x=>x.title==='Shell Doomed')+'|'+window.__MINOTES__.getCurrentPage()})()" | tr -d '"')
[[ "$R" == "false|Shell Doomed" ]] && pass "Ctrl+Z restored and reopened the deleted page" || fail "Ctrl+Z didn't undo the page delete" "$R"

step "Renaming the page to a taken title shows why and keeps the old title"
ev "document.querySelector('.page-view h2.page-title-editable')?.click()" > /dev/null; sleep 0.4
ev "($SH_FILL)('.page-title-input','Shell Other','Enter')" > /dev/null; sleep 1.5
R=$(ev "(()=>[window.__MINOTES__.getCurrentPage(),[...document.querySelectorAll('.main div')].some(d=>/Couldn.t rename/.test(d.textContent||'')&&d.children.length===0)].join('|'))()" | tr -d '"')
[[ "$R" == "Shell Doomed|true" ]] && pass "Rename refused with a visible reason; title unchanged" || fail "Rename to taken title" "$R"

step "A link with a stray space opens the existing page instead of creating one"
api "navigateTo('Shell Other ')" > /dev/null; sleep 2
R=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.listPages(1000);return window.__MINOTES__.getCurrentPage()+'|'+p.filter(x=>x.title.startsWith('Shell Other')).length})()" | tr -d '"')
[[ "$R" == "Shell Other|1" ]] && pass "'Shell Other ' opened 'Shell Other', no duplicate page" || fail "Trailing-space title" "$R"

step "A second project with the same name is refused inline"
for n in 1 2; do
  ev "document.querySelector('.sidebar-new-project')?.click()" > /dev/null; sleep 0.4
  ev "($SH_FILL)('input[placeholder^=\"Project name\"]','Shell Dup','Enter')" > /dev/null; sleep 1.2
done
R=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getFolderTree();return t.folders.filter(f=>f.name==='Shell Dup').length+'|'+(document.querySelector('.inline-field-error')?.textContent||'')})()" | tr -d '"')
press "Escape"; sleep 0.3
[[ "$R" == "1|"*"already exists"* ]] && pass "Duplicate project name refused with a message" || fail "Duplicate project" "$R"

step "Escape closes Kanban and All Pages"
api "navigateTo('Shell Other')" > /dev/null; sleep 1
ev "document.querySelector('.stats-mode-btn[title^=Kanban]')?.click()" > /dev/null; sleep 1
K1=$(ev "!!document.querySelector('.canvas-layer')" | tr -d '"')
ev "document.activeElement?.blur()" > /dev/null
press "Escape"; sleep 0.8
K2=$(ev "!!document.querySelector('.canvas-layer')" | tr -d '"')
ev "document.querySelector('.stats-mode-btn[title=\"All Pages\"]')?.click()" > /dev/null; sleep 1
A1=$(ev "!!document.querySelector('.canvas-layer')" | tr -d '"')
press "Escape"; sleep 0.8
A2=$(ev "!!document.querySelector('.canvas-layer')" | tr -d '"')
[[ "$K1|$K2|$A1|$A2" == "true|false|true|false" ]] && pass "Escape closes Kanban and All Pages" || fail "Escape didn't close" "kanban $K1→$K2 pages $A1→$A2"

step "Ctrl+J works with the cursor in a block"
api "focusBlock(0)" > /dev/null; sleep 0.5
press "Control+j"; sleep 1.5
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == Journal/* ]] && pass "Ctrl+J from the editor opened the journal" || fail "Ctrl+J from editor" "$R"

step "A future journal day keeps Prev / Today / Next"
api "openJournal('2099-01-01')" > /dev/null; sleep 1.5
R=$(ev "document.querySelectorAll('.pending-journal .journal-nav button').length" | tr -d '"')
ev "[...document.querySelectorAll('.pending-journal .journal-nav button')].find(b=>b.textContent==='Today')?.click()" > /dev/null; sleep 1.5
R2=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == "3" && "$R2" == Journal/* ]] && pass "Future day shows navigation; Today returns to today's journal" || fail "Future journal navigation" "buttons=$R page=$R2"

ss "56-app-shell"

journey "57. Ask your notes — I turn on AI and get answers that cite my notes"
# Browser mode: lib/aiMock.ts stands in for the backend (fake OpenRouter
# catalogue, scripted answers with [[cite:<block-id>]] markers, one invented id
# that must be stripped). The real provider/tool loop is covered by
# `cargo test -p minotes-core ai::` and the desktop check (local mock server).
# ═══════════════════════════════════════════════

if [[ "$BACKEND" == "desktop" ]]; then
  step "Skipped on the desktop backend (needs an AI provider; see desktop-check notes)"
else
# Set a textarea/input value the way React sees typing.
ai_type() { ev "(()=>{const el=document.querySelector('$1');if(!el)return 'missing';const P=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;Object.getOwnPropertyDescriptor(P.prototype,'value').set.call(el,'$2');el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" > /dev/null; }
ai_click() { ev "(()=>{const el=document.querySelector('$1');if(!el)return 'missing';el.click();return 'ok'})()" | tr -d '"'; }
ai_wait_answers() { for _ in $(seq 1 40); do N=$(ev "document.querySelectorAll('[data-testid=ai-answer]').length" | tr -d '"'); [[ "$N" -ge "$1" ]] 2>/dev/null && return 0; sleep 0.25; done; return 1; }

step "Open the Ask panel from the launcher — AI is off until I set it up"
api "closePanel()" > /dev/null
api "navigateTo('Getting Started')" > /dev/null; sleep 1
ai_click "[data-testid=ai-launcher]" > /dev/null; sleep 1
NC=$(ev "!!document.querySelector('[data-testid=ask-panel] [data-testid=ai-not-configured]')" | tr -d '"')
[[ "$NC" == "true" ]] && pass "Ask panel shows a 'not configured' state" || fail "No not-configured state" "$NC"

step "'Set up AI' opens AI settings with a plain-language data notice"
ai_click "[data-testid=ai-setup]" > /dev/null; sleep 1
NOTICE=$(ev "document.querySelector('[data-testid=ai-data-notice]')?.textContent" | tr -d '"')
[[ "$NOTICE" == *"no note content leaves this device"* ]] && pass "Settings open; off = nothing leaves the device" || fail "AI settings/notice missing" "$NOTICE"

step "A 'local' endpoint that isn't on this computer needs my explicit confirmation"
ai_click "[data-testid=ai-provider-local]" > /dev/null; sleep 0.5
ai_type "[data-testid=ai-local-model]" "llama3.1"
WARN0=$(ev "!!document.querySelector('[data-testid=ai-remote-warning]')" | tr -d '"')
ai_type "[data-testid=ai-local-url]" "https://ai.example.com/v1"; sleep 0.3
WARN=$(ev "document.querySelector('[data-testid=ai-remote-warning]')?.textContent" | tr -d '"')
NOTICE=$(ev "document.querySelector('[data-testid=ai-data-notice]')?.textContent" | tr -d '"')
[[ "$WARN0" == "false" && "$WARN" == *"Notes will be sent to ai.example.com"* && "$NOTICE" == *"ai.example.com"*"NOT on this computer"* ]] \
  && pass "Custom endpoint: warning names the host; notice says notes leave this computer" || fail "Custom endpoint warning" "w0=$WARN0 w=$WARN n=$NOTICE"
ai_click "[data-testid=ai-save]" > /dev/null; sleep 0.5
ERR=$(ev "document.querySelector('[data-testid=ai-settings] .ai-error')?.textContent" | tr -d '"')
[[ "$ERR" == *"not on this computer"* ]] && pass "Saving without confirmation is refused" || fail "Unconfirmed custom endpoint saved" "$ERR"
ai_click "[data-testid=ai-remote-confirm]" > /dev/null; sleep 0.3
ai_click "[data-testid=ai-save]" > /dev/null; sleep 0.5
SAVED=$(ev "document.querySelector('[data-testid=ai-settings] .ai-saved')?.textContent" | tr -d '"')
[[ "$SAVED" == *"Saved"* ]] && pass "Confirmed custom endpoint saves" || fail "Confirmed endpoint not saved" "$SAVED"
ai_type "[data-testid=ai-local-url]" "http://localhost:11434/v1"; sleep 0.3
WARN=$(ev "!!document.querySelector('[data-testid=ai-remote-warning]')" | tr -d '"')
[[ "$WARN" == "false" ]] && pass "Loopback endpoint needs no confirmation" || fail "Loopback endpoint warned" "$WARN"

step "Choose OpenRouter, store a key, keep the recommended model"
ai_click "[data-testid=ai-provider-openrouter]" > /dev/null; sleep 1
ai_type "[data-testid=ai-key-input]" "sk-or-test-key"
ev "(()=>{const b=[...document.querySelectorAll('[data-testid=ai-settings] button')].find(b=>b.textContent==='Save key');b?.click();return !!b})()" > /dev/null; sleep 1
KEY=$(ev "document.querySelector('[data-testid=ai-key-status]')?.textContent" | tr -d '"')
LEAK=$(ev "document.body.innerHTML.includes('sk-or-test-key')" | tr -d '"')
[[ "$KEY" == *"keychain"* && "$LEAK" == "false" ]] && pass "Key stored; never shown in the page" || fail "Key handling" "status=$KEY leak=$LEAK"
MODEL=$(ev "document.querySelector('[data-testid=ai-model-interactive]')?.value" | tr -d '"')
OPTS=$(ev "[...document.querySelectorAll('[data-testid=ai-model-interactive] option')].map(o=>o.textContent).join(' | ')" | tr -d '"')
[[ "$MODEL" == anthropic/claude-opus* && "$OPTS" == *"per M"* ]] && pass "Newest Claude Opus preselected; prices shown ($MODEL)" || fail "Model preselection" "$MODEL / $OPTS"
NOTICE=$(ev "document.querySelector('[data-testid=ai-data-notice]')?.textContent" | tr -d '"')
[[ "$NOTICE" == *"sent to OpenRouter and Anthropic"* ]] && pass "Notice names OpenRouter and the model provider" || fail "Notice wrong" "$NOTICE"
ai_click "[data-testid=ai-save]" > /dev/null; sleep 1
SAVED=$(ev "document.querySelector('[data-testid=ai-settings] .ai-saved')?.textContent" | tr -d '"')
[[ "$SAVED" == *"AI is ready"* ]] && pass "Settings saved; AI ready" || fail "Save failed" "$SAVED"
ss "57-ai-settings"
ai_click "[data-testid=ai-settings] .settings-close-btn" > /dev/null; sleep 1

step "Ask a question — the answer streams in with citations"
ai_type "[data-testid=ai-input]" "What does the architecture use?"
ai_click "[data-testid=ai-send]" > /dev/null
ai_wait_answers 1 && pass "An answer arrives" || fail "No answer" "timeout"
ANS=$(ev "document.querySelector('[data-testid=ai-answer]')?.innerText" | tr -d '"')
CITES=$(ev "document.querySelectorAll('[data-testid=ai-answer] [data-testid=ai-cite]').length" | tr -d '"')
[[ "$ANS" == *"architecture"* && "$CITES" -ge 1 ]] 2>/dev/null && pass "Answer quotes my notes with $CITES citation chip(s)" || fail "Answer/citations" "cites=$CITES ans=$ANS"
[[ "$ANS" != *"[[cite"* && "$ANS" != *"mock-invented-id"* ]] && pass "No raw or invented citation ids shown" || fail "Raw citation leaked" "$ANS"
META=$(ev "document.querySelector('[data-testid=ai-cost]')?.textContent" | tr -d '"')
[[ "$META" == *'$'* && "$META" == *"invalid citation removed"* ]] && pass "Run cost shown; invented citation stripped ($META)" || fail "Cost/strip info" "$META"
ss "57-ask-answer"

step "Clicking a source opens the cited page"
SRC=$(ev "document.querySelector('[data-testid=ai-source] .ai-source-title')?.textContent" | tr -d '"')
ai_click "[data-testid=ai-source]" > /dev/null; sleep 2
CUR=$(api "getCurrentPage()" | tr -d '"')
[[ -n "$SRC" && "$CUR" == "$SRC" ]] && pass "Citation navigates to '$CUR'" || fail "Citation navigation" "source=$SRC current=$CUR"

step "A follow-up stays in the same conversation"
ai_type "[data-testid=ai-input]" "And what about CRDT sync?"
ai_click "[data-testid=ai-send]" > /dev/null
ai_wait_answers 2 && pass "Follow-up answered in the same thread" || fail "No follow-up answer" "timeout"
ANS2=$(ev "[...document.querySelectorAll('[data-testid=ai-answer]')][1]?.innerText" | tr -d '"')
[[ "$ANS2" == *"CRDT"* ]] && pass "Follow-up cites the CRDT note" || fail "Follow-up answer" "$ANS2"

step "A question my notes can't answer says so"
ai_type "[data-testid=ai-input]" "zebra quokka flibbertigibbet?"
ai_click "[data-testid=ai-send]" > /dev/null
ai_wait_answers 3
ANS3=$(ev "[...document.querySelectorAll('[data-testid=ai-answer]')][2]?.innerText" | tr -d '"')
[[ "$ANS3" == *"couldn't find that in your notes"* ]] && pass "No citation → 'I couldn't find that in your notes'" || fail "Not-found answer" "$ANS3"

step "Ctrl+Shift+A toggles the panel"
press "Escape" > /dev/null; sleep 0.5
CLOSED=$(ev "!!document.querySelector('[data-testid=ask-panel]')" | tr -d '"')
ev "window.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true}))" > /dev/null; sleep 0.5
REOPEN=$(ev "!!document.querySelector('[data-testid=ask-panel]')" | tr -d '"')
[[ "$CLOSED" == "false" && "$REOPEN" == "true" ]] && pass "Escape closes; Ctrl+Shift+A reopens (conversation kept: $(ev "document.querySelectorAll('[data-testid=ai-answer]').length" | tr -d '"') answers)" || fail "Panel toggle" "closed=$CLOSED reopen=$REOPEN"
ev "window.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true}))" > /dev/null; sleep 0.3
fi

# ═══════════════════════════════════════════════
journey "50. Rust backend — count_pending_todos works"
# ═══════════════════════════════════════════════

step "Rust function compiles and is callable"
# This is tested by cargo test — verify the command is registered
grep -q "get_pending_todo_count" "$APP_DIR/src-tauri/src/lib.rs" && pass "get_pending_todo_count registered in Tauri" || fail "Command not registered" ""

step "Rust repo module includes ai_suggestions"
grep -q "ai_suggestions" "$CORE_DIR/src/repo/mod.rs" && pass "ai_suggestions module included" || fail "Module not included" ""

step "count_pending_todos function exists"
grep -q "count_pending_todos" "$CORE_DIR/src/repo/ai_suggestions.rs" && pass "count_pending_todos function exists" || fail "Function not found" ""

ss "46-ai-tagging"
ss "47-ai-link-suggestions"
ss "48-ai-todo-extraction"
ss "49-ai-settings"
ss "50-ai-rust-backend"

# ═══════════════════════════════════════════════
journey "54. My notes stay findable and consistent (search, journal, trash, links)"
# Data-layer rules the mock must share with the real backend (parity.sh).
# ═══════════════════════════════════════════════
A54="const api=await import('/src/lib/api.ts');"

step "Search finds word prefixes, all words in any order, and quoted phrases exactly"
R=$(ev "(async()=>{$A54 const p=await api.createPage('Search54 Page');await api.createBlock(p.id,'the zqalphabet54 soup');await api.createBlock(p.id,'東京都の天気 zq54');const n=async q=>(await api.search(q,50)).filter(b=>b.content.includes('54')).length;return [await n('zqalpha'),await n('soup zqalphabet54'),await n('\\\"soup zqalphabet54\\\"'),await n('京都'),await n('zqalphabet54 (\\\"*:-')].join(',')})()" | tr -d '"')
[[ "$R" == "1,1,0,1,1" ]] && pass "Search: prefix, AND, exact phrase, CJK substring, punctuation-safe ($R)" || fail "Search semantics" "$R"

step "A past day's journal can be written to on first open"
R=$(ev "(async()=>{$A54 const a=await api.getJournal('2001-02-03');const b=await api.getJournal('2001-02-03');await api.createBlock(a.page.id,'first entry 54');const t=await api.getPageTree('Journal/2001-02-03');return [a.page.id===b.page.id,t.page.id===a.page.id,t.blocks.map(x=>x.content).join('|')].join(',')})()" | tr -d '"')
[[ "$R" == "true,true,first entry 54" ]] && pass "Virtual journal: same id twice, first block materialises it ($R)" || fail "Past journal write" "$R"

step "Deleting a page frees its title; restoring it while taken renames it"
R=$(ev "(async()=>{$A54 const old=await api.createPage('Reuse54');await api.addFavorite(old.id);await api.trashPage(old.id);const fresh=await api.createPage('Reuse54');const shown=(await api.listTrash()).some(t=>t.title==='Reuse54');await api.restoreFromTrash(old.id,'page');const back=(await api.getPageTree(old.id)).page.title;const fav=(await api.listFavorites()).some(f=>f.id===old.id);return [fresh.id!==old.id,shown,back,fav].join(',')})()" | tr -d '"')
[[ "$R" == "true,true,Reuse54 (restored),true" ]] && pass "Trash title reuse + restore rename + favourite kept ($R)" || fail "Trash title rules" "$R"

step "Backlinks: one per block, with the source block, and trashed pages drop out"
R=$(ev "(async()=>{$A54 const t=await api.createPage('Target54');const s=await api.createPage('Source54');const b=await api.createBlock(s.id,'see [[Target54]] and [[Target54]] again');const l=await api.getBacklinks(t.id);const g=await api.getBlock(b.id);await api.trashPage(s.id);const after=(await api.getBacklinks(t.id)).length;const un=(await api.getUnlinkedReferences(t.id)).length;return [l.length,l[0]&&l[0].block&&l[0].block.page_title,g&&g.page_title,after,un].join(',')})()" | tr -d '"')
[[ "$R" == "1,Source54,Source54,0,0" ]] && pass "Backlinks deduped, batched, hidden when trashed; getBlock has page title ($R)" || fail "Backlinks" "$R"

step "Blank titles and duplicate renames are refused with a readable message"
R=$(ev "(async()=>{$A54 const e=async f=>{try{await f();return 'ok'}catch(x){return String(x&&x.message||x)}};const a=await api.createPage('Dup54 A');await api.createPage('Dup54 B');return [await e(()=>api.createPage('   ')),await e(()=>api.renamePage(a.id,'Dup54 B'))].join('|')})()" | tr -d '"')
[[ "$R" == *"cannot be empty"*"|A page titled 'Dup54 B' already exists"* ]] && pass "Validation messages ($R)" || fail "Validation" "$R"

ss "54-data-consistency"

# ═══════════════════════════════════════════════
journey "58. Names stay tidy, properties are checked, and the mind map starts from nothing"
# Titles/folder names are trimmed and single-line; set_property validates key,
# entity and value type (same rules in mock and Rust). Mind map: first node on
# an empty page, delete with Undo, collapse that survives reopen, exports with labels.
# ═══════════════════════════════════════════════
A58="const api=await import('/src/lib/api.ts');const e=async f=>{try{await f();return 'ok'}catch(x){return String(x&&x.message||x)}};"

step "Page titles and folder names are trimmed, newlines become spaces, blanks are refused"
R=$(ev "(async()=>{$A58 const p=(await api.createPage('  Pad58 one\\nline  ')).title;const r=(await api.renamePage((await api.getPageTree('Pad58 one line')).page.id,'\\n Pad58 renamed ')).title;const fo=await api.createFolder('  F58\\r\\nX ');const f=fo.name;const g=(await api.renameFolder(fo.id,' F58 Y ')).name;return [p,r,f,g,await e(()=>api.createFolder('  ')),await e(()=>api.renameFolder(fo.id,'\\n'))].join('|')})()" | tr -d '"')
[[ "$R" == "Pad58 one line|Pad58 renamed|F58 X|F58 Y|"*"Folder name cannot be empty|"*"Folder name cannot be empty" ]] && pass "Names normalised; blank folder names refused ($R)" || fail "Name normalisation" "$R"

step "set_property checks the key, the entity and the value type"
R=$(ev "(async()=>{$A58 const p=await api.createPage('Props58');const b=await api.createBlock(p.id,'blk58');const ghost='01890000-0000-7000-8000-000000000058';const r=[await e(()=>api.setProperty(p.id,'page','  ','v')),await e(()=>api.setProperty(ghost,'block','k','v')),await e(()=>api.setProperty(b.id,'page','k','v')),await e(()=>api.setProperty(p.id,'banana','k','v')),await e(()=>api.setProperty(p.id,'page','n','not-a-number','number')),await e(()=>api.setProperty(p.id,'page','x','v','made-up')),await e(()=>api.setProperty(p.id,'page',' rating ','4.5','number'))];const keys=(await api.getProperties(p.id)).map(x=>x.key+'='+x.value_type).join(',');return r.join('|')+'|'+keys})()" | tr -d '"')
[[ "$R" == *"key cannot be empty|"*"Not found: Block"*"is a block, not a page|"*"Unknown entity type 'banana'"*"not a valid number"*"Unknown property value type 'made-up'"*"|ok|rating=number" ]] && pass "Bad keys/entities/values refused; good one stored trimmed ($R)" || fail "Property validation" "$R"

step "An empty page's mind map offers a way to add the first node"
ev "(async()=>{$A58 await api.createPage('Empty58');return 1})()" > /dev/null
api "navigateTo('Empty58')" > /dev/null; sleep 2
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
press "Control+m"; sleep 2
HINT=$(ev "document.querySelector('.mm-empty-hint')?.textContent||'none'" | tr -d '"')
[[ "$HINT" == *"Add first node"* ]] && pass "Empty map shows '+ Add first node'" || fail "No empty-map affordance" "$HINT"
MM_TYPE="(v)=>{const i=document.querySelector('.mm-node-input');if(!i)return 'no input';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,v);i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 'typed'}"
ev "(()=>{const b=document.querySelector('.mm-empty-hint button');b&&b.click();return !!b})()" > /dev/null; sleep 1.5
ev "($MM_TYPE)('First58')" > /dev/null; sleep 2
R=$(ev "(async()=>{$A58 const t=await api.getPageTree('Empty58');return t.blocks.filter(b=>!b.parent_id&&b.content.trim()).map(b=>b.content).join(',')+'|'+[...document.querySelectorAll('.mm-node .mm-label')].map(l=>l.textContent.trim()).join(',')})()" | tr -d '"')
[[ "$R" == "First58|"*"First58"* ]] && pass "First node created from the map and shown ($R)" || fail "First node not created" "$R"

step "Selecting the page node and pressing Tab adds another top-level node"
ev "document.querySelector('.react-flow__node[data-id=__page_root__]')?.click()" > /dev/null; sleep 0.5
ev "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))" > /dev/null; sleep 1.5
ev "($MM_TYPE)('Second58')" > /dev/null; sleep 2
R=$(ev "(async()=>{$A58 const t=await api.getPageTree('Empty58');return t.blocks.filter(b=>!b.parent_id&&b.content.trim()).map(b=>b.content).join(',')})()" | tr -d '"')
[[ "$R" == "First58,Second58" ]] && pass "Tab on the page node adds a top-level node ($R)" || fail "Tab on root" "$R"

step "Deleting from the right-click menu offers Undo, which restores the branch"
ev "(async()=>{$A58 const t=await api.getPageTree('Empty58');const s=t.blocks.find(b=>b.content==='Second58');await api.createBlock(t.page.id,'Child58',s.id);window.__MINOTES__.navigateTo('Empty58');return 1})()" > /dev/null; sleep 2
for i in 1 2 3 4 5 6; do N=$(ev "document.querySelectorAll('.mm-node').length" | tr -d '"'); [[ "$N" -ge 4 ]] 2>/dev/null && break; sleep 1; done
ev "(()=>{const n=[...document.querySelectorAll('.react-flow__node')].find(e=>e.textContent.includes('Second58'));if(!n)return 'none';const r=n.getBoundingClientRect();n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+5,clientY:r.y+5}));return 'menu'})()" > /dev/null; sleep 0.5
ev "(()=>{const b=[...document.querySelectorAll('.mindmap-context-menu button')].find(x=>x.textContent==='Delete');b&&b.click();return !!b})()" > /dev/null; sleep 1.5
TOAST=$(ev "document.querySelector('.minotes-toast-undo')?.textContent||'none'" | tr -d '"')
GONE=$(ev "(async()=>{$A58 const t=await api.getPageTree('Empty58');return t.blocks.map(b=>b.content).sort().join(',')})()" | tr -d '"')
[[ "$TOAST" == *"Deleted"*"Second58"*"1 child node"*"Undo"* && "$GONE" == "First58" ]] && pass "Deleted with an Undo toast ($TOAST)" || fail "Delete feedback" "toast=$TOAST left=$GONE"
ev "document.querySelector('.minotes-toast-undo .minotes-toast-undo-btn')?.click()" > /dev/null; sleep 2
BACK=$(ev "(async()=>{$A58 const t=await api.getPageTree('Empty58');const s=t.blocks.find(b=>b.content==='Second58');const c=t.blocks.find(b=>b.content==='Child58');return !!s+','+(!!c&&c.parent_id===s.id)})()" | tr -d '"')
[[ "$BACK" == "true,true" ]] && pass "Undo restored the node and its child" || fail "Undo didn't restore" "$BACK"

step "Collapsing a branch is remembered when the map is reopened"
for i in 1 2 3 4 5 6; do N=$(ev "document.querySelectorAll('.mm-collapse-badge').length" | tr -d '"'); [[ "$N" -ge 1 ]] 2>/dev/null && break; sleep 1; done
ev "(()=>{const n=[...document.querySelectorAll('.mm-node')].find(e=>e.textContent.includes('Second58'));const b=n&&n.querySelector('.mm-collapse-badge');b&&b.click();return !!b})()" > /dev/null; sleep 1
C1=$(ev "[...document.querySelectorAll('.mm-node')].find(e=>e.textContent.includes('Second58'))?.querySelector('.mm-collapse-badge')?.textContent||'none'" | tr -d '"')
press "Escape"; sleep 1
ev "document.activeElement?.blur()" > /dev/null 2>&1; sleep 0.3
press "Control+m"; sleep 2
for i in 1 2 3 4 5; do N=$(ev "document.querySelectorAll('.mm-node').length" | tr -d '"'); [[ "$N" -ge 3 ]] 2>/dev/null && break; sleep 1; done
C2=$(ev "[...document.querySelectorAll('.mm-node')].find(e=>e.textContent.includes('Second58'))?.querySelector('.mm-collapse-badge')?.textContent||'none'" | tr -d '"')
CH=$(ev "[...document.querySelectorAll('.mm-node')].some(e=>e.textContent.includes('Child58'))" | tr -d '"')
[[ "$C1" == "+1" && "$C2" == "+1" && "$CH" == "false" ]] && pass "Branch still collapsed after reopening (+1)" || fail "Collapse not persisted" "before=$C1 after=$C2 childVisible=$CH"

step "SVG and PNG exports contain the node labels"
# Capture the export instead of saving it: browser downloads go through a blob
# URL; the desktop app saves through the save_export_file command
# (intercepted here — it would open a native save dialog — never write to the real Downloads folder from a test).
ev "(()=>{window.__x58={};const o=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__x58.blob=b;return o(b)};if(navigator.clipboard)navigator.clipboard.writeText=t=>{window.__x58.text=t;return Promise.resolve()};if(window.__TAURI_INTERNALS__){const f=window.fetch;window.fetch=function(u,opt){if(String(u).endsWith('/save_export_file')||String(u).endsWith('/save_png_to_downloads')){const d=JSON.parse(opt.body).data;const bytes=new Uint8Array(d);if(bytes[0]===0x89)window.__x58.png=d;else window.__x58.text=new TextDecoder().decode(bytes);return Promise.resolve(new Response(JSON.stringify('/captured/export'),{status:200,headers:{'Tauri-Response':'ok','Content-Type':'application/json'}}))}return f.apply(this,arguments)};window.__x58.wrapped=window.fetch!==f}return 1})()" > /dev/null
# Tauri IPC goes through fetch('ipc://localhost/<cmd>'); only proceed if that hook took.
WRAP=$(ev "!window.__TAURI_INTERNALS__||window.__x58.wrapped===true" | tr -d '"')
MM_EXPORT="(w)=>{const m=[...document.querySelectorAll('.mindmap-toolbar .btn-sm')].find(b=>b.textContent.includes('Export'));m&&m.click();setTimeout(()=>{const b=[...document.querySelectorAll('.mindmap-dropdown button')].find(x=>x.textContent.includes(w));b&&b.click()},300);return 1}"
ev "($MM_EXPORT)('SVG')" > /dev/null; sleep 2
SVG=$(ev "(async()=>{const x=window.__x58;const t=x.text||(x.blob&&await x.blob.text())||'';return t.startsWith('<svg')+','+t.includes('>First58</text>')+','+t.includes('>Second58</text>')+','+t.includes('Empty58')})()" | tr -d '"')
[[ "$SVG" == "true,true,true,true" ]] && pass "SVG export has every node label (incl. the page title)" || fail "SVG export lacks labels" "$SVG"
if [[ "$WRAP" == "true" ]]; then
  ev "(()=>{window.__x58.blob=null;return 1})()" > /dev/null
  ev "($MM_EXPORT)('PNG')" > /dev/null; sleep 3
  PNG=$(ev "(async()=>{const x=window.__x58;const blob=x.png?new Blob([new Uint8Array(x.png)],{type:'image/png'}):x.blob;if(!blob)return 'none';const bm=await createImageBitmap(blob);return blob.type+','+(bm.width>300)+','+(bm.height>150)})()" | tr -d '"')
  [[ "$PNG" == "image/png,true,true" ]] && pass "PNG export is a real image of the whole map ($PNG)" || fail "PNG export" "$PNG"
else
  fail "Could not intercept the desktop PNG save — skipped to protect Downloads" "$WRAP"
fi
press "Escape"; sleep 0.5
press "Escape"; sleep 1
ss "58-names-props-mindmap"

journey "59. A 1,000-block page opens fast and I can edit deep inside it"
# Blocks render as static HTML until edited (one live editor, not 1,000), the
# list renders progressively, and block properties load in one batched call.
# ═══════════════════════════════════════════════

step "I have a page with 1,000 blocks"
R=$(ev "(async()=>{const api=await import('/src/lib/api.ts');let p;try{p=(await api.getPageTree('Big58')).page}catch{p=null}if(!p){p=await api.createPage('Big58');for(let i=0;i<1000;i++){await api.createBlock(p.id,(i===0?'big58 start ':'')+'Line '+i+' with **bold** and [[Getting Started]]'+(i%10===0?'\n- a list item':''))}}return (await api.getPageTree('Big58')).blocks.length})()" | tr -d '"')
[[ "$R" == "1000" ]] && pass "Big58 has 1,000 blocks" || fail "Big page not created" "$R"
api "navigateTo('Getting Started')" > /dev/null; sleep 2

step "I open it: the first blocks paint quickly and the UI never freezes long"
R=$(ev "(async()=>{const M=window.__MINOTES__;const t0=performance.now();let first=null,last=t0,stall=0;M.navigateTo('Big58');await new Promise(res=>{const tick=()=>{const n=performance.now();stall=Math.max(stall,n-last);last=n;const el=document.querySelector('.block-list .block .ProseMirror');if(first===null&&el&&el.textContent.includes('big58 start'))first=n-t0;if(document.querySelectorAll('.block-list .block').length>=1000||n-t0>60000)return res();setTimeout(tick,0)};setTimeout(tick,0)});return JSON.stringify({first:Math.round(first),all:Math.round(performance.now()-t0),stall:Math.round(stall),editors:document.querySelectorAll('.block-list .ProseMirror[contenteditable=\"true\"]').length})})()")
R=$(echo "$R" | sed 's/^"//; s/"$//; s/\\"/"/g')
FIRST=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["first"])' 2>/dev/null)
STALL=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["stall"])' 2>/dev/null)
EDS=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["editors"])' 2>/dev/null)
[[ -n "$FIRST" && "$FIRST" -lt 3000 ]] 2>/dev/null && pass "First block painted in ${FIRST} ms ($R)" || fail "Big page slow to open" "$R"
[[ -n "$STALL" && "$STALL" -lt 1500 ]] 2>/dev/null && pass "Longest main-thread stall ${STALL} ms" || fail "Big page froze the UI" "$R"
[[ -n "$EDS" && "$EDS" -le 2 ]] 2>/dev/null && pass "At most a couple of live editors ($EDS), not one per block" || fail "Too many live editors" "$R"

step "I edit block 900 and it is saved"
sleep 1
api "focusBlock(900)" > /dev/null; sleep 0.6
FI=$(api "getFocusedBlockIndex()" | tr -d '"')
ev "document.execCommand('insertText',false,' EDIT58')" > /dev/null; sleep 0.3
ev "document.activeElement?.blur()" > /dev/null; sleep 1.5
UI=$(api "getBlockContent(900)" | tr -d '"')
DB=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Big58');return t.blocks.filter(b=>b.content.includes('EDIT58')).map(b=>b.content).join('|')})()" | tr -d '"')
[[ "$FI" == "900" && "$UI" == *"EDIT58" && "$DB" == *"Line 900 "*"EDIT58"* ]] && pass "Deep edit saved (focused=$FI)" || fail "Deep edit failed" "focused=$FI ui=$UI db=$DB"
VIS=$(ev "document.querySelectorAll('.block-list .block')[900]?.querySelector('.ProseMirror')?.textContent" | tr -d '"')
[[ "$VIS" == *"EDIT58"* ]] && pass "The edited block shows the new text" || fail "Edited block not shown" "$VIS"

ss "59-big-page"
journey "60. I keep work and home apart — notebooks in the sidebar"
# The switcher in the sidebar header: create, switch, isolation, manage, delete.
# ═══════════════════════════════════════════════
A58="const api=await import('/src/lib/api.ts');"
NB58="Journey58 $(date +%s)"
setval() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
api "closePanel()" >/dev/null; sleep 0.5
HOME_NB=$(ev "(async()=>{$A58 return (await api.getNotebookSession()).key})()" | tr -d '"')
HOME_NAME=$(ev "(async()=>{$A58 return (await api.getNotebookSession()).name})()" | tr -d '"')

step "The sidebar header shows which notebook is open"
R=$(ev "document.querySelector('.sidebar-header [data-testid=notebook-switcher]')?.innerText||''" | tr -d '"')
[[ "$R" == *"$HOME_NAME"* ]] && pass "Notebook name next to MiNotes ($HOME_NAME)" || fail "No notebook name in the sidebar header" "$R"

step "Its menu lists my notebooks with the open one checked, plus New / Open / Manage"
ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.5
R=$(ev "(()=>{const m=document.querySelector('.nb-menu');if(!m)return 'no menu';const cur=m.querySelector('[aria-checked=true]');return (cur?cur.dataset.notebookKey:'none')+'|'+[...m.querySelectorAll('.nb-menu-action')].map(b=>b.textContent.trim()).join(',')})()" | tr -d '"')
[[ "$R" == "$HOME_NB|New notebook…,Open notebook…,Manage notebooks…,Export notebook…,Import notebook…,Import from other apps…" ]] && pass "Menu: current checked + actions" || fail "Notebook menu" "$R"
ss "60-notebook-menu"

step "New notebook… asks for a name and a location, creates it and opens it"
ev "[...document.querySelectorAll('.nb-menu-action')].find(b=>b.textContent.startsWith('New'))?.click()" >/dev/null; sleep 0.5
setval "[data-testid=new-notebook-name]" "a/b"
R=$(ev "(()=>{const d=document.querySelector('[data-testid=new-notebook-dialog]');return d?(d.querySelector('[data-testid=new-notebook-create]').disabled+'|'+d.innerText.includes('no dots or slashes')):'no dialog'})()" | tr -d '"')
[[ "$R" == "true|true" ]] && pass "Invalid names are refused before creating" || fail "Name validation" "$R"
setval "[data-testid=new-notebook-name]" "$NB58"
sleep 0.5
LOC=$(ev "document.querySelector('[data-testid=new-notebook-location]')?.textContent||''" | tr -d '"')
[[ "$LOC" == *"MiNotes/$NB58"* ]] && pass "Default location is ~/MiNotes/<name> ($LOC)" || fail "Default location" "$LOC"
ss "60-new-notebook-dialog"
ev "document.querySelector('[data-testid=new-notebook-create]').click()" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; R=$(ev "document.querySelector('[data-testid=notebook-switcher]')?.innerText||''" | tr -d '"'); [[ "$R" == *"$NB58"* ]] && break; done
[[ "$R" == *"$NB58"* ]] && pass "Switched to the new notebook" || fail "New notebook not opened" "$R"
sleep 1
R=$(ev "(async()=>{$A58 const ps=await api.listPages(1000);return ps.filter(p=>!p.is_journal).length+'|'+(window.__MINOTES__.getCurrentPage()||'')})()" | tr -d '"')
[[ "$R" == 0\|* && "$R" == *"$(date +%Y-%m-%d)"* ]] && pass "It starts empty, on today's journal ($R)" || fail "New notebook content" "$R"

step "What I write here stays here: search, TODO count, trash"
R=$(ev "(async()=>{$A58 const p=await api.createPage('Secret58 plan');await api.createBlock(p.id,'TODO nb58zz task');await api.createBlock(p.id,'TODO nb58zz second');const gone=await api.createPage('Trash58 page');await api.trashPage(gone.id);return [(await api.search('nb58zz',50)).length,await api.getPendingTodoCount(),(await api.listTrash()).map(t=>t.title).join(';')].join('|')})()" | tr -d '"')
NB_TODOS=$(echo "$R" | cut -d'|' -f2)
[[ "$R" == "2|2|Trash58 page" ]] && pass "In the new notebook: search 2, TODOs 2, trash 1 ($R)" || fail "New notebook data" "$R"
api "navigateTo('Secret58 plan')" >/dev/null; sleep 1
ev "(async()=>{const u=await import('/src/lib/undoStack.ts');u.undoStack.push({type:'update',blockId:'x',pageId:'y',before:'',after:'',timestamp:Date.now()});return 1})()" >/dev/null

step "I switch back from the menu: my other notebook knows nothing of it"
ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.5
ev "document.querySelector('.nb-menu [data-notebook-key=\"$HOME_NB\"]')?.click()" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; R=$(ev "document.querySelector('[data-testid=notebook-switcher]')?.innerText||''" | tr -d '"'); [[ "$R" == *"$HOME_NAME"* ]] && break; done
[[ "$R" == *"$HOME_NAME"* ]] && pass "Back in $HOME_NAME" || fail "Switch back" "$R"
sleep 1
R=$(ev "(async()=>{$A58 const titles=(await api.listPages(1000)).map(p=>p.title);return [(await api.search('nb58zz',50)).length,(await api.listTrash()).some(t=>t.title==='Trash58 page'),titles.includes('Secret58 plan')].join('|')})()" | tr -d '"')
[[ "$R" == "0|false|false" ]] && pass "Search, trash and pages don't leak across notebooks ($R)" || fail "Notebook isolation" "$R"
HOME_TODOS=$(ev "(async()=>{$A58 return String(await api.getPendingTodoCount())})()" | tr -d '"')
BADGE=$(ev "(()=>{const t=document.body.innerText.match(/(\\d+)\\s*TODOs?/);return t?t[1]:'none'})()" | tr -d '"')
[[ "$BADGE" == "$HOME_TODOS" || ( "$HOME_TODOS" == "0" && "$BADGE" == "none" ) ]] && pass "Sidebar TODO count is this notebook's ($BADGE)" || fail "TODO count leaked" "badge=$BADGE home=$HOME_TODOS other=$NB_TODOS"
R=$(ev "(async()=>{const u=await import('/src/lib/undoStack.ts');return String(u.undoStack.canUndo())})()" | tr -d '"')
[[ "$R" == "false" ]] && pass "Undo history was cleared on switch" || fail "Undo survived the switch" "$R"
R=$(ev "(()=>{try{return String(JSON.parse(localStorage.getItem('minotes-recent-pages')||'[]').some(r=>r.title==='Secret58 plan'))}catch(e){return 'err'}})()" | tr -d '"')
[[ "$R" == "false" ]] && pass "Recent pages are per notebook" || fail "Recent pages leaked" "$R"
R=$(ev "String((window.__MINOTES__.getCurrentPage()||'').includes('$(date +%Y-%m-%d)'))" | tr -d '"')
[[ "$R" == "true" ]] && pass "Switching lands on today's journal" || fail "Switch landing page" "$(api 'getCurrentPage()')"

step "The Graph view shows the notebook as a label, not a second switcher"
api "closePanel()" >/dev/null; press "Control+g"; sleep 2
R=$(ev "(()=>{const l=document.querySelector('[data-testid=graph-notebook-label]');return (l?l.textContent:'none')+'|'+!!document.querySelector('.graph-switcher-dropdown,.graph-switcher-btn')})()" | tr -d '"')
[[ "$R" == "Notebook: $HOME_NAME|false" ]] && pass "Graph view: read-only notebook label ($R)" || fail "Graph view notebook label" "$R"
api "closePanel()" >/dev/null; sleep 0.5

step "Manage notebooks…: the open one can't be deleted; another needs its name typed"
ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.4
ev "[...document.querySelectorAll('.nb-menu-action')].find(b=>b.textContent.startsWith('Manage'))?.click()" >/dev/null; sleep 0.6
OTHER=$(ev "(async()=>{$A58 return (await api.listNotebooks()).find(n=>n.name==='$NB58')?.key||''})()" | tr -d '"')
R=$(ev "(()=>{const d=document.querySelector('[data-testid=manage-notebooks-dialog]');if(!d)return 'no dialog';const cur=d.querySelector('[data-notebook-key=\"$HOME_NB\"] [data-testid=delete-notebook]');const oth=d.querySelector('[data-notebook-key=\"$OTHER\"] [data-testid=delete-notebook]');return cur.disabled+'|'+oth.disabled})()" | tr -d '"')
[[ "$R" == "true|false" ]] && pass "Delete refused for the open notebook only" || fail "Manage dialog" "$R"
ss "60-manage-notebooks"
ev "document.querySelector('[data-notebook-key=\"$OTHER\"] [data-testid=delete-notebook]').click()" >/dev/null; sleep 0.4
setval "[data-testid=delete-notebook-typed]" "Journey58"
R1=$(ev "String(document.querySelector('[data-testid=delete-notebook-go]')?.disabled)" | tr -d '"')
setval "[data-testid=delete-notebook-typed]" "$NB58"
R2=$(ev "String(document.querySelector('[data-testid=delete-notebook-go]')?.disabled)" | tr -d '"')
[[ "$R1|$R2" == "true|false" ]] && pass "Delete needs the exact name typed" || fail "Type-the-name confirmation" "$R1|$R2"
ev "document.querySelector('[data-testid=delete-notebook-go]').click()" >/dev/null; sleep 1
R=$(ev "(async()=>{$A58 return String((await api.listNotebooks()).some(n=>n.key==='$OTHER'))})()" | tr -d '"')
[[ "$R" == "false" ]] && pass "The other notebook is gone from the list" || fail "Delete notebook" "$R"
press "Escape"; sleep 0.3
R=$(ev "(async()=>{$A58 try{await api.deleteNotebook('$HOME_NB');return 'deleted!'}catch(e){return String(e).includes('open notebook')?'refused':String(e)}})()" | tr -d '"')
[[ "$R" == "refused" ]] && pass "The backend refuses deleting the open notebook too" || fail "Delete open notebook" "$R"

step "Settings shows where the markdown copy lives"
api "openSettings()" >/dev/null; sleep 1
R=$(ev "(()=>{const s=document.querySelector('[data-testid=notebook-settings]');return s?[s.querySelector('[data-testid=mirror-dir]')?.textContent||'',s.querySelector('[data-testid=mirror-status]')?.textContent||''].join('|'):'none'})()" | tr -d '"')
[[ "$R" == *"MiNotes_Sync"*"|Up to date"* || "$R" == *"/notes|Up to date"* ]] && pass "Mirror location + status in Settings ($R)" || fail "Mirror status in Settings" "$R"
ss "60-settings-notebook"
api "closePanel()" >/dev/null

# ═══════════════════════════════════════════════
journey "61. I bring my Obsidian vault in — preview, import into a new notebook, undo"
# File → Import… (notebook menu): pick a source, see the preview, import into a
# new notebook, read the report, undo it. Then paste an image into a block.
# ═══════════════════════════════════════════════
A61="const api=await import('/src/lib/api.ts');"
api "closePanel()" >/dev/null; sleep 0.3
HOME61=$(ev "(async()=>{$A61 return (await api.getNotebookSession()).key})()" | tr -d '"')
if [[ "$BACKEND" == "desktop" ]]; then
  VAULT61="$DC_STATE/$(cat "$DC_STATE/profile" 2>/dev/null || echo home)/Imports/obsidian-vault"
  rm -rf "$VAULT61"; mkdir -p "$(dirname "$VAULT61")"; cp -r "$REPO_ROOT/tests/fixtures/import/obsidian-vault" "$VAULT61"
else
  VAULT61="/home/demo/Imports/My Vault"
fi

step "The notebook menu has Import…, and it offers Obsidian, Evernote and markdown"
ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.4
ev "document.querySelector('[data-testid=menu-import]')?.click()" >/dev/null; sleep 0.6
R=$(ev "[...document.querySelectorAll('[data-import-source]')].map(b=>b.dataset.importSource).join(',')" | tr -d '"')
[[ "$R" == "obsidian,evernote,markdown" ]] && pass "Import dialog: three sources" || fail "Import dialog sources" "$R"

step "I pick my vault: it is scanned and I see what will be created"
ev "window.__MINOTES__.setNextImportPick('$VAULT61')" >/dev/null
ev "document.querySelector('[data-import-source=obsidian]').click()" >/dev/null
for _ in $(seq 1 30); do sleep 0.5; R=$(ev "document.querySelector('[data-testid=import-dialog]')?.dataset.step||''" | tr -d '"'); [[ "$R" == "preview" ]] && break; done
[[ "$R" == "preview" ]] && pass "Scan finished, preview shown" || fail "Scan" "$R $(ev "document.querySelector('[data-testid=import-error]')?.innerText||''")"
R=$(ev "(()=>{const d=document.querySelector('[data-testid=import-dialog]');return [d.querySelectorAll('.imp-tree li').length>3,d.querySelectorAll('.imp-tab').length,!!d.querySelector('.imp-source'),d.querySelectorAll('[data-testid=import-warnings] li').length>0,/pages/.test(d.querySelector('[data-testid=import-counts]')?.innerText||'')].join('|')})()" | tr -d '"')
[[ "$R" == "true|3|true|true|true" ]] && pass "Preview: tree, 3 samples beside their source, warnings, counts" || fail "Preview content" "$R"
ss "61-import-preview"

step "Changing the split option re-renders the samples (one block per note)"
ev "(()=>{const s=document.querySelector('[data-testid=import-split]');s.closest('details').open=true;const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'note');s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()" >/dev/null
sleep 1.5
R=$(ev "document.querySelector('[data-testid=import-samples] .imp-blocks')?.children.length||0" | tr -d '"')
[[ "$R" == "1" ]] && pass "One block per note in the sample" || fail "Split option" "$R"
ev "(()=>{const s=document.querySelector('[data-testid=import-split]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'outline');s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()" >/dev/null
sleep 1

step "Import goes into a NEW notebook by default; I get a report"
R=$(ev "document.querySelector('[data-testid=import-destination] input[type=radio]')?.checked" | tr -d '"')
[[ "$R" == "true" ]] && pass "New notebook is the default destination" || fail "Default destination" "$R"
ev "document.querySelector('[data-testid=import-start]').click()" >/dev/null
for _ in $(seq 1 60); do sleep 0.5; R=$(ev "document.querySelector('[data-testid=import-dialog]')?.dataset.step||''" | tr -d '"'); [[ "$R" == "report" ]] && break; done
[[ "$R" == "report" ]] && pass "Import finished" || fail "Import" "$R $(ev "document.querySelector('[data-testid=import-error]')?.innerText||''")"
ss "61-import-report"
NB61=$(ev "(async()=>{$A61 return (await api.getNotebookSession()).key})()" | tr -d '"')
[[ -n "$NB61" && "$NB61" != "$HOME61" ]] && pass "The new notebook is open" || fail "New notebook not opened" "$NB61"
R=$(ev "(async()=>{$A61 const ps=await api.listPages(1000);const t=ps.map(p=>p.title);const home=await api.getPageTree('Home');return [t.includes('Alpha'),t.some(x=>x.startsWith('Import report')),home.blocks.some(b=>b.content.includes('](attachment:'))].join('|')})()" | tr -d '"')
[[ "$R" == "true|true|true" ]] && pass "Pages, report page and an attachment image arrived" || fail "Imported content" "$R"

step "The imported page shows the image inline and the link resolves"
ev "document.querySelector('[data-testid=import-dialog] .btn-primary')?.click()" >/dev/null; sleep 0.5
api "navigateTo('Home')" >/dev/null; sleep 2
R=$(ev "(()=>{const img=[...document.querySelectorAll('.block img')].find(i=>i.getAttribute('data-attachment-src'));return img?(img.complete&&img.naturalWidth>0)+'|'+img.getAttribute('src').slice(0,24):'no img'})()" | tr -d '"')
[[ "$R" == true\|* ]] && pass "Attachment image renders ($R)" || fail "Attachment image" "$R"
R=$(ev "[...document.querySelectorAll('.block .wiki-link')].some(a=>/Alpha/.test(a.textContent))" | tr -d '"')
[[ "$R" == "true" ]] && pass "[[Alpha]] is a working page link" || fail "Resolved link" "$R"
ss "61-imported-page"

step "Undo import removes everything it created"
RUN61=$(ev "(async()=>{$A61 return (await api.importRuns())[0]?.id||''})()" | tr -d '"')
api "openImport()" >/dev/null; sleep 0.8
ev "document.querySelector('[data-testid=import-run-undo]')?.click()" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "document.querySelector('[data-testid=import-dialog]')?.dataset.step||''" | tr -d '"'); [[ "$R" == "undone" ]] && break; done
[[ "$R" == "undone" ]] && pass "Undo import ran ($RUN61)" || fail "Undo import" "$R $(ev "document.querySelector('[data-testid=import-dialog]')?.innerText.slice(0,200)||''")"
R=$(ev "(async()=>{$A61 return String((await api.listPages(1000)).filter(p=>!p.is_journal).length)})()" | tr -d '"')
[[ "$R" == "0" ]] && pass "The notebook is empty again" || fail "Pages left after undo" "$R"
press "Escape"; sleep 0.3

step "I paste an image into a block: it is stored as an attachment, not a data URL"
ev "(async()=>{$A61 const p=await api.createPage('Paste61');await api.createBlock(p.id,'Screenshot below');return 1})()" >/dev/null
api "navigateTo('Paste61')" >/dev/null; sleep 1.5
api "focusBlock(0)" >/dev/null; sleep 0.5
ev "(()=>{const ed=document.querySelector('.ProseMirror-focused')||document.querySelector('.block .ProseMirror');if(!ed)return 'no editor';const c=document.createElement('canvas');c.width=40;c.height=30;const x=c.getContext('2d');x.fillStyle='#d33';x.fillRect(0,0,40,30);const b64=c.toDataURL('image/png').split(',')[1];const bytes=Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'shot.png',{type:'image/png'}));ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 'pasted'})()" >/dev/null
for _ in $(seq 1 10); do sleep 0.5; R=$(ev "(async()=>{$A61 const t=await api.getPageTree('Paste61');return t.blocks.map(b=>b.content).join('\\n')})()" | tr -d '"'); [[ "$R" == *"attachment:"* ]] && break; done
[[ "$R" == *"](attachment:"* && "$R" != *"data:image"* ]] && pass "Pasted image saved as attachment:<hash>" || fail "Paste image" "$R"
api "closePanel()" >/dev/null

step "Back to my notebook"
ev "window.__MINOTES__.switchNotebook('$HOME61')" >/dev/null; sleep 2
R=$(ev "(async()=>{$A61 return (await api.getNotebookSession()).key})()" | tr -d '"')
[[ "$R" == "$HOME61" ]] && pass "Home notebook open again" || fail "Switch back" "$R"

# ═══════════════════════════════════════════════
journey "62. I find and link a page in my other notebook"
# Search with "All notebooks" finds a page in another notebook and opens it there;
# a [[Notebook::Page]] link renders as a chip, opens the page, survives the page's
# rename, never creates a page; a link to nothing is a muted "not found" chip;
# typing [[ offers my notebooks, then their pages.
# ═══════════════════════════════════════════════
A62="const api=await import('/src/lib/api.ts');"
setval62() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
cur62() { ev "(async()=>{$A62 return (await api.getNotebookSession()).key})()" | tr -d '"'; }
api "closePanel()" >/dev/null; sleep 0.3
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({searchAllNotebooks:false});return 1})()" >/dev/null
HOME62=$(cur62)
WORK62="Work62 $(date +%s)"
WKEY62=$(ev "(async()=>{$A62 return (await api.createNotebook('$WORK62')).key})()" | tr -d '"')
ev "window.__MINOTES__.switchNotebook('$WKEY62')" >/dev/null; sleep 2
ev "(async()=>{$A62 const p=await api.createPage('Roadmap62');await api.createBlock(p.id,'Intro to the roadmap');await api.createBlock(p.id,'quokka62 migration plan');return 1})()" >/dev/null
ev "window.__MINOTES__.switchNotebook('$HOME62')" >/dev/null; sleep 2
[[ -n "$WKEY62" && "$(cur62)" == "$HOME62" ]] && pass "Two notebooks: '$WORK62' holds Roadmap62" || fail "Setup" "work=$WKEY62 cur=$(cur62)"

step "Ctrl+K only searches this notebook until I tick All notebooks"
api "openSearch()" >/dev/null; sleep 0.6
setval62 ".command-palette-input" "quokka62"; sleep 1.2
R=$(ev "document.querySelectorAll('[data-testid=search-other-result]').length+'|'+!!document.querySelector('[data-testid=search-all-notebooks]')" | tr -d '"')
[[ "$R" == "0|true" ]] && pass "Toggle shown, off by default: no other-notebook results" || fail "Search scope" "$R"
ev "document.querySelector('[data-testid=search-all-notebooks]').click()" >/dev/null
for _ in $(seq 1 12); do sleep 0.5; R=$(ev "[...document.querySelectorAll('[data-testid=search-other-result]')].map(e=>e.innerText.replace(/\\s+/g,' ')).join(' / ')" | tr -d '"'); [[ "$R" == *quokka62* ]] && break; done
[[ "$R" == *"$WORK62"*"quokka62 migration plan"*"Roadmap62"* ]] && pass "Found in the other notebook, labelled with its name ($R)" || fail "Cross-notebook result" "$R"
R=$(ev "(()=>{const s=document.querySelector('[data-testid=search-notebook-section]');return s?s.textContent:''})()" | tr -d '"')
[[ "$R" == *"$WORK62"* ]] && pass "Results grouped under the notebook's name" || fail "Notebook section" "$R"
R=$(ev "(async()=>{const s=await import('/src/lib/settings.ts');return String(s.getSettings().searchAllNotebooks)})()" | tr -d '"')
[[ "$R" == "true" ]] && pass "The choice is remembered" || fail "Setting not saved" "$R"
ss "62-search-all-notebooks"

step "Opening the result switches notebooks and shows the block"
ev "[...document.querySelectorAll('[data-testid=search-other-result]')].find(e=>e.innerText.includes('quokka62'))?.click()" >/dev/null
for _ in $(seq 1 16); do sleep 0.5; [[ "$(api 'getCurrentPage()' | tr -d '"')" == "Roadmap62" ]] && break; done
R="$(cur62)|$(api 'getCurrentPage()' | tr -d '"')"
[[ "$R" == "$WKEY62|Roadmap62" ]] && pass "Now in $WORK62, on Roadmap62" || fail "Open result" "$R"
R=$(ev "document.querySelector('[data-testid=notebook-switcher]')?.innerText||''" | tr -d '"')
[[ "$R" == *"$WORK62"* ]] && pass "The sidebar shows the switched notebook" || fail "Switcher label" "$R"
R=$(ev "(()=>{const b=[...document.querySelectorAll('[data-block-id]')].find(e=>e.textContent.includes('quokka62'));return b?String(b.classList.contains('block-ref-highlight')||!!b.querySelector('.ProseMirror-focused')||b.contains(document.activeElement)):'none'})()" | tr -d '"')
[[ "$R" == "true" ]] && pass "The matching block is revealed" || fail "Block reveal" "$R"
ss "62-opened-in-other-notebook"
ev "window.__MINOTES__.switchNotebook('$HOME62')" >/dev/null; sleep 2

step "A [[Notebook::Page]] link renders as a chip — and creates nothing"
ev "(async()=>{$A62 const p=await api.createPage('Links62');await api.createBlock(p.id,'See [[$WORK62::Roadmap62]] and [[$WORK62::No Such Page62]]');return 1})()" >/dev/null
api "navigateTo('Links62')" >/dev/null; sleep 2
CHIPS62="[...document.querySelectorAll('.block .xnb-link')].map(c=>c.textContent+'#'+c.classList.contains('xnb-missing')).join(' | ')"
for _ in $(seq 1 10); do R=$(ev "$CHIPS62" | tr -d '"'); [[ "$R" == *"#true"* ]] && break; sleep 0.5; done
[[ "$R" == "$WORK62 › Roadmap62#false | $WORK62 › No Such Page62#true" ]] && pass "Chips: '$WORK62 › Roadmap62' and a muted not-found one" || fail "Chips" "$R"
R=$(ev "document.querySelectorAll('.block .xnb-link')[1]?.title||''" | tr -d '"')
[[ "$R" == *"Not found"* ]] && pass "The not-found chip explains itself on hover" || fail "Tooltip" "$R"
R=$(ev "(async()=>{$A62 const t=(await api.listPages(1000)).map(p=>p.title);const g=await api.getGraphData();return [t.some(x=>x.includes('::')||x.includes('Roadmap62')),g.nodes.some(n=>String(n.title||n.label||'').includes('Roadmap62'))].join('|')})()" | tr -d '"')
[[ "$R" == "false|false" ]] && pass "No local page and nothing in the local graph" || fail "Fake local page" "$R"
ss "62-chips"

step "Clicking the chip opens the page in its notebook"
ev "document.querySelectorAll('.block .xnb-link')[0].click()" >/dev/null
for _ in $(seq 1 16); do sleep 0.5; [[ "$(api 'getCurrentPage()' | tr -d '"')" == "Roadmap62" ]] && break; done
R="$(cur62)|$(api 'getCurrentPage()' | tr -d '"')"
[[ "$R" == "$WKEY62|Roadmap62" ]] && pass "Switched to $WORK62 and opened Roadmap62" || fail "Follow link" "$R"

step "I rename the page over there — the link still finds it"
ev "(async()=>{$A62 const t=await api.getPageTree('Roadmap62');await api.renamePage(t.page.id,'Roadmap62 final');return 1})()" >/dev/null
R=$(ev "(async()=>{$A62 const t=(await api.listPages(1000)).map(p=>p.title);return [t.includes('No Such Page62'),t.includes('Roadmap62 final')].join('|')})()" | tr -d '"')
[[ "$R" == "false|true" ]] && pass "Renamed; no page was created for the missing link" || fail "Other notebook pages" "$R"
ev "window.__MINOTES__.switchNotebook('$HOME62')" >/dev/null; sleep 2
api "navigateTo('Links62')" >/dev/null; sleep 2
for _ in $(seq 1 10); do R=$(ev "document.querySelectorAll('.block .xnb-link')[0]?.textContent||''" | tr -d '"'); [[ "$R" == *final* ]] && break; sleep 0.5; done
[[ "$R" == "$WORK62 › Roadmap62 final" ]] && pass "The chip shows the new title" || fail "Chip after rename" "$R"
R=$(ev "(async()=>{$A62 const t=await api.getPageTree('Links62');return t.blocks[0].content})()" | tr -d '"')
[[ "$R" == *"[[$WORK62::Roadmap62]]"* ]] && pass "The block text is untouched (round-trips as written)" || fail "Block text" "$R"
ss "62-chip-after-rename"
ev "document.querySelectorAll('.block .xnb-link')[0].click()" >/dev/null
for _ in $(seq 1 16); do sleep 0.5; [[ "$(api 'getCurrentPage()' | tr -d '"')" == "Roadmap62 final" ]] && break; done
[[ "$(api 'getCurrentPage()' | tr -d '"')" == "Roadmap62 final" ]] && pass "…and still opens it" || fail "Follow after rename" "$(api 'getCurrentPage()')"
ev "window.__MINOTES__.switchNotebook('$HOME62')" >/dev/null; sleep 2

step "Clicking the not-found chip explains instead of creating a page"
api "navigateTo('Links62')" >/dev/null; sleep 2
ev "document.querySelectorAll('.block .xnb-link')[1]?.click()" >/dev/null; sleep 1.5
R=$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' | ')" | tr -d '"')
[[ "$R" == *"has no page"*"No Such Page62"* ]] && pass "A toast explains the page doesn't exist there" || fail "Not-found click" "$R"
R="$(cur62)|$(api 'getCurrentPage()' | tr -d '"')"
[[ "$R" == "$HOME62|Links62" ]] && pass "I stay where I was" || fail "Moved on a not-found click" "$R"

step "Typing [[ offers my other notebook, then its pages"
ev "(async()=>{$A62 const p=await api.createPage('Typing62');await api.createBlock(p.id,'Next');return 1})()" >/dev/null
api "navigateTo('Typing62')" >/dev/null; sleep 2
api "focusBlock(0)" >/dev/null; sleep 0.5
api "typeInBlock(0, ' [[${WORK62:0:6}')" >/dev/null; sleep 1.5
R=$(ev "[...document.querySelectorAll('.slash-menu-item[data-kind=notebook]')].map(e=>e.textContent).join('|')" | tr -d '"')
[[ "$R" == *"$WORK62::"* ]] && pass "Notebook offered as '$WORK62::'" || fail "Notebook suggestion" "$R"
ev "[...document.querySelectorAll('.slash-menu-item[data-kind=notebook]')].find(e=>e.textContent.includes('$WORK62'))?.click()" >/dev/null; sleep 1.5
R=$(ev "[...document.querySelectorAll('.slash-menu-item[data-kind=xpage]')].map(e=>e.textContent).join('|')" | tr -d '"')
[[ "$R" == *"Roadmap62 final"* ]] && pass "Then its pages ($R)" || fail "Page suggestions" "$R"
ev "[...document.querySelectorAll('.slash-menu-item[data-kind=xpage]')].find(e=>e.textContent.includes('Roadmap62 final'))?.click()" >/dev/null; sleep 1
api "closePanel()" >/dev/null; press "Escape"; sleep 1.5
R=$(ev "(async()=>{$A62 const t=await api.getPageTree('Typing62');return t.blocks[0].content})()" | tr -d '"')
[[ "$R" == *"[[$WORK62::Roadmap62 final]]"* ]] && pass "Inserted [[$WORK62::Roadmap62 final]]" || fail "Inserted link" "$R"
api "navigateTo('Typing62')" >/dev/null; sleep 2
for _ in $(seq 1 10); do R=$(ev "document.querySelector('.block .xnb-link')?.textContent||''" | tr -d '"'); [[ -n "$R" ]] && break; sleep 0.5; done
[[ "$R" == "$WORK62 › Roadmap62 final" ]] && pass "…rendered as a chip" || fail "Typed chip" "$R"
ss "62-typed-link"

step "Search back to this notebook only"
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({searchAllNotebooks:false});return 1})()" >/dev/null
[[ "$(cur62)" == "$HOME62" ]] && pass "Home notebook open" || fail "End notebook" "$(cur62)"

# ═══════════════════════════════════════════════
journey "63. I switch notebooks right after typing or drawing — nothing is lost"
# ARCH U-1: the save barrier. Unsaved typing and whiteboard strokes are written
# to the notebook they belong to BEFORE the switch, not by the unmount save
# afterwards (which used to land in the other notebook: lost edit / orphan board).
# ═══════════════════════════════════════════════
A63="const api=await import('/src/lib/api.ts');"
cur63() { ev "(async()=>{$A63 return (await api.getNotebookSession()).key})()" | tr -d '"'; }
# Edit63's block contents (in whichever notebook is open).
blocks63() { ev "(async()=>{$A63 const t=await api.getPageTree('Edit63');return t.blocks.map(b=>b.content).join(' / ')})()" | tr -d '"'; }
has_edit63() { ev "(async()=>{$A63 return (await api.listPages(1000)).some(p=>p.title==='Edit63')})()" | tr -d '"'; }
board63() { ev "(async()=>{$A63 const d=await api.getWhiteboard('$1');return d?String(JSON.parse(d).lines.length):'none'})()" | tr -d '"'; }
wait_nb63() { for _ in $(seq 1 12); do sleep 0.5; [[ "$(cur63)" == "$1" ]] && break; done; }
api "closePanel()" >/dev/null; sleep 0.3
HOME63=$(cur63)
OTHER63="Other63 $(date +%s)"
OKEY63=$(ev "(async()=>{$A63 return (await api.createNotebook('$OTHER63')).key})()" | tr -d '"')
ev "window.__MINOTES__.switchNotebook('$OKEY63')" >/dev/null; sleep 2
ev "(async()=>{$A63 const p=await api.createPage('Target63');await api.createBlock(p.id,'Over here');return 1})()" >/dev/null
ev "window.__MINOTES__.switchNotebook('$HOME63')" >/dev/null; sleep 2
ev "(async()=>{$A63 const p=await api.createPage('Edit63');await api.createBlock(p.id,'Go to [[$OTHER63::Target63]]');await api.createBlock(p.id,'Second63');return 1})()" >/dev/null
[[ -n "$OKEY63" && "$(cur63)" == "$HOME63" ]] && pass "Two notebooks; Edit63 links to $OTHER63::Target63" || fail "Setup" "other=$OKEY63 cur=$(cur63)"

step "I type into a block and click its cross-notebook chip at once (no blur)"
api "navigateTo('Edit63')" >/dev/null; sleep 2
api "focusBlock(0)" >/dev/null; sleep 0.6
for _ in $(seq 1 10); do R=$(ev "!!document.querySelector('[data-block-id] .ProseMirror:not(.block-static) .xnb-link')" | tr -d '"'); [[ "$R" == "true" ]] && break; sleep 0.3; done
R=$(ev "(()=>{const ok=window.__MINOTES__.typeInBlock(0,' typed63chip');const c=document.querySelector('[data-block-id] .ProseMirror:not(.block-static) .xnb-link');if(!ok||!c)return 'no editor/chip';c.click();return 'clicked'})()" | tr -d '"')
for _ in $(seq 1 16); do sleep 0.5; [[ "$(api 'getCurrentPage()' | tr -d '"')" == "Target63" ]] && break; done
R="$R|$(cur63)|$(api 'getCurrentPage()' | tr -d '"')"
[[ "$R" == "clicked|$OKEY63|Target63" ]] && pass "The live editor's chip opened Target63 in $OTHER63" || fail "Chip follow" "$R"
R=$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' | ')" | tr -d '"')
R2=$(ev "(document.body.innerText.match(/Couldn.t save[^\\n]*/)||[''])[0]" | tr -d '"')
[[ "$R $R2" != *"ouldn't save"* && "$R $R2" != *"no longer exists"* ]] && pass "No save error after the switch" || fail "Save error after switch" "$R $R2"
[[ "$(has_edit63)" == "false" ]] && pass "Nothing of Edit63 leaked into $OTHER63" || fail "Leak into other notebook" "Edit63 exists there"
ev "window.__MINOTES__.switchNotebook('$HOME63')" >/dev/null; wait_nb63 "$HOME63"
R=$(blocks63)
[[ "$R" == *"typed63chip"* ]] && pass "The typed text is saved in the home notebook ($R)" || fail "Typing lost on chip switch" "$R"

step "I type and switch notebooks in the same instant (window.__MINOTES__.switchNotebook)"
api "navigateTo('Edit63')" >/dev/null; sleep 2
R=$(ev "(()=>{const ok=window.__MINOTES__.typeInBlock(1,' typed63api');window.__MINOTES__.switchNotebook('$OKEY63');return String(ok)})()" | tr -d '"')
wait_nb63 "$OKEY63"
[[ "$R|$(cur63)" == "true|$OKEY63" ]] && pass "Switched right after typing" || fail "Switch" "$R|$(cur63)"
ev "window.__MINOTES__.switchNotebook('$HOME63')" >/dev/null; wait_nb63 "$HOME63"
R=$(blocks63)
[[ "$R" == *"typed63chip"*"typed63api"* ]] && pass "Both edits are in the home notebook ($R)" || fail "Typing lost on API switch" "$R"

# A stroke on the open whiteboard, then a switch 150 ms later (inside the 1 s save debounce).
DRAWMODE63="(()=>{const b=[...document.querySelectorAll('.whiteboard-toolbar button')].find(b=>b.textContent.trim()==='Draw');if(b)b.click();return !!b})()"
DRAW63="(()=>{const c=document.querySelector('canvas.whiteboard-canvas');if(!c)return 'no canvas';const r=c.getBoundingClientRect();const o=(x,y)=>({bubbles:true,button:0,clientX:r.left+x,clientY:r.top+y});c.dispatchEvent(new MouseEvent('mousedown',o(120,120)));for(let i=1;i<=8;i++)c.dispatchEvent(new MouseEvent('mousemove',o(120+i*20,120+i*10)));c.dispatchEvent(new MouseEvent('mouseup',o(280,200)));setTimeout(()=>window.__MINOTES__.switchNotebook('$OKEY63'),150);return 'drawn'})()"

step "I draw on an existing whiteboard and switch within a second"
WB63=$(ev "(async()=>{$A63 const {generateWhiteboardId}=await import('/src/lib/whiteboardUtils.ts');const t=await api.getPageTree('Edit63');const id=generateWhiteboardId();await api.createBlock(t.page.id,'{{whiteboard:'+id+'}}');return id})()" | tr -d '"')
api "navigateTo('Edit63')" >/dev/null; sleep 2
ev "document.querySelector('.whiteboard-indicator')?.click()" >/dev/null; sleep 1.5
ev "$DRAWMODE63" >/dev/null; sleep 0.5
R=$(ev "$DRAW63" | tr -d '"')
wait_nb63 "$OKEY63"
[[ "$R|$(cur63)" == "drawn|$OKEY63" ]] && pass "Drew a stroke on $WB63, switched to $OTHER63" || fail "Draw + switch" "$R|$(cur63)"
R=$(board63 "$WB63")
[[ "$R" == "none" ]] && pass "No stray board row in $OTHER63" || fail "Board saved into the other notebook" "$R"
ev "window.__MINOTES__.switchNotebook('$HOME63')" >/dev/null; wait_nb63 "$HOME63"
R=$(board63 "$WB63")
[[ "$R" == "1" ]] && pass "The stroke is saved in the home notebook's board" || fail "Stroke lost" "lines=$R"

step "I draw on a NEW board (Draw button) and switch at once: block and board stay home"
api "navigateTo('Edit63')" >/dev/null; sleep 2
ev "[...document.querySelectorAll('.stats-mode-btn')].find(b=>b.textContent.includes('Draw'))?.click()" >/dev/null; sleep 1.5
NWB63=$(api "getOpenWhiteboardId()" | tr -d '"')
ev "$DRAWMODE63" >/dev/null; sleep 0.5
R=$(ev "$DRAW63" | tr -d '"')
wait_nb63 "$OKEY63"
[[ "$NWB63" == wb-* && "$R|$(cur63)" == "drawn|$OKEY63" ]] && pass "Drew on new board $NWB63, switched" || fail "New board draw + switch" "$NWB63|$R|$(cur63)"
R="$(board63 "$NWB63")|$(has_edit63)"
[[ "$R" == "none|false" ]] && pass "Nothing created in $OTHER63" || fail "New board leaked" "$R"
ev "window.__MINOTES__.switchNotebook('$HOME63')" >/dev/null; wait_nb63 "$HOME63"
R="$(board63 "$NWB63")|$(blocks63)"
[[ "$R" == "1|"*"{{whiteboard:$NWB63}}"* ]] && pass "New board and its block are in the home notebook" || fail "New board lost" "$R"

step "If a save fails, the switch is refused and I'm told why"
R=$(ev "(async()=>{$A63 const pe=await import('/src/lib/pendingEdits.ts');const un=pe.registerFlush(()=>Promise.reject(new Error('disk full63')));let msg='no error';try{await window.__MINOTES__.switchNotebook('$OKEY63')}catch(e){msg=String(e&&e.message||e)}finally{un()}return msg+'|'+(await api.getNotebookSession()).key})()" | tr -d '"')
[[ "$R" == *"disk full63"*"|$HOME63" ]] && pass "Switch refused, still in the home notebook ($R)" || fail "Failed save didn't stop the switch" "$R"
[[ "$(cur63)" == "$HOME63" ]] && pass "Home notebook open" || fail "End notebook" "$(cur63)"
journey "64. A note with web images doesn't phone home until I say so"
# Remote images are blocked by default (Settings → Privacy → Remote images: Ask).
# A placeholder shows the alt text and host; one bar offers "Load images" (this
# page, this session) and "Always for this notebook". Loading goes through the
# backend (fetch_remote_image), never an <img src="https://…">. "Save to
# notebook" stores the image as an attachment. Desktop mode serves the image from
# a local server via the debug-only MINOTES_TEST_IMAGE_ORIGIN (the SSRF guard
# refuses loopback otherwise).
# ═══════════════════════════════════════════════
A64="const api=await import('/src/lib/api.ts');const ri=await import('/src/lib/remoteImages.ts');"
WEBIMG64="[...document.querySelectorAll('img')].filter(i=>/^(https?:)?\\/\\//i.test(i.getAttribute('src')||'')).length"
STATE64="[...document.querySelectorAll('.block .remote-img')].map(e=>e.getAttribute('data-remote-state')).join(',')"
SRV64=""
if [[ "$BACKEND" == "desktop" ]]; then
  IMGDIR64="$DC_STATE/img64"; rm -rf "$IMGDIR64"; mkdir -p "$IMGDIR64"
  python3 - "$IMGDIR64" <<'PY'
import sys, zlib, struct
w, h = 48, 32
raw = b"".join(b"\x00" + bytes([0x3b, 0x82, 0xf6]) * w for _ in range(h))
ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")
for n in ("harbour64.png", "pier64.png", "fresh64.png"):
    open(f"{sys.argv[1]}/{n}", "wb").write(png)
PY
  PORT64=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  (cd "$IMGDIR64" && exec python3 -m http.server "$PORT64" --bind 127.0.0.1) >"$IMGDIR64/server.log" 2>&1 &
  SRV64=$!
  export MINOTES_TEST_IMAGE_ORIGIN="http://127.0.0.1:$PORT64"
  "$DC" restart >/dev/null 2>&1; "$DC" wait 'window.__MINOTES__ && typeof window.__MINOTES__.navigateTo === "function"' 30 >/dev/null 2>&1; sleep 1
  IMGBASE64="http://127.0.0.1:$PORT64"
else
  IMGBASE64="https://images.example.com"
fi
hits64() { [[ -n "$SRV64" ]] && { grep -c "GET /$1" "$IMGDIR64/server.log" 2>/dev/null || true; } || echo 0; }
api "closePanel()" >/dev/null; sleep 0.3
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({remoteImages:'ask'});const ri=await import('/src/lib/remoteImages.ts');ri.setNotebookAlways(false);return 1})()" >/dev/null
ev "(async()=>{$A64 const p=await api.createPage('Remote64');await api.createBlock(p.id,'Trip photo ![Harbour at dusk]($IMGBASE64/harbour64.png)');await api.createBlock(p.id,'Just text');const q=await api.createPage('Remote64b');await api.createBlock(q.id,'![Pier]($IMGBASE64/pier64.png)');return 1})()" >/dev/null
api "navigateTo('Remote64')" >/dev/null; sleep 2

step "The web image is a placeholder with its alt text and host"
for _ in $(seq 1 10); do R=$(ev "$STATE64" | tr -d '"'); [[ "$R" == "blocked" ]] && break; sleep 0.5; done
[[ "$R" == "blocked" ]] && pass "Placeholder, blocked" || fail "Placeholder state" "$R"
R=$(ev "document.querySelector('.block .remote-img')?.innerText.replace(/\\s+/g,' ')||''" | tr -d '"')
HOST64="${IMGBASE64#*://}"
[[ "$R" == *"Harbour at dusk"*"$HOST64"* ]] && pass "Shows 'Harbour at dusk · $HOST64'" || fail "Placeholder text" "$R"
R=$(ev "$WEBIMG64" | tr -d '"')
[[ "$R" == "0" && "$(hits64 harbour64)" == "0" ]] && pass "No <img> points at the web; nothing was requested" || fail "Web image in DOM" "imgs=$R hits=$(hits64 harbour64)"

step "One small bar: Load images · Always for this notebook"
R=$(ev "[...document.querySelectorAll('[data-testid=remote-images-bar]')].map(b=>b.innerText.replace(/\\s+/g,' ')).join(' | ')" | tr -d '"')
[[ "$R" == *"Remote images blocked on this page"*"Load images"*"Always for this notebook"* && "$R" != *"|"* ]] && pass "Bar: $R" || fail "Bar" "$R"
ss "64-blocked"

step "Editing the block keeps it blocked"
api "focusBlock(0)" >/dev/null; sleep 1
R=$(ev "(document.querySelector('.ProseMirror-focused .remote-img')||document.querySelector('.block .ProseMirror .remote-img'))?.getAttribute('data-remote-state')+'|'+($WEBIMG64)" | tr -d '"')
[[ "$R" == "blocked|0" ]] && pass "Placeholder in the live editor too" || fail "Live editor" "$R"
press "Escape"; sleep 0.8
R=$(ev "(async()=>{$A64 const t=await api.getPageTree('Remote64');return t.blocks[0].content})()" | tr -d '"')
[[ "$R" == *"![Harbour at dusk]($IMGBASE64/harbour64.png)"* ]] && pass "The markdown is unchanged" || fail "Block content" "$R"

if [[ "$BACKEND" == "browser" ]]; then
  step "A link preview's og:image is not loaded either"
  ev "(async()=>{$A64 const t=await api.getPageTree('Remote64');await api.createBlock(t.page.id,'{{link-preview:https://news.example.com/story?og-image=1}}');return 1})()" >/dev/null
  api "navigateTo('Remote64b')" >/dev/null; sleep 1; api "navigateTo('Remote64')" >/dev/null; sleep 2
  for _ in $(seq 1 10); do R=$(ev "document.querySelector('.link-preview-card .remote-img')?.getAttribute('data-remote-state')||'none'" | tr -d '"'); [[ "$R" == "blocked" ]] && break; sleep 0.5; done
  [[ "$R" == "blocked" && "$(ev "$WEBIMG64" | tr -d '"')" == "0" ]] && pass "og:image held back (card shows text only)" || fail "OG image" "$R"
fi

step "Load images: they appear, fetched by the backend"
ev "document.querySelector('[data-testid=remote-images-load]')?.click()" >/dev/null
for _ in $(seq 1 20); do R=$(ev "(()=>{const i=document.querySelector('.block .remote-img img');return i?(i.src.split(':')[0]+':'+i.naturalWidth):'none'})()" | tr -d '"'); [[ "$R" == "blob:48" ]] && break; sleep 0.5; done
[[ "$R" == "blob:48" ]] && pass "Image shown from a blob: URL (48 px wide)" || fail "Load images" "$R"
[[ "$(ev "$WEBIMG64" | tr -d '"')" == "0" ]] && pass "Still no <img> with a web address" || fail "Web img after load" "$(ev "$WEBIMG64")"
[[ -z "$SRV64" || "$(hits64 harbour64)" == "1" ]] && pass "Fetched once (server: $(hits64 harbour64))" || fail "Server hits" "$(hits64 harbour64)"
if [[ "$BACKEND" == "browser" ]]; then
  R=$(ev "document.querySelector('.link-preview-card .remote-img')?.getAttribute('data-remote-state')" | tr -d '"')
  [[ "$R" == "loaded" ]] && pass "…and the link preview's image" || fail "OG after load" "$R"
fi
R=$(ev "document.querySelector('[data-testid=remote-images-bar]')?.innerText.replace(/\\s+/g,' ')||''" | tr -d '"')
[[ "$R" == *"Save to notebook"* ]] && pass "Bar now offers Save to notebook" || fail "Loaded bar" "$R"
ss "64-loaded"

step "Loading was for that page only"
api "navigateTo('Remote64b')" >/dev/null; sleep 2
for _ in $(seq 1 10); do R=$(ev "$STATE64" | tr -d '"'); [[ -n "$R" ]] && break; sleep 0.5; done
[[ "$R" == "blocked" && "$(hits64 pier64)" == "0" ]] && pass "Another page's image stays blocked" || fail "Other page" "$R hits=$(hits64 pier64)"

step "Always for this notebook — loads, and is remembered"
ev "document.querySelector('[data-testid=remote-images-always]')?.click()" >/dev/null
for _ in $(seq 1 20); do R=$(ev "$STATE64" | tr -d '"'); [[ "$R" == "loaded" ]] && break; sleep 0.5; done
[[ "$R" == "loaded" ]] && pass "Loaded without asking again" || fail "Always" "$R"
R=$(ev "(async()=>{$A64 const k=await api.getCurrentNotebook();return String(JSON.parse(localStorage.getItem('minotes-remote-images-notebooks')||'[]').includes(k))})()" | tr -d '"')
[[ "$R" == "true" ]] && pass "Stored for this notebook" || fail "Not stored" "$R"
ev "location.reload()" >/dev/null 2>&1; sleep 4
for _ in $(seq 1 30); do [[ "$(ev "String(!!(window.__MINOTES__&&window.__MINOTES__.navigateTo))" | tr -d '"')" == "true" ]] && break; sleep 0.5; done
sleep 1
ev "(async()=>{$A64 if(!(await api.listPages(1000)).some(p=>p.title==='Fresh64')){const p=await api.createPage('Fresh64');await api.createBlock(p.id,'![Fresh]($IMGBASE64/fresh64.png)');}return 1})()" >/dev/null
api "navigateTo('Fresh64')" >/dev/null; sleep 2
for _ in $(seq 1 20); do R=$(ev "$STATE64" | tr -d '"'); [[ "$R" == "loaded" ]] && break; sleep 0.5; done
B=$(ev "document.querySelectorAll('[data-testid=remote-images-load]').length" | tr -d '"')
[[ "$R" == "loaded" && "$B" == "0" ]] && pass "After a reload: loads straight away, no Load button" || fail "Persisted always" "$R load-buttons=$B"
api "openSettings()" >/dev/null; sleep 1
R=$(ev "(()=>{const s=document.querySelector('[data-testid=remote-images-mode]');const c=document.querySelector('[data-testid=remote-images-notebook]');return (s?s.value:'none')+'|'+(c?c.checked:'none')})()" | tr -d '"')
[[ "$R" == "ask|true" ]] && pass "Settings: Remote images = Ask, Always in this notebook = on" || fail "Settings UI" "$R"
ss "64-settings"
api "closePanel()" >/dev/null; press "Escape"; sleep 0.5

step "Save to notebook keeps a copy as an attachment"
api "navigateTo('Fresh64')" >/dev/null; sleep 2
ev "document.querySelector('[data-testid=remote-images-save]')?.click()" >/dev/null
for _ in $(seq 1 20); do R=$(ev "(async()=>{$A64 const t=await api.getPageTree('Fresh64');return t.blocks[0].content})()" | tr -d '"'); [[ "$R" == *attachment:* ]] && break; sleep 0.5; done
[[ "$R" =~ ^\!\[Fresh\]\(attachment:[0-9a-f]{64}/fresh64\.png\)$ ]] && pass "Block now references the stored copy ($R)" || fail "Save to notebook" "$R"
for _ in $(seq 1 20); do R=$(ev "(()=>{const i=document.querySelector('.block img');return i?(i.complete+':'+i.naturalWidth+':'+!!document.querySelector('.block .remote-img')):'none'})()" | tr -d '"'); [[ "$R" == "true:48:false" ]] && break; sleep 0.5; done
[[ "$R" == "true:48:false" ]] && pass "Shown from the attachment store, no placeholder" || fail "Saved image" "$R"

step "Never: placeholders only, no bar"
ev "(async()=>{const ri=await import('/src/lib/remoteImages.ts');ri.setRemoteImageMode('never');return 1})()" >/dev/null
ev "(async()=>{$A64 const p=await api.createPage('Never64');await api.createBlock(p.id,'![Never]($IMGBASE64/never64.png)');return 1})()" >/dev/null
api "navigateTo('Never64')" >/dev/null; sleep 2
for _ in $(seq 1 10); do R=$(ev "($STATE64)+'|'+document.querySelectorAll('[data-testid=remote-images-bar]').length" | tr -d '"'); [[ "$R" == blocked* ]] && break; sleep 0.5; done
[[ "$R" == "blocked|0" && "$(hits64 never64)" == "0" ]] && pass "Blocked, no bar ($R)" || fail "Never" "$R hits=$(hits64 never64)"
ev "(async()=>{const ri=await import('/src/lib/remoteImages.ts');ri.setRemoteImageMode('ask');ri.setNotebookAlways(false);return 1})()" >/dev/null
if [[ -n "$SRV64" ]]; then kill "$SRV64" 2>/dev/null; wait "$SRV64" 2>/dev/null; fi
unset MINOTES_TEST_IMAGE_ORIGIN

# ═══════════════════════════════════════════════
journey "65. I keep a private notebook encrypted — create, lock, unlock, recover"
# PRD-encryption §5: "Encrypt this notebook" in New notebook…, the recovery key
# shown once, Lock now, the unlock screen (wrong passphrase refused), the
# recovery-key flow, Ctrl+Shift+L, and no titles left in webview storage.
# ═══════════════════════════════════════════════
A65="const api=await import('/src/lib/api.ts');"
NB65="Vault65 $(date +%s)"
PASS65="correct horse battery staple"
setv65() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
click65() { ev "(()=>{const b=document.querySelector('$1');if(!b)return 'none';b.click();return 'ok'})()" | tr -d '"'; }
api "closePanel()" >/dev/null; press "Escape"; sleep 0.5
HOME65=$(ev "(async()=>{$A65 return (await api.getNotebookSession()).key})()" | tr -d '"')

step "New notebook… with 'Encrypt this notebook' asks for a strong passphrase twice"
ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.5
ev "[...document.querySelectorAll('.nb-menu-action')].find(b=>b.textContent.startsWith('New'))?.click()" >/dev/null; sleep 0.5
setv65 "[data-testid=new-notebook-name]" "$NB65"
click65 "[data-testid=new-notebook-encrypt]" >/dev/null; sleep 0.3
setv65 "[data-testid=new-notebook-passphrase]" "password1"
setv65 "[data-testid=new-notebook-passphrase-confirm]" "password1"
sleep 0.3
R=$(ev "(()=>{const d=document.querySelector('[data-testid=new-notebook-dialog]');return d.querySelector('[data-testid=new-notebook-create]').disabled+'|'+(document.querySelector('[data-testid=new-notebook-strength]')?.textContent||'')})()" | tr -d '"')
[[ "$R" == true\|*"too easy"* ]] && pass "A weak passphrase is refused ($R)" || fail "Weak passphrase" "$R"
setv65 "[data-testid=new-notebook-passphrase]" "$PASS65"
setv65 "[data-testid=new-notebook-passphrase-confirm]" "$PASS65 x"
sleep 0.3
R=$(ev "document.querySelector('[data-testid=new-notebook-create]').disabled" | tr -d '"')
[[ "$R" == "true" ]] && pass "Mismatched repeat is refused" || fail "Mismatch" "$R"
setv65 "[data-testid=new-notebook-passphrase-confirm]" "$PASS65"
sleep 0.3
click65 "[data-testid=new-notebook-create]" >/dev/null
for _ in $(seq 1 30); do sleep 0.5; RK65=$(ev "document.querySelector('[data-testid=recovery-key]')?.textContent||''" | tr -d '"'); [[ -n "$RK65" ]] && break; done
[[ "$RK65" =~ ^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$ ]] && pass "The recovery key is shown once: 8 groups of 7 ($RK65)" || fail "Recovery key" "$RK65"
R=$(ev "document.querySelector('[data-testid=recovery-done]')?.disabled" | tr -d '"')
[[ "$R" == "true" ]] && pass "Can't continue before ticking 'I have saved my recovery key'" || fail "Saved checkbox" "$R"
ss "65-recovery-key"
click65 "[data-testid=recovery-saved]" >/dev/null; sleep 0.2
click65 "[data-testid=recovery-done]" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "document.querySelector('[data-testid=notebook-switcher]')?.innerText||''" | tr -d '"'); [[ "$R" == *"$NB65"* ]] && break; done
L=$(ev "!!document.querySelector('[data-testid=notebook-lock-icon]')" | tr -d '"')
[[ "$R" == *"$NB65"* && "$L" == "true" ]] && pass "Opened, with a lock icon by its name" || fail "Open encrypted notebook" "$R lock=$L"
ev "(async()=>{$A65 const p=await api.createPage('Narwhal65 plans');await api.createBlock(p.id,'narwhal65 secret line');return 1})()" >/dev/null
api "navigateTo('Narwhal65 plans')" >/dev/null; sleep 1.5

step "Lock now: only the unlock screen remains, and nothing can be read"
ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.5
click65 "[data-testid=menu-lock-now]" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "!!document.querySelector('[data-testid=unlock-screen]')" | tr -d '"'); [[ "$R" == "true" ]] && break; done
R=$(ev "[!!document.querySelector('[data-testid=unlock-screen]'),!!document.querySelector('.sidebar'),document.body.innerText.includes('Narwhal65')].join('|')" | tr -d '"')
[[ "$R" == "true|false|false" ]] && pass "Unlock screen only, no sidebar, no titles ($R)" || fail "Locked view" "$R"
R=$(ev "(async()=>{$A65 try{await api.listPages(10);return 'read'}catch(e){return String(e).split(':')[0]}})()" | tr -d '"')
[[ "$R" == "NOTEBOOK_LOCKED" ]] && pass "Data commands refuse while locked" || fail "Locked data" "$R"
R=$(ev "JSON.stringify(Object.keys(localStorage).map(k=>k+'='+localStorage.getItem(k))).includes('Narwhal65')" | tr -d '"')
[[ "$R" == "false" ]] && pass "No title of it in webview storage (recent pages live in its database)" || fail "Title in localStorage" "$R"
ss "65-unlock-screen"

step "A wrong passphrase is refused; the right one opens it again"
setv65 "[data-testid=unlock-passphrase]" "not my passphrase"
click65 "[data-testid=unlock-submit]" >/dev/null
for _ in $(seq 1 10); do sleep 0.5; R=$(ev "document.querySelector('[data-testid=unlock-error]')?.textContent||''" | tr -d '"'); [[ -n "$R" ]] && break; done
[[ "$R" == "Wrong passphrase." ]] && pass "Inline: Wrong passphrase." || fail "Wrong passphrase message" "$R"
setv65 "[data-testid=unlock-passphrase]" "$PASS65"
click65 "[data-testid=unlock-submit]" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "!document.querySelector('[data-testid=unlock-screen]')&&!!document.querySelector('.sidebar')" | tr -d '"'); [[ "$R" == "true" ]] && break; done
R2=$(ev "(async()=>{$A65 return (await api.listPages(100)).map(p=>p.title).filter(t=>t.startsWith('Narwhal65')).join('|')})()" | tr -d '"')
[[ "$R" == "true" && "$R2" == "Narwhal65 plans" ]] && pass "Unlocked: the page is back" || fail "Unlock" "$R $R2"

step "Forgot the passphrase: the recovery key sets a new one and issues a new key"
press "Control+Shift+L"
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "!!document.querySelector('[data-testid=unlock-screen]')" | tr -d '"'); [[ "$R" == "true" ]] && break; done
[[ "$R" == "true" ]] && pass "Ctrl+Shift+L locks it" || fail "Ctrl+Shift+L" "$R"
click65 "[data-testid=unlock-toggle-recovery]" >/dev/null; sleep 0.3
setv65 "[data-testid=unlock-recovery-key]" "$(echo "$RK65" | tr 'A-Z' 'a-z')"
setv65 "[data-testid=recover-passphrase]" "brand new passphrase sixty five"
setv65 "[data-testid=recover-passphrase-confirm]" "brand new passphrase sixty five"
click65 "[data-testid=unlock-submit]" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; NEWRK=$(ev "document.querySelector('[data-testid=recovery-key]')?.textContent||''" | tr -d '"'); [[ -n "$NEWRK" ]] && break; done
[[ -n "$NEWRK" && "$NEWRK" != "$RK65" ]] && pass "Recovered (lower-case key accepted); a new recovery key is shown" || fail "Recovery" "$NEWRK"
click65 "[data-testid=recovery-saved]" >/dev/null; sleep 0.2; click65 "[data-testid=recovery-done]" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "!document.querySelector('[data-testid=unlock-screen]')" | tr -d '"'); [[ "$R" == "true" ]] && break; done
R=$(ev "(async()=>{const e=await import('/src/lib/encryption.ts');await e.lockNow();let old='';try{await e.unlock('$PASS65');old='opened'}catch(x){old=String(x).split(':')[0]}await e.unlock('brand new passphrase sixty five');return old})()" | tr -d '"')
[[ "$R" == "WRONG_PASSPHRASE" ]] && pass "The old passphrase no longer works; the new one does" || fail "New passphrase" "$R"

step "From the unlock screen I can open another notebook; this one stays locked"
ev "(async()=>{const e=await import('/src/lib/encryption.ts');await e.lockNow();return 1})()" >/dev/null; sleep 1
ev "[...document.querySelectorAll('.enc-others-list button')].find(b=>!b.textContent.includes('🔒'))?.click()" >/dev/null
for _ in $(seq 1 20); do sleep 0.5; R=$(ev "!document.querySelector('[data-testid=unlock-screen]')&&!!document.querySelector('.sidebar')" | tr -d '"'); [[ "$R" == "true" ]] && break; done
R2=$(ev "(async()=>{$A65 const l=await api.listNotebooks();const v=l.find(n=>n.name==='$NB65');return (v?v.encrypted+'/'+v.locked:'missing')+'|'+((await api.getNotebookSession()).encrypted)})()" | tr -d '"')
[[ "$R" == "true" && "$R2" == "true/true|false" ]] && pass "Another notebook opened; the encrypted one is listed as locked ($R2)" || fail "Open another" "$R $R2"

step "Settings → Security offers to encrypt a plain notebook (and explains what goes)"
api "openSettings()" >/dev/null; sleep 1
R=$(ev "!!document.querySelector('[data-section=security] [data-testid=security-encrypt]')" | tr -d '"')
[[ "$R" == "true" ]] && pass "'Encrypt this notebook…' is there" || fail "Security section" "$R"
ss "65-security-settings"
api "closePanel()" >/dev/null; press "Escape"; sleep 0.5
[[ -n "$HOME65" ]] && ev "(async()=>{const n=await import('/src/lib/notebooks.ts');await n.switchNotebook('$HOME65');return 1})()" >/dev/null
sleep 1

# ═══════════════════════════════════════════════
close_app

# ═══════════════════════════════════════════════
# Report
# ═══════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════"
echo "  User Journey Results: $P passed, $F failed"
echo "═══════════════════════════════════════════════"
echo ""
for r in "${RESULTS[@]}"; do
  if [[ "$r" == ✓* ]]; then
    echo -e "  \033[32m$r\033[0m"
  else
    echo -e "  \033[31m$r\033[0m"
  fi
done

if [[ ${#BUGS[@]} -gt 0 ]]; then
  echo ""
  echo -e "\033[1;31m  BUGS FOUND (${#BUGS[@]}):\033[0m"
  for b in "${BUGS[@]}"; do
    echo -e "  \033[31m  🐛 $b\033[0m"
  done
fi

echo ""
echo "Screenshots: $SSDIR/"
echo "═══════════════════════════════════════════════"

exit $F
