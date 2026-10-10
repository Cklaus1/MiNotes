#!/usr/bin/env bash
# Drive the REAL MiNotes desktop app (Tauri/WebKitGTK) on a private virtual
# display, against a throwaway HOME. Never touches the user's ~/.minotes.
#
#   desktop.sh up [--no-build] [--webdriver]
#                                start display, build + launch app, wait for window.
#                                --webdriver launches through tauri-driver so the
#                                js/text/wclick/wshot commands work (DOM access).
#   desktop.sh shot <name>       screenshot → prints the PNG path
#   desktop.sh click <x> <y>     left click (window is at 0,0 so page coords == screen coords)
#   desktop.sh key <keys...>     e.g. key ctrl+p   |  key Escape  |  key Return
#   desktop.sh type <text>       type text into the focused widget / dialog
#   desktop.sh cli <args...>     run the minotes CLI against the scratch database
#   desktop.sh fixture-pdf       write a 1-page test PDF → prints its path
#   desktop.sh js '<body>'       (webdriver) run async JS in the app, print the JSON result.
#                                Body is an async function body: use `return`, `await`;
#                                `invoke(cmd, args)` calls a Tauri command.
#   desktop.sh text <css>        (webdriver) innerText of the first match
#   desktop.sh wclick <css>      (webdriver) click the first match
#   desktop.sh wshot <name>      (webdriver) screenshot of the webview only
#   desktop.sh paste-image       (webdriver) paste a generated red 96x96 PNG into the
#                                focused view (e.g. an open whiteboard)
#   desktop.sh status            is everything alive?
#   desktop.sh log               tail the app's stdout/stderr
#   desktop.sh down              stop app + display (state dir is kept for inspection)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STATE="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
DNUM="${DESKTOP_CHECK_DISPLAY:-97}"
export DISPLAY="localhost:$DNUM"
# glvnd otherwise picks the NVIDIA EGL vendor, which aborts the X server on WSL.
MESA_EGL=/usr/share/glvnd/egl_vendor.d/50_mesa.json
[ -f "$MESA_EGL" ] && export __EGL_VENDOR_LIBRARY_FILENAMES="$MESA_EGL"

APP_HOME="$STATE/home"; DB="$APP_HOME/.minotes/default.db"; SHOTS="$STATE/shots"
BIN="$REPO/target/debug/minotes-app"; CLI="$REPO/target/debug/minotes"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD_PORT="${DESKTOP_CHECK_WD_PORT:-4455}"
wd() { python3 "$HERE/wd.py" "http://127.0.0.1:$WD_PORT" "$STATE/wd.sid" "$@"; }
jsstr() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
x() { timeout 15 "$@"; }
win() { x xwininfo -root -tree 2>/dev/null | awk '/"MiNotes"/ {print $1; exit}'; }
need() { for t in "$@"; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done; }

cmd="${1:-}"; shift || true
case "$cmd" in
up)
  need Xvfb xdotool xwininfo import
  mkdir -p "$STATE" "$SHOTS"
  if ! alive xvfb; then
    # TCP only: on WSLg /tmp/.X11-unix is owned by the system compositor.
    Xvfb ":$DNUM" -nolisten unix -listen tcp -ac -screen 0 1280x900x24 >"$STATE/xvfb.log" 2>&1 &
    echo $! >"$STATE/xvfb.pid"; sleep 2
    alive xvfb || { echo "Xvfb failed to start:" >&2; tail -5 "$STATE/xvfb.log" >&2; exit 1; }
  fi
  build=1; webdriver=0
  for a in "$@"; do case "$a" in --no-build) build=0 ;; --webdriver) webdriver=1 ;; *) echo "unknown option: $a" >&2; exit 2 ;; esac; done
  if [ "$build" = 1 ]; then
    echo "building desktop app + CLI (debug; production frontend + CSP)…"
    (cd "$REPO/crates/minotes-app" && npx tauri build --debug --no-bundle) >"$STATE/build.log" 2>&1 \
      || { echo "build failed:" >&2; tail -15 "$STATE/build.log" >&2; exit 1; }
    (cd "$REPO" && cargo build -q -p minotes-cli) >>"$STATE/build.log" 2>&1
  fi
  [ -x "$BIN" ] || { echo "no binary at $BIN (run without --no-build)" >&2; exit 1; }
  if alive app; then
    [ -f "$STATE/wd.sid" ] && { wd quit >/dev/null 2>&1 || true; }
    kill "$(cat "$STATE/app.pid")" 2>/dev/null || true; sleep 1
  fi
  rm -rf "$APP_HOME" "$STATE/wd.sid"; mkdir -p "$APP_HOME"
  export WAYLAND_DISPLAY= GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
  if [ "$webdriver" = 1 ]; then
    # tauri-driver (wrapping WebKitWebDriver) launches the app itself, so the app
    # inherits this environment — including the scratch HOME.
    TD="$(command -v tauri-driver || echo "$HOME/.cargo/bin/tauri-driver")"
    { [ -x "$TD" ] && command -v WebKitWebDriver >/dev/null; } || {
      echo "webdriver mode needs: apt-get install webkit2gtk-driver && cargo install tauri-driver --locked" >&2; exit 2; }
    HOME="$APP_HOME" nohup "$TD" --port "$WD_PORT" --native-port "$((WD_PORT + 1))" >"$STATE/app.log" 2>&1 </dev/null &
    echo $! >"$STATE/app.pid"; sleep 2
    wd new "$BIN"
  else
    HOME="$APP_HOME" nohup "$BIN" >"$STATE/app.log" 2>&1 </dev/null &
    echo $! >"$STATE/app.pid"
  fi
  for _ in $(seq 1 40); do [ -n "$(win)" ] && break; alive app || break; sleep 1; done
  [ -n "$(win)" ] || { echo "app window never appeared:" >&2; tail -10 "$STATE/app.log" >&2; exit 1; }
  sleep 4   # first paint + initial data load
  echo "up: display=$DISPLAY window=$(win) home=$APP_HOME shots=$SHOTS"
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
js)     wd js "${1:?usage: js '<async function body>'}" ;;
text)   wd js "return document.querySelector($(jsstr "${1:?css}"))?.innerText ?? null" ;;
wclick) wd js "const el = document.querySelector($(jsstr "${1:?css}")); if (!el) throw new Error('no match'); el.click(); return true" ;;
wshot)  mkdir -p "$SHOTS"; wd shot "$SHOTS/${1:?usage: wshot <name>}.png" ;;
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
  alive app && echo "app: up (window $(win))" || echo "app: down"
  echo "state: $STATE"
  ;;
log) tail -n "${1:-30}" "$STATE/app.log" ;;
down)
  [ -f "$STATE/wd.sid" ] && { wd quit >/dev/null 2>&1 || true; rm -f "$STATE/wd.sid"; }
  for p in app xvfb; do alive $p && kill "$(cat "$STATE/$p.pid")" 2>/dev/null || true; rm -f "$STATE/$p.pid"; done
  echo "down (screenshots kept in $SHOTS)"
  ;;
*) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
