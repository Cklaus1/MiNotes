#!/bin/bash
# Quick single-feature test for MiNotes
# Usage: ./tests/quick-test.sh [feature]
# Features: load, type, enter, slash, search, settings, journal, graph

AB="agent-browser"
URL="http://localhost:1420"

case "${1:-load}" in
  load)
    echo "Testing: App loads"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB snapshot
    $AB screenshot tests/screenshots/quick-load.png
    $AB close
    ;;

  type)
    echo "Testing: Type in block"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+j"
    sleep 1
    $AB click "[class*=ProseMirror]" || true
    sleep 0.5
    $AB type "Testing typing in MiNotes block"
    sleep 1
    $AB screenshot tests/screenshots/quick-type.png
    $AB snapshot
    $AB close
    ;;

  enter)
    echo "Testing: Enter creates new block"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+j"
    sleep 1
    $AB click "[class*=ProseMirror]" || true
    $AB type "Block one"
    sleep 0.5
    $AB press "Enter"
    sleep 1
    $AB type "Block two"
    sleep 1
    $AB screenshot tests/screenshots/quick-enter.png
    $AB snapshot
    $AB close
    ;;

  slash)
    echo "Testing: Slash commands"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+j"
    sleep 1
    $AB press "Enter"
    sleep 0.5
    $AB type "/"
    sleep 1
    $AB screenshot tests/screenshots/quick-slash.png
    $AB snapshot -i
    $AB press "Escape"
    $AB close
    ;;

  search)
    echo "Testing: Search panel"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+k"
    sleep 1
    $AB screenshot tests/screenshots/quick-search.png
    $AB snapshot -i
    $AB press "Escape"
    $AB close
    ;;

  settings)
    echo "Testing: Settings panel"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+,"
    sleep 1
    $AB screenshot tests/screenshots/quick-settings.png
    $AB snapshot
    $AB press "Escape"
    $AB close
    ;;

  journal)
    echo "Testing: Journal"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+j"
    sleep 2
    $AB screenshot tests/screenshots/quick-journal.png
    $AB snapshot
    $AB close
    ;;

  graph)
    echo "Testing: Graph view"
    $AB open "$URL" --wait-until networkidle
    sleep 2
    $AB press "Control+g"
    sleep 2
    $AB screenshot tests/screenshots/quick-graph.png
    $AB snapshot
    $AB press "Escape"
    $AB close
    ;;

  all)
    echo "Running all quick tests..."
    for t in load type enter slash search settings journal graph; do
      echo ""
      echo "--- $t ---"
      $0 $t
    done
    ;;

  *)
    echo "Usage: $0 [load|type|enter|slash|search|settings|journal|graph|all]"
    exit 1
    ;;
esac

echo "Done."
