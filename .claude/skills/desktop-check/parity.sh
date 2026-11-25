#!/usr/bin/env bash
# Mock-vs-real backend parity: run the same scenarios (parity.js) against the
# in-memory mock (what browser journeys trust) and the real Rust/SQLite backend
# inside the real desktop app, diff the normalised results, and write
#   $DESKTOP_CHECK_DIR/signals/parity.md   (ranked divergences + every check)
#   $DESKTOP_CHECK_DIR/signals/parity.json (raw records)
#
#   parity.sh               build, launch on a FRESH profile, run, tear down
#   parity.sh --no-build    reuse target/debug/minotes-app
#   parity.sh --only 'se|ln'   only checks whose id starts with se or ln
#   parity.sh --attach      use the app that is already up (no launch, no down;
#                           state left by an earlier run can skew a few checks)
# Exit 0 unless the tool itself breaks; divergences are findings, not failures.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
D="$HERE/desktop.sh"
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
OUT="$DESKTOP_CHECK_DIR/signals"; mkdir -p "$OUT"
build=""; attach=0; only=""
while [ $# -gt 0 ]; do case "$1" in
  --no-build) build="--no-build" ;; --attach) attach=1 ;; --only) only="${2:?--only REGEX}"; shift ;;
  *) echo "unknown option: $1" >&2; exit 2 ;; esac; shift; done

if [ "$attach" = 0 ]; then
  "$D" up --webdriver --profile parity $build >/dev/null || { echo "parity: launch failed" >&2; exit 1; }
  trap '"$D" down >/dev/null 2>&1' EXIT
fi
# One WebDriver script call is capped at 60 s (wd.py), so run the areas in chunks
# (check-id prefixes) and merge. The page - and so the mock's state - persists.
chunks=("pg" "bl" "se" "ln|pr|fv" "fo|tr|ar" "jo|td" "tp|rb|ms|er|ea")
[ -n "$only" ] && chunks=("$only")
: >"$OUT/parity.err"; rm -f "$OUT"/parity.part*.json; i=0
for c in "${chunks[@]}"; do
  i=$((i+1))
  "$D" js "window.__PARITY_ONLY__ = $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$c"); $(cat "$HERE/parity.js")" >"$OUT/parity.part$i.json" 2>>"$OUT/parity.err" \
    || { echo "parity: scenario chunk '$c' failed:" >&2; head -c 600 "$OUT/parity.part$i.json" "$OUT/parity.err" >&2; exit 1; }
done
python3 - "$OUT" <<'PY' || { echo "parity: merge failed" >&2; exit 1; }
import glob, json, re, sys
parts = sorted(glob.glob(sys.argv[1] + "/parity.part*.json"), key=lambda p: int(re.search(r"part(\d+)", p).group(1)))
res, defined = [], 0
for p in parts:
    d = json.load(open(p)); res += d["results"]; defined = d["defined"]
json.dump({"ran": len(res), "defined": defined, "results": res}, open(sys.argv[1] + "/parity.json", "w"), ensure_ascii=False, indent=1)
PY
rm -f "$OUT"/parity.part*.json
python3 "$HERE/parity-report.py" "$OUT/parity.json" "$HERE/parity-notes.json" "$REPO/tests/user-journey-test.sh" >"$OUT/parity.md" \
  || { echo "parity: report generation failed" >&2; exit 1; }
sed -n '1,/^## Ranked divergences/p' "$OUT/parity.md" | sed '$d'
echo "report: $OUT/parity.md"
