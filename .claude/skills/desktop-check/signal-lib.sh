# Shared helpers for the signal tools (friction.sh, silent-errors.sh, dead-ends.sh,
# shortcuts.sh). Source it; do not run it.
#
# Every tool: starts the real app on its own throwaway profile, seeds the demo
# pages, installs signal-hooks.js, does its work, writes a markdown report into
# $DESKTOP_CHECK_DIR/signals/, and shuts the app down again.
#   --no-build   reuse target/debug/minotes-app
#   --keep-up    leave the app running afterwards (for poking at a finding by hand)
SIG_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SIG_HERE/../../.." && pwd)"
D="$SIG_HERE/desktop.sh"
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-check-$(id -u)}"
export DISPLAY="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
SIG_OUT="$DESKTOP_CHECK_DIR/signals"; mkdir -p "$SIG_OUT"
SIG_BUILD=""; SIG_KEEP=0
for a in "$@"; do case "$a" in --no-build) SIG_BUILD="--no-build" ;; --keep-up) SIG_KEEP=1 ;; esac; done
CLICKS=0; KEYS=0

# --- lifecycle ---------------------------------------------------------------
sig_up() { # $1 = profile name
  "$D" up --webdriver --profile "$1" $SIG_BUILD >/dev/null || { echo "launch failed (see $DESKTOP_CHECK_DIR/app.log, build.log)" >&2; return 1; }
  "$D" seed-demo >/dev/null 2>&1
  hooks
  # seed-demo can leave a stale "openPage failed" banner behind; start from a clean page.
  goto "Getting Started"
}
sig_down() { [ "$SIG_KEEP" = 1 ] && { echo "(app left running: $D down when finished)"; return 0; }; "$D" down >/dev/null 2>&1 || true; }
hooks() { "$D" js "$(cat "$SIG_HERE/signal-hooks.js")" >/dev/null 2>&1; }

# --- JS ----------------------------------------------------------------------
ev()  { "$D" eval "$1" 2>/dev/null; }                 # JSON result
evs() { "$D" eval "$1" 2>/dev/null | python3 -c 'import json,sys
try: v=json.load(sys.stdin)
except Exception: v=""
print(v if isinstance(v,str) else json.dumps(v,ensure_ascii=False))'; }   # unquoted string
js()  { "$D" js "$1" 2>/dev/null; }
waitfor() { "$D" wait "$1" "${2:-6}" 2>/dev/null; }
mark() { ev "(window.__sig.mark = $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"), 1)" >/dev/null; }
page() { evs 'window.__MINOTES__.getCurrentPage()'; }
goto() { ev "window.__MINOTES__.navigateTo($(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"))" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()===$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")" 6; sleep 0.6; }
blur() { ev '(document.activeElement && document.activeElement.blur(), window.getSelection().removeAllRanges(), 1)' >/dev/null; }
shot() { "$D" wshot "../signals/$1" 2>/dev/null; }     # → $SIG_OUT/$1.png

# --- real input (xdotool), counted ------------------------------------------
# center '<js expr → element>'  → "x y" (page px == screen px), empty if not found/visible
center() { "$D" js "const el = $1; if (!el) return ''; el.scrollIntoView({block: 'nearest'}); const r = el.getBoundingClientRect(); if (!r.width || !r.height) return ''; return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2);" 2>/dev/null | tr -d '"'; }
xd() { timeout 15 xdotool "$@"; }
rclick()  { local p; p="$(center "$1")"; [ -n "$p" ] || { echo "  (no element: $1)" >&2; return 1; }; xd mousemove $p; sleep 0.25; xd click 1; CLICKS=$((CLICKS+1)); sleep "${2:-0.6}"; }
rrclick() { local p; p="$(center "$1")"; [ -n "$p" ] || { echo "  (no element: $1)" >&2; return 1; }; xd mousemove $p; sleep 0.25; xd click 3; CLICKS=$((CLICKS+1)); sleep "${2:-0.6}"; }
rhover()  { local p; p="$(center "$1")"; [ -n "$p" ] || return 1; xd mousemove $p; sleep 0.4; }
rclickxy() { xd mousemove "$1" "$2"; sleep 0.2; xd click 1; CLICKS=$((CLICKS+1)); sleep "${3:-0.6}"; }
rtype()   { xd type --delay "${SIG_TYPE_DELAY:-30}" -- "$1"; KEYS=$((KEYS+${#1})); sleep 0.3; }
rkey()    { xd key "$1"; KEYS=$((KEYS+1)); sleep "${2:-0.6}"; }
reset_count() { CLICKS=0; KEYS=0; }
# Park the pointer where it hovers nothing interactive.
park() { xd mousemove 700 600; sleep 0.2; }
md() { printf '%s\n' "$*" >>"$REPORT"; }
