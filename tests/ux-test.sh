#!/bin/bash
# MiNotes UX Automated Test Suite
# Uses agent-browser to test the editor UX with mock backend
#
# Prerequisites:
#   - agent-browser installed and Chrome available
#   - MiNotes dev server running on http://localhost:1420
#
# Usage:
#   ./tests/ux-test.sh

set -euo pipefail

AB="agent-browser"
URL="http://localhost:1420"
PASS=0
FAIL=0
TESTS=()
SSDIR="tests/screenshots"

GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
NC="\033[0m"

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASS=$((PASS + 1)); TESTS+=("PASS: $1"); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1 — $2"; FAIL=$((FAIL + 1)); TESTS+=("FAIL: $1 — $2"); }
log_info() { echo -e "${YELLOW}→${NC} $1"; }

mkdir -p "$SSDIR"

echo "================================================"
echo "  MiNotes UX Test Suite (agent-browser)"
echo "================================================"
echo ""

# ─── Setup ───
log_info "Opening MiNotes..."
$AB open "$URL" --wait-until networkidle 2>/dev/null
sleep 3

# ─── Test 1: App Loads with Mock Data ───
log_info "Test 1: App loads with mock data"
SNAP=$($AB snapshot 2>/dev/null || echo "")
if echo "$SNAP" | grep -qi "Journal" && echo "$SNAP" | grep -qi "Getting Started"; then
  log_pass "App loaded with mock pages (Journal + Getting Started)"
else
  log_fail "App load" "Expected mock pages not found"
fi
$AB screenshot "$SSDIR/01-app-loaded.png" 2>/dev/null

# ─── Test 2: Sidebar Shows Pages ───
log_info "Test 2: Sidebar shows all mock pages"
if echo "$SNAP" | grep -qi "Project Alpha" && echo "$SNAP" | grep -qi "Research Notes"; then
  log_pass "Sidebar shows Project Alpha and Research Notes"
else
  log_fail "Sidebar pages" "Expected pages not found in sidebar"
fi

# ─── Test 3: Journal Auto-Opens ───
log_info "Test 3: Journal auto-opened on launch"
if echo "$SNAP" | grep -qi "Journal/2026"; then
  log_pass "Journal page auto-opened"
else
  log_fail "Journal auto-open" "Journal heading not found"
fi

# ─── Test 4: Block Editor is Interactive ───
log_info "Test 4: Block editor is interactive"
SNAP_I=$($AB snapshot -i 2>/dev/null || echo "")
if echo "$SNAP_I" | grep -qi "editable\|contenteditable"; then
  log_pass "Block editor is editable"
else
  log_fail "Block editor" "No editable content found"
fi

# ─── Test 5: Type in Block ───
log_info "Test 5: Type text in a block"
$AB click "[contenteditable]" 2>/dev/null || true
sleep 0.5
$AB press "End" 2>/dev/null || true
$AB type " — Agent test!" 2>/dev/null || true
sleep 1
SNAP=$($AB snapshot 2>/dev/null || echo "")
if echo "$SNAP" | grep -qi "Agent test"; then
  log_pass "Text typed successfully"
else
  log_fail "Type in block" "Typed text not found"
fi
$AB screenshot "$SSDIR/05-typed.png" 2>/dev/null

# ─── Test 6: Search Panel (Ctrl+K) ───
log_info "Test 6: Search panel (Ctrl+K)"
$AB press "Control+k" 2>/dev/null || true
sleep 1
SNAP=$($AB snapshot 2>/dev/null || echo "")
if echo "$SNAP" | grep -qi "Search pages\|command"; then
  log_pass "Search panel opened"
else
  log_fail "Search panel" "Search input not found"
fi
$AB screenshot "$SSDIR/06-search.png" 2>/dev/null
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 7: Settings Panel (Ctrl+,) ───
log_info "Test 7: Settings panel (Ctrl+,)"
$AB press "Control+," 2>/dev/null || true
sleep 1
SNAP=$($AB snapshot 2>/dev/null || echo "")
if echo "$SNAP" | grep -qi "Settings\|Theme\|Tree Mode"; then
  log_pass "Settings panel opened"
else
  log_fail "Settings panel" "Settings content not found"
fi
$AB screenshot "$SSDIR/07-settings.png" 2>/dev/null
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 8: Navigate to Page ───
log_info "Test 8: Click to navigate to Project Alpha"
$AB click "text=Project Alpha" 2>/dev/null || true
sleep 2
SNAP=$($AB snapshot 2>/dev/null || echo "")
if echo "$SNAP" | grep -qi "Project Alpha"; then
  log_pass "Navigated to Project Alpha page"
else
  log_fail "Page navigation" "Project Alpha content not found"
fi
$AB screenshot "$SSDIR/08-project-alpha.png" 2>/dev/null

# ─── Test 9: Graph View (Ctrl+G) ───
log_info "Test 9: Graph view (Ctrl+G)"
$AB press "Control+g" 2>/dev/null || true
sleep 2
SNAP=$($AB snapshot 2>/dev/null || echo "")
$AB screenshot "$SSDIR/09-graph.png" 2>/dev/null
if echo "$SNAP" | grep -qi "graph\|canvas\|Close\|nodes"; then
  log_pass "Graph view opened"
else
  log_fail "Graph view" "Graph content not found"
fi
$AB press "Escape" 2>/dev/null || true
sleep 0.5

# ─── Test 10: Journal Navigation ───
log_info "Test 10: Journal Prev/Next navigation"
$AB press "Control+j" 2>/dev/null || true
sleep 1
$AB click "text=← Prev" 2>/dev/null || true
sleep 1
SNAP=$($AB snapshot 2>/dev/null || echo "")
if echo "$SNAP" | grep -qi "Journal/2026-03-23"; then
  log_pass "Journal navigated to previous day"
else
  log_fail "Journal nav" "Previous day journal not found"
fi
$AB screenshot "$SSDIR/10-journal-prev.png" 2>/dev/null

# ─── Test 11: Annotated Screenshot ───
log_info "Test 11: Annotated screenshot for visual QA"
$AB press "Control+j" 2>/dev/null || true
sleep 1
$AB screenshot "$SSDIR/11-annotated.png" --annotate 2>/dev/null || $AB screenshot "$SSDIR/11-final.png" 2>/dev/null
log_pass "Final screenshot captured"

# ─── Cleanup ───
$AB close 2>/dev/null || true

# ─── Report ───
echo ""
echo "================================================"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "================================================"
for t in "${TESTS[@]}"; do
  if [[ "$t" == PASS* ]]; then
    echo -e "  ${GREEN}✓${NC} ${t#PASS: }"
  else
    echo -e "  ${RED}✗${NC} ${t#FAIL: }"
  fi
done
echo ""
echo "Screenshots: $SSDIR/"
echo "================================================"

exit $FAIL
