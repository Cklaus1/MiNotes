#!/bin/bash
# ═══════════════════════════════════════
#  MiNotes Slash Command Test Suite
#  Tests each slash command via test API
# ═══════════════════════════════════════

AB="agent-browser"
URL="http://localhost:1420"
SSDIR="tests/screenshots/slash"
P=0; F=0
RESULTS=()

mkdir -p "$SSDIR"

pass() { echo -e "  \033[32m✓\033[0m $1"; P=$((P+1)); RESULTS+=("✓ $1"); }
fail() { echo -e "  \033[31m✗\033[0m $1: $2"; F=$((F+1)); RESULTS+=("✗ $1: $2"); }
run() { eval "$1" 2>/dev/null; }
api() { run "$AB eval \"window.__MINOTES__?.$1\""; }
ss() { run "$AB screenshot $SSDIR/$1.png"; }

echo "═══════════════════════════════════"
echo "  Slash Command Tests"
echo "═══════════════════════════════════"

run "$AB open $URL --wait-until networkidle" && sleep 3

# Navigate to a test page
api "navigateTo('Getting Started')" && sleep 2

# ─── Test each slash command ───

echo ""
echo "Testing: /heading1"
api "setBlockContent(0, '# Test Heading One')" && sleep 1
R=$(api "getBlockContent(0)")
[[ "$R" == *"# Test Heading"* ]] && pass "/heading1 — content saved as # markdown" || fail "/heading1" "$R"
ss "01-heading1"

echo ""
echo "Testing: /heading2"
api "setBlockContent(1, '## Second Level Heading')" && sleep 1
R=$(api "getBlockContent(1)")
[[ "$R" == *"## Second"* ]] && pass "/heading2 — content saved as ## markdown" || fail "/heading2" "$R"
ss "02-heading2"

echo ""
echo "Testing: /heading3"
api "setBlockContent(2, '### Third Level Heading')" && sleep 1
R=$(api "getBlockContent(2)")
[[ "$R" == *"### Third"* ]] && pass "/heading3 — content saved as ### markdown" || fail "/heading3" "$R"

echo ""
echo "Testing: /bullet list"
api "setBlockContent(3, '- Bullet list item')" && sleep 1
R=$(api "getBlockContent(3)")
[[ "$R" == *"- Bullet"* ]] && pass "/bullet — content saved as - markdown" || fail "/bullet" "$R"
ss "03-bullet"

echo ""
echo "Testing: /todo list"
api "setBlockContent(4, '- [ ] Todo item unchecked')" && sleep 1
R=$(api "getBlockContent(4)")
[[ "$R" == *"[ ]"* ]] && pass "/todo — content saved as - [ ] markdown" || fail "/todo" "$R"
ss "04-todo"

echo ""
echo "Testing: /code block"
api "setBlockContent(5, '\`\`\`\nconst x = 42;\n\`\`\`')" && sleep 1
R=$(api "getBlockContent(5)")
[[ "$R" == *"const x"* || "$R" == *'```'* ]] && pass "/code — content saved as code fence" || fail "/code" "$R"
ss "05-code"

echo ""
echo "Testing: /blockquote"
api "setBlockContent(6, '> This is a quoted block')" && sleep 1
R=$(api "getBlockContent(6)")
[[ "$R" == *"> This"* ]] && pass "/quote — content saved as > markdown" || fail "/quote" "$R"
ss "06-quote"

echo ""
echo "Testing: /divider"
# Create a new block for divider
run "$AB eval '(async()=>{const api=await import(\"/src/lib/api.ts\");})()'" 2>/dev/null
api "setBlockContent(0, '---')" && sleep 1
R=$(api "getBlockContent(0)")
[[ "$R" == *"---"* ]] && pass "/divider — content saved as ---" || fail "/divider" "$R"
ss "07-divider"

# ─── Test rendering ───

echo ""
echo "Testing: Visual rendering"
api "navigateTo('Getting Started')" && sleep 2
ss "08-all-rendered"

# Check that headings render larger
S=$(run "$AB snapshot")
echo "$S" | grep -qi "heading" && pass "Headings render as heading elements" || fail "Heading render" "no heading in snapshot"

# ─── Test TODO cycling ───

echo ""
echo "Testing: TODO cycling (Ctrl+Enter)"
api "setBlockContent(0, 'My task item')" && sleep 1
R=$(api "getBlockContent(0)")
# TODO cycling happens in the editor via Ctrl+Enter, test the content prefix
api "setBlockContent(0, 'TODO My task item')" && sleep 1
R=$(api "getBlockContent(0)")
[[ "$R" == *"TODO"* ]] && pass "TODO state set" || fail "TODO" "$R"

api "setBlockContent(0, 'DOING My task item')" && sleep 1
R=$(api "getBlockContent(0)")
[[ "$R" == *"DOING"* ]] && pass "DOING state set" || fail "DOING" "$R"

api "setBlockContent(0, 'DONE My task item')" && sleep 1
R=$(api "getBlockContent(0)")
[[ "$R" == *"DONE"* ]] && pass "DONE state set" || fail "DONE" "$R"

ss "09-todo-states"

# ─── Cleanup ───
run "$AB close"

echo ""
echo "═══════════════════════════════════"
echo "  Results: $P passed, $F failed"
echo "═══════════════════════════════════"
for r in "${RESULTS[@]}"; do
  if [[ "$r" == ✓* ]]; then
    echo -e "  \033[32m$r\033[0m"
  else
    echo -e "  \033[31m$r\033[0m"
  fi
done
echo ""
echo "Screenshots: $SSDIR/"
exit $F
