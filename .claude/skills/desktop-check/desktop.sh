#!/usr/bin/env bash
# Drive the REAL MiNotes desktop app (Tauri/WebKitGTK) on a private virtual
# display, against a throwaway HOME. Never touches the user's ~/.minotes.
#
# Lifecycle
#   desktop.sh up [--no-build] [--webdriver] [--keep] [--profile NAME]
#                                start display, build + launch app, wait for window.
#                                --webdriver  launch through tauri-driver (DOM commands below)
#                                --keep       keep the profile's data (default: wipe it)
#                                --profile    which scratch HOME to use (default "home");
#                                             two profiles = two "devices"
#   desktop.sh restart           quit and relaunch, same mode + profile, data kept
#   desktop.sh status | log [n] | down
#
# Input + screenshots (always available; window is at 0,0 so page px == screen px)
#   desktop.sh shot <name>       screenshot of the display → prints the PNG path
#   desktop.sh click <x> <y> | key <keys...> | type <text>     (xdotool, real X input)
#   desktop.sh cli <args...>     minotes CLI against the current profile's database
#   desktop.sh fixture-pdf       write a 1-page test PDF → prints its path
#
# WebDriver (needs `up --webdriver`)
#   desktop.sh js '<body>'       run an async function body in the app, print JSON.
#                                `invoke(cmd, args)` calls a Tauri command.
#   desktop.sh eval '<expr>'     evaluate an expression (agent-browser compatible)
#   desktop.sh press <Combo>     real key input: Control+k, Escape, Control+Shift+K
#   desktop.sh text <css> | wclick <css> | wshot <name> | snapshot [-i]
#   desktop.sh wait '<expr>' [seconds]      poll until truthy
#   desktop.sh paste-image       paste a generated red 96x96 PNG into the current view
#   desktop.sh seed-demo         load the mock backend's demo pages into the real DB
#   desktop.sh audit             UX/accessibility signals for the current screen (JSON)
#   ux-tour.sh [--no-build]      every main view: screenshot + audit + timing → ux/tour.md
#
# Assertions + report (results accumulate in the state dir until `report --reset`)
#   desktop.sh expect <label> '<expr>'            passes when expr becomes truthy (≤5s)
#   desktop.sh expect-db <label> '<sql>' <want>   passes when the query prints <want>
#   desktop.sh errors [--clear]                   uncaught errors / CSP violations seen
#   desktop.sh report [--reset]                   pass/fail table; exit 1 on any failure
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STATE="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
DNUM="${DESKTOP_CHECK_DISPLAY:-97}"
export DISPLAY="localhost:$DNUM"
# glvnd otherwise picks the NVIDIA EGL vendor, which aborts the X server on WSL.
MESA_EGL=/usr/share/glvnd/egl_vendor.d/50_mesa.json
[ -f "$MESA_EGL" ] && export __EGL_VENDOR_LIBRARY_FILENAMES="$MESA_EGL"

mkdir -p "$STATE"
PROFILE="$(cat "$STATE/profile" 2>/dev/null || echo home)"
set_profile() { PROFILE="$1"; echo "$PROFILE" >"$STATE/profile"; APP_HOME="$STATE/$PROFILE"; DB="$APP_HOME/.minotes/default.db"; }
set_profile "$PROFILE"
SHOTS="$STATE/shots"; RESULTS="$STATE/results.tsv"
BIN="$REPO/target/debug/minotes-app"; CLI="$REPO/target/debug/minotes"
WD_PORT="${DESKTOP_CHECK_WD_PORT:-4455}"

wd() { python3 "$HERE/wd.py" "http://127.0.0.1:$WD_PORT" "$STATE/wd.sid" "$@"; }
jsstr() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
x() { timeout 15 "$@"; }
win() { x xwininfo -root -tree 2>/dev/null | awk '/"MiNotes"/ {print $1; exit}'; }
need() { for t in "$@"; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done; }
record() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$RESULTS"; }

stop_app() {
  [ -f "$STATE/wd.sid" ] && { wd quit >/dev/null 2>&1 || true; rm -f "$STATE/wd.sid"; }
  if alive app; then
    # The app runs in its own process group (setsid in launch), so this also
    # reaches dbus-run-session's children: tauri-driver, WebKitWebDriver, the app.
    local pg; pg="$(cat "$STATE/app.pid")"
    kill -TERM -- "-$pg" 2>/dev/null || kill "$pg" 2>/dev/null || true
    for _ in $(seq 1 20); do alive app || break; sleep 0.25; done
    kill -KILL -- "-$pg" 2>/dev/null || true
  fi
  rm -f "$STATE/app.pid"
  # tauri-driver leaves the app and WebKitWebDriver behind if the session wasn't
  # closed cleanly; they'd keep the profile's database open.
  for _ in $(seq 1 20); do [ -z "$(win)" ] && break; sleep 0.25; done
  if [ -n "$(win)" ]; then x xdotool search --name '^MiNotes$' 2>/dev/null | head -1 | xargs -r -I{} timeout 5 xdotool windowkill {} 2>/dev/null || true; sleep 1; fi
}

# Run the app on a private D-Bus session: on this WSL host, connecting to the
# shared session bus stalls ~25 s per launch (D-Bus default timeout). Opt out with
# DESKTOP_CHECK_DBUS=0 (e.g. to test the OS keychain, which lives on that bus).
DBUS_PREFIX=()
if [ "${DESKTOP_CHECK_DBUS:-1}" = 1 ] && command -v dbus-run-session >/dev/null; then DBUS_PREFIX=(dbus-run-session --); fi

launch() { # $1 = webdriver 0|1
  export WAYLAND_DISPLAY= GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
  echo "$1" >"$STATE/mode"
  if [ "$1" = 1 ]; then
    # tauri-driver (wrapping WebKitWebDriver) launches the app itself, so the app
    # inherits this environment — including the scratch HOME.
    TD="$(command -v tauri-driver || echo "$HOME/.cargo/bin/tauri-driver")"
    { [ -x "$TD" ] && command -v WebKitWebDriver >/dev/null; } || {
      echo "webdriver mode needs: apt-get install webkit2gtk-driver && cargo install tauri-driver --locked" >&2; exit 2; }
    HOME="$APP_HOME" setsid nohup "${DBUS_PREFIX[@]}" "$TD" --port "$WD_PORT" --native-port "$((WD_PORT + 1))" >"$STATE/app.log" 2>&1 </dev/null &
    echo $! >"$STATE/app.pid"; sleep 2
    wd new "$BIN"
  else
    HOME="$APP_HOME" setsid nohup "${DBUS_PREFIX[@]}" "$BIN" >"$STATE/app.log" 2>&1 </dev/null &
    echo $! >"$STATE/app.pid"
  fi
  for _ in $(seq 1 40); do [ -n "$(win)" ] && break; alive app || break; sleep 1; done
  [ -n "$(win)" ] || { echo "app window never appeared:" >&2; tail -10 "$STATE/app.log" >&2; exit 1; }
  if [ "$1" = 1 ]; then
    wd wait 'window.__MINOTES__ && typeof window.__MINOTES__.navigateTo === "function"' 30 || true
    sleep 1
  else
    sleep 4   # first paint + initial data load
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
up)
  need Xvfb xdotool xwininfo import
  mkdir -p "$SHOTS"
  build=1; webdriver=0; keep=0
  while [ $# -gt 0 ]; do case "$1" in
    --no-build) build=0 ;; --webdriver) webdriver=1 ;; --keep) keep=1 ;;
    --profile) set_profile "${2:?--profile NAME}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;; esac; shift; done
  if ! alive xvfb; then
    # TCP only: on WSLg /tmp/.X11-unix is owned by the system compositor.
    Xvfb ":$DNUM" -nolisten unix -listen tcp -ac -screen 0 1280x900x24 >"$STATE/xvfb.log" 2>&1 &
    echo $! >"$STATE/xvfb.pid"; sleep 2
    alive xvfb || { echo "Xvfb failed to start:" >&2; tail -5 "$STATE/xvfb.log" >&2; exit 1; }
  fi
  if [ "$build" = 1 ]; then
    echo "building desktop app + CLI (debug; production frontend + CSP)…"
    (cd "$REPO/crates/minotes-app" && npx tauri build --debug --no-bundle) >"$STATE/build.log" 2>&1 \
      || { echo "build failed:" >&2; tail -15 "$STATE/build.log" >&2; exit 1; }
    (cd "$REPO" && cargo build -q -p minotes-cli) >>"$STATE/build.log" 2>&1
  fi
  [ -x "$BIN" ] || { echo "no binary at $BIN (run without --no-build)" >&2; exit 1; }
  stop_app
  [ "$keep" = 1 ] || rm -rf "$APP_HOME"
  mkdir -p "$APP_HOME"
  launch "$webdriver"
  echo "up: display=$DISPLAY window=$(win) profile=$PROFILE home=$APP_HOME shots=$SHOTS"
  ;;
restart)
  mode="$(cat "$STATE/mode" 2>/dev/null || echo 0)"
  stop_app; launch "$mode"
  echo "restarted: profile=$PROFILE (data kept)"
  ;;
shot)
  name="${1:?usage: shot <name>}"; mkdir -p "$SHOTS"; out="$SHOTS/$name.png"
  # Root capture so native dialogs (prompt/confirm) are included.
  x import -window root "$out"; echo "$out"
  ;;
click) x xdotool mousemove "${1:?x}" "${2:?y}" click 1 ;;
key)   x xdotool key "$@" ;;
type)  x xdotool type --delay 15 -- "$*" ;;
cli)   [ -x "$CLI" ] || { echo "no CLI at $CLI" >&2; exit 1; }; "$CLI" --graph "$DB" "$@" ;;
js)       wd js "${1:?usage: js '<async function body>'}" ;;
eval)     wd eval "${1:?usage: eval '<expression>'}" ;;
press)    wd press "${1:?usage: press <Combo>}" ;;
snapshot) wd snapshot "$@" ;;
wait)     wd wait "$@" ;;
errors)   wd errors "$@" ;;
audit)    wd js "$(cat "$HERE/audit.js")" ;;
text)     wd js "return document.querySelector($(jsstr "${1:?css}"))?.innerText ?? null" ;;
wclick)   wd js "const el = document.querySelector($(jsstr "${1:?css}")); if (!el) throw new Error('no match'); el.click(); return true" ;;
wshot)    mkdir -p "$SHOTS"; wd shot "$SHOTS/${1:?usage: wshot <name>}.png" ;;
expect)
  label="${1:?usage: expect <label> '<expr>'}"; expr="${2:?expr}"
  if wd wait "$expr" "${3:-5}" 2>/dev/null; then
    record PASS "$label"; echo "PASS  $label"
  else
    mkdir -p "$SHOTS"; shot="$SHOTS/FAIL-$(echo "$label" | tr -c 'A-Za-z0-9' '-' | cut -c1-50).png"
    wd shot "$shot" >/dev/null 2>&1 || true
    got="$(wd eval "$expr" 2>&1 | head -c 200 || true)"
    record FAIL "$label" "got: $got  screenshot: $shot"; echo "FAIL  $label  (got: $got)"; exit 1
  fi
  ;;
expect-db)
  label="${1:?usage: expect-db <label> '<sql>' <want>}"; want="${3?want}"
  got="$(sqlite3 "$DB" "${2:?sql}" 2>&1 || true)"
  if [ "$got" = "$want" ]; then record PASS "$label"; echo "PASS  $label"
  else record FAIL "$label" "want: $want  got: $got"; echo "FAIL  $label  (want: $want, got: $got)"; exit 1; fi
  ;;
report)
  touch "$RESULTS"
  p=$(grep -c '^PASS' "$RESULTS" || true); f=$(grep -c '^FAIL' "$RESULTS" || true)
  errs=""; [ -f "$STATE/wd.sid" ] && errs="$(wd errors 2>/dev/null || true)"
  hard="$(printf '%s\n' "$errs" | grep -E '^(uncaught|csp|unhandledrejection)' || true)"
  echo "desktop-check: $p passed, $f failed"
  grep '^FAIL' "$RESULTS" | awk -F'\t' '{print "  ✗ " $2 " — " $3}' || true
  if [ -n "$hard" ]; then echo "page errors:"; printf '%s\n' "$hard" | sed 's/^/  ! /'; fi
  soft=$(printf '%s\n' "$errs" | grep -c '^console.error' || true)
  [ "$soft" -gt 0 ] && echo "($soft console.error lines — see: desktop.sh errors)"
  [ "${1:-}" = "--reset" ] && : >"$RESULTS"
  [ "$f" = 0 ] && [ -z "$hard" ]
  ;;
seed-demo)
  # Browser-mode journeys assume the mock backend's demo pages. Replay that seed
  # through the real API so the same journeys can run against the real backend.
  wd js "$(cat "$HERE/seed-demo.js")"
  ;;
paste-image)
  b64="$(python3 -c "
import zlib,struct,base64
w=h=96; raw=b''.join(b'\\x00'+bytes([220,40,40])*w for _ in range(h))
def ch(t,d): c=struct.pack('>I',len(d))+t+d; return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
print(base64.b64encode(b'\\x89PNG\\r\\n\\x1a\\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b'')).decode())")"
  wd js "const bytes = Uint8Array.from(atob('$b64'), c => c.charCodeAt(0));
const dt = new DataTransfer(); dt.items.add(new File([bytes], 'pasted.png', {type: 'image/png'}));
window.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
return 'pasted';"
  ;;
fixture-pdf)
  out="$APP_HOME/desktop-check.pdf"
  python3 - "$out" <<'PY'
import sys
objs=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
 "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
 "<< /Length 77 >>\nstream\n0 0 1 rg 20 20 80 80 re f\nBT /F1 24 Tf 120 100 Td (Desktop check) Tj ET\nendstream",
 "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
s="%PDF-1.4\n"; offs=[]
for i,o in enumerate(objs): offs.append(len(s)); s+=f"{i+1} 0 obj\n{o}\nendobj\n"
x=len(s); s+=f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n"+"".join(f"{o:010d} 00000 n \n" for o in offs)
s+=f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
open(sys.argv[1],"w").write(s)
PY
  echo "$out"
  ;;
status)
  alive xvfb && echo "xvfb: up ($DISPLAY)" || echo "xvfb: down"
  alive app && echo "app: up (window $(win), profile $PROFILE, webdriver=$(cat "$STATE/mode" 2>/dev/null || echo 0))" || echo "app: down"
  echo "state: $STATE"
  ;;
log) tail -n "${1:-30}" "$STATE/app.log" ;;
down)
  stop_app
  alive xvfb && kill "$(cat "$STATE/xvfb.pid")" 2>/dev/null || true; rm -f "$STATE/xvfb.pid"
  echo "down (screenshots kept in $SHOTS)"
  ;;
*) sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
