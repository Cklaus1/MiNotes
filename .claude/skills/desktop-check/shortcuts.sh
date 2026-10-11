#!/usr/bin/env bash
# DOCS VS BEHAVIOUR — do the advertised shortcuts do what they say?
#
# 1. Collects every advertised shortcut (Settings › Keyboard Shortcuts, Getting Started,
#    title/placeholder hints, command-palette hints, README/CLAUDE.md) and every key
#    handler in crates/minotes-app/src (shortcuts_collect.py).
# 2. Presses each testable shortcut in the real app, on a fresh page, from a neutral
#    state (nothing focused) and from inside a block editor. WebDriver key events first;
#    if that does not produce the effect, xdotool (real X input) — the report says which.
# 3. Classifies: advertised-and-works / advertised-but-broken / works-but-undocumented /
#    conflicts.
#
#   shortcuts.sh [--no-build] [--keep-up] [--only '<substring>']
# Report: $DESKTOP_CHECK_DIR/signals/shortcuts.md
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signal-lib.sh"
REPORT="$SIG_OUT/shortcuts.md"; ROWS="$SIG_OUT/shortcuts.tsv"; : >"$ROWS"
ONLY=""; prev=""; for a in "$@"; do [ "$prev" = "--only" ] && ONLY="$a"; prev="$a"; done
python3 "$SIG_HERE/shortcuts_collect.py" "$REPO" advertised >"$SIG_OUT/shortcuts-advertised.tsv"
python3 "$SIG_HERE/shortcuts_collect.py" "$REPO" handlers >"$SIG_OUT/shortcuts-handlers.tsv"

sig_up shortcuts || { printf '# Shortcuts\n\napp did not start\n' >"$REPORT"; echo "report: $REPORT"; exit 0; }
settings_live="$(js 'window.__MINOTES__.openSettings(); await window.__sig.sleep(700);
  const r = [...document.querySelectorAll(".shortcut-row")].map(x => x.innerText.replace(/\s+/g, " ").trim()); window.__MINOTES__.closePanel(); return r.join(" · ");' | tr -d '"')"

N=0
fresh() { # new page with alpha, beta, gamma(child of beta); go there; nothing focused
  N=$((N+1)); local t="SC $N"
  js "const api = window.__MINOTES__.modules['/src/lib/api.ts']; const T = window.__MINOTES__;
      T.closePanel(); const pc = document.querySelector('.pdf-close-btn'); if (pc) pc.click();
      document.querySelectorAll('.minotes-toast').forEach(t => t.remove());
      const p = await api.createPage('$t'); await api.createBlock(p.id, 'alpha [[Project Alpha]]');
      const b = await api.createBlock(p.id, 'beta'); await api.createBlock(p.id, 'gamma', b.id);
      T.navigateTo('$t'); for (let i = 0; i < 40 && T.getCurrentPage() !== '$t'; i++) await window.__sig.sleep(100);
      await window.__sig.sleep(500); window.__sig.dialogs.length = 0; window.__sig.answer = null;
      if (document.activeElement) document.activeElement.blur(); return 1" >/dev/null
  PAGE="$t"; park
}
# focus block N (0-based, visible order) with a real click, cursor at the end
inblock() { rclick "document.querySelectorAll('.block .ProseMirror')[${1:-0}]" 0.3; xd key End; sleep 0.2; }
# Resolve the page when the check RUNS, not when the check string is built: callers
# build the expression before fresh() sets $PAGE, so baking $PAGE in read the
# previous test's page.
tree() { echo "(async () => { const t = await window.__MINOTES__.modules['/src/lib/api.ts'].getPageTree(window.__MINOTES__.getCurrentPage()); return $1; })()"; }

# t <combo label> <wd combo> <xdotool combo> <context> <claim> <setup shell> <check JS expr> [cleanup shell]
t() {
  local label="$1" wdc="$2" xdc="$3" ctx="$4" claim="$5" setup="$6" check="$7" cleanup="${8:-}"
  [ -n "$ONLY" ] && [[ "$label" != *"$ONLY"* ]] && return 0
  local path="neither" detail=""
  for via in wd xdo; do
    fresh; [ "$ctx" = editor ] && inblock 0
    eval "$setup" >/dev/null 2>&1
    js 'window.__b = { page: window.__MINOTES__.getCurrentPage(), theme: document.documentElement.className + "|" + document.body.className + "|" + (document.documentElement.dataset.theme || ""), focus: document.activeElement && document.activeElement.className, dialogs: window.__sig.dialogs.length }; return 1' >/dev/null
    if [ "$via" = wd ]; then "$D" press "$wdc" >/dev/null 2>&1; else xd key "$xdc"; fi
    sleep 1.2
    if [ "$(ev "$check")" = "true" ]; then path="$via"; break; fi
    [ "$via" = wd ] && [ -z "$xdc" ] && break
  done
  detail="$(evs 'JSON.stringify({page: window.__MINOTES__.getCurrentPage(), focus: (document.activeElement && (document.activeElement.closest(".ProseMirror") ? "editor" : document.activeElement.tagName)), dialogs: window.__sig.dialogs.slice(-1).map(d => d.msg), canvas: document.querySelector(".canvas-mode-btn.active") && document.querySelector(".canvas-mode-btn.active").innerText})')"
  eval "$cleanup" >/dev/null 2>&1
  local res="works"; [ "$path" = neither ] && res="NO EFFECT"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$ctx" "$claim" "$res" "$path" "$detail" >>"$ROWS"
  printf '  %-14s %-8s %-34s %s (%s)\n' "$label" "$ctx" "${claim:0:34}" "$res" "$path"
}
canvas_is() { echo "(document.querySelector('.canvas-mode-btn.active')?.innerText || '').includes('$1')"; }
journal='(window.__MINOTES__.getCurrentPage() || "").startsWith("Journal/")'

echo "testing shortcuts…"
for ctx in neutral editor; do
  t "Ctrl+K" Control+k ctrl+k $ctx "Search" "" 'window.__MINOTES__.isPanelOpen("search")'
  t "Ctrl+J" Control+j ctrl+j $ctx "Journal (\"anytime\")" "" "$journal"
  t "Ctrl+N" Control+n ctrl+n $ctx "New Page" "" 'window.__sig.dialogs.length > window.__b.dialogs'
  t "Ctrl+G" Control+g ctrl+g $ctx "Graph" "" "$(canvas_is Graph)"
  t "Ctrl+M" Control+m ctrl+m $ctx "Mind Map" "" "$(canvas_is Mind)"
  t "Ctrl+W" Control+w ctrl+w $ctx "Draw (new whiteboard)" "" "$(canvas_is Draw)"
  t "Ctrl+Shift+K" Control+Shift+K ctrl+shift+k $ctx "Kanban" "" "$(canvas_is Kanban)"
  t "Ctrl+," Control+, ctrl+comma $ctx "Settings" "" 'window.__MINOTES__.isPanelOpen("settings")'
  t "Ctrl+Q" Control+q ctrl+q $ctx "SQL Query Panel (palette hint)" "" 'window.__MINOTES__.isPanelOpen("query")'
  t "Ctrl+R" Control+r ctrl+r $ctx "Flashcard Review (palette hint)" "" 'window.__MINOTES__.isPanelOpen("review")'
  t "Ctrl+Shift+T" Control+Shift+T ctrl+shift+t $ctx "Toggle Theme (palette hint)" "" '(document.documentElement.className + "|" + document.body.className + "|" + (document.documentElement.dataset.theme || "")) !== window.__b.theme' '"$D" press Control+Shift+T'
  t "Ctrl+P" Control+p ctrl+p $ctx "(undocumented) open PDF by path" "" 'window.__sig.dialogs.some(d => /PDF/.test(d.msg))'
  t "Ctrl+1" Control+1 ctrl+1 $ctx "(undocumented) open pinned page #1" "ev \"(async()=>{const api=window.__MINOTES__.modules['/src/lib/api.ts']; const p=(await api.listPages(1000)).find(x=>x.title==='Research Notes'); try{await api.addFavorite(p.id)}catch(e){} return 1})()\"" 'window.__MINOTES__.getCurrentPage() === "Research Notes"'
done
# Undo / redo
t "Ctrl+Z" Control+z ctrl+z neutral "Undo (after Enter made a block)" 'inblock 1; xd key Return; sleep 1.2; blur; ev "(window.__b0 = window.__MINOTES__.getBlockCount(), 1)"' 'window.__MINOTES__.getBlockCount() < window.__b0'
t "Ctrl+Z" Control+z ctrl+z editor "Undo (typing)" 'xd type zzz; sleep 0.4' '!(window.__MINOTES__.getLiveBlockContent(0) || "").includes("zzz")'
t "Ctrl+Shift+Z" Control+Shift+z ctrl+shift+z neutral "Redo (README)" 'inblock 1; xd key Return; sleep 1.2; blur; ev "(window.__b0 = window.__MINOTES__.getBlockCount(), 1)"; xd key ctrl+z; sleep 1.2' 'window.__MINOTES__.getBlockCount() === window.__b0'
# Editor keys
t "Enter" Enter Return editor "New Block" "" 'window.__MINOTES__.getBlockCount() === 4'
t "Tab" Tab Tab editor "Indent" 'inblock 1' "$(tree 't.blocks.find(b => b.content === "beta").parent_id !== null')"
t "Shift+Tab" Shift+Tab shift+Tab editor "Outdent (README)" 'inblock 2' "$(tree '!t.blocks.find(b => b.content === "gamma").parent_id')"
t "Esc" Escape Escape editor "Close (Settings list) — in a nested block" 'inblock 2' "$(tree '!!t.blocks.find(b => b.content === "gamma").parent_id && !document.activeElement.closest(".ProseMirror")')"
t "Esc" Escape Escape editor "(source) outdents a nested block" 'inblock 2' "$(tree '!t.blocks.find(b => b.content === "gamma").parent_id')"
t "Ctrl+Enter" Control+Enter ctrl+Return editor "Cycle TODO → DOING → DONE" "" '(window.__MINOTES__.getLiveBlockContent(0) || "").startsWith("TODO")'
t "Ctrl+B" Control+b ctrl+b editor "Bold (toolbar tooltip)" 'xd type " word"; xd key ctrl+shift+Left' '/<strong>/.test(document.querySelector(".block .ProseMirror").innerHTML)'
t "Ctrl+I" Control+i ctrl+i editor "Italic (toolbar tooltip)" 'xd type " word"; xd key ctrl+shift+Left' '/<em>/.test(document.querySelector(".block .ProseMirror").innerHTML)'
t "Ctrl+E" Control+e ctrl+e editor "Inline Code (toolbar tooltip)" 'xd type " word"; xd key ctrl+shift+Left' '/<code>/.test(document.querySelector(".block .ProseMirror").innerHTML)'
t "/" / slash editor "Commands (slash menu)" 'xd type " "' '!!document.querySelector(".slash-menu")'
t "[[" "[" bracketleft editor "Link to a page" 'xd type " ["' '[...document.querySelectorAll(".tippy-box")].some(window.__sig.visible)'
t "Backspace" Backspace BackSpace editor "Delete an empty block (at start)" 'xd key Return; sleep 1.2' 'window.__MINOTES__.getBlockCount() === 3'
t ">" ">" greater neutral "Command mode in search" '"$D" press Control+k; sleep 0.6' '/commands/i.test(document.querySelector(".command-palette") && document.querySelector(".command-palette").innerText || "")'
t "Esc" Escape Escape neutral "Close (Settings panel)" 'ev "window.__MINOTES__.openSettings()"; sleep 0.6' '!window.__MINOTES__.isPanelOpen("settings")'
t "Ctrl+F" Control+f ctrl+f neutral "Filter cards (Kanban placeholder)" '"$D" press Control+Shift+K; sleep 1.2' '/Filter/.test(document.activeElement && document.activeElement.placeholder || "")'
# Undocumented ones found in source
t "Ctrl+A" Control+a ctrl+a neutral "(undocumented) select all blocks" "" 'window.__MINOTES__.getSelectedCount() >= 3'
t "Ctrl+Shift+C" Control+Shift+C ctrl+shift+c neutral "(undocumented) copy page" "" 'window.__sig.feedback().some(f => /cop/i.test(f))'
t "Alt+→" Alt+ArrowRight alt+Right editor "(undocumented) zoom into block" "" '!!document.querySelector(".breadcrumb-bar")'
# Ctrl+\ (toggle right sidebar) is not tested: the right sidebar could not be opened (Shift+click on a [[link]] did nothing).

errs="$(evs 'window.__sig.events.map(e => e.kind + " [" + e.mark + "] " + e.msg).join("\n")')"
sig_down

python3 - "$ROWS" "$SIG_OUT/shortcuts-advertised.tsv" "$SIG_OUT/shortcuts-handlers.tsv" "$settings_live" >"$REPORT" <<'PY'
import sys, collections
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
adv = collections.defaultdict(list)
for l in open(sys.argv[2]):
    c, src, text = l.rstrip("\n").split("\t")
    adv[c].append(f"{src}: “{text}”")
handlers = collections.defaultdict(list)
for l in open(sys.argv[3]):
    c, loc, _ = l.rstrip("\n").split("\t")
    handlers[c].append(loc.replace("crates/minotes-app/src/", ""))
cell = lambda s, n=120: (s if len(s) <= n else s[:n - 1] + "…").replace("|", "\\|")
print("# Docs vs behaviour: keyboard shortcuts\n")
print(f"Settings › Keyboard Shortcuts, as rendered: {sys.argv[4]}\n")
print("Each shortcut pressed on a fresh page, from a **neutral** state (nothing focused) and from **inside a block editor**. "
      "*input* = which input path produced the effect: `wd` WebDriver key event, `xdo` real X key (tried when wd did nothing), `neither`.\n")
print("| combo | context | claim | result | input | advertised in | state after |")
print("|---|---|---|---|---|---|---|")
for r in rows:
    label, ctx, claim, res, via, detail = r
    where = "; ".join(sorted({a.split(":")[0] for a in adv.get(label, [])})) or "**nowhere**"
    print(f"| `{label}` | {ctx} | {cell(claim, 50)} | {'✅ works' if res == 'works' else '❌ ' + res} | {via} | {cell(where, 90)} | {cell(detail, 110)} |")

def key(r): return (r[0], r[1])
works = {key(r) for r in rows if r[3] == "works"}
tested = {r[0] for r in rows}
print("\n## Advertised and works\n")
for c in sorted({r[0] for r in rows if r[3] == "works" and r[0] in adv}):
    ctxs = [r[1] for r in rows if r[0] == c and r[3] == "works"]
    print(f"- `{c}` ({', '.join(ctxs)})")
print("\n## Advertised but broken (in at least one context)\n")
for r in rows:
    if r[3] != "works" and r[0] in adv:
        print(f"- `{r[0]}` from **{r[1]}**: claim “{r[2]}” — no effect. Advertised in: {cell('; '.join(adv[r[0]]), 260)}")
untested = sorted(c for c in adv if c not in tested)
if untested:
    print("\n## Advertised but not tested by this tool\n")
    for c in untested:
        print(f"- `{c}` — {cell('; '.join(adv[c]), 200)}")
print("\n## Works but undocumented\n")
for c in sorted({r[0] for r in rows if r[3] == "works" and r[0] not in adv}):
    print(f"- `{c}` — {next(r[2] for r in rows if r[0] == c)}")
print("\nOther key handlers in the source that no advertising text mentions (context-specific; not pressed):\n")
skip = set(adv) | tested | {"Enter", "Esc", "↑", "↓", "Backspace", "Delete", "Tab"}
for c in sorted(handlers):
    if c not in skip and c.strip():
        print(f"- `{c}` — {', '.join(sorted(set(handlers[c]))[:4])}")
print("\n## Conflicts\n")
same = collections.defaultdict(set)
for r in rows:
    if r[3] == "works":
        same[r[0]].add(r[2])
for c, claims in same.items():
    if len({x.split(" (")[0].split()[0].lower() for x in claims}) > 1:
        print(f"- `{c}` does different things by context: {'; '.join(sorted(claims))}")
for r in rows:
    if r[0] == "Esc" and r[1] == "editor" and r[3] == "works":
        pass
for r in rows:
    if r[0] == "Esc" and r[1] == "editor" and "outdents" in r[2] and r[3] == "works":
        print("- `Esc` is advertised as “Close”, but inside a nested block it **outdents** the block and keeps editing (useBlockEditor.ts).")
os_conv = {"Ctrl+W": "close window/tab", "Ctrl+Q": "quit the application (Linux/GNOME convention)", "Ctrl+R": "reload",
           "Ctrl+P": "print", "Ctrl+N": "new window", "Ctrl+J": "downloads (browsers)", "Ctrl+Shift+T": "reopen closed tab",
           "Ctrl+M": "minimise (macOS Cmd+M)", "Ctrl+E": "search bar (browsers)", "Ctrl+K": "insert link (most editors)"}
for c, conv in os_conv.items():
    if c in tested:
        print(f"- `{c}` overrides the common platform meaning “{conv}”.")
PY
{ echo; echo "### Errors recorded while pressing shortcuts"; echo; if [ -n "$errs" ]; then printf '%s\n' "$errs" | sort | uniq -c | sed 's/^ *//; s/^/- ×/' | cut -c1-250 | head -20; else echo "none"; fi; } >>"$REPORT"
echo "report: $REPORT"
exit 0
