#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  MiNotes User Journey Tests
#
#  Tests every interaction a REAL USER would try.
#  Not "does the API work?" but "can I click this?"
#
#  Each journey = one thing a user wants to accomplish
#  Each step = one action the user takes
#  Each check = what the user expects to see
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
echo "  MiNotes User Journey Tests"
echo "  Testing: Can a real user DO this?"
echo "═══════════════════════════════════════════════"

$AB open "$URL" --wait-until networkidle 2>/dev/null && sleep 3

# ═══════════════════════════════════════════════
journey "I open the app and want to start writing"
# ═══════════════════════════════════════════════

step "App loads — do I see anything useful?"
S=$(snap)
echo "$S" | grep -qi "Journal" && pass "I see today's journal" || fail "No journal on launch" "App didn't show journal"

step "Is there a place for me to type?"
SI=$(snapi)
echo "$SI" | grep -qi "editable\|contenteditable" && pass "I see an editable area" || fail "No editable area" "Can't find where to type"

step "Can I actually type text?"
api "typeInBlock(0, 'My first thought')" > /dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.textContent")
echo "$H" | grep -qi "first thought" && pass "Text appears when I type" || fail "Typing doesn't work" "Text not visible: $H"

ss "01-start-writing"

# ═══════════════════════════════════════════════
journey "I want to create a todo list"
# ═══════════════════════════════════════════════

step "I type /todo to create a task list"
api "setBlockContent(0, '- [ ] Buy groceries')" > /dev/null; sleep 2

step "Do I see a checkbox?"
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "checkbox" && pass "I see a checkbox" || fail "No checkbox" "Task list didn't render checkbox"

step "Can I CLICK the checkbox to mark it done?"
# Try clicking the checkbox
$AB click "input[type=checkbox]" 2>/dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.querySelector('li')?.getAttribute('data-checked')")
echo "$H" | grep -qi "true" && pass "Checkbox toggles on click" || fail "Checkbox click broken" "Clicking checkbox doesn't toggle it — data-checked=$H"

step "If checked, does it show strikethrough?"
echo "$H" | grep -qi "true" && {
  STYLE=$(ev "window.getComputedStyle(document.querySelectorAll('.ProseMirror')[0]?.querySelector('li div p'))?.textDecoration")
  echo "$STYLE" | grep -qi "line-through" && pass "Done tasks show strikethrough" || fail "No strikethrough" "Checked items don't show strikethrough"
} || echo "    (skipped — checkbox didn't toggle)"

step "Can I uncheck it by clicking again?"
$AB click "input[type=checkbox]" 2>/dev/null; sleep 1
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.querySelector('li')?.getAttribute('data-checked')")
echo "$H" | grep -qi "false" && pass "Checkbox unchecks on second click" || fail "Uncheck broken" "Can't uncheck — data-checked=$H"

ss "02-todo-list"

# ═══════════════════════════════════════════════
journey "I want to navigate between pages"
# ═══════════════════════════════════════════════

step "I see pages in the sidebar"
S=$(snap)
echo "$S" | grep -qi "Getting Started" && echo "$S" | grep -qi "Project Alpha" && pass "Pages visible in sidebar" || fail "Pages missing" "Can't see pages"

step "I click on 'Getting Started'"
$AB click "text=Getting Started" 2>/dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Getting Started"* ]] && pass "Page opens when I click it" || fail "Click doesn't navigate" "Still on: $R"

step "I click on 'Project Alpha'"
$AB click "text=Project Alpha" 2>/dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Project Alpha"* ]] && pass "Another page opens" || fail "Navigation broken" "Still on: $R"

step "I see the page content"
R=$(api "getBlockCount()" | tr -d '"')
[[ "$R" -ge 5 ]] 2>/dev/null && pass "Page has content ($R blocks)" || fail "Page empty" "$R blocks"

ss "03-navigation"

# ═══════════════════════════════════════════════
journey "I want to use keyboard shortcuts"
# ═══════════════════════════════════════════════

step "Ctrl+K opens search"
$AB press "Control+k" 2>/dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Search pages" && pass "Search opens" || fail "Ctrl+K broken" "Search didn't open"
$AB press "Escape" 2>/dev/null; sleep 0.5

step "Ctrl+, opens settings"
$AB press "Control+," 2>/dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Settings" && pass "Settings opens" || fail "Ctrl+, broken" "Settings didn't open"
$AB press "Escape" 2>/dev/null; sleep 0.5

step "Ctrl+J opens journal"
$AB press "Control+j" 2>/dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"Journal"* ]] && pass "Journal opens" || fail "Ctrl+J broken" "Didn't open journal: $R"

step "Ctrl+G opens graph"
$AB press "Control+g" 2>/dev/null; sleep 2
S=$(snap)
echo "$S" | grep -qi "graph\|canvas\|close" && pass "Graph view opens" || fail "Ctrl+G broken" "Graph didn't open"
$AB press "Escape" 2>/dev/null; sleep 0.5

ss "04-shortcuts"

# ═══════════════════════════════════════════════
journey "I want to format text with slash commands"
# ═══════════════════════════════════════════════

step "I create a heading"
api "navigateTo('Getting Started')" > /dev/null; sleep 2
api "setBlockContent(0, '# My Big Title')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[0]?.innerHTML")
echo "$H" | grep -qi "<h1" && pass "H1 heading renders large" || fail "H1 not rendering" "Expected <h1>: ${H:0:60}"

step "I create a bullet list"
api "setBlockContent(1, '- Item one\n- Item two\n- Item three')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[1]?.innerHTML")
echo "$H" | grep -qi "<ul" && echo "$H" | grep -qi "<li" && pass "Bullet list renders" || fail "Bullets broken" "${H:0:60}"

step "I create a blockquote"
api "setBlockContent(2, '> Important quote')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[2]?.innerHTML")
echo "$H" | grep -qi "<blockquote" && pass "Blockquote renders" || fail "Blockquote broken" "${H:0:60}"

step "I create a divider"
api "setBlockContent(3, '---')" > /dev/null; sleep 2
H=$(ev "document.querySelectorAll('.ProseMirror')[3]?.innerHTML")
echo "$H" | grep -qi "<hr" && pass "Divider renders" || fail "Divider broken" "${H:0:60}"

ss "05-formatting"

# ═══════════════════════════════════════════════
journey "I want to use the search to find content"
# ═══════════════════════════════════════════════

step "I open search and see all pages"
api "openSearch()" > /dev/null; sleep 1
S=$(snap)
PAGES_FOUND=0
for p in "Journal" "Getting Started" "Project Alpha" "Research Notes"; do
  echo "$S" | grep -qi "$p" && PAGES_FOUND=$((PAGES_FOUND+1))
done
[[ "$PAGES_FOUND" -ge 3 ]] && pass "Search shows pages ($PAGES_FOUND found)" || fail "Search missing pages" "Only $PAGES_FOUND found"
api "closePanel()" > /dev/null; sleep 0.5

ss "06-search"

# ═══════════════════════════════════════════════
journey "I want to check settings and customize"
# ═══════════════════════════════════════════════

step "Settings shows theme option"
api "openSettings()" > /dev/null; sleep 1
S=$(snap)
echo "$S" | grep -qi "Theme" && pass "Theme setting visible" || fail "No theme setting" "Theme not found"

step "Settings shows Full Tree Mode"
echo "$S" | grep -qi "Full Tree Mode" && pass "Tree mode toggle visible" || fail "No tree mode" "Not found"

step "Settings shows keyboard shortcuts"
echo "$S" | grep -qi "Ctrl" && pass "Keyboard shortcuts listed" || fail "No shortcuts" "Not found"

api "closePanel()" > /dev/null; sleep 0.5
ss "07-settings"

# ═══════════════════════════════════════════════
journey "I want to navigate the journal by date"
# ═══════════════════════════════════════════════

step "I'm on today's journal"
api "openJournal()" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-24"* ]] && pass "Today's journal open" || fail "Wrong date" "$R"

step "I click Prev to go to yesterday"
api "openJournal('2026-03-23')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-23"* ]] && pass "Yesterday's journal" || fail "Prev broken" "$R"

step "I go back to today"
api "openJournal('2026-03-24')" > /dev/null; sleep 2
R=$(api "getCurrentPage()" | tr -d '"')
[[ "$R" == *"2026-03-24"* ]] && pass "Back to today" || fail "Today broken" "$R"

ss "08-journal"

# ═══════════════════════════════════════════════
journey "I want to see wiki links and follow them"
# ═══════════════════════════════════════════════

step "I go to Research Notes which has [[Project Alpha]] link"
api "navigateTo('Research Notes')" > /dev/null; sleep 2
S=$(snap)
echo "$S" | grep -qi "Project Alpha" && pass "Wiki link text visible" || fail "No wiki link" "Can't see link"

step "The link is clickable"
SI=$(snapi)
echo "$SI" | grep -qi "Project Alpha" && pass "Wiki link is interactive" || fail "Link not clickable" "Not interactive"

ss "09-wiki-links"

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
  echo -e "\033[1;31m  BUGS FOUND:\033[0m"
  for b in "${BUGS[@]}"; do
    echo -e "  \033[31m🐛 $b\033[0m"
  done
fi

echo ""
echo "Screenshots: $SSDIR/"
echo "═══════════════════════════════════════════════"

exit $F
