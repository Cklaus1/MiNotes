#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  MiNotes Desktop Journeys
#
#  Journeys that only exist in the REAL desktop app: data surviving a restart,
#  real keyboard typing, the CLI and the app sharing one database, and two
#  "devices" syncing through git.
#
#  Runs the actual binary on a private virtual display against throwaway HOMEs
#  (see .claude/skills/desktop-check). Nothing here touches ~/.minotes.
#
#    bash tests/desktop-journey-test.sh            # build, then run
#    DESKTOP_NO_BUILD=1 bash tests/desktop-journey-test.sh
#
#  The 52 browser journeys can also run against the real backend:
#    JOURNEY_BACKEND=desktop bash tests/user-journey-test.sh
# ═══════════════════════════════════════════════════════════

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DC="$REPO_ROOT/.claude/skills/desktop-check/desktop.sh"
export DESKTOP_CHECK_DIR="${DESKTOP_CHECK_DIR:-${TMPDIR:-/tmp}/minotes-desktop-journeys-$(id -u)}"
STATE="$DESKTOP_CHECK_DIR"
P=0; F=0; BUGS=()

pass() { echo -e "    \033[32m✓\033[0m $1"; P=$((P+1)); }
fail() { echo -e "    \033[31m✗\033[0m $1: $2"; F=$((F+1)); BUGS+=("$1: $2"); "$DC" wshot "FAIL-$F" >/dev/null 2>&1; }
step() { echo -e "  \033[90m→ $1\033[0m"; }
journey() { echo -e "\n\033[1;33m🧭 DESKTOP JOURNEY: $1\033[0m"; }
ev() { "$DC" eval "$1" 2>/dev/null | tr -d '"'; }
api() { ev "window.__MINOTES__?.$1"; }
# is <label> <actual> <expected>
is() { [[ "$2" == "$3" ]] && pass "$1" || fail "$1" "expected '$3', got '$2'"; }
waitfor() { "$DC" wait "$1" "${2:-15}" 2>/dev/null; }
db() { sqlite3 "$STATE/$1/.minotes/default.db" "$2" 2>&1; }
# Launch a profile (a "device"). First launch wipes it unless told to keep.
device() { "$DC" up --no-build --webdriver --profile "$1" ${2:+--keep} >/dev/null || { fail "launch $1" "app did not start"; return 1; }; }
PAGES="(async()=>{const api=await import('/src/lib/api.ts');return (await api.listPages(1000)).map(p=>p.title).sort().join('|')})()"
blocks_of() { ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('$1');return t.blocks.map(b=>b.content).join(' ¦ ')})()"; }

echo "═══════════════════════════════════════════════"
echo "  MiNotes Desktop Journeys (real app, real backend)"
echo "═══════════════════════════════════════════════"

rm -rf "$STATE"/{persist,devA,devB,remote.git} "$STATE/results.tsv"
if [[ -z "$DESKTOP_NO_BUILD" ]]; then
  "$DC" up --webdriver --profile persist >/dev/null || { echo "build/launch failed"; exit 1; }
else
  device persist || exit 1
fi

# ═══════════════════════════════════════════════
journey "D1. I write things, quit, and come back tomorrow"
# The most basic promise of a notes app.
# ═══════════════════════════════════════════════

step "I create a page with formatted, nested content"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Persist Me');const a=await api.createBlock(p.id,'**Bold** start with [[Getting Started]] and #tagged');const b=await api.createBlock(p.id,'Parent block');await api.createBlock(p.id,'Child block',b.id);await api.createBlock(p.id,'TODO finish the report');await api.setProperty(a.id,'block','status','urgent');return 'ok'})()" >/dev/null
api "navigateTo('Persist Me')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Persist Me'"
SIG="(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Persist Me');const ps=await Promise.all(t.blocks.map(b=>api.getProperties(b.id)));return t.blocks.map((b,i)=>b.id+'/'+(b.parent_id||'')+'/'+b.position+'/'+b.content+'/'+ps[i].map(p=>p.key+'='+p.value).join('&')).join(';')})()"
is "Page has 4 blocks" "$(api 'getBlockCount()')" "4"

step "I draw on a whiteboard"
"$DC" press "Control+w"; waitfor "!!document.querySelector('canvas')" 10
"$DC" click 229 62; sleep 0.5
DISPLAY="localhost:${DESKTOP_CHECK_DISPLAY:-97}" bash -c 'xdotool mousemove 300 300 mousedown 1; for i in $(seq 1 15); do xdotool mousemove $((300+i*20)) $((300+(i%4)*30)); sleep 0.03; done; xdotool mouseup 1'
sleep 3; "$DC" click 50 22; sleep 2
WB_BEFORE=$(db persist "select id||':'||length(data) from whiteboards")
[[ -n "$WB_BEFORE" ]] && pass "Whiteboard saved to the database ($WB_BEFORE)" || fail "Whiteboard not saved" "no row in whiteboards"
# Drawing added a {{whiteboard:…}} block to the page, so snapshot the page now.
BEFORE=$(blocks_of 'Persist Me')
SIG_BEFORE=$(ev "$SIG")
[[ "$BEFORE" == *"{{whiteboard:"* ]] && pass "Whiteboard block added to the page" || fail "No whiteboard block on the page" "$BEFORE"

step "I change a setting, pin the page, and collapse a block"
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings?s.updateSettings({ai:{...s.getSettings().ai,autoTag:false}}):s.saveSettings({...s.getSettings(),ai:{...s.getSettings().ai,autoTag:false}});return 'ok'})()" >/dev/null
ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Persist Me');await api.addFavorite(t.page.id);return 'ok'})()" >/dev/null
api "navigateTo('Persist Me')" >/dev/null; sleep 1
PI=$(ev "window.__MINOTES__.getBlocks().findIndex(b=>b.content==='Parent block')")
api "toggleCollapseBlock($PI)" >/dev/null; sleep 1
is "Collapsing hides the child (4 of 5 visible)" "$(api 'getBlockCount()')" "4"

step "I quit the app and open it again"
"$DC" restart >/dev/null && pass "App relaunched on the same data" || fail "Relaunch failed" ""
waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30

step "Everything I wrote is still there, exactly"
is "Page content survived" "$(blocks_of 'Persist Me')" "$BEFORE"
is "Ids, nesting, order and properties survived" "$(ev "$SIG")" "$SIG_BEFORE"
is "Whiteboard survived" "$(db persist "select id||':'||length(data) from whiteboards")" "$WB_BEFORE"
is "Setting survived" "$(ev "(async()=>{const s=await import('/src/lib/settings.ts');return String(s.getSettings().ai.autoTag)})()")" "false"
is "Pin survived" "$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Persist Me');return String((await api.listFavorites()).some(f=>(f.id||f.page_id)===t.page.id))})()")" "true"
api "navigateTo('Persist Me')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Persist Me'"; sleep 1
is "Collapsed state survived (4 of 5 visible)" "$(api 'getBlockCount()')" "4"
is "Formatting renders after restart" "$(ev "String(!!document.querySelector('.ProseMirror strong') && document.body.innerText.includes('Getting Started'))")" "true"
is "Whiteboard thumbnail block renders" "$(ev "String(document.body.innerText.includes('Whiteboard'))")" "true"

# ═══════════════════════════════════════════════
journey "D2. I type with a real keyboard"
# Browser tests can't send real keys to the editor; here they are real X input.
# ═══════════════════════════════════════════════

step "I make a fresh page and click into its first block"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Typing');await api.createBlock(p.id,'seed');return 'ok'})()" >/dev/null
api "navigateTo('Typing')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Typing'"; sleep 1
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" key End; "$DC" type " and typed words"; sleep 0.5
is "Typed text lands in the editor" "$(api 'getLiveBlockContent(0)')" "seed and typed words"

step "Enter makes a new block and I keep typing"
"$DC" key Return; sleep 1; "$DC" type "second line"; sleep 0.5
"$DC" key Return; sleep 1; "$DC" type "third line"; sleep 0.5
ev "document.activeElement?.blur()" >/dev/null; sleep 1.5
is "Three blocks saved in order" "$(blocks_of 'Typing')" "seed and typed words ¦ second line ¦ third line"

step "Enter in the middle of a line splits it without losing formatting"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Split');await api.createBlock(p.id,'alpha **bold** [[Getting Started]] omega');return 'ok'})()" >/dev/null
api "navigateTo('Split')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Split'"; sleep 1
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" key Home; for _ in 1 2 3 4 5 6; do "$DC" key Right; done; "$DC" key Return; sleep 1.5
ev "document.activeElement?.blur()" >/dev/null; sleep 1.5
is "Split keeps bold and the link" "$(blocks_of 'Split')" "alpha ¦ **bold** [[Getting Started]] omega"

step "Backspace at the start of a line merges it back"
api "focusBlock(1)" >/dev/null; sleep 0.5; "$DC" key Home; "$DC" key BackSpace; sleep 1.5
ev "document.activeElement?.blur()" >/dev/null; sleep 1.5
MERGED=$(blocks_of 'Split')
[[ "$MERGED" == *"**bold**"* && "$MERGED" == *"[[Getting Started]]"* && "$MERGED" != *"¦"* ]] && pass "Merge keeps bold and the link in one block" || fail "Merge lost content" "$MERGED"

step "Ctrl+Enter cycles a TODO on what I just typed"
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Todo Keys');await api.createBlock(p.id,'');return 'ok'})()" >/dev/null
api "navigateTo('Todo Keys')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Todo Keys'"; sleep 1
api "focusBlock(0)" >/dev/null; sleep 0.5; "$DC" type "buy milk"; sleep 0.3; "$DC" key ctrl+Return; sleep 1.5
is "TODO keeps the typed text" "$(blocks_of 'Todo Keys')" "TODO buy milk"
is "Sidebar TODO count sees it" "$(ev "(async()=>{const api=await import('/src/lib/api.ts');return String((await api.getPendingTodoCount())>=1)})()")" "true"

step "Ctrl+K search finds what I typed"
"$DC" press "Control+k"; sleep 1; "$DC" type "typed words"; sleep 2
[[ "$("$DC" snapshot 2>/dev/null)" == *"Typing"* ]] && pass "Search finds the page by typed content" || fail "Search missed typed content" ""
"$DC" press Escape; sleep 0.5

# ═══════════════════════════════════════════════
journey "D3. The CLI and the app share my notes"
# ═══════════════════════════════════════════════

step "I add a page from the terminal while the app is open"
"$DC" cli page create "From CLI" >/dev/null && "$DC" cli block create "From CLI" "written by the cli with [[Typing]]" >/dev/null
waitfor "document.body.innerText.includes('From CLI')" 10 && pass "App sidebar shows the CLI's page without a restart" || fail "App never showed the CLI page" ""
api "navigateTo('From CLI')" >/dev/null; sleep 1.5
is "App renders the CLI's block" "$(api 'getBlockContent(0)')" "written by the cli with [[Typing]]"

step "I edit in the app and read it back from the terminal"
ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('From CLI');await api.updateBlock(t.blocks[0].id,'edited in the app');return 'ok'})()" >/dev/null
CLI_READ=$("$DC" cli page get "From CLI" -f md 2>/dev/null)
[[ "$CLI_READ" == *"edited in the app"* ]] && pass "CLI reads the app's edit" || fail "CLI did not see the app's edit" "$CLI_READ"

step "CLI delete goes to the app's trash"
"$DC" cli page delete "From CLI" >/dev/null
is "Page is in the app's trash" "$(ev "(async()=>{const api=await import('/src/lib/api.ts');return String((await api.listTrash()).some(t=>t.title==='From CLI'))})()")" "true"
is "CLI search agrees it is gone" "$("$DC" cli search "edited in the app" -f json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["count"])' 2>/dev/null)" "0"

# ═══════════════════════════════════════════════
journey "D4. Two devices stay in sync through git"
# devA and devB are separate HOMEs cloning one bare remote.
# ═══════════════════════════════════════════════

if ! command -v git >/dev/null; then
  fail "git available" "git is not installed — sync journey skipped"
else
git init -q --bare -b main "$STATE/remote.git"
for d in devA devB; do
  mkdir -p "$STATE/$d"
  printf '[user]\n\tname = %s\n\temail = %s@example.test\n[init]\n\tdefaultBranch = main\n' "$d" "$d" >"$STATE/$d/.gitconfig"
done
SYNC="(async()=>{const api=await import('/src/lib/api.ts');const r=await api.gitSync();return (r.error||'ok')+'|conflicts='+(r.conflicts_resolved??0)})()"
ENABLE="(async()=>{const api=await import('/src/lib/api.ts');try{const s=await api.gitSyncEnable();return 'enabled='+s.enabled}catch(e){return 'ERR '+e}})()"
remote() { HOME="$STATE/$1" git -C "$STATE/$1/MiNotes_Sync" remote add origin "$STATE/remote.git" 2>/dev/null || true; }

step "Device A writes notes and turns sync on"
device devA keep || true
ev "(async()=>{const api=await import('/src/lib/api.ts');const p=await api.createPage('Roadmap');await api.createBlock(p.id,'Q1 ship sync');const b=await api.createBlock(p.id,'Q2 plugins');await api.createBlock(p.id,'detail under Q2',b.id);const f=await api.createFolder('Work');await api.movePageToFolder(p.id,f.id);await api.createPage('Scratch');return 'ok'})()" >/dev/null
mkdir -p "$STATE/devA/MiNotes_Sync"; HOME="$STATE/devA" git -C "$STATE/devA/MiNotes_Sync" init -q -b main; remote devA
is "A enables sync" "$(ev "$ENABLE")" "enabled=true"
is "A syncs cleanly" "$(ev "$SYNC")" "ok|conflicts=0"
REMOTE_FILES=$(git --git-dir="$STATE/remote.git" ls-tree -r --name-only main 2>/dev/null | grep -c '\.md$')
[[ "$REMOTE_FILES" -ge 2 ]] && pass "Remote received A's pages ($REMOTE_FILES files)" || fail "Remote is empty" "$REMOTE_FILES md files"

step "Device B starts fresh and pulls A's notes"
device devB keep || true
HOME="$STATE/devB" git clone -q "$STATE/remote.git" "$STATE/devB/MiNotes_Sync" 2>/dev/null
is "B enables sync" "$(ev "$ENABLE")" "enabled=true"
ev "$SYNC" >/dev/null
[[ "$(ev "$PAGES")" == *"Roadmap"* ]] && pass "B sees Roadmap" || fail "B did not receive Roadmap" "$(ev "$PAGES")"
is "B has Roadmap's blocks, nested" "$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Roadmap');const kid=t.blocks.find(b=>b.content==='detail under Q2');const par=t.blocks.find(b=>b.content==='Q2 plugins');return t.blocks.length+':'+String(!!kid&&!!par&&kid.parent_id===par.id)})()")" "3:true"
is "B has the Work folder" "$(ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getFolderTree();return String(JSON.stringify(t).includes('Work'))})()")" "true"

step "B renames the page, adds a block, deletes Scratch — and syncs"
ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Roadmap');await api.renamePage(t.page.id,'Roadmap 2027');await api.createBlock(t.page.id,'Q3 added on B');const s=await api.getPageTree('Scratch');await api.deletePage(s.page.id);return 'ok'})()" >/dev/null
is "B syncs cleanly" "$(ev "$SYNC")" "ok|conflicts=0"

step "A picks up B's rename, new block and deletion"
device devA keep || true
ev "$SYNC" >/dev/null
A_PAGES=$(ev "$PAGES")
[[ "$A_PAGES" == *"Roadmap 2027"* && "$A_PAGES" != *"Roadmap|"* && "$A_PAGES" != *"|Roadmap" && "$A_PAGES" != "Roadmap" ]] && pass "A shows the renamed page, not the old name" || fail "Rename did not propagate cleanly" "$A_PAGES"
[[ "$(blocks_of 'Roadmap 2027')" == *"Q3 added on B"* ]] && pass "A has B's new block" || fail "A is missing B's block" "$(blocks_of 'Roadmap 2027')"
[[ "$A_PAGES" != *"Scratch"* ]] && pass "A no longer lists Scratch" || fail "Deletion did not propagate" "$A_PAGES"
is "Scratch went to A's trash, not hard-deleted" "$(ev "(async()=>{const api=await import('/src/lib/api.ts');return String((await api.listTrash()).some(t=>t.title==='Scratch'))})()")" "true"

step "Syncing again changes nothing (no revert, no duplicates)"
STABLE_BEFORE="$(ev "$PAGES")#$(blocks_of 'Roadmap 2027')"
ev "$SYNC" >/dev/null; ev "$SYNC" >/dev/null
is "A is stable across repeated syncs" "$(ev "$PAGES")#$(blocks_of 'Roadmap 2027')" "$STABLE_BEFORE"
STALE=$(ls "$STATE/devA/MiNotes_Sync" "$STATE/devA/MiNotes_Sync/Work" 2>/dev/null | grep -c '^Roadmap\.md$')
is "No stale Roadmap.md left in the sync folder" "$STALE" "0"

step "Both devices edit the same block — nothing is lost"
ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Roadmap 2027');const b=t.blocks.find(b=>b.content.startsWith('Q1'));await api.updateBlock(b.id,'Q1 edited on A');return 'ok'})()" >/dev/null
device devB keep || true
ev "(async()=>{const api=await import('/src/lib/api.ts');const t=await api.getPageTree('Roadmap 2027');const b=t.blocks.find(b=>b.content.startsWith('Q1'));await api.updateBlock(b.id,'Q1 edited on B');return 'ok'})()" >/dev/null
ev "$SYNC" >/dev/null                      # B pushes first
device devA keep || true
A_SYNC=$(ev "$SYNC")                       # A now conflicts
[[ "$A_SYNC" == ok* ]] && pass "A's conflicting sync completes ($A_SYNC)" || fail "Conflicting sync errored" "$A_SYNC"
ALL=$(ev "(async()=>{const api=await import('/src/lib/api.ts');const ps=await api.listPages(1000);let out=[];for(const p of ps){const t=await api.getPageTree(p.id);out.push(...t.blocks.map(b=>b.content))}return out.join(' ¦ ')})()")
[[ "$ALL" == *"Q1 edited on A"* && "$ALL" == *"Q1 edited on B"* ]] && pass "Both versions of the block survive" || fail "A conflicting edit was lost" "$ALL"
[[ "$(ev "$PAGES")" == *"conflict"* ]] && pass "The other version is kept as a separate conflict page" || fail "No conflict page" "$(ev "$PAGES")"
MARKERS=$(grep -rl '^<<<<<<<\|^>>>>>>>' "$STATE/devA/MiNotes_Sync" --include='*.md' 2>/dev/null | wc -l)
is "No git conflict markers in any note" "$MARKERS" "0"
fi

# ═══════════════════════════════════════════════
echo ""
ERRS=$("$DC" errors 2>/dev/null | grep -E '^(uncaught|csp|unhandledrejection)' || true)
[[ -z "$ERRS" ]] && pass "No uncaught errors or CSP violations in the last session" || fail "Page errors" "$ERRS"
"$DC" down >/dev/null

echo ""
echo "═══════════════════════════════════════════════"
echo "  Desktop Journey Results: $P passed, $F failed"
echo "═══════════════════════════════════════════════"
if [[ ${#BUGS[@]} -gt 0 ]]; then
  echo -e "\033[1;31m  FAILURES (${#BUGS[@]}):\033[0m"
  for b in "${BUGS[@]}"; do echo -e "  \033[31m  ✗ $b\033[0m"; done
  echo "  screenshots: $STATE/shots/"
fi
exit $F
