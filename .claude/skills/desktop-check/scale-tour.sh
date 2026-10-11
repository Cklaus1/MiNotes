#!/usr/bin/env bash
# Scale tour: how does the REAL app behave as the notebook grows?
# For each size it seeds a deterministic notebook through the CLI (scale-seed.py +
# `minotes import dir`), then measures inside the app (scale-lib.js) and writes
#   $DESKTOP_CHECK_DIR/signals/scale.md      size x metric table + call-outs
#   $DESKTOP_CHECK_DIR/signals/scale-<S>.tsv raw samples per size
#
#   scale-tour.sh [--no-build] [--sizes S,M,L] [--runs 3] [--report-only]
#     S = 50 pages / 500 blocks, M = 300 / 5,000, L = 1,000 / 20,000
#     (+ in every size: "Hub", linked from every page, and "Big Page", 2,000 blocks)
# Exit 0 unless the tool itself breaks. Xvfb = software rendering: compare the
# numbers across sizes, do not read them as absolute.
set -uo pipefail
# The app blocks ~25 s at startup on a D-Bus call to the host session bus (seen
# with strace: connect(/run/user/0/bus), then nothing until the D-Bus default
# timeout). Run the whole tour on a private session bus so cold start measures
# the app, not that timeout. desktop.sh and the app inherit the address.
if [ -z "${SCALE_PRIVATE_BUS:-}" ] && command -v dbus-run-session >/dev/null; then
  export SCALE_PRIVATE_BUS=1; exec dbus-run-session -- bash "$0" "$@"
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/desktop.sh"
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
OUT="$DESKTOP_CHECK_DIR/signals"; mkdir -p "$OUT"
build=""; sizes="S,M,L"; RUNS=3; report_only=0
while [ $# -gt 0 ]; do case "$1" in
  --no-build) build="--no-build" ;; --sizes) sizes="${2:?}"; shift ;; --runs) RUNS="${2:?}"; shift ;; --report-only) report_only=1 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;; esac; shift; done
declare -A PAGES=([S]=50 [M]=300 [L]=1000) BLOCKS=([S]=500 [M]=5000 [L]=20000)
BIG=2000
LIB="$(cat "$HERE/scale-lib.js")"
now() { date +%s%3N; }

# js <body>: run with the lib installed; retried while the webview is too busy to answer.
js() { local out rc; for _ in 1 2 3 4 5 6 7 8; do out="$("$D" js "$LIB $1" 2>&1)"; rc=$?; [ $rc = 0 ] && { printf '%s' "$out"; return 0; }; [ $rc = 1 ] && { printf '%s' "$out"; return 1; }; sleep 5; done; return 3; }
# result <name> <timeout-s>: poll window.__sc.res[name] until the measurement finished.
result() { local t0; t0=$(date +%s); local r; while :; do r="$(js "return window.__sc.res[$(printf '"%s"' "$1")] || null")"; [ -n "$r" ] && [ "$r" != "null" ] && { printf '%s' "$r"; return 0; }; [ $(( $(date +%s) - t0 )) -gt "$2" ] && { echo '{"ok":false,"error":"timeout"}'; return 1; }; sleep 1; done; }
rec() { printf '%s\t%s\n' "$1" "$2" >>"$TSV"; }     # metric <TAB> json
measure() { # measure <metric> <timeout> <js that starts sc.* with name "m">
  js "window.__sc.res.m = null; $3 return 1" >/dev/null || { rec "$1" '{"ok":false,"error":"start failed"}'; return; }
  rec "$1" "$(result m "$2")"
}
times() { rec "$1" "$(js "return await window.__sc.times($2, $RUNS)")"; }   # times <metric> '"fn", [args]'
goto() { js "window.__sc.open('nav', $1, $2, 1); return 1" >/dev/null; result nav 120 >/dev/null; sleep 0.5; }
# cold_probe <profile>: launch the binary directly (same env as desktop.sh) and
# time process start -> window mapped -> first non-blank frame -> screen stable
# (two identical captures 250 ms apart). Pixels, not DOM: no WebDriver involved.
cold_probe() {
  local home="$DESKTOP_CHECK_DIR/$1" bin; bin="$(cd "$HERE/../../.." && pwd)/target/debug/minotes-app"
  local env=(DISPLAY="localhost:${DESKTOP_CHECK_DISPLAY:-97}" WAYLAND_DISPLAY= GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 HOME="$home")
  [ -f /usr/share/glvnd/egl_vendor.d/50_mesa.json ] && env+=(__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json)
  local x="localhost:${DESKTOP_CHECK_DISPLAY:-97}" t0 tw=null tp=null ts=null prev="" cur sd
  # A fresh private session bus per launch: on a reused bus (or the host bus) the
  # app sits ~25 s in a D-Bus call before mapping its window.
  t0=$(now); env "${env[@]}" dbus-run-session -- "$bin" >/dev/null 2>&1 & local ap=$!
  while [ $(( $(now) - t0 )) -lt 90000 ]; do
    if [ "$tw" = null ] && DISPLAY="$x" timeout 5 xwininfo -root -tree 2>/dev/null | grep -q '"MiNotes"'; then tw=$(( $(now) - t0 )); fi
    if [ "$tw" != null ]; then
      cur="$(DISPLAY="$x" timeout 5 import -window root -resize 25% png:- 2>/dev/null | md5sum | cut -c1-12)"
      if [ "$tp" = null ]; then
        # painted = the frame has real content (text antialiasing -> many colours)
        sd="$(DISPLAY="$x" timeout 5 import -window root png:- 2>/dev/null | convert png:- -format '%k' info: 2>/dev/null)"
        [ "${sd:-0}" -gt 200 ] 2>/dev/null && tp=$(( $(now) - t0 ))
      elif [ "$cur" = "$prev" ]; then ts=$(( $(now) - t0 )); break; fi
      prev="$cur"
    fi
    kill -0 $ap 2>/dev/null || break
    sleep 0.25
  done
  pkill -P $ap 2>/dev/null; kill $ap 2>/dev/null; wait $ap 2>/dev/null
  local k; for k in $(seq 1 20); do DISPLAY="$x" timeout 5 xwininfo -root -tree 2>/dev/null | grep -q '"MiNotes"' || break; sleep 0.5; done
  echo "{\"window\": $tw, \"painted\": $tp, \"stable\": $ts}"
}
app_pid() { local p; for p in $(pgrep -x minotes-app); do tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null | grep -qx "HOME=$DESKTOP_CHECK_DIR/$1" && { echo "$p"; return; }; done; }

run_size() {
  local S="$1" prof="scale-$1"; TSV="$OUT/scale-$S.tsv"; : >"$TSV"
  echo "== size $S: ${PAGES[$S]} pages / ${BLOCKS[$S]} blocks (+ Hub, + Big Page of $BIG) =="
  # Plain (non-WebDriver) launch first: creates the profile's database and the display.
  "$D" up --profile "$prof" $build >/dev/null || { echo "scale: launch failed" >&2; return 1; }
  build="--no-build"
  kill "$(cat "$DESKTOP_CHECK_DIR/app.pid")" 2>/dev/null; sleep 2
  local seed="$DESKTOP_CHECK_DIR/scale-seed/$S"; rm -rf "$seed"
  local manifest; manifest="$(python3 "$HERE/scale-seed.py" "$seed" "${PAGES[$S]}" "${BLOCKS[$S]}" "$BIG")" || return 1
  rec manifest "$manifest"
  local t0; t0=$(now); "$D" cli import dir "$seed" >/dev/null || { echo "scale: import failed" >&2; return 1; }
  rec seed_ms "{\"ms\": $(( $(now) - t0 ))}"
  rec stats "$("$D" cli stats | tr -d '\n ')"
  # ── cold start, measured WITHOUT WebDriver (under tauri-driver every launch
  # spends ~30 s before the webview even navigates, whatever the app does) ──
  local i
  for i in $(seq 1 "$RUNS"); do rec cold_direct "$(cold_probe "$prof")"; done
  "$D" up --webdriver --keep --profile "$prof" --no-build >/dev/null || { echo "scale: webdriver launch failed" >&2; return 1; }
  local A B; A="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["small_a"])' "$manifest")"; B="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["small_b"])' "$manifest")"
  local MA MB; MA="p${A#Page }"; MB="p${B#Page }"
  local PER; PER="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["per_page"])' "$manifest")"
  local NBACK; NBACK="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["hub_backlinks_expected"])' "$manifest")"

  # ── frontend boot against the running backend: reload, then time to usable ──
  for i in $(seq 1 "$RUNS"); do
    "$D" js 'sessionStorage.setItem("__scReload", String(Date.now())); setTimeout(() => location.reload(), 30); return 1' >/dev/null 2>&1
    local b='{"stale":true}' k; sleep 0.3
    for k in 1 2 3 4 5 6; do b="$("$D" js "$(cat "$HERE/scale-boot.js")" 2>/dev/null)" || b='{"stale":true}'; case "$b" in *'"stale"'*|"") sleep 1 ;; *) break ;; esac; done
    rec boot "$b"
  done
  "$D" wait 'window.__MINOTES__ && typeof window.__MINOTES__.getBlockCount === "function"' 60 >/dev/null 2>&1; sleep 1

  # ── backend only (IPC + SQLite; no rendering) ──
  local hub; hub="$(js 'return (await window.__MINOTES__.modules["/src/lib/api.ts"].getPageTree("Hub")).page.id' | tr -d '"')"
  times api_getPageTree_small "\"getPageTree\", [\"$A\"]"
  times api_getPageTree_big '"getPageTree", ["Big Page"]'
  times api_search_common '"search", ["project", 20]'
  times api_search_rare '"search", ["quokkazephyr", 20]'
  times api_getFolderTree '"getFolderTree", []'
  times api_listPages_200 '"listPages", [200]'
  times api_listPages_all '"listPages", [100000]'
  times api_getGraphData '"getGraphData", []'
  times api_getBacklinks_hub "\"getBacklinks\", [\"$hub\"]"
  times api_getUnlinkedReferences_hub "\"getUnlinkedReferences\", [\"$hub\"]"
  times api_getPendingTodoCount '"getPendingTodoCount", []'
  times api_getGraphStats '"getGraphStats", []'
  rec api_createPage "$(js "const api = window.__MINOTES__.modules['/src/lib/api.ts']; const ms = []; for (let i = 0; i < $RUNS; i++) { const t = performance.now(); const p = await api.createPage('Scale probe ' + Date.now() + '-' + i); ms.push(performance.now() - t); await api.trashPage(p.id); await api.permanentlyDelete(p.id, 'page'); } return {ms}")"
  rec api_createBlock "$(js "const api = window.__MINOTES__.modules['/src/lib/api.ts']; const pg = await api.getPageTree('$A'); const ms = []; for (let i = 0; i < $RUNS; i++) { const t = performance.now(); const b = await api.createBlock(pg.page.id, 'scale probe block'); ms.push(performance.now() - t); await api.deleteBlock(b.id); } return {ms}")"

  # ── views ──
  goto "\"$B\"" "\"$MB\""
  for i in $(seq 1 "$RUNS"); do
    measure open_small 60 "window.__sc.open('m', \"$A\", \"$MA\", $PER);"; goto "\"$B\"" "\"$MB\""
  done
  for i in $(seq 1 "$RUNS"); do measure sidebar_refresh 30 "window.__sc.sidebar('m');"; done
  for i in $(seq 1 "$RUNS"); do
    measure open_hub_backlinks 300 "window.__sc.hub('m', 'Hub', 'hub', $NBACK);"; goto "\"$B\"" "\"$MB\""
  done
  for q in project quokkazephyr; do
    for i in $(seq 1 "$RUNS"); do
      "$D" eval "window.__MINOTES__.isPanelOpen('search') || window.__MINOTES__.openSearch()" >/dev/null 2>&1
      "$D" wait "!!document.querySelector('.command-palette-input')" 10 >/dev/null 2>&1; sleep 0.4
      measure "search_ui_$q" 40 "window.__sc.searchUi('m', '$q');"
      "$D" press Escape >/dev/null 2>&1; sleep 0.4
    done
  done
  for i in $(seq 1 "$RUNS"); do
    js "window.__sc.graphArm('m'); return 1" >/dev/null
    "$D" press Control+g >/dev/null 2>&1
    rec open_graph "$(result m 150)"
    "$D" press Escape >/dev/null 2>&1; sleep 1
  done
  js "return 1" >/dev/null
  # typing baseline in a small page
  type_probe() { # type_probe <metric> <block index>
    local xy; xy="$(js "const r = window.__sc.rect($2); return r ? r.x + ' ' + r.y : ''" | tr -d '"')"
    [ -n "$xy" ] || { rec "$1" '{"ok":false,"error":"no block"}'; return; }
    sleep 0.5; xy="$(js "const r = window.__sc.rect($2); return r.x + ' ' + r.y" | tr -d '"')"
    # shellcheck disable=SC2086
    "$D" click $xy >/dev/null 2>&1; sleep 0.8; "$D" key End >/dev/null 2>&1; sleep 0.5
    js "return window.__sc.keysStart($2)" >/dev/null
    local t0; t0=$(now); "$D" type " qwertyuiop" >/dev/null 2>&1; local typed=$(( $(now) - t0 ))
    # wait until all 11 characters have landed (the app may still be catching up)
    local k r='null'; for k in $(seq 1 120); do r="$(js "const k = window.__sc.keys; return k.list.length >= 11 && k.list.every(c => c.frame !== null) ? window.__sc.keysStop() : null")"; [ "$r" != "null" ] && [ -n "$r" ] && break; sleep 1; done
    [ "$r" = "null" ] && r="$(js "return window.__sc.keysStop()")"
    rec "$1" "$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "null") or {"keys":[]}; d["xdotoolMs"]=int(sys.argv[2]); d["waitedS"]=int(sys.argv[3]); print(json.dumps(d))' "$r" "$typed" "$k")"
    sleep 2
  }
  goto "\"$A\"" "\"$MA\""; type_probe type_small 2
  # ── the 2,000-block page ──
  goto "\"$B\"" "\"$MB\""
  for i in $(seq 1 "$RUNS"); do
    measure open_big 900 "window.__sc.open('m', 'Big Page', 'bigpage', $BIG);"
    [ "$i" = "$RUNS" ] && type_probe type_big 3
    measure close_big 600 "window.__sc.open('m', \"$B\", \"$MB\", $PER);"
  done
  local db="$DESKTOP_CHECK_DIR/$prof/.minotes/default.db"
  rec db_bytes "{\"db\": $(stat -c %s "$db" 2>/dev/null || echo 0), \"wal\": $(stat -c %s "$db-wal" 2>/dev/null || echo 0)}"
  rec errors "$(python3 -c 'import json,sys; print(json.dumps({"lines": sys.stdin.read().splitlines()[:20]}))' < <("$D" errors 2>/dev/null))"
  "$D" down >/dev/null 2>&1
}

if [ "$report_only" = 0 ]; then
  trap '"$D" down >/dev/null 2>&1' EXIT
  for S in ${sizes//,/ }; do
    [ -n "${PAGES[$S]:-}" ] || { echo "unknown size: $S" >&2; exit 2; }
    run_size "$S" || { echo "scale: size $S aborted (partial data kept in $OUT/scale-$S.tsv)" >&2; "$D" down >/dev/null 2>&1; }
  done
fi
python3 "$HERE/scale-report.py" "$OUT" >"$OUT/scale.md" || { echo "scale: report generation failed" >&2; exit 1; }
sed -n '1,/^## Raw/p' "$OUT/scale.md" | sed '$d'
echo "report: $OUT/scale.md"
