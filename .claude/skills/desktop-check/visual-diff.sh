#!/usr/bin/env bash
# Visual regression for the desktop app's main views (screenshots of visual-tour.sh,
# the deterministic variant of ux-tour.sh).
#
#   visual-diff.sh approve [DIR]   copy DIR's screenshots (default: a fresh tour) into
#                                  baselines/ (in this skill dir) — commit them
#   visual-diff.sh check [DIR]     compare DIR (default: a fresh tour) with baselines/
#   visual-diff.sh noise [N]       run the tour N times (default 2) with no code change and
#                                  report the run-to-run % per view = the noise floor
#   visual-diff.sh tour [DIR]      only take the screenshots
# Options (any command): --no-build
#
# Per-view masks, fuzz and thresholds: visual-config.json. Masked rectangles are
# painted solid on BOTH images before comparing. "layout-only" views are compared
# after a heavy blur + downscale, so only big moves count.
# Output: $DESKTOP_CHECK_DIR/signals/visual.md (+ visual-diffs/<view>.png for anything
# over threshold: baseline | current | highlighted diff). Exit 0 unless the tool
# itself breaks — CHANGED is a finding, not a failure. (VISUAL_STRICT=1: exit 1 on CHANGED/MISSING.)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# See scale-tour.sh: avoid the app's ~25 s D-Bus timeout at every launch.
if [ -z "${VISUAL_PRIVATE_BUS:-}" ] && command -v dbus-run-session >/dev/null; then
  export VISUAL_PRIVATE_BUS=1; exec dbus-run-session -- bash "$0" "$@"
fi
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
BASE="$HERE/baselines"; CFG="$HERE/visual-config.json"
SIG="$DESKTOP_CHECK_DIR/signals"; DIFFS="$SIG/visual-diffs"; mkdir -p "$SIG"
for t in compare convert identify; do command -v $t >/dev/null || { echo "missing ImageMagick tool: $t" >&2; exit 2; }; done
cmd="${1:-}"; shift || true
build=""; args=()
for a in "$@"; do if [ "$a" = "--no-build" ]; then build="--no-build"; else args+=("$a"); fi; done
tour() { # tour <dir>
  local d="${1:?}"; rm -rf "${d:?}"; mkdir -p "$d"
  bash "$HERE/visual-tour.sh" "$d" $build || { echo "visual tour failed" >&2; exit 1; }
  build="--no-build"
}
fresh() { local d; d="$DESKTOP_CHECK_DIR/visual-runs/run-$(date +%Y%m%d-%H%M%S)"; tour "$d" >&2; echo "$d"; }
cleandiffs() { rm -rf "${DIFFS:?}"; mkdir -p "$DIFFS"; }

case "$cmd" in
tour)    d="${args[0]:-$DESKTOP_CHECK_DIR/visual-runs/run-$(date +%Y%m%d-%H%M%S)}"; tour "$d"; echo "$d" ;;
approve)
  d="${args[0]:-}"; [ -n "$d" ] || d="$(fresh)"
  ls "$d"/*.png >/dev/null 2>&1 || { echo "no screenshots in $d" >&2; exit 1; }
  mkdir -p "$BASE"; find "${BASE:?}" -maxdepth 1 -name '*.png' -delete
  for f in "$d"/*.png; do convert "$f" -strip -define png:compression-level=9 "PNG24:$BASE/$(basename "$f")"; done
  cp "$d/freeze.json" "$BASE/freeze.json" 2>/dev/null || true
  du -ch "$BASE"/*.png | tail -1 | sed "s|^|baselines approved from $d: |"
  ;;
check)
  d="${args[0]:-}"; [ -n "$d" ] || d="$(fresh)"
  ls "$BASE"/*.png >/dev/null 2>&1 || { echo "no baselines yet: run visual-diff.sh approve" >&2; exit 1; }
  cleandiffs
  python3 "$HERE/visual-compare.py" check "$BASE" "$d" "$CFG" "$DIFFS" >"$SIG/visual.md" || { echo "comparison failed" >&2; exit 1; }
  sed -n '1,/^## /p' "$SIG/visual.md" | sed '$d'; echo "report: $SIG/visual.md"
  if [ "${VISUAL_STRICT:-0}" = 1 ] && grep -qE '\| (CHANGED|MISSING) ' "$SIG/visual.md"; then exit 1; fi
  ;;
noise)
  n="${args[0]:-2}"; runs=()
  for i in $(seq 1 "$n"); do runs+=("$(fresh)"); done
  cleandiffs
  python3 "$HERE/visual-compare.py" noise "${runs[0]}" "${runs[*]:1}" "$CFG" "$DIFFS" >"$SIG/visual-noise.md" || { echo "comparison failed" >&2; exit 1; }
  sed -n '1,/^## /p' "$SIG/visual-noise.md" | sed '$d'; echo "report: $SIG/visual-noise.md"
  ;;
*) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
