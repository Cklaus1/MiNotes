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

rm -rf "$STATE"/{persist,devA,devB,nbook,outside,remote.git} "$STATE/results.tsv"
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

step "Device B clones the sync folder, starts fresh and pulls A's notes"
# Clone first: the app's markdown mirror writes ~/MiNotes_Sync as soon as it starts.
HOME="$STATE/devB" git clone -q "$STATE/remote.git" "$STATE/devB/MiNotes_Sync" 2>/dev/null
device devB keep || true
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
journey "D5. My notebook lives in a folder I choose"
# Create it in a picked folder, write, quit, reopen; copy the folder and open the
# copy; the markdown copy follows edits; switching keeps notebooks apart.
# ═══════════════════════════════════════════════
device nbook || true
NBH="$STATE/nbook"
A5="const api=await import('/src/lib/api.ts');"
setval() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
# wait_file <file> <seconds> <text>: until the file exists and contains text
wait_file() { local n=$(( ${2:-10} * 4 )); for _ in $(seq 1 $n); do grep -qF -- "$3" "$1" 2>/dev/null && return 0; sleep 0.25; done; return 1; }
menu() { ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.5; }
menu_action() { menu; ev "[...document.querySelectorAll('.nb-menu-action')].find(b=>b.textContent.startsWith('$1'))?.click()" >/dev/null; sleep 0.6; }
switcher() { ev "document.querySelector('[data-testid=notebook-switcher]')?.innerText||''"; }
mjs() { HOME="$NBH" "$REPO_ROOT/target/debug/minotes" "$@" 2>&1; }
FOLDER="$NBH/Documents/Field Notes"; COPY="$NBH/Documents/Field Notes copy"
mkdir -p "$NBH/Documents"

step "New notebook… with a folder I pick"
menu_action "New"
setval "[data-testid=new-notebook-name]" "Field Notes"
api "setNextPickedFolder('$NBH/Documents')" >/dev/null
ev "document.querySelector('[data-testid=new-notebook-choose]').click()" >/dev/null; sleep 0.6
is "The location is the picked folder + the name" "$(ev "document.querySelector('[data-testid=new-notebook-location]')?.getAttribute('title')||''")" "$FOLDER"
"$DC" wshot "d5-new-notebook-dialog" >/dev/null
ev "document.querySelector('[data-testid=new-notebook-create]').click()" >/dev/null
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Field Notes')" 15 \
  && pass "The new notebook is open" || fail "New notebook not opened" "$(switcher)"
[[ -f "$FOLDER/notebook.minotes" && -f "$FOLDER/notebook.json" && -d "$FOLDER/notes" && -f "$FOLDER/.minotes/lock.json" ]] \
  && pass "Folder layout: notebook.minotes, notebook.json, notes/, .minotes/lock.json" || fail "Folder layout" "$(ls -A "$FOLDER" 2>&1 | tr '\n' ' ')"
KEY=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$FOLDER/notebook.json" 2>/dev/null)
is "The app remembers it as the active notebook" "$(cat "$NBH/.minotes/active_graph" 2>/dev/null)" "$KEY"
is "~/.minotes/notebooks.json registers the folder" "$(python3 -c 'import json,sys;print([n["path"] for n in json.load(open(sys.argv[1]))["notebooks"]])' "$NBH/.minotes/notebooks.json" 2>/dev/null)" "['$FOLDER']"

step "I write — the markdown copy appears and follows my edits"
ev "(async()=>{$A5 const p=await api.createPage('Field Page');await api.createBlock(p.id,'first field note');await api.createBlock(p.id,'TODO collect samples');return 'ok'})()" >/dev/null
T0=$(date +%s%N)
wait_file "$FOLDER/notes/Field Page.md" 15 "first field note" \
  && pass "notes/Field Page.md written ($(( ($(date +%s%N) - T0) / 1000000 )) ms after the write)" || fail "Mirror file missing" "$(ls "$FOLDER/notes" 2>&1)"
grep -q "^id: " "$FOLDER/notes/Field Page.md" 2>/dev/null && pass "It carries the page id in frontmatter" || fail "No id frontmatter" "$(head -3 "$FOLDER/notes/Field Page.md" 2>&1)"
ev "(async()=>{$A5 const t=await api.getPageTree('Field Page');await api.updateBlock(t.blocks.find(b=>b.content.startsWith('first')).id,'edited field note');return 'ok'})()" >/dev/null
T0=$(date +%s%N)
if wait_file "$FOLDER/notes/Field Page.md" 10 "edited field note"; then
  MS=$(( ($(date +%s%N) - T0) / 1000000 )); [[ $MS -lt 6000 ]] && pass "An edit reaches the file in ${MS} ms (2 s debounce)" || fail "Mirror too slow" "${MS} ms"
else fail "Edit never reached the mirror" "$(cat "$FOLDER/notes/Field Page.md" 2>&1 | tail -3)"; fi
is "No temp files left behind" "$(find "$FOLDER/notes" -name '*.minotes-tmp' | wc -l)" "0"

step "I quit and open the app again"
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Field Notes')" 15 \
  && pass "It reopens the folder notebook" || fail "Wrong notebook after restart" "$(switcher)"
[[ "$(blocks_of 'Field Page')" == *"edited field note"* ]] && pass "My page survived" || fail "Page lost after restart" "$(blocks_of 'Field Page')"

step "I copy the whole folder and open the copy"
cp -a "$FOLDER" "$COPY"
api "setNextPickedFolder('$COPY')" >/dev/null
menu_action "Open"
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Field Notes 2')" 15 \
  && pass "The copy opens as its own notebook ('Field Notes 2')" || fail "Copy not opened" "$(switcher)"
COPY_KEY=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$COPY/notebook.json" 2>/dev/null)
[[ -n "$COPY_KEY" && "$COPY_KEY" != "$KEY" ]] && pass "The copy got its own id" || fail "Copy id" "$COPY_KEY vs $KEY"
[[ "$(blocks_of 'Field Page')" == *"edited field note"* ]] && pass "The copy has everything (a complete backup)" || fail "Copy content" "$(blocks_of 'Field Page')"
ev "(async()=>{$A5 const p=await api.createPage('Copy Only');await api.createBlock(p.id,'TODO only in the copy zzq');await api.createBlock(p.id,'TODO another zzq');const t=await api.createPage('Copy Trash');await api.trashPage(t.id);return 'ok'})()" >/dev/null
wait_file "$COPY/notes/Copy Only.md" 15 "zzq" && pass "The copy's markdown goes to the copy's notes/" || fail "Copy mirror" "$(ls "$COPY/notes" 2>&1)"
[[ ! -e "$FOLDER/notes/Copy Only.md" ]] && pass "The original folder is untouched" || fail "Copy wrote into the original" ""
COPY_TODOS=$(ev "(async()=>{$A5 return String(await api.getPendingTodoCount())})()")

step "I switch back from the menu — nothing leaks across notebooks"
menu; ev "document.querySelector('.nb-menu [data-notebook-key=\"$KEY\"]')?.click()" >/dev/null
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').trim().startsWith('Field Notes') && !(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Field Notes 2')" 15 \
  && pass "Back in Field Notes" || fail "Switch back" "$(switcher)"
is "Search doesn't see the copy's notes" "$(ev "(async()=>{$A5 return String((await api.search('zzq',50)).length)})()")" "0"
is "TODO count is this notebook's (1, the copy has $COPY_TODOS)" "$(ev "(async()=>{$A5 return String(await api.getPendingTodoCount())})()")" "1"
is "Trash is this notebook's" "$(ev "(async()=>{$A5 return String((await api.listTrash()).some(t=>t.title==='Copy Trash'))})()")" "false"
is "Landed on today's journal" "$(ev "String((window.__MINOTES__.getCurrentPage()||'').startsWith('Journal/'))")" "true"
"$DC" wshot "d5-switcher" >/dev/null

step "The CLI opens it by name or by folder"
[[ "$(mjs --notebook "Field Notes" page list -f text)" == *"Field Page"* ]] && pass "minotes --notebook 'Field Notes'" || fail "CLI --notebook" "$(mjs --notebook "Field Notes" page list -f text | head -3)"
is "minotes --notebook <folder> searches it" "$(mjs --notebook "$FOLDER" search "edited field note" -f json | python3 -c 'import sys,json;print(json.load(sys.stdin)["count"])' 2>/dev/null)" "1"
# The deprecated --graph alias still works; its notice goes to stderr, so stdout stays JSON.
is "deprecated --graph <folder> still works (stdout stays JSON)" "$(HOME="$NBH" "$REPO_ROOT/target/debug/minotes" --graph "$FOLDER" search "edited field note" -f json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["count"])' 2>/dev/null)" "1"
is "--graph prints a deprecation notice on stderr" "$(HOME="$NBH" "$REPO_ROOT/target/debug/minotes" --graph "$FOLDER" page list 2>&1 >/dev/null | grep -c 'deprecated')" "1"

step "Settings shows where the markdown copy is and that it is current"
api "openSettings()" >/dev/null; sleep 1.5
[[ "$(ev "document.querySelector('[data-testid=mirror-dir]')?.getAttribute('title')||''")" == "$FOLDER/notes" ]] && pass "Mirror location in Settings" || fail "Mirror location" "$(ev "document.querySelector('[data-testid=mirror-dir]')?.getAttribute('title')||''")"
# (The CLI just opened the database, so a pass may still be due: give it its 2 s.)
waitfor "document.querySelector('[data-testid=mirror-status]')?.textContent==='Up to date'" 10 \
  && pass "Mirror status: Up to date" || fail "Mirror status" "$(ev "document.querySelector('[data-testid=mirror-status]')?.textContent||''")"
"$DC" wshot "d5-settings-mirror" >/dev/null
api "closePanel()" >/dev/null

step "Another MiNotes window has the copy open → I get it read-only"
printf '{"pid":%s,"host":"%s","instance":"other-window","opened_at":"2026-01-01T00:00:00Z","root":"%s"}' "$(cat "$STATE/xvfb.pid")" "$(hostname)" "$COPY" >"$COPY/.minotes/lock.json"
ev "window.__MINOTES__.switchNotebook('$COPY_KEY')" >/dev/null
waitfor "!!document.querySelector('[data-testid=readonly-banner]')" 15 && pass "Read-only banner shown" || fail "No read-only banner" "$(switcher)"
is "Writes are refused" "$(ev "(async()=>{$A5 try{await api.createPage('Should Fail');return 'written'}catch(e){return 'refused'}})()")" "refused"
"$DC" wshot "d5-readonly" >/dev/null
ev "document.querySelector('[data-testid=readonly-banner] button')?.click()" >/dev/null
waitfor "!document.querySelector('[data-testid=readonly-banner]')" 10 && pass "'Open for editing anyway' takes it over" || fail "Take over" ""

step "A folder that went missing is unavailable — never recreated — and can be located"
ev "window.__MINOTES__.switchNotebook('$KEY')" >/dev/null; sleep 2
mv "$COPY" "$COPY (unplugged)"
is "Listed as unavailable" "$(ev "(async()=>{$A5 return String((await api.listNotebooks()).find(n=>n.key==='$COPY_KEY')?.available)})()")" "false"
is "Switching to it is refused" "$(ev "(async()=>{$A5 try{await api.switchNotebook('$COPY_KEY');return 'opened'}catch(e){return 'refused'}})()")" "refused"
[[ ! -e "$COPY" ]] && pass "No empty notebook was created in its place" || fail "Missing folder recreated" "$(ls -A "$COPY")"
ev "(async()=>{$A5 await api.locateNotebook('$COPY_KEY','$COPY (unplugged)');return 'ok'})()" >/dev/null
is "Locate… finds it again" "$(ev "(async()=>{$A5 return String((await api.listNotebooks()).find(n=>n.key==='$COPY_KEY')?.available)})()")" "true"

step "My old notebook (in app data) moves into a folder of its own"
ev "window.__MINOTES__.switchNotebook('default')" >/dev/null; sleep 2
ev "(async()=>{$A5 const p=await api.createPage('Legacy Page');await api.createBlock(p.id,'kept through the move');return 'ok'})()" >/dev/null
wait_file "$NBH/MiNotes_Sync/Legacy Page.md" 15 "kept through the move" && pass "The legacy notebook's copy is at ~/MiNotes_Sync" || fail "Legacy mirror" "$(ls "$NBH/MiNotes_Sync" 2>&1)"
R=$(ev "(async()=>{$A5 const s=await api.moveNotebookToFolder('$NBH/MiNotes/Old Default');return s.kind})()")
is "Moved: it is a folder notebook now" "$R" "folder"
[[ ! -e "$NBH/.minotes/default.db" && -f "$NBH/MiNotes/Old Default/notebook.minotes" ]] && pass "Old database removed only after the verified copy" || fail "Move files" "$(ls "$NBH/.minotes")"
[[ -f "$NBH/MiNotes/Old Default/notes/Legacy Page.md" && ! -e "$NBH/MiNotes_Sync" ]] && pass "The markdown copy moved with it" || fail "Mirror not moved" "$(ls "$NBH/MiNotes/Old Default/notes" 2>&1)"
[[ "$(blocks_of 'Legacy Page')" == "kept through the move" ]] && pass "Content intact after the move" || fail "Content after move" "$(blocks_of 'Legacy Page')"


# ═══════════════════════════════════════════════
journey "D6. I move in from Obsidian and Evernote — then paste a screenshot"
# Import through the dialog into new notebooks (preview, report, inline image,
# resolved links, markdown copy with _attachments/), undo, paste an image and
# see it survive a restart. Fixtures: tests/fixtures/import/.
# ═══════════════════════════════════════════════
device import6 || true
IH="$STATE/import6"
A6="const api=await import('/src/lib/api.ts');"
mkdir -p "$IH/Imports"
cp -r "$REPO_ROOT/tests/fixtures/import/obsidian-vault" "$IH/Imports/Vault"
cp -r "$REPO_ROOT/tests/fixtures/import/evernote" "$IH/Imports/evernote"
step6() { ev "document.querySelector('[data-testid=import-dialog]')?.dataset.step||''"; }
open_import() { ev "document.querySelector('[data-testid=notebook-switcher]').click()" >/dev/null; sleep 0.5; ev "document.querySelector('[data-testid=menu-import]')?.click()" >/dev/null; waitfor "!!document.querySelector('[data-testid=import-dialog]')" 10; }
HOME6=$(ev "(async()=>{$A6 return (await api.getNotebookSession()).key})()")

step "File → Import… (notebook menu) → Obsidian vault → the scan shows a preview"
open_import && pass "Import dialog opens from the notebook menu" || fail "Import dialog" "not shown"
api "setNextImportPick('$IH/Imports/Vault')" >/dev/null
ev "document.querySelector('[data-import-source=obsidian]').click()" >/dev/null
waitfor "document.querySelector('[data-testid=import-dialog]')?.dataset.step==='preview'" 30 \
  && pass "Preview shown" || fail "Scan" "$(step6) $(ev "document.querySelector('[data-testid=import-error]')?.innerText||''")"
is "Preview counts: 14 pages, 5 Projects, 2 journal days, 6 attachments" "$(ev "[...document.querySelectorAll('[data-testid=import-counts] strong')].slice(0,4).map(s=>s.textContent).join(',')")" "14,5,2,6"
R=$(ev "(()=>{const d=document.querySelector('[data-testid=import-dialog]');return [d.querySelectorAll('.imp-tab').length,d.querySelector('.imp-source')?.textContent.includes('[[Beta#Section Two]]'),d.querySelector('.imp-blocks')?.textContent.includes('[[Beta|Beta > Section Two]]'),[...d.querySelectorAll('[data-testid=import-warnings] summary')].some(s=>s.textContent.includes('Dataview'))].join('|')})()")
is "3 samples, source beside conversion, warnings by category" "$R" "3|true|true|true"
"$DC" wshot "d6-preview" >/dev/null

step "Import into a new notebook (the default) — progress, then the report"
ev "document.querySelector('[data-testid=import-start]').click()" >/dev/null
waitfor "document.querySelector('[data-testid=import-dialog]')?.dataset.step==='report'" 60 \
  && pass "Import finished" || fail "Import" "$(step6) $(ev "document.querySelector('[data-testid=import-error]')?.innerText||''")"
"$DC" wshot "d6-report" >/dev/null
NB6=$(ev "(async()=>{$A6 return (await api.getNotebookSession()).key})()")
VDIR="$IH/MiNotes/Vault"
[[ "$NB6" != "$HOME6" && -f "$VDIR/notebook.minotes" ]] && pass "A new notebook 'Vault' was created and opened" || fail "New notebook" "$NB6 $(ls "$IH/MiNotes" 2>&1)"
# (Landing on the notebook may have started today's journal: not an imported page.)
is "Pages in the new notebook (14 + the report)" "$(sqlite3 "$VDIR/notebook.minotes" "select count(*) from pages where title != 'Journal/$(date +%F)'")" "15"
is "Attachments stored by hash in the notebook folder" "$(find "$VDIR/attachments" -type f | wc -l | tr -d ' ')" "6"
ALPHA_ID=$(sqlite3 "$VDIR/notebook.minotes" "select id from pages where title='Alpha'")
[[ $(sqlite3 "$VDIR/notebook.minotes" "select count(*) from links where to_page='$ALPHA_ID'") -ge 3 ]] && pass "[[Alpha]] links resolved (link rows)" || fail "Links to Alpha" "none"
ev "document.querySelector('[data-testid=import-open-report]')?.click()" >/dev/null; sleep 2
[[ "$(api 'getCurrentPage()')" == "Import report"* ]] && pass "The report is a page in the notebook" || fail "Report page" "$(api 'getCurrentPage()')"
"$DC" wshot "d6-report-page" >/dev/null

step "An imported page shows its image inline (attachment:// under the real CSP)"
api "navigateTo('Home')" >/dev/null; sleep 2.5
ev "(()=>{const i=[...document.querySelectorAll('.block img')].find(i=>i.getAttribute('data-attachment-src'));i?.scrollIntoView({block:'center'});return 1})()" >/dev/null; sleep 1
waitfor "[...document.querySelectorAll('.block img')].some(i=>i.getAttribute('data-attachment-src')&&i.complete&&i.naturalWidth===240)" 10 \
  && pass "diagram.png renders inline (240 px wide)" || fail "Inline image" "$(ev "[...document.querySelectorAll('.block img')].map(i=>i.src+':'+i.naturalWidth).join(' ')")"
"$DC" wshot "d6-imported-page" >/dev/null
ev "[...document.querySelectorAll('.block .wiki-link')].find(a=>a.textContent.trim()==='Alpha')?.click()" >/dev/null; sleep 2
is "Clicking the resolved [[Alpha]] opens it" "$(api 'getCurrentPage()')" "Alpha"
"$DC" wshot "d6-resolved-link" >/dev/null

step "The markdown copy carries the attachments with relative links"
wait_file "$VDIR/notes/Home.md" 15 "](_attachments/" && pass "notes/Home.md links ](_attachments/…)" || fail "Mirror links" "$(grep -m2 attachment "$VDIR/notes/Home.md" 2>&1)"
[[ $(find "$VDIR/notes/_attachments" -name diagram.png | wc -l) -eq 1 ]] && pass "notes/_attachments/<hash>/diagram.png" || fail "Mirror attachments" "$(ls -R "$VDIR/notes/_attachments" 2>&1 | head)"
D=$(find "$VDIR/notes/_attachments" -name diagram.png | head -1); [[ -n "$D" ]] && cmp -s "$D" "$IH/Imports/Vault/attachments/diagram.png" && pass "Byte-identical copy" || fail "Mirror copy differs" "$D"

step "Evernote: two .enex files → a new notebook, one Project each, then Undo import"
open_import
ev "window.__MINOTES__.setNextImportPick(['$IH/Imports/evernote/Travel.enex','$IH/Imports/evernote/Recipes.enex'])" >/dev/null
ev "document.querySelector('[data-import-source=evernote]').click()" >/dev/null
waitfor "document.querySelector('[data-testid=import-dialog]')?.dataset.step==='preview'" 30 && pass "Evernote preview" || fail "Evernote scan" "$(ev "document.querySelector('[data-testid=import-error]')?.innerText||''")"
"$DC" wshot "d6-evernote-preview" >/dev/null
ev "document.querySelector('[data-testid=import-start]').click()" >/dev/null
waitfor "document.querySelector('[data-testid=import-dialog]')?.dataset.step==='report'" 60 && pass "Evernote import finished" || fail "Evernote import" "$(step6)"
EN=$(ev "(async()=>{$A6 const t=(await api.listPages(1000)).map(p=>p.title);const ph=await api.getPageTree('Trip photos');return [t.includes('Packing list (2)'),t.includes('Pancakes'),ph.blocks.some(b=>b.content.includes('![beach.png](attachment:'))].join('|')})()")
is "Notes, numbered duplicate title, en-media image as attachment" "$EN" "true|true|true"
ev "document.querySelector('[data-testid=import-undo]')?.click()" >/dev/null
waitfor "document.querySelector('[data-testid=import-dialog]')?.dataset.step==='undone'" 20 && pass "Undo import" || fail "Undo" "$(step6) $(ev "document.querySelector('[data-testid=import-dialog]')?.innerText.slice(0,300)||''")"
"$DC" wshot "d6-undone" >/dev/null
is "The Evernote notebook is empty again (today's journal aside)" "$(ev "(async()=>{$A6 return String((await api.listPages(1000)).filter(p=>p.title!=='Journal/$(date +%F)').length)})()")" "0"
ENDIR=$(ls -d "$IH/MiNotes/"*/ | grep -v Vault | head -1)
is "Its attachment store is empty" "$(find "$ENDIR/attachments" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"
press_esc() { "$DC" press Escape >/dev/null 2>&1; }; press_esc

step "Undo refuses pages I edited since — and lists them"
ev "window.__MINOTES__.switchNotebook('$NB6')" >/dev/null; sleep 2
ev "(async()=>{$A6 const t=await api.getPageTree('Beta');await api.updateBlock(t.blocks[0].id,'# Beta (mine now)');return 1})()" >/dev/null
open_import; ev "document.querySelector('[data-testid=import-run-undo]')?.click()" >/dev/null
waitfor "!!document.querySelector('[data-testid=import-undo-refused]')" 10 \
  && is "Refused, listing the edited page" "$(ev "document.querySelector('[data-testid=import-undo-refused] .imp-chip')?.textContent||''")" "Beta" \
  || fail "Undo refusal" "$(step6)"
"$DC" wshot "d6-undo-refused" >/dev/null
press_esc; sleep 0.5

step "I paste a screenshot into a block: stored as an attachment, still there after a restart"
ev "(async()=>{$A6 const p=await api.createPage('Pasted Here');await api.createBlock(p.id,'Screenshot:');return 1})()" >/dev/null
api "navigateTo('Pasted Here')" >/dev/null; sleep 1.5; api "focusBlock(0)" >/dev/null; sleep 0.6
ev "(()=>{const ed=document.querySelector('.ProseMirror-focused');if(!ed)return 'no editor';const c=document.createElement('canvas');c.width=120;c.height=60;const x=c.getContext('2d');x.fillStyle='#2a7';x.fillRect(0,0,120,60);const b=Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]),ch=>ch.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([b],'screenshot.png',{type:'image/png'}));ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 'ok'})()" >/dev/null
sleep 2; api "closePanel()" >/dev/null; "$DC" press Escape >/dev/null 2>&1; sleep 1
PB=$(blocks_of 'Pasted Here')
[[ "$PB" == *"](attachment:"* && "$PB" != *"data:image"* ]] && pass "Block references attachment:<hash>/screenshot.png" || fail "Paste" "$PB"
PH=$(echo "$PB" | grep -o 'attachment:[0-9a-f]\{64\}' | head -1 | cut -d: -f2)
[[ -n "$PH" && -f "$VDIR/attachments/${PH:0:2}/$PH.png" ]] && pass "File stored at attachments/${PH:0:2}/<hash>.png" || fail "Pasted file" "$PH"
is "attachments row" "$(sqlite3 "$VDIR/notebook.minotes" "select name||':'||mime from attachments where hash='$PH'")" "screenshot.png:image/png"
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
api "navigateTo('Pasted Here')" >/dev/null; sleep 2
waitfor "[...document.querySelectorAll('.block img')].some(i=>i.complete&&i.naturalWidth===120)" 10 \
  && pass "The pasted image renders after a restart" || fail "Pasted image after restart" "$(ev "[...document.querySelectorAll('.block img')].map(i=>i.src+':'+i.naturalWidth).join(' ')")"
"$DC" wshot "d6-pasted-after-restart" >/dev/null
is "attachment:// serves nothing outside the store" "$(ev "(async()=>{const load=u=>new Promise(r=>{const i=new Image();i.onload=()=>r('loaded');i.onerror=()=>r('refused');i.src=u});const ok=await load('attachment://localhost/$PH');return [ok,await load('attachment://localhost/..%2F..%2Fnotebook.minotes'),await load('attachment://localhost/'+'0'.repeat(64))].join(',')})()")" "loaded,refused,refused"

# ═══════════════════════════════════════════════
journey "D7. I edit my notes in another app while MiNotes is open"
# The markdown copy (here a legacy notebook's ~/MiNotes_Sync) is edited with the
# shell: changes reach the open page, removed lines go to the Trash, edits on both
# sides keep both versions, files dropped in become pages, deleted files trash
# their page, unreadable files are left alone, and a read-only window imports nothing.
# ═══════════════════════════════════════════════
device outside || true
OH="$STATE/outside"; MD="$OH/MiNotes_Sync"; OF="$MD/Outside Page.md"
A7="const api=await import('/src/lib/api.ts');"
# wait_js <async expr returning a string> <substring> [secs]: poll until it contains the substring
wait_js() { local n=$(( ${3:-15} * 2 )); for _ in $(seq 1 $n); do [[ "$(ev "$1")" == *"$2"* ]] && return 0; sleep 0.5; done; return 1; }
TRASH7="(async()=>{$A7 return (await api.listTrash()).map(t=>t.title).join('|')})()"
# sub <file> <python-expr over s>: rewrite a file in place, like another editor would
sub() { python3 -c 'import sys;p=sys.argv[1];s=open(p,encoding="utf-8").read();s=eval(sys.argv[2]);open(p,"w",encoding="utf-8").write(s)' "$1" "$2"; }

step "A page and its markdown file"
ev "(async()=>{$A7 const p=await api.createPage('Outside Page');for(const t of ['first line','second line','third line'])await api.createBlock(p.id,t);return 'ok'})()" >/dev/null
wait_file "$OF" 15 "third line" && pass "Outside Page.md written" || fail "Mirror file" "$(ls "$MD" 2>&1)"
api "navigateTo('Outside Page')" >/dev/null; sleep 1.5
ID_FIRST=$(ev "(async()=>{$A7 return (await api.getPageTree('Outside Page')).blocks[0].id})()")

step "I edit the file with another program — the open page follows"
sub "$OF" "s.replace('second line','second line, edited in vim') + '- added in vim\n'"
waitfor "document.body.innerText.includes('added in vim') && document.body.innerText.includes('edited in vim')" 15 \
  && pass "The open page shows the outside edit without a reload" || fail "Open page not refreshed" "$(blocks_of 'Outside Page')"
is "Blocks: ids kept, edit + new line imported" "$(blocks_of 'Outside Page')" "first line ¦ second line, edited in vim ¦ third line ¦ added in vim"
is "The first block kept its id" "$(ev "(async()=>{$A7 return (await api.getPageTree('Outside Page')).blocks[0].id})()")" "$ID_FIRST"
waitfor "[...document.querySelectorAll('.minotes-toast')].some(t=>t.textContent.includes('Updated “Outside Page”'))" 5 \
  && pass "A quiet toast says the page was updated from the file" || fail "No toast" "$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' | ')")"
"$DC" wshot "d7-outside-edit" >/dev/null
wait_file "$OF" 10 "added in vim <!-- id:" && pass "MiNotes then writes the file back with block ids" || fail "File not re-rendered" "$(tail -2 "$OF")"
is "No conflict copy for a one-sided edit" "$(ev "(async()=>{$A7 return String((await api.listPages(1000)).some(p=>p.title.includes('(edited outside)')))})()")" "false"

step "I delete a line in the file — the block goes to the Trash, and undo brings it back"
sub "$OF" "''.join(l for l in s.splitlines(True) if 'third line' not in l)"
wait_js "(async()=>{$A7 return (await api.getPageTree('Outside Page')).blocks.map(b=>b.content).join('|')})()" "edited in vim|added in vim" 15 \
  && pass "The line is gone from the page" || fail "Line not removed" "$(blocks_of 'Outside Page')"
[[ "$(ev "$TRASH7")" == *"Outside Page (removed outside"* ]] && pass "Its block is in the Trash (a 'removed outside' page)" || fail "Removed block not in Trash" "$(ev "$TRASH7")"
ev "(async()=>{const u=await import('/src/lib/undoManager.ts');await u.executeUndo();return 'ok'})()" >/dev/null
wait_js "(async()=>{$A7 return (await api.getPageTree('Outside Page')).blocks.map(b=>b.content).join('|')})()" "edited in vim|third line|added in vim" 10 \
  && pass "Undo (one step) restores the line" || fail "Undo" "$(blocks_of 'Outside Page')"
[[ "$(ev "$TRASH7")" != *"removed outside"* ]] && pass "…and the emptied Trash page is gone" || fail "Parking page left" "$(ev "$TRASH7")"
wait_file "$OF" 10 "third line" && pass "The file gets the line back" || fail "File after undo" "$(cat "$OF")"
sleep 2.5

step "The page and its file both change — both versions are kept"
ev "(async()=>{$A7 const t=await api.getPageTree('Outside Page');await api.updateBlock(t.blocks[0].id,'first line, changed in MiNotes');return 'ok'})()" >/dev/null
sub "$OF" "s.replace('first line','first line, changed in the other app')"
wait_js "(async()=>{$A7 return (await api.listPages(1000)).map(p=>p.title).join('|')})()" "Outside Page (edited outside)" 15 \
  && pass "The outside version became 'Outside Page (edited outside)'" || fail "No conflict copy" "$(ev "$PAGES")"
[[ "$(blocks_of 'Outside Page (edited outside)')" == *"first line, changed in the other app"* ]] && pass "…with the other app's text" || fail "Conflict copy content" "$(blocks_of 'Outside Page (edited outside)')"
[[ "$(blocks_of 'Outside Page')" == "first line, changed in MiNotes"* ]] && pass "The page keeps MiNotes' version" || fail "Page content" "$(blocks_of 'Outside Page')"
waitfor "!!document.querySelector('[data-testid=outside-conflict-banner]')" 5 && pass "A notice explains it, with 'Open it'" || fail "No conflict notice" ""
"$DC" wshot "d7-conflict-banner" >/dev/null
wait_file "$OF" 10 "changed in MiNotes" && pass "The file shows MiNotes' version again" || fail "File after conflict" "$(head -8 "$OF")"
ev "document.querySelector('[data-testid=outside-open-copy]')?.click()" >/dev/null
waitfor "(window.__MINOTES__.getCurrentPage()||'')==='Outside Page (edited outside)'" 8 && pass "'Open it' opens the copy" || fail "Open copy" "$(ev "window.__MINOTES__.getCurrentPage()")"

step "I drop a new file into a folder of the markdown copy"
mkdir -p "$MD/Inbox"; printf -- '- dropped note zq7\n  - nested under it\n' >"$MD/Inbox/Dropped Note.md"
wait_js "(async()=>{$A7 return (await api.listPages(1000)).map(p=>p.title).join('|')})()" "Dropped Note" 15 \
  && pass "It became a page" || fail "Dropped file not imported" "$(ev "$PAGES")"
is "…with its lines as blocks" "$(blocks_of 'Dropped Note')" "dropped note zq7 ¦ nested under it"
is "…in the folder named like the directory" "$(ev "(async()=>{$A7 const t=await api.getPageTree('Dropped Note');const f=(await api.getFolderTree()).folders.find(x=>x.id===t.page.folder_id);return f?f.name:'none'})()")" "Inbox"
wait_file "$MD/Inbox/Dropped Note.md" 10 "id: " && pass "The file got its page id" || fail "Dropped file not adopted" "$(cat "$MD/Inbox/Dropped Note.md")"

step "A file MiNotes can't read is left alone"
printf 'binary\000\001\002' >"$MD/Binary.md"; BIN_SUM=$(md5sum <"$MD/Binary.md")
waitfor "!!document.querySelector('[data-testid=outside-rejected-banner]')" 10 && pass "Reported in a notice" || fail "No notice for the unreadable file" ""
sleep 3
is "Not imported" "$(ev "(async()=>{$A7 return String((await api.listPages(1000)).some(p=>p.title==='Binary'))})()")" "false"
is "Not rewritten" "$(md5sum <"$MD/Binary.md")" "$BIN_SUM"

step "I delete a page's file — the page goes to the Trash"
rm "$MD/Inbox/Dropped Note.md"
wait_js "$TRASH7" "Dropped Note" 15 && pass "Dropped Note is in the Trash" || fail "Deleted file's page not trashed" "$(ev "$TRASH7")"
is "…with its blocks (recoverable)" "$(db outside "select count(*) from blocks b join pages p on p.id=b.page_id where p.title='Dropped Note'")" "2"

step "A read-only window (another MiNotes has the notebook) imports nothing"
sleep 2.5
"$DC" down >/dev/null 2>&1
printf '{"pid":%s,"host":"%s","instance":"other-window","opened_at":"2026-01-01T00:00:00Z"}' "$$" "$(hostname)" >"$OH/.minotes/default.lock.json"
device outside keep || true
waitfor "!!document.querySelector('[data-testid=readonly-banner]')" 15 && pass "Opened read-only" || fail "Not read-only" ""
sub "$OF" "s.replace('added in vim','added while read-only')"
sleep 5
is "The edit was not imported by the read-only window" "$(db outside "select count(*) from blocks where content like '%added while read-only%'")" "0"
grep -q "added while read-only" "$OF" && pass "…and the file was not touched" || fail "Read-only window rewrote the file" "$(tail -2 "$OF")"
ev "document.querySelector('[data-testid=readonly-banner] button')?.click()" >/dev/null
wait_js "(async()=>{$A7 return (await api.getPageTree('Outside Page')).blocks.map(b=>b.content).join('|')})()" "added while read-only" 15 \
  && pass "Taking the notebook over imports the edit made meanwhile" || fail "Edit lost after take-over" "$(blocks_of 'Outside Page')"

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
