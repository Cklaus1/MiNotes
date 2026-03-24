#!/bin/bash
# MiNotes UX Automated Test Suite
# Uses agent-browser to test the editor UX
#
# Prerequisites:
#   - agent-browser installed and Chrome available
#   - MiNotes running on http://localhost:1420
#
# Usage:
#   ./tests/ux-test.sh
#
# The script tests each UX feature and reports pass/fail.

set -e

AB="agent-browser"
URL="http://localhost:1420"
PASS=0
FAIL=0
TESTS=()

# Colors
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
NC="\033[0m"

log_pass() {
  echo -e "${GREEN}✓ PASS${NC}: $1"
  PASS=$((PASS + 1))
  TESTS+=("PASS: $1")
}

log_fail() {
  echo -e "${RED}✗ FAIL${NC}: $1 — $2"
  FAIL=$((FAIL + 1))
  TESTS+=("FAIL: $1 — $2")
}

log_info() {
  echo -e "${YELLOW}→${NC} $1"
}

# Wait for a condition with timeout
wait_for() {
  local desc="$1"
  local check_cmd="$2"
  local timeout="${3:-5}"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if eval "$check_cmd" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

echo "================================================"
echo "  MiNotes UX Automated Test Suite"
echo "================================================"
echo ""

# ─── Setup ───
log_info "Opening MiNotes..."
$AB open "$URL" --wait-until networkidle 2>/dev/null || {
  echo "ERROR: Could not open MiNotes. Is it running on $URL?"
  exit 1
}
sleep 2

# Take initial screenshot
$AB screenshot tests/screenshots/01-initial.png 2>/dev/null
log_info "Initial screenshot captured"

# ─── Test 1: App Loads ───
log_info "Test 1: App loads and shows content"
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "MiNotes\|journal\|block\|page"; then
  log_pass "App loaded successfully"
else
  log_fail "App load" "No MiNotes content found in snapshot"
fi

# ─── Test 2: Sidebar Visible ───
log_info "Test 2: Sidebar is visible"
SNAPSHOT=$($AB snapshot -i --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "sidebar\|search\|journal\|project"; then
  log_pass "Sidebar visible with navigation"
else
  log_fail "Sidebar" "No sidebar elements found"
fi

# ─── Test 3: Create a New Page ───
log_info "Test 3: Create a new page via + New button"
# Find and click the New button
$AB snapshot -i 2>/dev/null | head -20
NEW_REF=$($AB snapshot -i --json 2>/dev/null | grep -o '@e[0-9]*' | head -20)
log_info "Found refs: $NEW_REF"

# Try clicking the search/new area
$AB press "Control+n" 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/02-new-page-prompt.png 2>/dev/null

# ─── Test 4: Journal Opens ───
log_info "Test 4: Open journal via Ctrl+J"
$AB press "Control+j" 2>/dev/null || true
sleep 2
$AB screenshot tests/screenshots/03-journal.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "journal"; then
  log_pass "Journal opened via Ctrl+J"
else
  log_fail "Journal" "Journal content not found after Ctrl+J"
fi

# ─── Test 5: Block Editor Focus ───
log_info "Test 5: Block editor auto-focus"
# Check if there's a focused/editable area
SNAPSHOT=$($AB snapshot -i --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "textbox\|editor\|contenteditable\|prosemirror"; then
  log_pass "Block editor is present and interactive"
else
  log_fail "Block editor" "No editable area found"
fi

# ─── Test 6: Type in Block ───
log_info "Test 6: Type text in a block"
$AB press "Control+j" 2>/dev/null || true
sleep 1
# Click into the content area
$AB click "text=Type something" 2>/dev/null || $AB click "[class*=ProseMirror]" 2>/dev/null || true
sleep 0.5
$AB type "Hello from agent-browser test" 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/04-typed-text.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "Hello from agent-browser"; then
  log_pass "Text typed successfully in block"
else
  log_fail "Type in block" "Typed text not found in snapshot"
fi

# ─── Test 7: Enter Creates New Block ───
log_info "Test 7: Enter creates a new block"
$AB press "Enter" 2>/dev/null || true
sleep 1
$AB type "Second block from test" 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/05-two-blocks.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "Second block from test"; then
  log_pass "Enter created new block with typed text"
else
  log_fail "Enter new block" "Second block text not found"
fi

# ─── Test 8: Search Panel (Ctrl+K) ───
log_info "Test 8: Search panel opens with Ctrl+K"
$AB press "Control+k" 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/06-search-panel.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "search\|command"; then
  log_pass "Search/command palette opened"
else
  log_fail "Search panel" "Search panel not found"
fi
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 9: Settings Panel (Ctrl+,) ───
log_info "Test 9: Settings panel opens with Ctrl+,"
$AB press "Control+," 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/07-settings.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "settings\|theme\|tree mode\|keyboard"; then
  log_pass "Settings panel opened"
else
  log_fail "Settings panel" "Settings content not found"
fi
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 10: Graph View (Ctrl+G) ───
log_info "Test 10: Graph view opens with Ctrl+G"
$AB press "Control+g" 2>/dev/null || true
sleep 2
$AB screenshot tests/screenshots/08-graph.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "graph\|canvas\|node"; then
  log_pass "Graph view opened"
else
  log_fail "Graph view" "Graph content not found"
fi
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 11: Slash Commands ───
log_info "Test 11: Slash commands popup"
$AB press "Control+j" 2>/dev/null || true
sleep 1
$AB press "Enter" 2>/dev/null || true
sleep 0.5
$AB type "/" 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/09-slash-menu.png 2>/dev/null
SNAPSHOT=$($AB snapshot --json 2>/dev/null || echo "{}")
if echo "$SNAPSHOT" | grep -qi "heading\|bullet\|todo\|code\|divider"; then
  log_pass "Slash command menu appeared"
else
  log_fail "Slash commands" "Slash menu items not found"
fi
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 12: Visual Regression Baseline ───
log_info "Test 12: Capturing visual baseline"
$AB press "Control+j" 2>/dev/null || true
sleep 1
$AB screenshot tests/screenshots/10-baseline.png --full 2>/dev/null || $AB screenshot tests/screenshots/10-baseline.png 2>/dev/null
log_pass "Visual baseline captured"

# ─── Cleanup ───
$AB close 2>/dev/null || true

# ─── Report ───
echo ""
echo "================================================"
echo "  Test Results: ${PASS} passed, ${FAIL} failed"
echo "================================================"
for t in "${TESTS[@]}"; do
  if [[ "$t" == PASS* ]]; then
    echo -e "  ${GREEN}✓${NC} ${t#PASS: }"
  else
    echo -e "  ${RED}✗${NC} ${t#FAIL: }"
  fi
done
echo ""
echo "Screenshots saved to tests/screenshots/"
echo "================================================"

exit $FAIL
