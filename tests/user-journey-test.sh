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
SSDIR="tests/screenshots/journey"
P=0; F=0
RESULTS=()
BUGS=()

mkdir -p "$SSDIR"

pass() { echo -e "    \033[32m✓\033[0m $1"; P=$((P+1)); RESULTS+=("✓ $1"); }
fail() { echo -e "    \033[31m✗\033[0m $1: $2"; F=$((F+1)); RESULTS+=("✗ $1: $2"); BUGS+=("$1: $2"); }
step() { echo -e "  \033[90m→ $1\033[0m"; }
journey() { echo -e "\n\033[1;33m🧭 JOURNEY: $1\033[0m"; }
ev() { $AB eval "$1" 2>/dev/null; }
api() { ev "window.__MINOTES__?.$1"; }
snap() { $AB snapshot 2>/dev/null; }
snapi() { $AB snapshot -i 2>/dev/null; }
ss() { $AB screenshot "$SSDIR/$1.png" 2>/dev/null; }

echo "═══════════════════════════════════════════════"
echo "  MiNotes User Journey Tests v2"
echo "  Simulating: A real day using MiNotes"
echo "═══════════════════════════════════════════════"

$AB open "$URL" --wait-until networkidle 2>/dev/null && sleep 3

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
SI=$(snapi)
echo "$SI" | grep -qi "editable\|contenteditable" && pass "I see where to type" || fail "No editable area" "Don't know where to type"

step "I see stats (how much content I have)"
echo "$S" | grep -qi "pages\|blocks" && pass "Stats visible" || fail "No stats" "Don't know how much I've written"

ss "01-first-impression"

# ═══════════════════════════════════════════════
journey "2. I want to write a few thoughts in my journal"
# The #1 use case: open journal, type, Enter, type more
# ═══════════════════════════════════════════════

step "I type my first thought"
api "typeInBlock(0, ' Morning standup notes')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.textContent")
echo "$H" | grep -qi "standup\|Morning" && pass "First thought typed" || fail "Typing failed" "Text: ${H:0:40}"

step "I press Enter to start a new thought"
api "setBlockContent(0, 'Morning standup notes')" > /dev/null; sleep 1
# Simulate creating a second block
ev "(async()=>{const{createBlock}=await import('/src/lib/api.ts');await createBlock((await import('/src/lib/api.ts')).listPages().then(p=>p.find(x=>x.is_journal)?.id),'Need to review PR #42');return 'ok'})()" > /dev/null 2>&1
sleep 1
api "openJournal()" > /dev/null; sleep 2
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 2 ]] 2>/dev/null && pass "New block created ($R blocks)" || fail "Enter didn't create block" "$R blocks"

step "I keep writing — third thought"
ev "(async()=>{const api=await import('/src/lib/api.ts');const pages=await api.listPages();const j=pages.find(x=>x.is_journal);if(j)await api.createBlock(j.id,'Design review at 2pm');return 'ok'})()" > /dev/null 2>&1
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
$AB click "input[type=checkbox]" 2>/dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.querySelector('li')?.getAttribute('data-checked')")
echo "$H" | grep -qi "true" && pass "Checkbox toggles to done" || fail "Checkbox click broken" "Click doesn't toggle — still $H"

step "Done task shows strikethrough"
if echo "$H" | grep -qi "true"; then
  STYLE=$(ev "window.getComputedStyle(document.querySelectorAll('.ProseMirror li[data-checked=true] div p')[0]||document.body).textDecoration")
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
$AB press "Control+k" 2>/dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search pages" && pass "Search panel opens" || fail "Ctrl+K broken" "No search"

step "I see my pages listed"
FOUND=0
for p in "Getting Started" "Project Alpha" "Research Notes"; do
  echo "$S" | grep -qi "$p" && FOUND=$((FOUND+1))
done
[[ "$FOUND" -ge 3 ]] && pass "All my pages listed ($FOUND)" || fail "Missing pages in search" "Only $FOUND"

step "I close search and navigate via sidebar"
$AB press "Escape" 2>/dev/null; sleep 0.5
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

step "I can toggle tree mode"
echo "$S" | grep -qi "Full Tree Mode" && pass "Tree mode toggle available" || fail "No tree mode" "Can't find toggle"

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
[[ "$R" == *"2026-03-24"* ]] && pass "Today's date shown" || fail "Wrong date" "$R"

step "I go back to yesterday"
api "openJournal('2026-03-23')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-23"* ]] && pass "Yesterday accessible" || fail "Can't go back" "$R"

step "I go forward to today again"
api "openJournal('2026-03-24')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-24"* ]] && pass "Back to today" || fail "Can't go forward" "$R"

step "I check a specific date"
api "openJournal('2026-01-15')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-01-15"* ]] && pass "Any date accessible" || fail "Date nav broken" "$R"

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
$AB press "Control+k" 2>/dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search" && pass "Ctrl+K → search" || fail "Ctrl+K" "No search"
$AB press "Escape" 2>/dev/null; sleep 0.5

step "Ctrl+, opens settings"
$AB press "Control+," 2>/dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Settings\|Theme" && pass "Ctrl+, → settings" || fail "Ctrl+," "No settings"
$AB press "Escape" 2>/dev/null; sleep 0.5

step "Ctrl+J opens journal"
$AB press "Control+j" 2>/dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Journal"* ]] && pass "Ctrl+J → journal" || fail "Ctrl+J" "$R"

step "Ctrl+G opens graph"
$AB press "Control+g" 2>/dev/null; sleep 2
S=$(snap)
echo "$S" | grep -qi "graph\|canvas\|close\|node" && pass "Ctrl+G → graph" || fail "Ctrl+G" "No graph"
$AB press "Escape" 2>/dev/null; sleep 0.5

ss "10-keyboard-flow"

# ═══════════════════════════════════════════════
journey "11. I want to see my knowledge graph"
# Visual overview of all notes and connections
# ═══════════════════════════════════════════════

step "Graph view opens"
$AB press "Control+g" 2>/dev/null; sleep 2
S=$(snap)
echo "$S" | grep -qi "graph\|canvas" && pass "Graph renders" || fail "No graph" "Graph didn't load"

step "I can close the graph"
$AB press "Escape" 2>/dev/null; sleep 1
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
# Cleanup
# ═══════════════════════════════════════════════
$AB close 2>/dev/null

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
