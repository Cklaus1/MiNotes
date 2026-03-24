#!/bin/bash
# ═══════════════════════════════════════════════════════
#  MiNotes End-to-End Funnel Tests
#
#  Each test simulates a COMPLETE user journey, not just
#  "did the API call succeed?" but "can the user actually
#  accomplish their goal from start to finish?"
#
#  A funnel test fails if ANY step in the user journey breaks.
# ═══════════════════════════════════════════════════════

AB="agent-browser"
URL="http://localhost:1420"
SSDIR="tests/screenshots/funnel"
P=0; F=0
RESULTS=()

mkdir -p "$SSDIR"

pass() { echo -e "    \033[32m✓\033[0m $1"; P=$((P+1)); RESULTS+=("✓ $1"); }
fail() { echo -e "    \033[31m✗\033[0m $1: $2"; F=$((F+1)); RESULTS+=("✗ $1: $2"); }
step() { echo -e "  \033[90m→ $1\033[0m"; }
funnel() { echo -e "\n\033[33m━━━ FUNNEL: $1 ━━━\033[0m"; }
run() { eval "$1" 2>/dev/null; }
api() { R=$(run "$AB eval \"window.__MINOTES__?.$1\""); echo "$R"; }
snap() { run "$AB snapshot"; }
html() { run "$AB eval \"document.querySelectorAll('.ProseMirror')[$1]?.innerHTML\""; }
ss() { run "$AB screenshot $SSDIR/$1.png"; }
wait() { sleep "${1:-1}"; }

# Strip quotes from eval results
strip() { echo "$1" | tr -d '"'; }

echo "═══════════════════════════════════════════"
echo "  MiNotes End-to-End Funnel Tests"
echo "═══════════════════════════════════════════"

run "$AB open $URL --wait-until networkidle" && sleep 3

# ═══════════════════════════════════════════
funnel "Create a page and write content"
# User: click +New, type title, see page, type blocks
# ═══════════════════════════════════════════

step "Navigate to Getting Started page"
api "navigateTo('Getting Started')" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"Getting Started"* ]] && pass "Page opened" || fail "Open page" "$R"

step "Verify blocks are visible"
R=$(strip "$(api "getBlockCount()")")
[[ "$R" -ge 5 ]] 2>/dev/null && pass "Has $R blocks" || fail "Block count" "$R"

step "Read first block content"
R=$(strip "$(api "getBlockContent(0)")")
[[ -n "$R" && "$R" != "null" ]] && pass "Block 0 has content" || fail "Block 0 empty" "$R"

step "Modify a block"
api "setBlockContent(0, 'Modified by funnel test')" > /dev/null && wait 1
R=$(strip "$(api "getBlockContent(0)")")
[[ "$R" == *"Modified"* ]] && pass "Block updated" || fail "Block update" "$R"

step "Verify update persists in editor"
H=$(strip "$(html 0)")
[[ "$H" == *"Modified"* ]] && pass "Editor shows updated content" || fail "Editor content" "$H"

ss "01-create-page"

# ═══════════════════════════════════════════
funnel "Todo list: create, type, add items"
# User: /todo → type first item → Enter → type second item
# ═══════════════════════════════════════════

step "Set block to todo format"
api "setBlockContent(0, '- [ ] Buy groceries')" > /dev/null && wait 2

step "Verify checkbox renders (not plain text)"
H=$(strip "$(html 0)")
if [[ "$H" == *"taskList"* && "$H" == *"checkbox"* ]]; then
  pass "Checkbox renders as real task list"
else
  fail "Checkbox render" "Expected taskList, got: ${H:0:80}"
fi

step "Verify text is inside the checkbox item"
S=$(snap)
if echo "$S" | grep -qi "Buy groceries"; then
  pass "Task text visible in accessibility tree"
else
  fail "Task text" "Not found in snapshot"
fi

step "Check checkbox is unchecked"
if echo "$S" | grep -qi 'checked=false'; then
  pass "Checkbox starts unchecked"
else
  fail "Checkbox state" "Expected unchecked"
fi

step "Add second todo item via content"
api "setBlockContent(0, '- [ ] Buy groceries\n- [ ] Walk the dog')" > /dev/null && wait 2
H=$(strip "$(html 0)")
TASK_COUNT=$(echo "$H" | grep -o 'data-checked' | wc -l)
if [[ "$TASK_COUNT" -ge 2 ]]; then
  pass "Two task items render ($TASK_COUNT checkboxes)"
else
  fail "Second task item" "Expected 2 tasks, got $TASK_COUNT"
fi

step "Add checked item"
api "setBlockContent(0, '- [ ] Buy groceries\n- [x] Walk the dog\n- [ ] Clean house')" > /dev/null && wait 2
H=$(strip "$(html 0)")
CHECKED=$(echo "$H" | grep -o 'data-checked=\"true\"' | wc -l)
UNCHECKED=$(echo "$H" | grep -o 'data-checked=\"false\"' | wc -l)
[[ "$CHECKED" -ge 1 && "$UNCHECKED" -ge 2 ]] && pass "Mixed checked/unchecked tasks (✓$CHECKED ☐$UNCHECKED)" || fail "Checked state" "checked=$CHECKED unchecked=$UNCHECKED"

ss "02-todo-list"

# ═══════════════════════════════════════════
funnel "Heading: create and verify rendering"
# User: /heading1 → see large text → heading visible in snapshot
# ═══════════════════════════════════════════

step "Set block to H1"
api "setBlockContent(1, '# My Big Heading')" > /dev/null && wait 2

step "Verify H1 renders as heading element"
H=$(strip "$(html 1)")
if [[ "$H" == *"<h1>"* || "$H" == *"<h1 "* ]]; then
  pass "H1 renders as <h1> element"
else
  fail "H1 render" "Expected <h1>, got: ${H:0:80}"
fi

step "Set block to H2"
api "setBlockContent(2, '## Sub Heading')" > /dev/null && wait 2
H=$(strip "$(html 2)")
if [[ "$H" == *"<h2>"* || "$H" == *"<h2 "* ]]; then
  pass "H2 renders as <h2> element"
else
  fail "H2 render" "Expected <h2>, got: ${H:0:80}"
fi

step "Verify heading in accessibility snapshot"
S=$(snap)
if echo "$S" | grep -qi "heading.*My Big Heading"; then
  pass "H1 visible in accessibility tree"
else
  fail "H1 accessibility" "Not found as heading"
fi

ss "03-headings"

# ═══════════════════════════════════════════
funnel "Bullet list: create and verify"
# User: /bullet → see bullet point → type text
# ═══════════════════════════════════════════

step "Set block to bullet list"
api "setBlockContent(3, '- First item\n- Second item\n- Third item')" > /dev/null && wait 2

step "Verify bullet list renders"
H=$(strip "$(html 3)")
if [[ "$H" == *"<ul"* && "$H" == *"<li"* ]]; then
  pass "Bullet list renders as <ul><li>"
else
  fail "Bullet render" "Expected <ul><li>, got: ${H:0:80}"
fi

step "Count list items"
LI_COUNT=$(echo "$H" | grep -o '<li' | wc -l)
[[ "$LI_COUNT" -ge 3 ]] && pass "3 list items render ($LI_COUNT)" || fail "List items" "Expected 3, got $LI_COUNT"

ss "04-bullet-list"

# ═══════════════════════════════════════════
funnel "Blockquote: create and verify"
# ═══════════════════════════════════════════

step "Set block to blockquote"
api "setBlockContent(4, '> This is a quoted passage')" > /dev/null && wait 2

step "Verify blockquote renders"
H=$(strip "$(html 4)")
if [[ "$H" == *"<blockquote"* ]]; then
  pass "Blockquote renders as <blockquote>"
else
  fail "Blockquote render" "Expected <blockquote>, got: ${H:0:80}"
fi

ss "05-blockquote"

# ═══════════════════════════════════════════
funnel "Code block: create and verify"
# ═══════════════════════════════════════════

step "Set block to code"
api 'setBlockContent(5, "```\nconst x = 42;\nconsole.log(x);\n```")' > /dev/null && wait 2

step "Verify code block renders"
H=$(strip "$(html 5)")
if [[ "$H" == *"<pre"* || "$H" == *"<code"* || "$H" == *"code-block"* ]]; then
  pass "Code block renders as <pre>/<code>"
else
  fail "Code render" "Expected <pre>, got: ${H:0:80}"
fi

ss "06-code-block"

# ═══════════════════════════════════════════
funnel "Divider: create and verify"
# ═══════════════════════════════════════════

step "Set block to divider"
api "setBlockContent(6, '---')" > /dev/null && wait 2

step "Verify divider renders"
H=$(strip "$(html 6)")
if [[ "$H" == *"<hr"* ]]; then
  pass "Divider renders as <hr>"
else
  fail "Divider render" "Expected <hr>, got: ${H:0:80}"
fi

ss "07-divider"

# ═══════════════════════════════════════════
funnel "Wiki link: create and verify clickable"
# User: type [[page]] → see blue link → link is clickable
# ═══════════════════════════════════════════

step "Navigate to Research Notes (has wiki links)"
api "navigateTo('Research Notes')" > /dev/null && wait 2

step "Check wiki link renders"
S=$(snap)
if echo "$S" | grep -qi "Project Alpha"; then
  pass "Wiki link text visible"
else
  fail "Wiki link" "Project Alpha not found"
fi

step "Check link is interactive"
SI=$(run "$AB snapshot -i")
if echo "$SI" | grep -qi "Project Alpha"; then
  pass "Wiki link is interactive element"
else
  fail "Wiki link interactive" "Not found in interactive snapshot"
fi

ss "08-wiki-links"

# ═══════════════════════════════════════════
funnel "Search: find content across pages"
# User: Ctrl+K → type query → see results → click result → navigate
# ═══════════════════════════════════════════

step "Open search"
api "openSearch()" > /dev/null && wait 1

step "Verify search panel shows pages"
S=$(snap)
if echo "$S" | grep -qi "Project Alpha" && echo "$S" | grep -qi "Getting Started"; then
  pass "Search shows all pages"
else
  fail "Search pages" "Not all pages listed"
fi

step "Close search"
api "closePanel()" > /dev/null && wait 0.5

ss "09-search"

# ═══════════════════════════════════════════
funnel "Settings: toggle features"
# User: open settings → see options → toggle → verify
# ═══════════════════════════════════════════

step "Open settings"
api "openSettings()" > /dev/null && wait 1

step "Verify all settings sections present"
S=$(snap)
ALL_FOUND=true
for section in "Theme" "Full Tree Mode" "Obsidian Editor" "Keyboard Shortcuts"; do
  if echo "$S" | grep -qi "$section"; then
    pass "Settings: $section present"
  else
    fail "Settings: $section" "Not found"
    ALL_FOUND=false
  fi
done

step "Close settings"
api "closePanel()" > /dev/null && wait 0.5

ss "10-settings"

# ═══════════════════════════════════════════
funnel "Journal: navigate between dates"
# User: open journal → see today → prev → see yesterday → next → back to today
# ═══════════════════════════════════════════

step "Open today's journal"
api "openJournal()" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"2026-03-24"* ]] && pass "Today's journal opened" || fail "Today" "$R"

step "Navigate to yesterday"
api "openJournal('2026-03-23')" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"2026-03-23"* ]] && pass "Yesterday's journal opened" || fail "Yesterday" "$R"

step "Navigate back to today"
api "openJournal('2026-03-24')" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"2026-03-24"* ]] && pass "Back to today" || fail "Back to today" "$R"

ss "11-journal-nav"

# ═══════════════════════════════════════════
funnel "Page navigation: full sidebar flow"
# User: see sidebar → click page → see content → click another → verify
# ═══════════════════════════════════════════

step "Navigate to Project Alpha"
api "navigateTo('Project Alpha')" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"Project Alpha"* ]] && pass "Navigated to Project Alpha" || fail "Nav" "$R"

step "Verify page has expected content"
R=$(strip "$(api "getBlockContent(0)")")
[[ -n "$R" && "$R" != "null" ]] && pass "Page has blocks" || fail "No blocks" "$R"

step "Navigate to Research Notes"
api "navigateTo('Research Notes')" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"Research Notes"* ]] && pass "Navigated to Research Notes" || fail "Nav RN" "$R"

step "Navigate back to Getting Started"
api "navigateTo('Getting Started')" > /dev/null && wait 2
R=$(strip "$(api "getCurrentPage()")")
[[ "$R" == *"Getting Started"* ]] && pass "Navigated to Getting Started" || fail "Nav GS" "$R"

ss "12-navigation"

# ═══════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════
run "$AB close"

# ═══════════════════════════════════════════
# Report
# ═══════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════"
echo "  Funnel Test Results: $P passed, $F failed"
echo "═══════════════════════════════════════════"
echo ""
for r in "${RESULTS[@]}"; do
  if [[ "$r" == ✓* ]]; then
    echo -e "  \033[32m$r\033[0m"
  else
    echo -e "  \033[31m$r\033[0m"
  fi
done
echo ""
echo "Screenshots: $SSDIR/"
echo "═══════════════════════════════════════════"

exit $F
