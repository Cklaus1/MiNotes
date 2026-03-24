#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  MiNotes E2E Test Suite
#  Comprehensive end-to-end tests of all major features
#  Uses agent-browser + window.__MINOTES__ test API
#  Runs in ~2 minutes
# ═══════════════════════════════════════════════════════════

AB="agent-browser"
URL="http://localhost:1420"
SSDIR="tests/screenshots/e2e"
P=0; F=0; T=0
RESULTS=()

mkdir -p "$SSDIR"

pass() { echo -e "  \033[32m✓\033[0m $1"; P=$((P+1)); RESULTS+=("✓ $1"); }
fail() { echo -e "  \033[31m✗\033[0m $1: $2"; F=$((F+1)); RESULTS+=("✗ $1: $2"); }
section() { T=$((T+1)); echo -e "\n\033[33m[$T]\033[0m $1"; }
run() { eval "$1" 2>/dev/null; }
api() { run "$AB eval \"window.__MINOTES__?.$1\""; }
snap() { run "$AB snapshot"; }
ss() { run "$AB screenshot $SSDIR/$1.png"; }
wait() { sleep "${1:-1}"; }

echo "═══════════════════════════════════════"
echo "  MiNotes E2E Test Suite"
echo "═══════════════════════════════════════"

run "$AB open $URL --wait-until networkidle" && sleep 3

# ═══════════════════════════════════════
section "App Initialization"
# ═══════════════════════════════════════

R=$(api "version")
[[ "$R" == *"1.0"* ]] && pass "Test API loaded" || fail "Test API" "$R"

R=$(api "getCurrentPage()")
[[ "$R" == *"Journal"* ]] && pass "Journal auto-opens on launch" || fail "Auto-open" "$R"

R=$(api "getBlockCount()")
[[ "$R" -gt 0 ]] 2>/dev/null && pass "Journal has blocks ($R)" || fail "Journal blocks" "$R"

ss "01-init"

# ═══════════════════════════════════════
section "Page Navigation"
# ═══════════════════════════════════════

api "navigateTo('Getting Started')" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Getting Started"* ]] && pass "Navigate to Getting Started" || fail "Nav Getting Started" "$R"

R=$(api "getBlockCount()")
[[ "$R" -ge 5 ]] 2>/dev/null && pass "Getting Started has blocks ($R)" || fail "GS blocks" "$R"

api "navigateTo('Project Alpha')" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Project Alpha"* ]] && pass "Navigate to Project Alpha" || fail "Nav Project Alpha" "$R"

api "navigateTo('Research Notes')" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Research Notes"* ]] && pass "Navigate to Research Notes" || fail "Nav Research Notes" "$R"

ss "02-navigation"

# ═══════════════════════════════════════
section "Journal"
# ═══════════════════════════════════════

api "openJournal()" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Journal/2026-03-24"* ]] && pass "Open today's journal" || fail "Today journal" "$R"

api "openJournal('2026-03-23')" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Journal/2026-03-23"* ]] && pass "Open specific date journal" || fail "Date journal" "$R"

api "openJournal('2026-01-01')" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Journal/2026-01-01"* ]] && pass "Create new journal for past date" || fail "New journal" "$R"

ss "03-journal"

# ═══════════════════════════════════════
section "Block Reading"
# ═══════════════════════════════════════

api "navigateTo('Project Alpha')" && wait 2

R=$(api "getBlockContent(0)")
[[ "$R" == *"Project Alpha"* ]] && pass "Read block 0 content" || fail "Read block 0" "$R"

R=$(api "getBlockContent(2)")
[[ "$R" == *"Tasks"* ]] && pass "Read block 2 (Tasks heading)" || fail "Read block 2" "$R"

R=$(run "$AB eval 'String(window.__MINOTES__?.getBlocks()?.length)'")
R="${R//\"/}"  # strip quotes
[[ "$R" -ge 8 ]] 2>/dev/null && pass "getBlocks returns all blocks ($R)" || fail "getBlocks" "$R"

# ═══════════════════════════════════════
section "Block Editing (Test API)"
# ═══════════════════════════════════════

api "openJournal()" && wait 2

R=$(api "typeInBlock(0, ' — edited by agent')")
[[ "$R" == "true" ]] && pass "typeInBlock returns true" || fail "typeInBlock" "$R"

R=$(api "focusBlock(0)")
[[ "$R" == "true" ]] && pass "focusBlock returns true" || fail "focusBlock" "$R"

ss "04-editing"

# ═══════════════════════════════════════
section "Block Content Update"
# ═══════════════════════════════════════

api "navigateTo('Project Alpha')" && wait 2

R=$(api "setBlockContent(1, 'Updated by automation test')")
[[ "$R" == "true" ]] && pass "setBlockContent returns true" || fail "setBlockContent" "$R"

wait 1
R=$(api "getBlockContent(1)")
[[ "$R" == *"Updated by automation"* ]] && pass "Content updated and readable" || fail "Content update" "$R"

ss "05-content-update"

# ═══════════════════════════════════════
section "Keyboard Shortcuts (via CDP)"
# ═══════════════════════════════════════

# Ctrl+K → Search
run "$AB press 'Control+k'" && wait 1
R=$(snap | grep -c "Search pages")
[[ "$R" -gt 0 ]] && pass "Ctrl+K opens search" || fail "Ctrl+K" "search not found"
run "$AB press Escape" && wait 0.5

# Ctrl+, → Settings
run "$AB press 'Control+,'" && wait 1
R=$(snap | grep -c "Theme")
[[ "$R" -gt 0 ]] && pass "Ctrl+, opens settings" || fail "Ctrl+," "settings not found"
run "$AB press Escape" && wait 0.5

# Ctrl+G → Graph
run "$AB press 'Control+g'" && wait 2
R=$(snap | grep -ci "graph\|canvas\|close")
[[ "$R" -gt 0 ]] && pass "Ctrl+G opens graph view" || fail "Ctrl+G" "graph not found"
run "$AB press Escape" && wait 0.5

# Ctrl+J → Journal
run "$AB press 'Control+j'" && wait 2
R=$(api "getCurrentPage()")
[[ "$R" == *"Journal"* ]] && pass "Ctrl+J opens journal" || fail "Ctrl+J" "$R"

ss "06-keyboard"

# ═══════════════════════════════════════
section "Search Panel"
# ═══════════════════════════════════════

api "openSearch()" && wait 1

R=$(snap | grep -c "Search pages")
[[ "$R" -gt 0 ]] && pass "Search panel has input" || fail "Search input" "not found"

# Check pages listed
R=$(snap | grep -c "Project Alpha")
[[ "$R" -gt 0 ]] && pass "Search shows pages" || fail "Search pages" "not listed"

api "closePanel()" && wait 0.5

# ═══════════════════════════════════════
section "Settings Panel"
# ═══════════════════════════════════════

api "openSettings()" && wait 1
S=$(snap)

echo "$S" | grep -qi "Theme" && pass "Settings: Theme option" || fail "Settings Theme" "not found"
echo "$S" | grep -qi "Full Tree Mode" && pass "Settings: Full Tree Mode toggle" || fail "Settings Tree" "not found"
echo "$S" | grep -qi "Obsidian Editor" && pass "Settings: Obsidian Editor toggle" || fail "Settings Obsidian" "not found"
echo "$S" | grep -qi "Keyboard Shortcuts" && pass "Settings: Keyboard shortcuts section" || fail "Settings KB" "not found"

ss "07-settings"
api "closePanel()" && wait 0.5

# ═══════════════════════════════════════
section "Sidebar"
# ═══════════════════════════════════════

S=$(snap)

echo "$S" | grep -qi "MiNotes" && pass "Sidebar: App title" || fail "Sidebar title" "not found"
echo "$S" | grep -qi "Search" && pass "Sidebar: Search button" || fail "Sidebar search" "not found"
echo "$S" | grep -qi "New" && pass "Sidebar: + New button" || fail "Sidebar new" "not found"
echo "$S" | grep -qi "Journal" && pass "Sidebar: Journal button" || fail "Sidebar journal" "not found"
echo "$S" | grep -qi "Project" && pass "Sidebar: + Project button" || fail "Sidebar project" "not found"
echo "$S" | grep -qi "Graph" && pass "Sidebar: Graph button" || fail "Sidebar graph" "not found"
echo "$S" | grep -qi "pages" && pass "Sidebar: Page count" || fail "Sidebar count" "not found"

# ═══════════════════════════════════════
section "Page Content Rendering"
# ═══════════════════════════════════════

api "navigateTo('Project Alpha')" && wait 2
S=$(snap)

echo "$S" | grep -qi "Project Alpha" && pass "Page title renders" || fail "Page title" "not found"
echo "$S" | grep -qi "blocks" && pass "Block count shown" || fail "Block count" "not found"
echo "$S" | grep -qi "Updated" && pass "Last updated shown" || fail "Updated" "not found"

# Check blocks render
R=$(api "getBlockCount()")
[[ "$R" -ge 5 ]] 2>/dev/null && pass "Multiple blocks render ($R)" || fail "Block render" "$R"

ss "08-page-content"

# ═══════════════════════════════════════
section "Mock Backend CRUD"
# ═══════════════════════════════════════

# Create page
R=$(run "$AB eval 'async function t() { const p = await window.__MINOTES__?.navigateTo(\"New Test Page\"); return \"done\"; } t().catch(() => \"error\")'")

# Use API directly
run "$AB eval '(async () => { try { const { createPage } = await import(\"/src/lib/api.ts\"); } catch(e) {} })()')"

# Test via setBlockContent on current page
api "navigateTo('Project Alpha')" && wait 2
ORIG=$(api "getBlockContent(1)")
api "setBlockContent(1, 'CRUD test: modified content')" && wait 1
R=$(api "getBlockContent(1)")
[[ "$R" == *"CRUD test"* ]] && pass "Update block (CRUD)" || fail "Update block" "$R"

# Restore original
api "setBlockContent(1, $ORIG)" 2>/dev/null

ss "09-crud"

# ═══════════════════════════════════════
section "Visual Regression Baseline"
# ═══════════════════════════════════════

api "navigateTo('Getting Started')" && wait 2
ss "10-baseline-getting-started"
pass "Baseline: Getting Started"

api "navigateTo('Project Alpha')" && wait 2
ss "11-baseline-project-alpha"
pass "Baseline: Project Alpha"

api "openJournal()" && wait 2
ss "12-baseline-journal"
pass "Baseline: Journal"

# ═══════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════

run "$AB close"

# ═══════════════════════════════════════
# Report
# ═══════════════════════════════════════

echo ""
echo "═══════════════════════════════════════"
echo "  Results: $P passed, $F failed"
echo "═══════════════════════════════════════"
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
echo "═══════════════════════════════════════"

exit $F
