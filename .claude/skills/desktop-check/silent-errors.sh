#!/usr/bin/env bash
# SILENT ERRORS — which failures does the app hide from the user?
#
# Installs signal-hooks.js (rejected Tauri commands, console.error/warn, uncaught
# errors, unhandled rejections, failed resource loads, CSP violations, native
# dialogs), runs every scenario in silent-scenarios.js (all tour views + error-prone
# actions) and, for each problem recorded, checks what was VISIBLE right after it
# (toast, error banner, inline error, dialog).
#
#   silent-errors.sh [--no-build] [--keep-up] [--only '<substring>']
# Report: $DESKTOP_CHECK_DIR/signals/silent-errors.md   (+ silent-errors.json, se-NN.png)
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signal-lib.sh"
REPORT="$SIG_OUT/silent-errors.md"; RAW="$SIG_OUT/silent-errors.json"
ONLY=""; prev=""; for a in "$@"; do [ "$prev" = "--only" ] && ONLY="$a"; prev="$a"; done
rm -f "$SIG_OUT"/se-*.png

sig_up silent || { printf '# Silent errors\n\napp did not start\n' >"$REPORT"; echo "report: $REPORT"; exit 0; }
names_json="$(js "$(cat "$SIG_HERE/silent-scenarios.js")")"
[ -n "$names_json" ] && [ "$names_json" != "null" ] || { echo "could not load scenarios" >&2; sig_down; exit 1; }
hooked="$(evs 'String(window.__sig.invokeHooked)')"
startup="$(ev 'window.__sig.events.length')"

echo "[" >"$RAW.tmp"; n=0; first=1
while IFS= read -r name; do
  [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && continue
  n=$((n+1)); id="$(printf 'se-%02d' "$n")"
  qn="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$name")"
  res="$(js "const name = $qn; const S = window.__sig, T = window.__MINOTES__;
    S.answer = null; T.closePanel(); const pc = document.querySelector('.pdf-close-btn'); if (pc) pc.click();
    if (document.activeElement) document.activeElement.blur();
    await S.sleep(300);
    if (S.feedback().some(f => f.startsWith('banner'))) { T.navigateTo('Getting Started'); await S.sleep(1200); }
    const before = S.events.length;
    S.baseline = S.feedback(); S.mark = name;
    let outcome; try { outcome = await window.__scn[name](); } catch (e) { outcome = 'SCENARIO THREW: ' + ((e && e.message) || e); }
    await S.sleep(1800);
    return { name, outcome: String(outcome), feedback: S.feedback().filter(f => !S.baseline.includes(f)), dialogs: S.dialogs.filter(d => d.mark === name), newEvents: S.events.length - before };")"
  [ -n "$res" ] || res="{\"name\": $qn, \"outcome\": \"(WebDriver call failed)\", \"feedback\": [], \"dialogs\": [], \"newEvents\": 0}"
  new="$(printf '%s' "$res" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("newEvents",0))' 2>/dev/null || echo 0)"
  [ "$new" != "0" ] && shot "$id" >/dev/null
  [ "$first" = 1 ] || echo "," >>"$RAW.tmp"; first=0
  printf '{"id": "%s", "result": %s}' "$id" "$res" >>"$RAW.tmp"
  printf '  %s %-48s %s problem(s)\n' "$id" "${name:0:48}" "$new"
done < <(printf '%s' "$names_json" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')
echo "]" >>"$RAW.tmp"

ev 'window.__sig.events' >"$SIG_OUT/silent-events.json"; [ -s "$SIG_OUT/silent-events.json" ] || echo "[]" >"$SIG_OUT/silent-events.json"
applog="$("$D" log 400 2>/dev/null | grep -iE 'error|panic|warn' | grep -viE 'libEGL|MESA|dbus|Gtk-WARNING|atk-bridge|Fontconfig' | sort | uniq -c | sort -rn | head -15)"
python3 - "$RAW.tmp" "$SIG_OUT/silent-events.json" "$RAW" "$hooked" "$startup" <<'PY'
import json, sys
json.dump({"scenarios": json.load(open(sys.argv[1])), "events": json.load(open(sys.argv[2])),
           "invokeHooked": sys.argv[4], "startupEvents": sys.argv[5]}, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
PY
rm -f "$RAW.tmp" "$SIG_OUT/silent-events.json"
sig_down
python3 "$SIG_HERE/silent_report.py" "$RAW" >"$REPORT"
{ echo; echo "## Rust-side log lines (app stderr)"; echo; if [ -n "$applog" ]; then echo '```'; printf '%s\n' "$applog" | cut -c1-220; echo '```'; else echo "none matching error|panic|warn"; fi; } >>"$REPORT"
echo "report: $REPORT"
exit 0
