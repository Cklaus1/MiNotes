#!/bin/bash
# ═══════════════════════════════════════════
#  MiNotes Smoke Test
#  Quick health check — runs in ~30 seconds
#  Verifies the app loads and core features work
# ═══════════════════════════════════════════

AB="agent-browser"
URL="http://localhost:1420"
P=0; F=0

pass() { echo -e "\033[32m✓\033[0m $1"; P=$((P+1)); }
fail() { echo -e "\033[31m✗\033[0m $1: $2"; F=$((F+1)); }
run()  { eval "$1" 2>/dev/null; }

echo "MiNotes Smoke Test"
echo "──────────────────"

run "$AB open $URL --wait-until networkidle" && sleep 3

# 1. App loads
R=$(run "$AB eval 'window.__MINOTES__?.version'")
[[ "$R" == *"1.0"* ]] && pass "App loads, test API v1.0" || fail "App load" "$R"

# 2. Mock data present
R=$(run "$AB eval 'window.__MINOTES__?.getCurrentPage()'")
[[ "$R" == *"Journal"* ]] && pass "Journal auto-opened" || fail "Journal" "$R"

# 3. Pages exist
R=$(run "$AB eval 'window.__MINOTES__?.getBlockCount()'")
[[ "$R" -gt 0 ]] 2>/dev/null && pass "Blocks present ($R)" || fail "Blocks" "$R"

# 4. Navigation works
run "$AB eval 'window.__MINOTES__?.navigateTo(\"Getting Started\")'" && sleep 1
R=$(run "$AB eval 'window.__MINOTES__?.getCurrentPage()'")
[[ "$R" == *"Getting Started"* ]] && pass "Page navigation works" || fail "Navigation" "$R"

# 5. Search opens
run "$AB eval 'window.__MINOTES__?.openSearch()'" && sleep 0.5
R=$(run "$AB snapshot" | grep -c "Search pages")
[[ "$R" -gt 0 ]] && pass "Search panel opens" || fail "Search" "not found"
run "$AB eval 'window.__MINOTES__?.closePanel()'" && sleep 0.5

# 6. Settings opens
run "$AB eval 'window.__MINOTES__?.openSettings()'" && sleep 0.5
R=$(run "$AB snapshot" | grep -c "Theme")
[[ "$R" -gt 0 ]] && pass "Settings panel opens" || fail "Settings" "not found"
run "$AB eval 'window.__MINOTES__?.closePanel()'"

run "$AB close"

echo "──────────────────"
echo "Results: $P passed, $F failed"
exit $F
