#!/bin/bash
# Quick single-feature test for MiNotes using agent-browser + test API
# Usage: ./tests/quick-test.sh [feature]

AB="agent-browser"
URL="http://localhost:1420"
SSDIR="tests/screenshots"
mkdir -p "$SSDIR"

case "${1:-load}" in
  load)
    echo "Testing: App loads with mock data"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.getCurrentPage()"
    $AB eval "window.__MINOTES__?.getBlockCount()"
    $AB screenshot "$SSDIR/quick-load.png"
    $AB close
    ;;

  type)
    echo "Testing: Type in block via test API"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.typeInBlock(0, 'Hello from agent-browser!')"
    sleep 1
    $AB eval "window.__MINOTES__?.getBlockContent(0)"
    $AB screenshot "$SSDIR/quick-type.png"
    $AB close
    ;;

  enter)
    echo "Testing: Create new block"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.typeInBlock(0, 'First block')"
    sleep 0.5
    $AB eval "window.__MINOTES__?.pressEnterInBlock(0)"
    sleep 1
    $AB eval "window.__MINOTES__?.getBlocks()"
    $AB screenshot "$SSDIR/quick-enter.png"
    $AB close
    ;;

  navigate)
    echo "Testing: Navigate to page"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.navigateTo('Project Alpha')"
    sleep 2
    $AB eval "window.__MINOTES__?.getCurrentPage()"
    $AB eval "window.__MINOTES__?.getBlocks()"
    $AB screenshot "$SSDIR/quick-navigate.png"
    $AB close
    ;;

  journal)
    echo "Testing: Journal navigation"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.openJournal()"
    sleep 2
    $AB eval "window.__MINOTES__?.getCurrentPage()"
    $AB eval "window.__MINOTES__?.openJournal('2026-03-23')"
    sleep 2
    $AB eval "window.__MINOTES__?.getCurrentPage()"
    $AB screenshot "$SSDIR/quick-journal.png"
    $AB close
    ;;

  search)
    echo "Testing: Search panel"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.openSearch()"
    sleep 1
    $AB snapshot -i | head -10
    $AB screenshot "$SSDIR/quick-search.png"
    $AB eval "window.__MINOTES__?.closePanel()"
    $AB close
    ;;

  settings)
    echo "Testing: Settings panel"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.openSettings()"
    sleep 1
    $AB snapshot | grep -i "theme\|tree\|keyboard" | head -10
    $AB screenshot "$SSDIR/quick-settings.png"
    $AB eval "window.__MINOTES__?.closePanel()"
    $AB close
    ;;

  blocks)
    echo "Testing: Block content inspection"
    $AB open "$URL" --wait-until networkidle && sleep 3
    $AB eval "window.__MINOTES__?.navigateTo('Getting Started')"
    sleep 2
    $AB eval "JSON.stringify(window.__MINOTES__?.getBlocks(), null, 2)"
    $AB screenshot "$SSDIR/quick-blocks.png"
    $AB close
    ;;

  all)
    echo "Running all quick tests..."
    for t in load type navigate journal search settings blocks; do
      echo ""
      echo "=== $t ==="
      $0 $t
      echo ""
    done
    ;;

  *)
    echo "Usage: $0 [load|type|enter|navigate|journal|search|settings|blocks|all]"
    exit 1
    ;;
esac

echo "Done."
