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

rm -rf "$STATE"/{persist,devA,devB,nbook,outside,xnb,zip8,barrier10,trust10,rimg,img10,remote.git,enc13,enc13-tmp,enc13-keychain,enc14a,enc14b,enc14c,enc14-tmp,remote14.git,w1,w1-files,w2,j17a,j17b,t17,remote17.git,remote17.git.moved,w18,w19,w23,d20a,w21,w22,big22,w24,w25,enc25,enc25-tmp,enc25-keychain} "$STATE/results.tsv"
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
"$DC" press "Control+Shift+w"; waitfor "!!document.querySelector('canvas')" 10
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
is "Split → merge gives back the original line (no line break, space kept)" "$MERGED" "alpha **bold** [[Getting Started]] omega"

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
waitfor "!!document.querySelector('[data-testid=confirm-dialog]')" 10
C6=$(ev "document.querySelector('[data-testid=confirm-dialog]')?.innerText||'none'")
[[ "$C6" == *"Undo this import?"*"deletes the "*" pages"* ]] && pass "Undo import asks first, with the page count" || fail "No confirmation before Undo import" "$C6"
ev "document.querySelector('[data-testid=confirm-ok]')?.click()" >/dev/null
waitfor "document.querySelector('[data-testid=import-dialog]')?.dataset.step==='undone'" 20 && pass "Undo import" || fail "Undo" "$(step6) $(ev "document.querySelector('[data-testid=import-dialog]')?.innerText.slice(0,300)||''")"
"$DC" wshot "d6-undone" >/dev/null
is "The Evernote notebook is empty again (today's journal aside)" "$(ev "(async()=>{$A6 return String((await api.listPages(1000)).filter(p=>p.title!=='Journal/$(date +%F)').length)})()")" "0"
ENDIR=$(ls -d "$IH/MiNotes/"*/ | grep -v Vault | head -1)
is "Its attachment store is empty" "$(find "$ENDIR/attachments" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"
press_esc() { "$DC" press Escape >/dev/null 2>&1; }; press_esc

step "Undo warns about pages I edited since — and keeps them unless I cancel"
ev "window.__MINOTES__.switchNotebook('$NB6')" >/dev/null; sleep 2
ev "(async()=>{$A6 const t=await api.getPageTree('Beta');await api.updateBlock(t.blocks[0].id,'# Beta (mine now)');return 1})()" >/dev/null
open_import; ev "document.querySelector('[data-testid=import-run-undo]')?.click()" >/dev/null
waitfor "!!document.querySelector('[data-testid=confirm-dialog]')" 10
C6=$(ev "document.querySelector('[data-testid=confirm-dialog]')?.innerText||'none'")
[[ "$C6" == *"edited since the import"*"Beta"* ]] && pass "The confirmation names the edited page it keeps" || fail "No edited-page warning" "$C6"
"$DC" wshot "d6-undo-edited-warning" >/dev/null
ev "document.querySelector('[data-testid=confirm-cancel]')?.click()" >/dev/null; sleep 0.5
is "Cancel: the import is still there" "$(ev "(async()=>{$A6 return String((await api.listPages(1000)).some(p=>p.title==='Alpha'))})()")" "true"
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
journey "D8. I search and link across my notebooks"
# "All notebooks" search reads the other notebooks without writing them (bytes,
# mtime, lock unchanged), skips one whose folder is gone, and opens a hit in its
# notebook. [[Work8::Plan8]] is stored by target id, survives renaming the page
# and the notebook (done with the CLI while the app is open), creates nothing
# locally, round-trips through the markdown copy; the CLI searches all notebooks.
# ═══════════════════════════════════════════════
device xnb || true
XH="$STATE/xnb"; W8="$XH/MiNotes/Work8"; DB8="$XH/.minotes/default.db"
A8="const api=await import('/src/lib/api.ts');"
mx() { HOME="$XH" "$REPO_ROOT/target/debug/minotes" "$@" 2>&1; }
cur8() { ev "(async()=>{$A8 return (await api.getNotebookSession()).key})()"; }
setval8() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
chips8() { ev "[...document.querySelectorAll('.block .xnb-link')].map(c=>c.textContent).join('|')"; }
HOME8=$(cur8)

step "A second notebook made with the CLI, and one whose folder is gone"
mx notebook create Work8 >/dev/null; mx notebook create Gone8 >/dev/null
mx --notebook Work8 page create Plan8 >/dev/null
mx --notebook Work8 block create Plan8 "wombat8 rollout checklist" >/dev/null
rm -rf "$XH/MiNotes/Gone8"
WKEY8=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$W8/notebook.json" 2>/dev/null)
[[ -n "$WKEY8" && -n "$HOME8" ]] && pass "Work8 ($WKEY8) next to the open notebook ($HOME8)" || fail "Setup" "$(ls "$XH/MiNotes" 2>&1)"
SUM8=$(sha256sum <"$W8/notebook.minotes"); MT8=$(stat -c %y "$W8/notebook.minotes")

step "Search with All notebooks finds it — Work8 is only read"
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({searchAllNotebooks:true});return 1})()" >/dev/null
api "openSearch()" >/dev/null; sleep 0.6
setval8 ".command-palette-input" "wombat8"
waitfor "document.querySelectorAll('[data-testid=search-other-result]').length>0" 10 \
  && pass "A hit from Work8" || fail "No cross-notebook hit" "$(ev "document.querySelector('.command-palette')?.innerText||''")"
is "Labelled with its notebook" "$(ev "document.querySelector('[data-testid=search-other-result] .xnb-badge')?.textContent||''")" "Work8"
waitfor "!!document.querySelector('[data-testid=search-skipped]')" 5
is "Gone8 is skipped quietly" "$(ev "document.querySelector('[data-testid=search-skipped]')?.textContent||''")" "Skipped: Gone8 (not available)"
"$DC" wshot "d8-search" >/dev/null
is "Work8's database is byte-identical" "$(sha256sum <"$W8/notebook.minotes")" "$SUM8"
is "…with the same mtime" "$(stat -c %y "$W8/notebook.minotes")" "$MT8"
[[ ! -e "$W8/.minotes/lock.json" ]] && pass "…and its lock was never taken" || fail "Lock taken by a search" "$(cat "$W8/.minotes/lock.json")"
ev "document.querySelector('[data-testid=search-other-result]').click()" >/dev/null
waitfor "(window.__MINOTES__.getCurrentPage()||'')==='Plan8'" 15 && pass "Clicking it opens Plan8" || fail "Open hit" "$(api 'getCurrentPage()')"
is "…in Work8" "$(cur8)" "$WKEY8"
"$DC" wshot "d8-opened" >/dev/null
ev "window.__MINOTES__.switchNotebook('$HOME8')" >/dev/null; sleep 2
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({searchAllNotebooks:false});return 1})()" >/dev/null

step "[[Work8::Plan8]]: stored by id, a chip, nothing created locally"
ev "(async()=>{$A8 await api.createPage('Elsewhere8');const p=await api.createPage('Links8');await api.createBlock(p.id,'Go to [[Work8::Plan8]] or [[Work8::Missing8]]');return 1})()" >/dev/null
api "navigateTo('Links8')" >/dev/null
waitfor "[...document.querySelectorAll('.block .xnb-link')].map(c=>c.textContent+c.classList.contains('xnb-missing')).join('|')==='Work8 › Plan8false|Work8 › Missing8true'" 10 \
  && pass "Chips: Work8 › Plan8, and a muted not-found Work8 › Missing8" || fail "Chips" "$(chips8)"
PLAN8=$(sqlite3 "$W8/notebook.minotes" "select id from pages where title='Plan8'")
is "notebook_links: target notebook key + page id" "$(sqlite3 "$DB8" "select notebook_key||'|'||coalesce(page_id,'-') from notebook_links where page_title='Plan8'")" "$WKEY8|$PLAN8"
is "No local link rows or pages for them" "$(sqlite3 "$DB8" "select (select count(*) from links l join blocks b on b.id=l.from_block where b.content like '%Work8::%')||'|'||(select count(*) from pages where title like '%::%' or title in ('Plan8','Missing8'))")" "0|0"
wait_file "$XH/MiNotes_Sync/Links8.md" 15 "Go to [[Work8::Plan8]] or [[Work8::Missing8]]" \
  && pass "The markdown copy keeps the link as written" || fail "Mirror" "$(cat "$XH/MiNotes_Sync/Links8.md" 2>&1 | head -5)"
"$DC" wshot "d8-chips" >/dev/null

step "Renaming the page and the notebook (CLI, app open) doesn't break it"
mx --notebook Work8 page rename Plan8 "Plan8 final" >/dev/null
mx notebook rename Work8 Office8 >/dev/null
ev "window.dispatchEvent(new Event('minotes-notebooks-changed'))" >/dev/null
api "navigateTo('Elsewhere8')" >/dev/null; sleep 1; api "navigateTo('Links8')" >/dev/null
waitfor "(document.querySelector('.block .xnb-link')?.textContent||'')==='Office8 › Plan8 final'" 10 \
  && pass "The chip shows the new names (resolved by id)" || fail "Chip after renames" "$(chips8)"
is "The block text is unchanged" "$(sqlite3 "$DB8" "select count(*) from blocks where content='Go to [[Work8::Plan8]] or [[Work8::Missing8]]'")" "1"
"$DC" wshot "d8-after-rename" >/dev/null
ev "document.querySelector('.block .xnb-link').click()" >/dev/null
waitfor "(window.__MINOTES__.getCurrentPage()||'')==='Plan8 final'" 15 && pass "…and still opens the page" || fail "Follow after rename" "$(api 'getCurrentPage()')"
is "…in that notebook" "$(cur8)" "$WKEY8"
ev "window.__MINOTES__.switchNotebook('$HOME8')" >/dev/null; sleep 2

step "The not-found chip asks before creating it over there (UX Wave 4); Cancel creates nothing"
api "navigateTo('Links8')" >/dev/null; sleep 1.5
ev "document.querySelectorAll('.block .xnb-link')[1]?.click()" >/dev/null
waitfor "(document.querySelector('[data-testid=confirm-dialog]')?.innerText||'').includes('Create page in Office8')" 5 \
  && pass "Asks: Create page in Office8" || fail "Not-found click" "$(ev "document.querySelector('[data-testid=confirm-dialog]')?.innerText||'none'")"
ev "document.querySelector('[data-testid=confirm-cancel]')?.click()" >/dev/null; sleep 1
is "Still here" "$(cur8)|$(api 'getCurrentPage()')" "$HOME8|Links8"
is "No page Missing8 in Office8" "$(sqlite3 "$W8/notebook.minotes" "select count(*) from pages where title like 'Missing8%'")" "0"

step "The CLI searches all notebooks too"
R=$(mx -f text search wombat8 --all-notebooks)
[[ "$R" == *"[Office8]"*"wombat8 rollout checklist"* && "$R" == *"Skipped: Gone8 (not available)"* ]] \
  && pass "minotes search --all-notebooks: labelled hit + skipped note" || fail "CLI all-notebooks search" "$R"
journey "D9. I back up a notebook as one .zip and bring it back as a new notebook"
# Export notebook… / Import notebook… from the notebook menu (the dialogs are
# bypassed with setNextExportDest / setNextZipPick, both inside the scratch HOME).
# Also the way notebooks leave and enter app storage on Android.
# ═══════════════════════════════════════════════
device zip8 || true
ZH="$STATE/zip8"
A8="const api=await import('/src/lib/api.ts');"
mkdir -p "$ZH/Backups"
toasts() { ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' ¦ ')"; }
zip_names() { python3 -c 'import sys,zipfile;print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$1" 2>&1; }

step "I write a page with an image"
ev "(async()=>{$A8 const p=await api.createPage('Zip Page');await api.createBlock(p.id,'packed into a zip zq8');const c=document.createElement('canvas');c.width=40;c.height=20;const b=Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]),ch=>ch.charCodeAt(0));const a=await api.storeAttachment('zip8.png','image/png',b);await api.createBlock(p.id,'![zip8.png](attachment:'+a.hash+'/zip8.png)');return 'ok'})()" >/dev/null
HOME8=$(ev "(async()=>{$A8 return (await api.getNotebookSession()).key})()")

step "Notebook menu → Export notebook… → one .zip"
ev "window.__MINOTES__.setNextExportDest('$ZH/Backups/backup.zip')" >/dev/null
menu_action "Export notebook"
for _ in $(seq 1 40); do [[ -f "$ZH/Backups/backup.zip" ]] && break; sleep 0.25; done
[[ -f "$ZH/Backups/backup.zip" ]] && pass "backup.zip written ($(stat -c %s "$ZH/Backups/backup.zip") bytes)" || fail "No zip" "$(toasts)"
NAMES=$(zip_names "$ZH/Backups/backup.zip")
R=$(for f in "default/notebook.minotes" "default/notebook.json" "default/notes/Zip Page.md"; do grep -qxF "$f" <<<"$NAMES" && echo -n y || echo -n "[$f missing]"; done)
is "It holds notebook.minotes, notebook.json and notes/Zip Page.md" "$R" "yyy"
is "…the attachment store (one image)" "$(grep -c '^default/attachments/../[0-9a-f]\{64\}\.png$' <<<"$NAMES")" "1"
is "…and no device-private state (.minotes/, _attachments/)" "$(grep -cE '/\.minotes/|_attachments' <<<"$NAMES")" "0"
[[ "$(toasts)" == *"Exported"* ]] && pass "A toast says what was exported" || fail "Export toast" "$(toasts)"
[[ -z "$(find "$ZH/Backups" -name '*.minotes-tmp')" ]] && pass "No temp files next to it" || fail "Temp files left" "$(ls -a "$ZH/Backups")"

step "A hostile zip (path traversal) is refused and writes nothing"
python3 - "$ZH/Backups/evil.zip" "$ZH/Backups/backup.zip" <<'PY'
import sys, zipfile
src = zipfile.ZipFile(sys.argv[2]).read("default/notebook.minotes")
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("evil/notebook.minotes", src)
    z.writestr("evil/../../escaped.txt", "pwned")
PY
N_BEFORE=$(ev "(async()=>{$A8 return String((await api.listNotebooks()).length)})()")
ev "window.__MINOTES__.setNextZipPick('$ZH/Backups/evil.zip')" >/dev/null
menu_action "Import notebook"; sleep 1.5
[[ "$(toasts)" == *"unsafe path"* ]] && pass "Refused with a reason" || fail "Hostile zip" "$(toasts)"
is "No notebook was added" "$(ev "(async()=>{$A8 return String((await api.listNotebooks()).length)})()")" "$N_BEFORE"
[[ -z "$(find "$ZH" -name escaped.txt)" ]] && pass "Nothing escaped the import folder" || fail "Zip-slip" "$(find "$ZH" -name escaped.txt)"

step "Notebook menu → Import notebook… → it opens as a new notebook (never over the original)"
ev "window.__MINOTES__.setNextZipPick('$ZH/Backups/backup.zip')" >/dev/null
menu_action "Import notebook"
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('default 2')" 20 \
  && pass "Opened as 'default 2' (the name was taken)" || fail "Imported notebook not opened" "$(switcher) $(toasts)"
NB8=$(ev "(async()=>{$A8 return (await api.getNotebookSession()).key})()")
[[ -n "$NB8" && "$NB8" != "$HOME8" ]] && pass "It has its own key" || fail "Import key" "$NB8"
[[ -f "$ZH/MiNotes/default 2/notebook.minotes" && -d "$ZH/MiNotes/default 2/notes" ]] \
  && pass "A folder of its own: ~/MiNotes/default 2" || fail "Imported folder" "$(ls -A "$ZH/MiNotes" 2>&1)"
[[ "$(blocks_of 'Zip Page')" == *"packed into a zip zq8"* ]] && pass "My page came back" || fail "Imported content" "$(blocks_of 'Zip Page')"
api "navigateTo('Zip Page')" >/dev/null; sleep 2
waitfor "[...document.querySelectorAll('.block img')].some(i=>i.complete&&i.naturalWidth===40)" 10 \
  && pass "…with its image (from the imported attachment store)" || fail "Imported image" "$(ev "[...document.querySelectorAll('.block img')].map(i=>i.src+':'+i.naturalWidth).join(' ')")"
"$DC" wshot "d9-imported" >/dev/null
wait_file "$ZH/MiNotes/default 2/notes/Zip Page.md" 15 "zq8" && pass "The imported notebook gets its own markdown copy" || fail "Imported mirror" "$(ls "$ZH/MiNotes/default 2/notes" 2>&1)"
is "The original is still there and untouched" "$(ev "(async()=>{$A8 const l=await api.listNotebooks();return String(l.some(n=>n.key==='$HOME8'&&n.available))})()")" "true"

step "Manage notebooks… offers Export… per notebook and Import notebook (.zip)…"
menu_action "Manage"
is "Export… on every row, one Import button" "$(ev "[document.querySelectorAll('[data-testid=export-notebook]').length,document.querySelectorAll('[data-testid=import-notebook-zip]').length].join(',')")" "2,1"
"$DC" wshot "d9-manage" >/dev/null
"$DC" press Escape >/dev/null 2>&1; sleep 0.5

step "I quit and open the app again"
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('default 2')" 15 \
  && pass "The imported notebook reopens" || fail "After restart" "$(switcher)"
[[ "$(blocks_of 'Zip Page')" == *"zq8"* ]] && pass "…with my page" || fail "Content after restart" "$(blocks_of 'Zip Page')"
is "Desktop capabilities: folders, reveal, outside edits" "$(ev "(async()=>{$A8 const c=await api.getPlatformCapabilities();return [c.app_storage,c.choose_location,c.open_folder,c.outside_edits,c.notebook_zip].join(',')})()")" "false,true,true,true,true"

step "A shared zip can't bring an AI endpoint, styling or triggers with it"
python3 - "$ZH/Backups/gift.zip" "$ZH/Backups/backup.zip" "$ZH/Backups/gift.minotes" <<'PY'
import sqlite3, sys, zipfile
open(sys.argv[3], "wb").write(zipfile.ZipFile(sys.argv[2]).read("default/notebook.minotes"))
c = sqlite3.connect(sys.argv[3])
c.executescript("""
CREATE TABLE IF NOT EXISTS ai_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, task TEXT NOT NULL, scope TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL DEFAULT 'running', error TEXT, transcript TEXT);
INSERT OR REPLACE INTO ai_settings VALUES ('settings',
  '{"provider":"local","local":{"base_url":"https://evil.example/v1","model":"m","supports_tools":true,"confirmed_remote_host":"evil.example"}}');
INSERT INTO ai_runs(id, task, scope, provider, model, started_at, outcome, transcript)
  VALUES ('r1', 'ask', 'notebook', 'local', 'm', '2026-01-01T00:00:00Z', 'ok', 'secret');
INSERT INTO css_snippets(id, name, css, enabled, created_at) VALUES ('c1', 'gift-style', 'body{display:none}', 1, 'x');
CREATE TABLE stash(x TEXT);
CREATE TRIGGER gift_trg AFTER INSERT ON blocks BEGIN INSERT INTO stash VALUES (new.content); END;
CREATE VIEW gift_view AS SELECT content FROM blocks;
""")
c.commit(); c.close()
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.write(sys.argv[3], "Gift/notebook.minotes")
PY
ev "window.__MINOTES__.setNextZipPick('$ZH/Backups/gift.zip')" >/dev/null
menu_action "Import notebook"
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Gift')" 20 \
  && pass "The shared notebook opens" || fail "Gift notebook not opened" "$(switcher) $(toasts)"
[[ "$(toasts)" == *"Turned off for safety"*"AI settings"*"CSS snippet"* ]] && pass "The toast says what was turned off" || fail "Scrub toast" "$(toasts)"
is "AI is off in the imported notebook" "$(ev "(async()=>{$A8 const s=await api.aiGetStatus();return s.settings.provider+'|'+s.data_notice.includes('evil')})()")" "off|false"
GDB="$ZH/MiNotes/Gift/notebook.minotes"
is "No AI runs, snippet disabled, trigger and view gone" \
  "$(sqlite3 "$GDB" "SELECT (SELECT COUNT(*) FROM ai_runs)||','||(SELECT SUM(enabled) FROM css_snippets)||','||(SELECT COUNT(*) FROM sqlite_master WHERE name IN ('gift_trg','gift_view'))")" "0,0,0"

# ═══════════════════════════════════════════════
journey "D10. I switch notebooks right after typing or drawing — it stays in the notebook I wrote it in"
# ARCH U-1 save barrier. Real keystrokes / a real stroke, then a switch before
# the blur save (50 ms) or the whiteboard debounce (1 s) ran. Checked with sqlite
# on BOTH databases while the app shows the other notebook.
# ═══════════════════════════════════════════════
device barrier10 || true
BH="$STATE/barrier10"; HDB10="$BH/.minotes/default.db"; ODB10="$BH/MiNotes/Other10/notebook.minotes"
A10="const api=await import('/src/lib/api.ts');"
mx10() { HOME="$BH" "$REPO_ROOT/target/debug/minotes" "$@" 2>&1; }
cur10() { ev "(async()=>{$A10 return (await api.getNotebookSession()).key})()"; }
wait_nb10() { for _ in $(seq 1 24); do [[ "$(cur10)" == "$1" ]] && return 0; sleep 0.25; done; return 1; }
HOME10=$(cur10)
mx10 notebook create Other10 >/dev/null
mx10 --notebook Other10 page create Target10 >/dev/null
OKEY10=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$BH/MiNotes/Other10/notebook.json" 2>/dev/null)
ev "window.dispatchEvent(new Event('minotes-notebooks-changed'))" >/dev/null
ev "(async()=>{$A10 const p=await api.createPage('Edit10');await api.createBlock(p.id,'Go to [[Other10::Target10]]');await api.createBlock(p.id,'Second10');return 1})()" >/dev/null
[[ -n "$OKEY10" && -n "$HOME10" && -f "$ODB10" ]] && pass "Other10 ($OKEY10) next to the open notebook" || fail "Setup" "key=$OKEY10 $(ls "$BH/MiNotes" 2>&1)"

step "I type with the keyboard and click the [[Other10::Target10]] chip in the same editor at once"
api "navigateTo('Edit10')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Edit10'"; sleep 1
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" key End; "$DC" type " typed10chip"
ev "(()=>{const c=document.querySelector('[data-block-id] .ProseMirror:not(.block-static) .xnb-link');if(!c)return 'no chip';c.click();return 'clicked'})()" >/dev/null
waitfor "(window.__MINOTES__.getCurrentPage()||'')==='Target10'" 15 && pass "The chip opened Target10" || fail "Chip follow" "$(api 'getCurrentPage()')"
is "…in Other10" "$(cur10)" "$OKEY10"
is "The typed text is in the home database" "$(sqlite3 "$HDB10" "select count(*) from blocks where content='Go to [[Other10::Target10]] typed10chip'")" "1"
is "…and nothing landed in Other10's" "$(sqlite3 "$ODB10" "select count(*) from blocks where content like '%typed10%'")" "0"
ev "window.__MINOTES__.switchNotebook('$HOME10')" >/dev/null; wait_nb10 "$HOME10"

step "I type and switch notebooks straight away (no blur)"
api "navigateTo('Edit10')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Edit10'"; sleep 1
api "focusBlock(1)" >/dev/null; sleep 0.5
"$DC" key End; "$DC" type " typed10api"
ev "(()=>{window.__MINOTES__.switchNotebook('$OKEY10');return 1})()" >/dev/null
wait_nb10 "$OKEY10" && pass "Switched to Other10" || fail "Switch" "$(cur10)"
is "The edit is in the home database" "$(sqlite3 "$HDB10" "select count(*) from blocks where content='Second10 typed10api'")" "1"
ev "window.__MINOTES__.switchNotebook('$HOME10')" >/dev/null; wait_nb10 "$HOME10"

# Arm a switch 150 ms after the next mouseup on the canvas (inside the 1 s debounce).
ARM10="(()=>{const c=document.querySelector('canvas.whiteboard-canvas');if(!c)return 'no canvas';c.addEventListener('mouseup',()=>setTimeout(()=>window.__MINOTES__.switchNotebook('$OKEY10'),150),{once:true});return 'armed'})()"
DRAWMODE10="(()=>{const b=[...document.querySelectorAll('.whiteboard-toolbar button')].find(b=>b.textContent.trim()==='Draw');if(b)b.click();return !!b})()"
stroke10() { DISPLAY="localhost:${DESKTOP_CHECK_DISPLAY:-97}" bash -c 'xdotool mousemove 400 400 mousedown 1; for i in $(seq 1 12); do xdotool mousemove $((400+i*20)) $((400+(i%4)*25)); sleep 0.03; done; xdotool mouseup 1'; }
lines10() { sqlite3 "$1" "select coalesce(json_array_length(json_extract(data,'\$.lines')),0) from whiteboards where id='$2'"; }

step "I draw on a whiteboard on my page and switch within a second"
WB10=$(ev "(async()=>{$A10 const {generateWhiteboardId}=await import('/src/lib/whiteboardUtils.ts');const t=await api.getPageTree('Edit10');const id=generateWhiteboardId();await api.createBlock(t.page.id,'{{whiteboard:'+id+'}}');return id})()")
api "navigateTo('Target10')" >/dev/null 2>&1; api "navigateTo('Edit10')" >/dev/null; sleep 1.5
ev "document.querySelector('.whiteboard-indicator')?.click()" >/dev/null
waitfor "!!document.querySelector('canvas.whiteboard-canvas')" 10
ev "$DRAWMODE10" >/dev/null; sleep 0.5
is "Switch armed" "$(ev "$ARM10")" "armed"
stroke10
wait_nb10 "$OKEY10" && pass "Drew a stroke, switched to Other10" || fail "Draw + switch" "$(cur10)"
is "The stroke is in the home database's board" "$(lines10 "$HDB10" "$WB10")" "1"
is "No board row in Other10's database" "$(sqlite3 "$ODB10" "select count(*) from whiteboards where id='$WB10'")" "0"
ev "window.__MINOTES__.switchNotebook('$HOME10')" >/dev/null; wait_nb10 "$HOME10"

step "I draw on a NEW board (Ctrl+Shift+W) and switch at once: its block and board stay home"
api "navigateTo('Edit10')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Edit10'"; sleep 1
"$DC" press "Control+Shift+w"; waitfor "!!document.querySelector('canvas.whiteboard-canvas')" 10
NWB10=$(api "getOpenWhiteboardId()")
ev "$DRAWMODE10" >/dev/null; sleep 0.5
is "Switch armed" "$(ev "$ARM10")" "armed"
stroke10
wait_nb10 "$OKEY10" && pass "Drew on new board $NWB10, switched" || fail "New board draw + switch" "$(cur10)"
is "Its board is in the home database" "$(lines10 "$HDB10" "$NWB10")" "1"
is "Its {{whiteboard}} block is on Edit10 in the home database" "$(sqlite3 "$HDB10" "select count(*) from blocks b join pages p on p.id=b.page_id where p.title='Edit10' and b.content='{{whiteboard:$NWB10}}'")" "1"
is "Nothing of it in Other10's database" "$(sqlite3 "$ODB10" "select (select count(*) from whiteboards where id='$NWB10')+(select count(*) from blocks where content like '%$NWB10%')")" "0"
"$DC" wshot "d10-after-switch" >/dev/null
ev "window.__MINOTES__.switchNotebook('$HOME10')" >/dev/null; wait_nb10 "$HOME10"
is "Back home" "$(cur10)" "$HOME10"

# ═══════════════════════════════════════════════
journey "D11. A notebook folder copied from another computer asks before it syncs"
# Its own .minotes/sync-config.json says sync is on, and its notes/.git carries
# someone else's hook and fsmonitor command. Nothing may run before I agree, and
# nothing of theirs runs after.
# ═══════════════════════════════════════════════
if command -v git >/dev/null; then
device trust10 || true
TH="$STATE/trust10"
A10="const api=await import('/src/lib/api.ts');"
F10="$TH/Incoming/Arrived"; MARK="$TH/PWNED"
mkdir -p "$TH/Incoming"
printf '[user]\n\tname = t10\n\temail = t10@example.test\n[init]\n\tdefaultBranch = main\n' >"$TH/.gitconfig"
KEY10=$(ev "(async()=>{$A10 const n=await api.createNotebook('Arrived','$F10');return n.key})()")
step "The folder as it arrives: sync on, a repo with a hostile hook and fsmonitor"
git init -q --bare -b main "$TH/remote.git"
HOME="$TH" git -C "$F10/notes" init -q -b main
HOME="$TH" git -C "$F10/notes" remote add origin "$TH/remote.git"
printf '#!/bin/sh\necho ran >> "%s"\nexit 0\n' "$MARK" >"$F10/notes/.git/hooks/post-commit"
cp "$F10/notes/.git/hooks/post-commit" "$F10/notes/.git/hooks/pre-commit"
cp "$F10/notes/.git/hooks/post-commit" "$F10/notes/.git/fsmon"
chmod +x "$F10/notes/.git/hooks/post-commit" "$F10/notes/.git/hooks/pre-commit" "$F10/notes/.git/fsmon"
HOME="$TH" git -C "$F10/notes" config core.fsmonitor "$F10/notes/.git/fsmon"
mkdir -p "$F10/.minotes"; printf '{"enabled": true, "last_sync": null}\n' >"$F10/.minotes/sync-config.json"
ev "window.__MINOTES__.switchNotebook('$KEY10')" >/dev/null
waitfor "!!document.querySelector('[data-testid=sync-confirm-banner]')" 20 \
  && pass "Opening it asks before syncing" || fail "No confirmation notice" "$(ev "document.querySelector('.nb-banners')?.innerText||'none'")"
"$DC" wshot "d11-sync-confirm" >/dev/null
is "Status says it needs confirmation" "$(ev "(async()=>{$A10 return String((await api.gitSyncStatus()).needs_confirmation)})()")" "true"
is "A sync call is refused" "$(ev "(async()=>{$A10 const r=await api.gitSync();return String(r.needs_confirmation)+'/'+String(r.success)})()")" "true/false"
is "Nothing was committed" "$(HOME="$TH" git -C "$F10/notes" rev-parse -q --verify HEAD >/dev/null 2>&1 && echo yes || echo no)" "no"
step "I agree: Sync it here"
ev "document.querySelector('[data-testid=sync-confirm]')?.click()" >/dev/null
for _ in $(seq 1 60); do git --git-dir="$TH/remote.git" rev-parse -q --verify main >/dev/null 2>&1 && break; sleep 0.25; done
is "It synced to the folder's remote" "$(git --git-dir="$TH/remote.git" rev-parse -q --verify main >/dev/null 2>&1 && echo yes || echo no)" "yes"
waitfor "!document.querySelector('[data-testid=sync-confirm-banner]')" 10 && pass "The notice is gone" || fail "Notice still shown" ""
is "Their fsmonitor setting was removed" "$(HOME="$TH" git -C "$F10/notes" config --local --get core.fsmonitor || echo none)" "none"
is "Their hook and fsmonitor never ran" "$([[ -e "$MARK" ]] && cat "$MARK" | wc -l || echo 0)" "0"
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
sleep 2
is "After a restart it syncs without asking again" "$(ev "(async()=>{$A10 return String((await api.gitSyncStatus()).needs_confirmation)})()")" "false"
is "…and no notice" "$(ev "String(!!document.querySelector('[data-testid=sync-confirm-banner]'))")" "false"
fi

# ═══════════════════════════════════════════════
journey "D12. Web images in my notes stay blocked until I allow them"
# Under the real CSP (no http:/https: in img-src) a remote image never reaches
# the network from the webview: it's a placeholder until "Load images", then the
# backend fetches it (SSRF-safe: public hosts only, https, ≤10 MB, image only)
# and the page shows a blob:. The SSRF guard refuses loopback, so this journey
# serves its image from a local server through the debug-build-only escape hatch
# MINOTES_TEST_IMAGE_ORIGIN (exactly that one IP:port; compiled out of release
# builds). Every other loopback address stays refused — asserted below.
# ═══════════════════════════════════════════════
IMG10="$STATE/img10"; rm -rf "$IMG10"; mkdir -p "$IMG10"
python3 - "$IMG10" <<'PY'
import sys, zlib, struct
w, h = 48, 32
raw = b"".join(b"\x00" + bytes([0xf6, 0x82, 0x3b]) * w for _ in range(h))
ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")
for n in ("harbour.png", "sneaky.png", "csp.png"):
    open(f"{sys.argv[1]}/{n}", "wb").write(png)
open(f"{sys.argv[1]}/page.html", "w").write("<html><title>not an image</title></html>")
PY
PORT10=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
(cd "$IMG10" && exec python3 -m http.server "$PORT10" --bind 127.0.0.1) >"$IMG10/server.log" 2>&1 &
SRV10=$!
ORIGIN10="http://127.0.0.1:$PORT10"
export MINOTES_TEST_IMAGE_ORIGIN="$ORIGIN10"
hits10() { local n; n=$(grep -c "GET /$1" "$IMG10/server.log" 2>/dev/null); echo "${n:-0}"; }
A10="const api=await import('/src/lib/api.ts');"
STATE10="[...document.querySelectorAll('.block .remote-img')].map(e=>e.getAttribute('data-remote-state')).join(',')"
WEBIMG10="[...document.querySelectorAll('img')].filter(i=>/^(https?:)?\\/\\//i.test(i.getAttribute('src')||'')).length"
device rimg || true

step "A page with two web images opens with placeholders"
ev "(async()=>{$A10 const p=await api.createPage('Web Images');await api.createBlock(p.id,'![Harbour]($ORIGIN10/harbour.png)');await api.createBlock(p.id,'![Sneaky](http://localhost:$PORT10/sneaky.png)');return 1})()" >/dev/null
api "navigateTo('Web Images')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Web Images'"
waitfor "document.querySelectorAll('.block .remote-img[data-remote-state=blocked]').length===2" 10
is "Both blocked" "$(ev "$STATE10")" "blocked,blocked"
is "No <img> with a web address" "$(ev "$WEBIMG10")" "0"
is "The bar offers Load images" "$(ev "String(!!document.querySelector('[data-testid=remote-images-load]'))")" "true"
is "Nothing reached the server" "$(hits10 '')" "0"
"$DC" wshot "d12-blocked" >/dev/null

step "The CSP itself blocks web images (even if some path missed the placeholder)"
R=$("$DC" js "const v=[];const h=e=>v.push(e.effectiveDirective);document.addEventListener('securitypolicyviolation',h);const load=u=>new Promise(r=>{const i=new Image();i.onload=()=>r('loaded');i.onerror=()=>r('blocked');setTimeout(()=>r('timeout'),4000);i.src=u;});const a=await load('$ORIGIN10/csp.png');const b=await load('https://example.com/csp.png');await new Promise(r=>setTimeout(r,300));document.removeEventListener('securitypolicyviolation',h);return a+','+b+','+v.includes('img-src')" 2>&1 | tr -d '"')
is "http://127.0.0.1 and https:// <img> both refused by img-src" "$R" "blocked,blocked,true"
is "…and the server saw no request" "$(hits10 csp.png)" "0"
"$DC" errors --clear >/dev/null 2>&1   # those violations were deliberate

step "The backend refuses everything but the test origin"
R=$("$DC" js "const out=[];for(const u of ['http://localhost:$PORT10/sneaky.png','http://127.0.0.2:$PORT10/sneaky.png','http://[::1]:$PORT10/sneaky.png','http://169.254.169.254/latest/meta-data','file:///etc/passwd','$ORIGIN10/page.html']){try{await invoke('fetch_remote_image',{url:u});out.push('LOADED '+u)}catch(e){out.push(String(e).includes('not allowed')||String(e).includes('Not an image')||String(e).includes('Not a valid')?'refused':'other:'+e)}}return out.join(',')" 2>&1 | tr -d '"')
is "localhost, 127.0.0.2, [::1], metadata IP, file:, an HTML page" "$R" "refused,refused,refused,refused,refused,refused"
is "No request for sneaky.png" "$(hits10 sneaky.png)" "0"

step "Load images: the allowed one appears via the backend, the loopback one stays out"
"$DC" wclick "[data-testid=remote-images-load]" >/dev/null
waitfor "(()=>{const i=document.querySelector('.block .remote-img img');return i&&i.complete&&i.naturalWidth===48})()" 15 \
  && pass "Harbour shown (48 px, from a blob:)" || fail "Load" "$(ev "$STATE10")"
is "States: loaded, error" "$(ev "$STATE10")" "loaded,error"
[[ "$(ev "document.querySelectorAll('.block .remote-img')[1]?.title||''")" == *"not allowed"* ]] \
  && pass "The refused one says why on hover" || fail "Error tooltip" "$(ev "document.querySelectorAll('.block .remote-img')[1]?.title")"
is "Still no <img> with a web address" "$(ev "$WEBIMG10")" "0"
is "Server: one request for harbour.png, none for sneaky.png" "$(hits10 harbour.png),$(hits10 sneaky.png)" "1,0"
"$DC" wshot "d12-loaded" >/dev/null

step "Always for this notebook survives a restart"
ev "(async()=>{const r=await import('/src/lib/remoteImages.ts');r.setNotebookAlways(true);return 1})()" >/dev/null
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
api "navigateTo('Web Images')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Web Images'"
waitfor "document.querySelector('.block .remote-img')?.getAttribute('data-remote-state')==='loaded'" 15 \
  && pass "Loads straight away after restart" || fail "Always after restart" "$(ev "$STATE10")"
is "No Load button" "$(ev "String(document.querySelectorAll('[data-testid=remote-images-load]').length)")" "0"

step "Save to notebook: the image is kept and works offline"
"$DC" wclick "[data-testid=remote-images-save]" >/dev/null
waitfor "(async()=>{$A10 const t=await api.getPageTree('Web Images');return t.blocks[0].content.startsWith('![Harbour](attachment:')})()" 15
R=$(blocks_of 'Web Images')
[[ "$R" =~ ^\!\[Harbour\]\(attachment:[0-9a-f]{64}/harbour\.png\)\ ¦\ \!\[Sneaky\]\(http://localhost: ]] \
  && pass "Block points at the attachment; the refused one is left as it was" || fail "Saved block" "$R"
kill "$SRV10" 2>/dev/null; wait "$SRV10" 2>/dev/null
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
api "navigateTo('Web Images')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Web Images'"
waitfor "[...document.querySelectorAll('.block img')].some(i=>i.complete&&i.naturalWidth===48&&i.src.includes('attachment'))" 15 \
  && pass "Shown from attachment:// with the server gone" || fail "Offline image" "$(ev "[...document.querySelectorAll('.block img')].map(i=>i.src+':'+i.naturalWidth).join(' ')")"
"$DC" wshot "d12-saved" >/dev/null
ev "(async()=>{const r=await import('/src/lib/remoteImages.ts');r.setNotebookAlways(false);return 1})()" >/dev/null
unset MINOTES_TEST_IMAGE_ORIGIN

# ═══════════════════════════════════════════════
journey "D13. My private notebook is encrypted on disk — and only opens with my passphrase"
# PRD-encryption §7: create encrypted, write (title, block, folder, property,
# whiteboard, attachment, search), quit → relaunch locked, wrong passphrase,
# unlock, nothing readable anywhere under the scratch HOME / TMPDIR / app log
# (the leak test), the CLI with MINOTES_PASSPHRASE, "keep unlocked on this
# device" (debug-build fake keychain — never the real one), auto-lock, and
# encrypting an existing notebook (mirror deleted, page kept).
# ═══════════════════════════════════════════════
EH="$STATE/enc13"; ETMP="$STATE/enc13-tmp"; EKC="$STATE/enc13-keychain"
rm -rf "$ETMP" "$EKC"; mkdir -p "$ETMP"
export TMPDIR="$ETMP" MINOTES_FAKE_KEYCHAIN_DIR="$EKC"
device enc13 || true
A13="const api=await import('/src/lib/api.ts');"
PASS13="correct horse battery staple"
mx13() { HOME="$EH" "$REPO_ROOT/target/debug/minotes" "$@" 2>&1; }
setv13() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
# Own helpers: the journey also runs on its own (D5's wait_file isn't defined then).
wait_file13() { for _ in $(seq 1 $(( $2 * 4 ))); do grep -qF -- "$3" "$1" 2>/dev/null && return 0; sleep 0.25; done; return 1; }
unlock_ui13() { setv13 "[data-testid=unlock-passphrase]" "$1"; "$DC" wclick "[data-testid=unlock-submit]" >/dev/null; }
# Marker strings: none of them may appear in any file the app writes.
M_TITLE="Okapi13Title"; M_BLOCK="okapi13 block text"; M_FOLDER="Okapi13Folder"; M_PROP="okapi13prop"; M_BOARD="okapi13board"; M_ATT="OKAPI13ATTACH"; M_SEARCH="okapi13query"
leaks13() { grep -rlaF -e "$M_TITLE" -e "$M_BLOCK" -e "$M_FOLDER" -e "$M_PROP" -e "$M_BOARD" -e "$M_ATT" -e "$M_SEARCH" "$EH" "$ETMP" "$STATE/app.log" 2>/dev/null | grep -v '/shots/' | head -5; }

step "I create an encrypted notebook and write in it"
R=$(ev "(async()=>{$A13 const r=await api.createEncryptedNotebook('Vault13',undefined,'$PASS13');const n=await import('/src/lib/notebooks.ts');await n.switchNotebook(r.notebook.key);return r.recovery_key.length+'|'+(await api.getNotebookSession()).encrypted})()")
is "Created and opened (recovery key, encrypted)" "$R" "63|true"
R=$(ev "(async()=>{$A13 const f=await api.createFolder('$M_FOLDER');const p=await api.createPage('$M_TITLE');await api.movePageToFolder(p.id,f.id);const b=await api.createBlock(p.id,'$M_BLOCK');await api.setProperty(b.id,'block','status','$M_PROP');await api.saveWhiteboard('wb13','{\"notes\":[{\"text\":\"$M_BOARD\"}]}');await api.createBlock(p.id,'{{whiteboard:wb13}}');return (await api.search('$M_SEARCH'.slice(0,6),10)).length})()")
[[ "$R" =~ ^[0-9]+$ ]] && pass "Page, folder, property, whiteboard written; searched" || fail "Write" "$R"
R=$(ev "(async()=>{$A13 const a=await api.storeAttachment('n13.txt','text/plain',new TextEncoder().encode('$M_ATT bytes'));const p=await api.getPageTree('$M_TITLE');await api.createBlock(p.page.id,'['+a.name+'](attachment:'+a.hash+'/n13.txt)');const c=document.createElement('canvas');c.width=20;c.height=10;c.getContext('2d').fillRect(0,0,20,10);const png=new Uint8Array(await (await new Promise(r=>c.toBlob(r,'image/png'))).arrayBuffer());const i=await api.storeAttachment('p13.png','image/png',png);const w=await new Promise(r=>{const im=new Image();im.onload=()=>r(im.naturalWidth);im.onerror=()=>r('refused');im.src='attachment://localhost/'+i.hash});return (await api.getAttachment(a.hash)).name+'|'+w})()")
is "Attachments stored in the database and served back" "$R" "n13.txt|20"
api "navigateTo('$M_TITLE')" >/dev/null; sleep 1
VAULT="$EH/MiNotes/Vault13"
[[ -f "$VAULT/notebook.minotes" && ! -d "$VAULT/notes" ]] && pass "Folder has the database, no markdown copy" || fail "Vault layout" "$(ls "$VAULT" 2>&1 | tr '\n' ' ')"

step "Quit and relaunch: the notebook opens locked"
"$DC" restart >/dev/null
waitfor "!!document.querySelector('[data-testid=unlock-screen]')" 30 && pass "Unlock screen after restart" || fail "Not locked after restart" "$(ev "document.body.innerText.slice(0,200)")"
is "No title on the locked screen" "$(ev "String(document.body.innerText.includes('$M_TITLE'))")" "false"
"$DC" wshot "d13-locked" >/dev/null

step "The leak test: no marker in any file under HOME, TMPDIR or the app log"
L=$(leaks13); [[ -z "$L" ]] && pass "No plaintext markers anywhere (HOME, TMPDIR, app log)" || fail "Plaintext found" "$L"
H=$(head -c 16 "$VAULT/notebook.minotes" | tr -d '\0')
[[ "$H" != "SQLite format 3" ]] && pass "The database file has no SQLite header (it is ciphertext)" || fail "Plain database" "$H"

step "A wrong passphrase is refused; the right one opens it"
unlock_ui13 "not the passphrase"
waitfor "(document.querySelector('[data-testid=unlock-error]')?.textContent||'').includes('Wrong passphrase')" 10 && pass "Wrong passphrase refused" || fail "Wrong passphrase" "$(ev "document.querySelector('[data-testid=unlock-error]')?.textContent")"
unlock_ui13 "$PASS13"
waitfor "!document.querySelector('[data-testid=unlock-screen]') && !!window.__MINOTES__?.navigateTo" 20 && pass "Unlocked" || fail "Unlock" ""
R=$(ev "(async()=>{$A13 const t=await api.getPageTree('$M_TITLE');return t.blocks.map(b=>b.content).filter(c=>!c.startsWith('{{')&&!c.startsWith('[')).join('|')})()")
is "My page is there" "$R" "$M_BLOCK"

step "The CLI opens it only with the passphrase"
R=$(MINOTES_PASSPHRASE="$PASS13" mx13 --notebook Vault13 -f text page list)
[[ "$R" == *"$M_TITLE"* ]] && pass "CLI with MINOTES_PASSPHRASE lists the page" || fail "CLI unlock" "$R"
R=$(env -u MINOTES_PASSPHRASE HOME="$EH" "$REPO_ROOT/target/debug/minotes" --notebook Vault13 page list </dev/null 2>&1)
[[ "$R" == *"encrypted"* ]] && pass "Without it: refused ('encrypted')" || fail "CLI without passphrase" "$R"

step "Keep unlocked on this device: a restart opens it without asking"
R=$(ev "(async()=>{$A13 const s=await api.setRememberDevice(true);return s.remembered+'|'+s.keychain_available})()")
is "Remembered (debug fake keychain)" "$R" "true|true"
"$DC" restart >/dev/null
waitfor "!!window.__MINOTES__?.navigateTo && !document.querySelector('[data-testid=unlock-screen]')" 30 && pass "Opened unlocked after restart" || fail "Remembered device" "$(ev "document.body.innerText.slice(0,120)")"
ev "(async()=>{$A13 await api.setRememberDevice(false);return 1})()" >/dev/null

step "Auto-lock after a minute without input"
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({autoLockMinutes:1});return 1})()" >/dev/null
"$DC" restart >/dev/null
waitfor "!!document.querySelector('[data-testid=unlock-screen]')" 30
unlock_ui13 "$PASS13"
waitfor "!document.querySelector('[data-testid=unlock-screen]')" 20
waitfor "!!document.querySelector('[data-testid=unlock-screen]')" 110 && pass "Locked itself after ~1 min idle" || fail "Auto-lock" ""
ev "(async()=>{const s=await import('/src/lib/settings.ts');s.updateSettings({autoLockMinutes:15});return 1})()" >/dev/null
unlock_ui13 "$PASS13"
waitfor "!document.querySelector('[data-testid=unlock-screen]')" 20

step "Encrypting an existing notebook: verified copy, mirror deleted, page kept"
R=$(ev "(async()=>{$A13 const nb=await api.createNotebook('Plain13');const n=await import('/src/lib/notebooks.ts');await n.switchNotebook(nb.key);const p=await api.createPage('Okapi13Plainpage');await api.createBlock(p.id,'okapi13 plain body');return nb.path})()")
PLAIN="$R"
wait_file13 "$PLAIN/notes/Okapi13Plainpage.md" 20 "okapi13 plain body" && pass "Its markdown copy was written" \
  || fail "Plain mirror" "$PLAIN: $(ls "$PLAIN/notes" 2>&1 | tr '\n' ' ') $(ev "(async()=>{$A13 return JSON.stringify(await api.mirrorStatus())})()")"
R=$(ev "(async()=>{$A13 const plan=await api.encryptionPlan();const rk=await api.encryptNotebook('$PASS13');const s=await api.getNotebookSession();const t=await api.getPageTree('Okapi13Plainpage');return plan.deletes.length+'|'+rk.length+'|'+s.encrypted+'|'+t.blocks[0].content})()")
[[ "$R" =~ ^[0-9]+\|63\|true\|okapi13\ plain\ body$ ]] && pass "Encrypted in place, still open and readable ($R)" || fail "Encrypt existing" "$R"
[[ ! -e "$PLAIN/notes" ]] && pass "The plain markdown copy is gone" || fail "Mirror left" "$(ls -R "$PLAIN/notes" 2>&1 | head -3)"
G=$(grep -rlaF "Okapi13Plainpage" "$PLAIN" 2>/dev/null | head -3)
[[ -z "$G" ]] && pass "No plaintext left in its folder" || fail "Plaintext after encrypting" "$G"
L=$(leaks13); [[ -z "$L" ]] && pass "Leak scan still clean" || fail "Plaintext found" "$L"
unset TMPDIR MINOTES_FAKE_KEYCHAIN_DIR

# ═══════════════════════════════════════════════
journey "D14. My encrypted notebook syncs between two devices — and git never sees my notes"
# PRD-encryption §4.5 / step 5: device A turns sync on for an encrypted notebook;
# the remote gets only opaque .mne files + a key file. Device B joins with the
# passphrase (a wrong one creates nothing), sees everything; edits to different
# blocks on both devices merge per block — with the edit made before and after
# the relaunched app's own startup sync — and each device keeps ONE journal for
# today. A changes the passphrase: the remote's key slots follow, B keeps
# syncing. Device C (its own notebook, same passphrase, another key) is refused
# and the remote is untouched; joining the shared notebook from C needs the NEW
# passphrase. A copied
# encrypted folder still asks before it syncs (F-6). Leak scan: every file under
# both HOMEs and TMPDIRs, every decompressed git object of both repos and the remote.
# ═══════════════════════════════════════════════
if ! command -v git >/dev/null; then
  fail "git available" "git is not installed — encrypted sync journey skipped"
else
R14="$STATE/remote14.git"; rm -rf "$R14" "$STATE"/enc14-tmp; mkdir -p "$STATE/enc14-tmp"
git init -q --bare -b main "$R14"
export TMPDIR="$STATE/enc14-tmp"
A14="const api=await import('/src/lib/api.ts');"
PASS14="correct horse battery staple"
NEWPASS14="violet otter juggles nine lanterns"
M14=("Lynx14Title" "lynx14 first line" "lynx14 second line" "Lynx14Folder" "lynx14prop" "lynx14board")
gitcfg14() { mkdir -p "$STATE/$1"; printf '[user]\n\tname = %s\n\temail = %s@example.test\n[init]\n\tdefaultBranch = main\n' "$1" "$1" >"$STATE/$1/.gitconfig"; }
SYNC14="(async()=>{$A14 const r=await api.gitSync();return (r.error||'ok')+'|conflicts='+(r.conflicts_resolved??0)})()"
ENABLE14="(async()=>{$A14 try{const s=await api.gitSyncEnable();return 'enabled='+s.enabled}catch(e){return 'ERR '+e}})()"
remote_head14() { git --git-dir="$R14" rev-parse -q --verify refs/heads/main 2>/dev/null; }
# Every decompressed object of a repo (git dir) — note text must not be in any.
objects14() { git --git-dir="$1" cat-file --batch-all-objects --batch 2>/dev/null; }
leaks14() {
  local hits=""
  for m in "${M14[@]}"; do
    for d in "$STATE/enc14a" "$STATE/enc14b" "$STATE/enc14c" "$STATE/enc14-tmp"; do
      [[ -d "$d" ]] && hits+=$(grep -rlaF -- "$m" "$d" 2>/dev/null | head -2)
    done
    for g in "$R14" "$STATE/enc14a/MiNotes/Vault14/notes/.git" "$STATE/enc14b/MiNotes/Vault14 B/notes/.git"; do
      [[ -d "$g" ]] && objects14 "$g" | grep -qaF -- "$m" && hits+=" $g:$m"
    done
  done
  echo "$hits"
}
# A relaunched device opens its encrypted notebook locked: unlock it (with its
# own passphrase: $2, default PASS14). The app then syncs on start by itself.
relaunch14() {
  device "$1" keep || true
  waitfor "!!document.querySelector('[data-testid=unlock-screen]')" 30
  ev "(async()=>{const e=await import('/src/lib/encryption.ts');await e.unlock('${2:-$PASS14}');return 1})()" >/dev/null
  waitfor "!!window.__MINOTES__?.navigateTo && !document.querySelector('[data-testid=unlock-screen]')" 20
}
blocks14() { ev "(async()=>{$A14 const t=await api.getPageTree('Lynx14Title');return t.blocks.map(b=>b.content).filter(c=>!c.startsWith('{{')).join(' ¦ ')})()"; }
# Wait (up to $2 s) until the page shows text $1 — i.e. the app's own startup sync brought it.
until14() { local i; for i in $(seq 1 "${2:-30}"); do [[ "$(blocks14)" == *"$1"* ]] && return 0; sleep 1; done; return 1; }
# No conflict page, and ONE journal (today's — each device created its own).
pages14() { ev "(async()=>{$A14 const ps=await api.listPages(1000);return ps.some(p=>p.title.includes('conflict'))+'|'+ps.filter(p=>p.is_journal).map(p=>p.title.replace(/[0-9-]+/,'D')).join(',')})()"; }
cli14() { HOME="$STATE/$1" MINOTES_PASSPHRASE="$PASS14" "$REPO_ROOT/target/debug/minotes" --notebook "$2" "${@:3}" 2>&1; }

step "Device A: an encrypted notebook, written, with sync turned on"
gitcfg14 enc14a; gitcfg14 enc14b; gitcfg14 enc14c
device enc14a || true
R=$(ev "(async()=>{$A14 const r=await api.createEncryptedNotebook('Vault14',undefined,'$PASS14');await window.__MINOTES__.switchNotebook(r.notebook.key);const f=await api.createFolder('Lynx14Folder');const p=await api.createPage('Lynx14Title');await api.movePageToFolder(p.id,f.id);const b=await api.createBlock(p.id,'lynx14 first line');await api.createBlock(p.id,'lynx14 second line');await api.setProperty(b.id,'block','status','lynx14prop');await api.saveWhiteboard('wb14','{\"notes\":[{\"text\":\"lynx14board\"}]}');await api.createBlock(p.id,'{{whiteboard:wb14}}');return (await api.getNotebookSession()).encrypted})()")
is "Encrypted notebook written" "$R" "true"
L1ID14=$(ev "(async()=>{$A14 const t=await api.getPageTree('Lynx14Title');return t.blocks.find(x=>x.content==='lynx14 first line').id})()")
NOTES14A="$STATE/enc14a/MiNotes/Vault14/notes"
mkdir -p "$NOTES14A"; HOME="$STATE/enc14a" git -C "$NOTES14A" init -q -b main; HOME="$STATE/enc14a" git -C "$NOTES14A" remote add origin "$R14"
is "A turns sync on" "$(ev "$ENABLE14")" "enabled=true"
is "A syncs cleanly" "$(ev "$SYNC14")" "ok|conflicts=0"
FILES=$(git --git-dir="$R14" ls-tree -r --name-only main 2>/dev/null)
NMD=$(echo "$FILES" | grep -c '\.md$'); NMNE=$(echo "$FILES" | grep -cE '^[pfwa]/[0-9a-f]{32}\.mne$')
[[ "$NMD" == "0" && "$NMNE" -ge 3 && "$FILES" == *".minotes-encryption.json"* ]] && pass "The remote holds only opaque .mne files + the key file ($NMNE files)" || fail "Remote layout" "$FILES"
LOG=$(git --git-dir="$R14" log --format='%s' main 2>/dev/null | tr '\n' ' ')
[[ "$LOG" != *Lynx14* ]] && pass "Commit messages name no page" || fail "Commit message leak" "$LOG"

step "Device B: a wrong passphrase creates nothing; the right one joins and syncs everything"
device enc14b || true
R=$(ev "(async()=>{$A14 try{await api.joinEncryptedNotebook('$R14','Vault14 B',undefined,'not the passphrase');return 'joined'}catch(e){return String(e).split(':')[0]}})()")
is "Wrong passphrase refused" "$R" "WRONG_PASSPHRASE"
[[ ! -e "$STATE/enc14b/MiNotes/Vault14 B" ]] && pass "…and no notebook folder was made" || fail "Folder left behind" "$(ls "$STATE/enc14b/MiNotes")"
R=$(ev "(async()=>{$A14 const nb=await api.joinEncryptedNotebook('$R14','Vault14 B',undefined,'$PASS14');await window.__MINOTES__.switchNotebook(nb.key);const s=await api.gitSyncEnable();return s.enabled+'|'+(await api.getNotebookSession()).encrypted})()")
is "B joined, encrypted, sync on" "$R" "true|true"
is "B has the page, in order" "$(blocks14)" "lynx14 first line ¦ lynx14 second line"
is "…in its folder, with the block property and the whiteboard" "$(ev "(async()=>{$A14 const t=await api.getPageTree('Lynx14Title');const b=t.blocks.find(x=>x.content==='lynx14 first line');const props=await api.getProperties(b.id);const tree=JSON.stringify(await api.getFolderTree());const wb=await api.getWhiteboard('wb14');return [tree.includes('Lynx14Folder'),props.some(p=>p.key==='status'&&p.value==='lynx14prop'),(wb||'').includes('lynx14board')].join('|')})()")" "true|true|true"

# Nightly 2026-10-15 failed here with a "(conflict from …)" page: both devices'
# apps create today's journal (random ids, one title); sync kept them as
# "Journal/…" and "Journal/… (2)", the devices could disagree about which was
# which (import order), rewrote each other's journal titles at every sync, and a
# merge of a journal both had touched kept a conflict copy. Journals of one day
# now fold into one page. Both orders of "the app's startup sync" vs "my edit"
# run here, deterministically.
step "Both devices edit different lines; A's edit is made before its startup sync (git conflict, merged per block)"
ev "(async()=>{$A14 const t=await api.getPageTree('Lynx14Title');const b=t.blocks.find(x=>x.content==='lynx14 second line');await api.updateBlock(b.id,'lynx14 second line — edited on B');return 1})()" >/dev/null
is "B syncs" "$(ev "$SYNC14")" "ok|conflicts=0"
# A edits while its app is closed (the CLI), so the edit is in A's first export.
R=$(cli14 enc14a Vault14 block update "$L1ID14" --content 'lynx14 first line — edited on A')
[[ "$R" == *"edited on A"* ]] && pass "A edits line 1 before the app (and its sync) starts" || fail "CLI edit on A" "$R"
relaunch14 enc14a
R=$(ev "$SYNC14")
[[ "$R" == ok* ]] && pass "A syncs ($R)" || fail "A sync" "$R"
is "A has both edits (merged per block)" "$(blocks14)" "lynx14 first line — edited on A ¦ lynx14 second line — edited on B"
ev "$SYNC14" >/dev/null
is "A: no conflict page, one journal" "$(pages14)" "false|Journal/D"

step "Again — now each device's startup sync runs before the edit (fast-forward)"
relaunch14 enc14b
until14 "edited on A" 30 && pass "B's startup sync brought A's edit" || fail "B startup sync" "$(blocks14)"
is "B has both edits" "$(blocks14)" "lynx14 first line — edited on A ¦ lynx14 second line — edited on B"
ev "(async()=>{$A14 const t=await api.getPageTree('Lynx14Title');const b=t.blocks.find(x=>x.content.startsWith('lynx14 second line'));await api.updateBlock(b.id,'lynx14 second line — round 2 on B');return 1})()" >/dev/null
is "B syncs round 2" "$(ev "$SYNC14")" "ok|conflicts=0"
relaunch14 enc14a
until14 "round 2 on B" 30 && pass "A's startup sync brought B's round-2 edit" || fail "A startup sync" "$(blocks14)"
ev "(async()=>{$A14 const t=await api.getPageTree('Lynx14Title');const b=t.blocks.find(x=>x.content.startsWith('lynx14 first line'));await api.updateBlock(b.id,'lynx14 first line — round 2 on A');return 1})()" >/dev/null
is "A syncs round 2 without a git conflict" "$(ev "$SYNC14")" "ok|conflicts=0"
is "A has both round-2 edits" "$(blocks14)" "lynx14 first line — round 2 on A ¦ lynx14 second line — round 2 on B"
is "A: still no conflict page, one journal" "$(pages14)" "false|Journal/D"

# Opportunity P2 (E17): a new passphrase reaches the sync repo's key file, so a
# device joining later uses it; a device already syncing keeps its own and works on.
step "A changes the passphrase: the sync repo's key slots follow; B keeps syncing"
KF14_BEFORE=$(git --git-dir="$R14" rev-parse -q --verify "main:.minotes-encryption.json" 2>/dev/null)
R=$(ev "(async()=>{$A14 try{await api.changePassphrase('$PASS14','$NEWPASS14');const r=await api.gitSync();return r.error||'ok'}catch(e){return 'ERR '+e}})()")
is "Passphrase changed and synced" "$R" "ok"
KF14_AFTER=$(git --git-dir="$R14" rev-parse -q --verify "main:.minotes-encryption.json" 2>/dev/null)
[[ -n "$KF14_AFTER" && "$KF14_AFTER" != "$KF14_BEFORE" ]] && pass "The remote's key file was rewritten" || fail "Key file not updated" "$KF14_BEFORE -> $KF14_AFTER"
relaunch14 enc14b
until14 "round 2 on A" 30 && pass "B (old passphrase on this device) still syncs: has A's round-2 edit" || fail "B after the passphrase change" "$(blocks14)"
is "B syncs" "$(ev "$SYNC14")" "ok|conflicts=0"
is "B: no conflict page, one journal" "$(pages14)" "false|Journal/D"
is "B's sync left the new key slots in place" "$(git --git-dir="$R14" rev-parse -q --verify "main:.minotes-encryption.json" 2>/dev/null)" "$KF14_AFTER"
ev "$SYNC14" >/dev/null; sleep 2; ev "$SYNC14" >/dev/null
HEAD14=$(remote_head14); ev "$SYNC14" >/dev/null
is "Stable: another sync commits nothing (no title ping-pong)" "$(remote_head14)" "$HEAD14"

step "Device C: its own encrypted notebook, same passphrase, another key — refused, remote untouched"
BEFORE14=$(remote_head14)
device enc14c || true
ev "(async()=>{$A14 const r=await api.createEncryptedNotebook('Vault14 C',undefined,'$PASS14');await window.__MINOTES__.switchNotebook(r.notebook.key);await api.createPage('C14 page');return 1})()" >/dev/null
NOTES14C="$STATE/enc14c/MiNotes/Vault14 C/notes"
mkdir -p "$NOTES14C"; HOME="$STATE/enc14c" git -C "$NOTES14C" init -q -b main; HOME="$STATE/enc14c" git -C "$NOTES14C" remote add origin "$R14"
R=$(ev "$ENABLE14")
[[ "$R" == ERR*"different encrypted notebook"* ]] && pass "Refused: another notebook's remote" || fail "C was not refused" "$R"
is "The remote is untouched" "$(remote_head14)" "$BEFORE14"
is "C imported nothing" "$(ev "(async()=>{$A14 return String((await api.listPages(1000)).some(p=>p.title==='Lynx14Title'))})()")" "false"

step "A device joining after the passphrase change needs the NEW passphrase"
R=$(ev "(async()=>{$A14 try{await api.joinEncryptedNotebook('$R14','Vault14 D',undefined,'$PASS14');return 'joined'}catch(e){return String(e).split(':')[0]}})()")
is "The old passphrase is refused" "$R" "WRONG_PASSPHRASE"
R=$(ev "(async()=>{$A14 const nb=await api.joinEncryptedNotebook('$R14','Vault14 D',undefined,'$NEWPASS14');await window.__MINOTES__.switchNotebook(nb.key);const s=await api.gitSyncEnable();return s.enabled})()")
is "The new one joins, sync on" "$R" "true"
is "…and has the notes" "$(blocks14)" "lynx14 first line — round 2 on A ¦ lynx14 second line — round 2 on B"
is "…with one journal and no conflict page" "$(pages14)" "false|Journal/D"
BEFORE14=$(remote_head14)

step "A copied encrypted notebook folder still asks before it syncs (F-6)"
COPY14="$STATE/enc14c/Copied Vault14"
cp -r "$STATE/enc14a/MiNotes/Vault14" "$COPY14"
ev "(async()=>{$A14 const nb=await api.openNotebookFolder('$COPY14');const n=await import('/src/lib/notebooks.ts');await n.switchNotebook(nb.key);return 1})()" >/dev/null
waitfor "!!document.querySelector('[data-testid=unlock-screen]')" 20 && pass "The copy opens locked" || fail "Copy not locked" "$(ev "(async()=>{$A14 return JSON.stringify(await api.getNotebookSession())})()")"
ev "(async()=>{const e=await import('/src/lib/encryption.ts');await e.unlock('$NEWPASS14');return 1})()" >/dev/null
waitfor "!!window.__MINOTES__?.navigateTo && !document.querySelector('[data-testid=unlock-screen]')" 20
R=$(ev "(async()=>{$A14 const s=await api.gitSyncStatus();const r=await api.gitSync();return s.needs_confirmation+'|'+(r.needs_confirmation??false)})()")
is "Sync waits for confirmation on this computer" "$R" "true|true"
is "…and the remote is still untouched" "$(remote_head14)" "$BEFORE14"

step "The leak scan: no note text in any file of either device, any git object, or the remote"
L=$(leaks14); [[ -z "$L" ]] && pass "No plaintext anywhere (HOMEs, TMPDIR, 3 repos' objects)" || fail "Plaintext found" "$L"
OBJ=$(objects14 "$R14" | grep -caF "key_check"); [[ "$OBJ" -ge 1 ]] && pass "Control: the scan reads the remote's objects (key file seen)" || fail "Scan control" "$OBJ"
unset TMPDIR
fi

# ═══════════════════════════════════════════════
journey "D15. Real input never loses what I wrote (UX review Wave 1)"
# What the browser journeys can't see: an image pasted through the REAL X
# clipboard (WebKitGTK fills clipboardData.items, not .files — C-2), tags and
# highlights typed with real keys (C-3, C-4), and confirmations in the desktop
# webview, where window.confirm returns a Promise and so always "accepted" (C-1,
# C-5). Real clicks and keys throughout; WebDriver only sets up and reads back.
# ═══════════════════════════════════════════════
A15="const api=await import('/src/lib/api.ts');"
X15="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
# Real mouse click on the centre of an element (the window sits at 0,0).
rclick15() {
  local xy; xy=$(ev "(()=>{const e=$1;if(!e)return '';e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()")
  [[ -n "$xy" ]] && "$DC" click $xy >/dev/null
}
dialog15() { ev "(document.querySelector('[data-testid=confirm-dialog]')?.innerText||'none')"; }
device w1 || true
mkdir -p "$STATE/w1-files"
python3 - "$STATE/w1-files/paste15.png" <<'PY'
import sys, zlib, struct
w, h = 64, 40
raw = b''.join(b'\x00' + bytes([40, 160, 220]) * w for _ in range(h))
def ch(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))
PY

step "I copy an image (X clipboard) and press Ctrl+V in a block"
ev "(async()=>{$A15 const p=await api.createPage('Paste15');await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('Paste15')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Paste15'"; sleep 1
DISPLAY="$X15" xclip -quiet -selection clipboard -t image/png -i "$STATE/w1-files/paste15.png" >/dev/null 2>&1 &
XCLIP15=$!
sleep 0.5
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" key ctrl+v
waitfor "(async()=>{$A15 const t=await api.getPageTree('Paste15');return t.blocks.some(b=>b.content.includes('](attachment:'))})()" 15
kill "$XCLIP15" 2>/dev/null; wait "$XCLIP15" 2>/dev/null
ev "document.activeElement?.blur()" >/dev/null; sleep 1.5
PB15=$(blocks_of 'Paste15')
[[ "$PB15" == *"](attachment:"* && "$PB15" != *"blob:"* ]] && pass "Stored as an attachment, no blob: URL ($PB15)" || fail "Pasted image not stored as an attachment" "$PB15"
H15=$(echo "$PB15" | grep -o 'attachment:[0-9a-f]\{64\}' | head -1 | cut -d: -f2)
is "…and the attachment is in the database" "$(db w1 "select mime from attachments where hash='$H15'")" "image/png"

step "I quit and reopen: the image is still there"
"$DC" restart >/dev/null; waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
api "navigateTo('Paste15')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Paste15'"; sleep 1
waitfor "[...document.querySelectorAll('.block img')].some(i=>i.complete&&i.naturalWidth===64)" 15 \
  && pass "The pasted image renders after a restart (64×40)" || fail "Pasted image after restart" "$(ev "[...document.querySelectorAll('.block img')].map(i=>i.src+':'+i.naturalWidth).join(' ')||'no img'")"
"$DC" wshot "d15-pasted-after-restart" >/dev/null

step "I type 'x #urgent done' and a ==highlight== with real keys"
ev "(async()=>{$A15 const p=await api.createPage('Type15');await api.createBlock(p.id,'');await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('Type15')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Type15'"; sleep 1
api "focusBlock(0)" >/dev/null; sleep 0.5; "$DC" type "x #urgent done"; sleep 0.5
api "focusBlock(1)" >/dev/null; sleep 0.5; "$DC" type "say ==hi== there"; sleep 0.5
ev "document.activeElement?.blur()" >/dev/null; sleep 1.5
is "Stored markdown keeps the tag and the highlight" "$(blocks_of 'Type15')" "x #urgent done ¦ say ==hi== there"
is "…shown as a tag chip and a highlight" "$(ev "String(!!document.querySelector('.tag-pill[data-tag=urgent]') && !!document.querySelector('.block mark'))")" "true"

step "Deleting a CSS snippet shows the app's dialog; Cancel deletes nothing"
ev "(async()=>{$A15 await api.addCssSnippet('snippet15','.x15{color:red}');return 1})()" >/dev/null
api "openSettings()" >/dev/null; sleep 1
rclick15 "[...document.querySelectorAll('.settings-slide-panel button')].find(b=>b.textContent.includes('CSS snippets'))"; sleep 1
rclick15 "[...document.querySelectorAll('button[title=\"Delete snippet\"]')].find(b=>b.parentElement.textContent.includes('snippet15'))"; sleep 0.8
D15=$(dialog15)
[[ "$D15" == *"snippet15"* ]] && pass "The app's own confirm dialog asks" || fail "No confirm dialog for snippet delete" "$D15"
"$DC" shot "d15-snippet-confirm" >/dev/null
rclick15 "document.querySelector('[data-testid=confirm-cancel]')"; sleep 0.8
is "Cancel: the snippet is still there" "$(ev "(async()=>{$A15 return String((await api.listCssSnippets()).some(s=>s.name==='snippet15'))})()")" "true"
"$DC" key Escape; sleep 0.5

step "Empty trash shows the app's dialog; Cancel and Escape delete nothing"
ev "(async()=>{$A15 for(const t of ['Trash15 one','Trash15 two']){const p=await api.createPage(t);await api.trashPage(p.id)}window.dispatchEvent(new Event('minotes-sidebar-refresh'));return 1})()" >/dev/null; sleep 1
N15=$(ev "(async()=>{$A15 return String((await api.listTrash()).length)})()")
[[ "$(ev "String(!!document.querySelector('[data-testid=empty-trash]'))")" == "true" ]] || rclick15 "[...document.querySelectorAll('.sidebar-system-item')].find(e=>e.textContent.includes('Trash'))"
sleep 0.8
rclick15 "document.querySelector('[data-testid=empty-trash]')"; sleep 0.8
D15=$(dialog15)
[[ "$D15" == *"Empty the trash"* ]] && pass "The app's own confirm dialog asks ($N15 items)" || fail "No confirm dialog for Empty trash" "$D15"
rclick15 "document.querySelector('[data-testid=confirm-cancel]')"; sleep 0.8
is "Cancel: the trash still holds $N15 items" "$(ev "(async()=>{$A15 return String((await api.listTrash()).length)})()")" "$N15"
rclick15 "document.querySelector('[data-testid=empty-trash]')"; sleep 0.8
"$DC" key Escape; sleep 0.8
is "Escape closes the dialog and deletes nothing" "$(dialog15)|$(ev "(async()=>{$A15 return String((await api.listTrash()).length)})()")" "none|$N15"

# ═══════════════════════════════════════════════
journey "D16. The outline under a real mouse, keyboard and clipboard (UX review Wave 2)"
# Bugs only real input showed: the collapse arrow was covered (a click zoomed in,
# C-11), a real drag left the outline scrambled until a reload (C-13), markdown
# pasted from the X clipboard lost its structure and a typed ```lang + Enter
# saved escaped backticks (C-6). xdotool clicks, drags, keys and xclip; WebDriver
# only sets up and reads back.
# ═══════════════════════════════════════════════
A16="const api=await import('/src/lib/api.ts');"
X16="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
xy16() { ev "(()=>{const e=$1;if(!e)return '';const r=e.getBoundingClientRect();return Math.round(r.left+($2))+' '+Math.round(r.top+($3))})()"; }
blk16() { echo "[...document.querySelectorAll('.block-list > .block')].find(b=>b.querySelector('.block-content')?.innerText.trim()==='$1')"; }
shown16() { ev "[...document.querySelectorAll('.block-list > .block')].map(b=>b.querySelector('.block-content')?.innerText.trim()+'@'+(b.dataset.depth||0)).join('|')"; }
stored16() { ev "(async()=>{$A16 const t=await api.getPageTree('$1');const d=new Map();for(const b of t.blocks)d.set(b.id,b.parent_id?d.get(b.parent_id)+1:0);return t.blocks.map(b=>b.content.replace(/\\n/g,'⏎')+'@'+d.get(b.id)).join('|')})()"; }
# rdrag16 "<x1> <y1>" "<x2> <y2>": press, move in steps, release (real X input)
rdrag16() {
  local a=($1) b=($2)
  DISPLAY="$X16" xdotool mousemove "${a[0]}" "${a[1]}" sleep 0.2 mousedown 1 sleep 0.2
  for i in 1 2 3 4 5 6 7 8 9 10; do
    DISPLAY="$X16" xdotool mousemove $(( a[0] + (b[0]-a[0])*i/10 )) $(( a[1] + (b[1]-a[1])*i/10 )) sleep 0.06
  done
  # GTK only drops when the last drag motion was answered (accepted): keep the
  # pointer moving over the target for a moment, then release.
  for i in 1 2 3 4 5; do DISPLAY="$X16" xdotool mousemove_relative -- 1 0 sleep 0.1 mousemove_relative -- -1 0 sleep 0.1; done
  DISPLAY="$X16" xdotool sleep 0.5 mouseup 1
}
device w2 || true
ev "(async()=>{$A16 const p=await api.createPage('Fold16');const a=await api.createBlock(p.id,'parent16');const c=await api.createBlock(p.id,'child16',a.id);await api.createBlock(p.id,'grandchild16',c.id);await api.createBlock(p.id,'other16');return 1})()" >/dev/null
api "navigateTo('Fold16')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Fold16'"; sleep 1
ev "document.activeElement?.blur()" >/dev/null; sleep 0.5

step "I click the collapse arrow with the mouse: the block folds (it used to zoom in)"
P16=$(xy16 "$(blk16 parent16)" "10" "12")
DISPLAY="$X16" xdotool mousemove $P16 sleep 0.4
XY=$(xy16 "$(blk16 parent16)?.querySelector(':scope > .block-collapse')" "r.width/2" "r.height/2")
"$DC" click $XY >/dev/null; sleep 1
is "Children hidden, not zoomed" "$(shown16)|$(ev "String(!!document.querySelector('.breadcrumb-bar'))")" "parent16@0|other16@0|false"
is "…and it looks folded (+2 hidden)" "$(ev "(()=>{const b=$(blk16 parent16);return b.classList.contains('is-collapsed')+' '+getComputedStyle(b).getPropertyValue('--collapsed-label').replace(/[^+0-9]/g,'')})()")" 'true +2'
"$DC" shot "d16-collapsed" >/dev/null
"$DC" click $XY >/dev/null; sleep 1
is "A second click unfolds it" "$(shown16)" "parent16@0|child16@1|grandchild16@2|other16@0"

step "Ctrl+Up / Ctrl+Down with real keys fold and unfold the block I'm in"
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" key ctrl+Up; sleep 0.8; F1=$(shown16)
"$DC" key ctrl+Down; sleep 0.8; F2=$(shown16)
is "Ctrl+Up folded, Ctrl+Down unfolded" "$F1 / $F2" "parent16@0|other16@0 / parent16@0|child16@1|grandchild16@2|other16@0"
ev "document.activeElement?.blur()" >/dev/null; sleep 0.5

step "I drag a block by its handle with the real mouse: the outline is right at once"
ev "(async()=>{$A16 const p=await api.createPage('Drag16');const a=await api.createBlock(p.id,'A16');await api.createBlock(p.id,'a1 16',a.id);await api.createBlock(p.id,'a2 16',a.id);const b=await api.createBlock(p.id,'B16');await api.createBlock(p.id,'b1 16',b.id);await api.createBlock(p.id,'C16');return 1})()" >/dev/null
api "navigateTo('Drag16')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Drag16'"; sleep 1
ev "document.activeElement?.blur()" >/dev/null; sleep 0.5
DISPLAY="$X16" xdotool mousemove $(xy16 "$(blk16 A16)" "40" "12") sleep 0.4
FROM=$(xy16 "$(blk16 A16)?.querySelector(':scope > .block-drag-handle')" "r.width/2" "r.height/2")
TO=$(xy16 "$(blk16 C16)" "20" "r.height-4")
rdrag16 "$FROM" "$TO"; sleep 1
S16=$(shown16)
is "A16 (with a1, a2) now follows C16, rendered in order" "$S16" "B16@0|b1 16@1|C16@0|A16@0|a1 16@1|a2 16@1"
sleep 1; is "…and that is what was stored" "$(stored16 Drag16)" "$S16"
"$DC" shot "d16-after-drag" >/dev/null

step "Dragging with the pointer moved right drops the block as a child"
FROM=$(xy16 "$(blk16 C16)?.querySelector(':scope > .block-drag-handle')" "r.width/2" "r.height/2")
DISPLAY="$X16" xdotool mousemove $(xy16 "$(blk16 C16)" "40" "12") sleep 0.4
TO=$(xy16 "$(blk16 B16)" "120" "r.height-4")
rdrag16 "$FROM" "$TO"; sleep 1
S16=$(shown16)
is "C16 became B16's first child" "$S16" "B16@0|C16@1|b1 16@1|A16@0|a1 16@1|a2 16@1"
sleep 1; is "…stored the same" "$(stored16 Drag16)" "$S16"

step "I copy markdown (X clipboard) and press Ctrl+V in an empty block"
ev "(async()=>{$A16 const p=await api.createPage('Paste16');await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('Paste16')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Paste16'"; sleep 1
mkdir -p "$STATE/w1-files"
printf '# Plan16\n- one\n  - one.a\n1. two\n   1. two.1\nNotes\n    indented child\n```python\nprint(1)\n```\n' > "$STATE/w1-files/paste16.md"
DISPLAY="$X16" xclip -quiet -selection clipboard -t UTF8_STRING -i "$STATE/w1-files/paste16.md" >/dev/null 2>&1 &
XCLIP16=$!
sleep 0.5
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" key ctrl+v
waitfor "(async()=>{$A16 return (await api.getPageTree('Paste16')).blocks.length>=8})()" 15
kill "$XCLIP16" 2>/dev/null; wait "$XCLIP16" 2>/dev/null
sleep 1
is "Pasted as an outline (heading, nested blocks, a code block)" "$(stored16 Paste16)" '# Plan16@0|one@0|one.a@1|two@0|two.1@1|Notes@0|indented child@1|```python⏎print(1)⏎```@0'
"$DC" shot "d16-pasted-markdown" >/dev/null

step "I type \`\`\`python and Enter with real keys: a code block, not escaped backticks"
ev "(async()=>{$A16 const p=await api.createPage('Fence16');await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('Fence16')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Fence16'"; sleep 1
api "focusBlock(0)" >/dev/null; sleep 0.5
"$DC" type '```python'; sleep 0.3; "$DC" key Return; sleep 0.5; "$DC" type 'print(16)'; sleep 0.3
ev "document.activeElement?.blur()" >/dev/null; sleep 1.5
is "Stored as a python fence" "$(stored16 Fence16)" '```python⏎print(16)⏎```@0'
journey "D17. Sync tells the truth — and a new device joins cleanly (UX review Wave 2)"
# A fresh device joining sync keeps ONE "Getting Started" (C-9). "Sync now" and
# the sidebar status chip; a conflict toast that names the page and the device,
# with Open; a remote that is gone is an error with Retry, not a grey
# "Offline"; no remote is "no remote", never "Last synced"; a copied folder
# after "Not now" is "Paused — waiting for your OK". Real clicks on the chip,
# Settings and the toast; WebDriver sets up and reads back.
# ═══════════════════════════════════════════════
if command -v git >/dev/null; then
A17="const api=await import('/src/lib/api.ts');"
R17="$STATE/remote17.git"
git init -q --bare -b main "$R17"
for d in j17a j17b t17; do
  mkdir -p "$STATE/$d"
  printf '[user]\n\tname = %s\n\temail = %s@example.test\n[init]\n\tdefaultBranch = main\n' "$d" "$d" >"$STATE/$d/.gitconfig"
done
rclick17() {
  local xy; xy=$(ev "(()=>{const e=$1;if(!e)return '';e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()")
  [[ -n "$xy" ]] && "$DC" click $xy >/dev/null
}
ready17() { waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30; sleep 1.5; }
chip17() { ev "(document.querySelector('[data-testid=sync-chip]')?.textContent||'none')"; }
phase17() { ev "(document.querySelector('[data-testid=sync-chip]')?.dataset.phase||'none')"; }
# Titles of every "Getting Started…" page, and every numbered "(n)" title anywhere (Trash too).
gs17_() { ev "(async()=>{$A17 return (await api.listPages(1000)).map(p=>p.title).filter(t=>t.startsWith('Getting Started')).sort().join('|')})()"; }
numbered17_() { ev "(async()=>{$A17 const live=(await api.listPages(1000)).map(p=>p.title);const tr=(await api.listTrash()).map(t=>t.title);return live.concat(tr).filter(t=>/\\(\\d+\\)$/.test(t)).join('|')||'none'})()"; }
# (Retried once: an eval that lands while a sync reopens the page comes back empty.)
gs17() { local r; r=$(gs17_); [[ -n "$r" ]] || { sleep 1.5; r=$(gs17_); }; echo "$r"; }
numbered17() { local r; r=$(numbered17_); [[ -n "$r" ]] || { sleep 1.5; r=$(numbered17_); }; echo "$r"; }
# Sync now, as the user does it (the palette/Settings event), then wait for it to finish.
syncnow17() {
  ev "window.dispatchEvent(new Event('minotes-sync-now'))" >/dev/null; sleep 0.5
  waitfor "!!document.querySelector('[data-testid=sync-chip]') && document.querySelector('[data-testid=sync-chip]').dataset.phase!=='syncing'" 40; sleep 0.8
}
# Turn sync on with the Settings toggle (a real click).
enable17() {
  api "openSettings()" >/dev/null; sleep 0.8
  rclick17 "document.querySelector('[data-testid=sync-enable]')?.closest('label')"
  waitfor "!!document.querySelector('[data-testid=settings-sync-state]')" 40; sleep 0.5
}

step "Device A: a fresh install, sync on, pushing to the remote"
mkdir -p "$STATE/j17a/MiNotes_Sync"
HOME="$STATE/j17a" git -C "$STATE/j17a/MiNotes_Sync" init -q -b main
HOME="$STATE/j17a" git -C "$STATE/j17a/MiNotes_Sync" remote add origin "$R17"
device j17a keep || true
ready17
is "A starts with its Getting Started" "$(gs17)" "Getting Started"
enable17
is "Settings: synced (A reached the remote)" "$(ev "document.querySelector('[data-testid=settings-sync-state]')?.dataset.phase||'none'")|$(ev "String(!!document.querySelector('[data-testid=settings-last-synced]'))")" "idle|true"
api "closePanel()" >/dev/null; sleep 0.5
[[ "$(chip17)" == Synced* ]] && pass "The sidebar chip says $(chip17)" || fail "Chip after the first sync" "$(chip17)"
ev "(async()=>{$A17 const p=await api.createPage('Roadmap17');await api.createBlock(p.id,'Q1 plan');return 1})()" >/dev/null
syncnow17
REMOTE17=$(git --git-dir="$R17" ls-tree -r --name-only main 2>/dev/null | grep -c '^Getting Started\.md$\|^Roadmap17\.md$')
is "The remote has A's Getting Started and Roadmap17" "$REMOTE17" "2"

step "Device B: a fresh install that clones the sync folder and joins"
HOME="$STATE/j17b" git clone -q "$R17" "$STATE/j17b/MiNotes_Sync" 2>/dev/null
device j17b keep || true
ready17
enable17
api "closePanel()" >/dev/null; sleep 0.5
syncnow17
is "B has exactly one Getting Started" "$(gs17)" "Getting Started"
is "…and no numbered copies anywhere, Trash included" "$(numbered17)" "none"
[[ "$(ev "(async()=>{$A17 return (await api.listPages(1000)).map(p=>p.title).join('|')})()")" == *"Roadmap17"* ]] && pass "B has A's notes" || fail "B did not get Roadmap17" "$(ev "(async()=>{$A17 return (await api.listPages(1000)).map(p=>p.title).join('|')})()")"
"$DC" wshot "d17-b-joined" >/dev/null

step "Both devices change the same line: the toast names the page and the device, and Open goes there"
ev "(async()=>{$A17 const t=await api.getPageTree('Roadmap17');await api.updateBlock(t.blocks[0].id,'Q1 plan, edited on B');return 1})()" >/dev/null
device j17a keep || true
ready17
syncnow17
is "A has exactly one Getting Started after B joined" "$(gs17)" "Getting Started"
is "A has no numbered copies either" "$(numbered17)" "none"
ev "(async()=>{$A17 const t=await api.getPageTree('Roadmap17');await api.updateBlock(t.blocks[0].id,'Q1 plan, edited on A');return 1})()" >/dev/null
syncnow17
device j17b keep || true
ready17
# B's own edit is already in its database; this sync brings A's.
syncnow17
waitfor "[...document.querySelectorAll('.minotes-toast')].some(t=>t.textContent.includes('Sync conflict'))" 15
T17=$(ev "([...document.querySelectorAll('.minotes-toast')].find(t=>t.textContent.includes('Sync conflict'))?.textContent||'none')")
"$DC" shot "d17-conflict-toast" >/dev/null
[[ "$T17" == *"Roadmap17"*"(conflict from "* && "$T17" != *"<device>"* ]] && pass "The toast names the page and the copy ($T17)" || fail "Conflict toast text" "$T17"
rclick17 "[...document.querySelectorAll('.minotes-toast')].find(t=>t.textContent.includes('Sync conflict'))?.querySelector('button')"
sleep 1.5
[[ "$(api 'getCurrentPage()')" == "Roadmap17 (conflict from "* ]] && pass "Open shows the conflict copy" || fail "Open did not go to the copy" "$(api 'getCurrentPage()')"

step "The remote is moved away: an error with the reason and Retry — not a grey Offline"
mv "$R17" "$R17.moved"
syncnow17
is "Chip: error" "$(phase17)|$(chip17)" "error|Sync remote not found"
TIP17=$(ev "document.querySelector('[data-testid=sync-chip]')?.title||''")
[[ "$TIP17" == *"Remote not found"* ]] && pass "Its tooltip gives the reason" || fail "Chip tooltip" "$TIP17"
rclick17 "document.querySelector('[data-testid=sync-chip]')"; sleep 0.6
[[ "$(ev "document.querySelector('[data-testid=sync-details]')?.innerText||'none'")" == *"Sync remote not found"*"Retry"* ]] && pass "Clicking it shows the error and Retry" || fail "Chip details" "$(ev "document.querySelector('[data-testid=sync-details]')?.innerText||'none'")"
"$DC" shot "d17-missing-remote" >/dev/null
api "openSettings()" >/dev/null; sleep 0.8
S17=$(ev "document.querySelector('[data-testid=settings-sync-state]')?.innerText||'none'")
[[ "$S17" == *"Sync remote not found"*"Remote not found"*"Retry"* ]] && pass "Settings shows the error, the remote and Retry" || fail "Settings sync error" "$S17"
"$DC" wshot "d17-settings-error" >/dev/null
api "closePanel()" >/dev/null; sleep 0.5
mv "$R17.moved" "$R17"
[[ "$(ev "String(!!document.querySelector('[data-testid=sync-details]'))")" == "true" ]] || { rclick17 "document.querySelector('[data-testid=sync-chip]')"; sleep 0.5; }
rclick17 "document.querySelector('[data-testid=sync-details-retry]')"
waitfor "document.querySelector('[data-testid=sync-chip]')?.dataset.phase==='idle'" 40
[[ "$(chip17)" == Synced* ]] && pass "Retry with the remote back: $(chip17)" || fail "Retry" "$(phase17)|$(chip17)"

step "A notebook with sync on but no remote says so — never \"Last synced\""
device t17 keep || true
ready17
enable17
is "Settings: on, no remote" "$(ev "document.querySelector('[data-testid=settings-sync-state]')?.dataset.phase||'none'")|$(ev "String(!!document.querySelector('[data-testid=settings-last-synced]'))")" "local|false"
api "closePanel()" >/dev/null; sleep 0.5
syncnow17
is "Chip: no remote" "$(chip17)" "Not synced — no remote"
is "Status has no last-synced time" "$(ev "(async()=>{$A17 return String((await api.gitSyncStatus()).last_sync)})()")" "null"

step "A folder synced on another computer: after Not now, Settings says Paused"
F17="$STATE/t17/Incoming/Copied17"
KEY17=$(ev "(async()=>{$A17 const n=await api.createNotebook('Copied17','$F17');return n.key})()")
HOME="$STATE/t17" git -C "$F17/notes" init -q -b main
HOME="$STATE/t17" git -C "$F17/notes" remote add origin "$R17"
mkdir -p "$F17/.minotes"; printf '{"enabled": true, "last_sync": "2026-10-01T09:00:00Z"}\n' >"$F17/.minotes/sync-config.json"
ev "window.__MINOTES__.switchNotebook('$KEY17')" >/dev/null
waitfor "!!document.querySelector('[data-testid=sync-confirm-banner]')" 20 && pass "The trust banner asks" || fail "No trust banner" ""
rclick17 "document.querySelector('[data-testid=sync-decline]')"; sleep 0.8
is "Chip: paused" "$(phase17)|$(chip17)" "paused|Sync paused"
api "openSettings()" >/dev/null; sleep 0.8
P17=$(ev "document.querySelector('[data-testid=settings-sync-state]')?.innerText||'none'")
[[ "$P17" == *"Paused — waiting for your OK"* && "$(ev "String(!!document.querySelector('[data-testid=settings-last-synced]'))")" == "false" ]] \
  && pass "Settings: Paused — waiting for your OK (no other computer's Last synced)" || fail "Settings while paused" "$P17"
"$DC" wshot "d17-paused" >/dev/null
api "closePanel()" >/dev/null; sleep 0.5

step "Ask with a local model server that isn't running: a clear message within seconds, and Retry"
CLOSED17=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
ev "(async()=>{$A17 const s=(await api.aiGetStatus()).settings;s.provider='local';s.local.base_url='http://127.0.0.1:$CLOSED17/v1';s.local.model='test-model';await api.aiSaveSettings(s);return 1})()" >/dev/null
ev "window.dispatchEvent(new CustomEvent('minotes:open-ai',{detail:'ask'}))" >/dev/null
waitfor "!!document.querySelector('[data-testid=ai-input]')" 15
ev "(()=>{const t=document.querySelector('[data-testid=ai-input]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'What is on my roadmap?');t.dispatchEvent(new Event('input',{bubbles:true}));return 1})()" >/dev/null
T0=$SECONDS
rclick17 "document.querySelector('[data-testid=ai-send]')"
waitfor "!!document.querySelector('[data-testid=ai-error]')" 30
TOOK17=$((SECONDS - T0))
E17=$(ev "document.querySelector('[data-testid=ai-error]')?.innerText||'none'")
[[ "$TOOK17" -le 8 ]] && pass "It failed in ${TOOK17}s (was ~15 s)" || fail "Ask took too long to fail" "${TOOK17}s"
[[ "$E17" == *"isn't running"*"Retry"* && "$E17" != *"timeout"* ]] && pass "It says the server isn't running, with Retry" || fail "Ask error text" "$E17"
"$DC" wshot "d17-ask-refused" >/dev/null
rclick17 "document.querySelector('[data-testid=ai-retry]')"; sleep 0.5
waitfor "!!document.querySelector('[data-testid=ai-error]')" 30
is "Retry asks again (one question, one answer slot)" "$(ev "String(document.querySelectorAll('.ai-turn').length)")" "1"
"$DC" press Escape >/dev/null 2>&1; sleep 0.5
fi
journey "D18. Finding my way with real clicks (UX review Wave 2: navigation)"
# Nested projects open by clicking (C-10), the TODO badge's Tasks view writes
# the real block and creates no page (C-8) and removes the old generated page
# once, Prev stays under the pointer across empty days, Manage notebooks keeps
# its rows while renaming, and the native window title follows along.
# Real mouse and keys; WebDriver only sets up and reads back.
# ═══════════════════════════════════════════════
A18="const api=await import('/src/lib/api.ts');"
X18="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
rclick18() {
  local xy; xy=$(ev "(()=>{const e=$1;if(!e)return '';e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()")
  [[ -n "$xy" ]] && "$DC" click $xy >/dev/null
}
wintitle18() { local id; id=$(DISPLAY="$X18" timeout 5 xdotool search --name 'MiNotes$' 2>/dev/null | head -1); [[ -n "$id" ]] && DISPLAY="$X18" timeout 5 xdotool getwindowname "$id" 2>/dev/null; }
shown18() { ev "(async()=>{const e=$1;if(!e)return 'missing';let p=e.parentElement;while(p){if(p.classList&&p.classList.contains('folder-children')&&!p.classList.contains('folder-children-expanded'))return 'hidden';p=p.parentElement}return 'shown'})()"; }
device w18 || true
NB18=$(ev "(async()=>{$A18 return (await api.getNotebookSession()).name})()")

step "I click a project, then its subproject, then the page inside (real mouse)"
ev "(async()=>{$A18 const o=await api.createFolder('Outer18');const i=await api.createFolder('Inner18',o.id);const p=await api.createPage('Deep18 page');await api.createBlock(p.id,'deep18');await api.movePageToFolder(p.id,i.id);window.dispatchEvent(new Event('minotes-sidebar-refresh'));return 1})()" >/dev/null
waitfor "!![...document.querySelectorAll('.folder-item')].find(e=>e.textContent.includes('Outer18'))" 10
rclick18 "[...document.querySelectorAll('.folder-item')].find(e=>e.textContent.includes('Outer18'))"; sleep 0.8
rclick18 "[...document.querySelectorAll('.folder-item')].find(e=>e.textContent.includes('Inner18'))"; sleep 0.8
is "The page two levels down is shown" "$(shown18 "[...document.querySelectorAll('.sidebar .page-item')].find(e=>e.textContent.includes('Deep18 page'))")" "shown"
rclick18 "[...document.querySelectorAll('.sidebar .page-item')].find(e=>e.textContent.includes('Deep18 page'))"
waitfor "window.__MINOTES__.getCurrentPage()==='Deep18 page'" 10
is "…and a click opens it" "$(api 'getCurrentPage()')" "Deep18 page"
"$DC" shot "d18-nested-projects" >/dev/null
is "The native window title names the page and the notebook" "$(wintitle18)" "Deep18 page — $NB18 — MiNotes"

step "The TODO badge opens Tasks; ticking a task (real click) writes the block — no page is made"
ev "(async()=>{$A18 const p=await api.createPage('Tasks18');await api.createBlock(p.id,'TODO water plants18');window.dispatchEvent(new Event('minotes-sidebar-refresh'));return 1})()" >/dev/null; sleep 1
waitfor "!!document.querySelector('[data-testid=todo-badge]')" 10
rclick18 "document.querySelector('[data-testid=todo-badge]')"
waitfor "!![...document.querySelectorAll('[data-testid=task-row]')].find(r=>r.textContent.includes('water plants18'))" 10
is "Window title: Tasks" "$(wintitle18)" "Tasks — $NB18 — MiNotes"
rclick18 "[...document.querySelectorAll('[data-testid=task-row]')].find(r=>r.textContent.includes('water plants18'))?.querySelector('[data-testid=task-toggle]')"
sleep 1.5
is "The block in the database is now DONE" "$(db w18 "select content from blocks where content like '%water plants18%'")" "DONE water plants18"
is "No \"All TODOs\" page exists" "$(db w18 "select count(*) from pages where title='All TODOs'")" "0"
"$DC" shot "d18-tasks-view" >/dev/null
"$DC" key Escape; sleep 0.5

step "An old generated \"All TODOs\" page goes to the Trash on the next start (once)"
ev "(async()=>{$A18 const t=await api.getPageTree('Tasks18');const p=await api.createPage('All TODOs');await api.createBlock(p.id,'{{todo:pending}} [[Tasks18|'+t.page.id+']] water plants18');await api.setUiState('cleanup.all-todos-v1','');return 1})()" >/dev/null
"$DC" restart >/dev/null; waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
waitfor "[...document.querySelectorAll('.minotes-toast')].some(t=>t.innerText.includes('All TODOs'))" 15 \
  && pass "A toast says the generated page was moved to the Trash" || fail "No cleanup toast" "$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.innerText).join('|')")"
is "It is in the Trash (restorable), not deleted" "$(db w18 "select count(*) from trash t join pages p on p.id=t.page_id where p.title='All TODOs'")" "1"
is "The flag is set, so it runs once" "$(db w18 "select value from ui_state where key='cleanup.all-todos-v1'")" "done"

step "Prev stays under the pointer: three real clicks at one spot step back three days"
api "openJournal()" >/dev/null; waitfor "!!document.querySelector('.journal-nav')" 10; sleep 1
XY18=$(ev "(()=>{const b=[...document.querySelectorAll('.journal-nav button')].find(x=>x.textContent.includes('Prev'));const r=b.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()")
DAYS18=""
for n in 1 2 3; do
  "$DC" click $XY18 >/dev/null; sleep 1.2
  DAYS18+="$(ev "document.querySelector('.pending-journal')?.dataset.date||(window.__MINOTES__.getCurrentPage()||'').replace('Journal/','')")|"
done
is "Prev ×3 at the same spot" "$DAYS18" "$(date -d '-1 day' +%F)|$(date -d '-2 day' +%F)|$(date -d '-3 day' +%F)|"
"$DC" shot "d18-empty-day" >/dev/null
is "Window title on an empty day names the date" "$(wintitle18)" "$(ev "new Date($(date -d '-3 day' +%Y),$(( 10#$(date -d '-3 day' +%m) - 1 )),$(( 10#$(date -d '-3 day' +%d) ))).toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})") — $NB18 — MiNotes"
ev "document.activeElement?.blur()" >/dev/null
"$DC" key alt+Down; sleep 1.2
is "Alt+↓ (real key) goes to the next day" "$(ev "document.querySelector('.pending-journal')?.dataset.date||''")" "$(date -d '-2 day' +%F)"

step "Manage notebooks: renaming (real typing) keeps every row in place"
ev "(async()=>{$A18 await api.createNotebook('Bravo18');await api.createNotebook('Charlie18');window.dispatchEvent(new Event('minotes-notebooks-changed'));return 1})()" >/dev/null; sleep 0.5
ev "window.dispatchEvent(new CustomEvent('minotes-open-notebook-dialog',{detail:'manage'}))" >/dev/null
waitfor "!!document.querySelector('[data-testid=manage-notebooks-dialog] .nb-manage-row')" 10
ORDER18=$(ev "[...document.querySelectorAll('[data-testid=manage-notebooks-dialog] .nb-manage-row')].map(r=>r.dataset.notebookKey).join(',')")
CHARLIE18=$(ev "[...document.querySelectorAll('[data-testid=manage-notebooks-dialog] .nb-manage-row')].find(r=>r.textContent.includes('Charlie18'))?.dataset.notebookKey||''")
rclick18 "document.querySelector('[data-testid=manage-notebooks-dialog] [data-notebook-key=\"$CHARLIE18\"] [data-testid=rename-notebook]')"; sleep 0.5
"$DC" key ctrl+a; "$DC" type "Aardvark18"; "$DC" key Return; sleep 1
is "Rows keep their order after the rename" "$(ev "[...document.querySelectorAll('[data-testid=manage-notebooks-dialog] .nb-manage-row')].map(r=>r.dataset.notebookKey).join(',')")" "$ORDER18"
is "…and the renamed row shows its new name" "$(ev "document.querySelector('[data-testid=manage-notebooks-dialog] [data-notebook-key=\"$CHARLIE18\"] .nb-manage-name')?.textContent||''")" "Aardvark18"
"$DC" shot "d18-manage-after-rename" >/dev/null
rclick18 "document.querySelector('[data-testid=manage-notebooks-dialog] [data-notebook-key=\"$CHARLIE18\"] [data-testid=open-notebook]')"
waitfor "!document.querySelector('[data-testid=manage-notebooks-dialog]')" 15; sleep 2
T18=$(wintitle18)
[[ "$T18" == *" — Aardvark18 — MiNotes" ]] && pass "Open switched notebooks; the window title follows ($T18)" || fail "Window title after Open" "$T18"

# ═══════════════════════════════════════════════
journey "D19. One UI system under real input (UX review Wave 3)"
# Real keys and mouse (xdotool): Ctrl+N asks in the app (no GTK prompt), Esc
# closes only the topmost layer, the app's tooltip never covers an open menu,
# a notebook switch shows progress at once and ends with a toast, form
# controls are drawn by the app, the sidebar collapses with its shortcut.
# ═══════════════════════════════════════════════
A19="const api=await import('/src/lib/api.ts');"
X19="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
xy19() { ev "(()=>{const e=$1;if(!e)return '';const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()"; }
rclick19() { local xy; xy=$(xy19 "$1"); [[ -n "$xy" ]] && "$DC" click $xy >/dev/null; }
gtkdialogs19() { DISPLAY="$X19" timeout 5 xdotool search --name 'JavaScript' 2>/dev/null | wc -l; }
device w19 || true
api "navigateTo('Getting Started')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Getting Started'" 10
S19=$(date +%s)

step "Ctrl+N (real key) opens the New page field — no native prompt; typing + Enter creates the page"
rclick19 "document.querySelector('.main-header h2, .main-header')"; sleep 0.3
"$DC" key ctrl+n; sleep 0.8
is "No GTK 'JavaScript' dialog window" "$(gtkdialogs19)" "0"
is "The in-app field has the focus" "$(ev "document.activeElement?.getAttribute('data-testid')||''")" "new-page-field"
"$DC" type "Real19 $S19"; "$DC" key Return; sleep 1.5
is "The page is in the database" "$(db w19 "select count(*) from pages where title='Real19 $S19'")" "1"
"$DC" shot "d19-ctrl-n" >/dev/null

step "Esc (real key) closes only the topmost layer: Settings over the graph, then the graph"
"$DC" key Escape; sleep 0.3
"$DC" key ctrl+g; waitfor "!!document.querySelector('.graph-view')" 10
"$DC" key ctrl+comma; waitfor "!!document.querySelector('.settings-slide-panel')" 10
"$DC" key Escape; sleep 0.6
is "First Esc: Settings closed, graph open" "$(ev "!!document.querySelector('.settings-slide-panel')+'|'+!!document.querySelector('.graph-view')")" "false|true"
"$DC" key Escape; sleep 0.6
is "Second Esc: the graph closed" "$(ev "!!document.querySelector('.graph-view')")" "false"

step "The app's tooltip shows on a real hover and never over the page menu once it is open"
api "navigateTo('Real19 $S19')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Real19 $S19'" 10; sleep 0.5
XY=$(xy19 "document.querySelector('.sidebar .page-item.active .page-more-btn, .sidebar .page-more-btn')")
DISPLAY="$X19" xdotool mousemove 400 400
sleep 0.3; DISPLAY="$X19" xdotool mousemove $XY; sleep 1.2
is "Hover: the app's tooltip names the action" "$(ev "document.querySelector('.app-tooltip.visible')?.textContent||'none'")" "Page actions (Shift+F10)"
is "…and no title is left on it or its row (the platform would draw its own)" "$(ev "(()=>{let n=document.querySelector('.sidebar .page-item.active .page-more-btn, .sidebar .page-more-btn');while(n&&n!==document.body){if(n.hasAttribute('title'))return 'title on '+n.className;n=n.parentElement}return 'none'})()")" "none"
"$DC" shot "d19-tooltip" >/dev/null
"$DC" click $XY >/dev/null; sleep 0.6
DISPLAY="$X19" xdotool mousemove_relative 1 0; sleep 1.2
is "Menu open: no tooltip" "$(ev "!!document.querySelector('.sidebar-context-menu')+'|'+(document.querySelector('.app-tooltip.visible')?.textContent||'none')")" "true|none"
"$DC" shot "d19-menu-no-tooltip" >/dev/null
"$DC" key Escape; sleep 0.4
is "Esc closed the menu" "$(ev "!!document.querySelector('.sidebar-context-menu')")" "false"

step "Opening another notebook from the switcher (real clicks): busy at once, a toast when done"
HOME19=$(ev "(async()=>{$A19 return (await api.getNotebookSession()).key})()")
OTHER19=$(ev "(async()=>{$A19 const n=await api.createNotebook('Other19');return n.key})()")
ev "window.dispatchEvent(new Event('minotes-notebooks-changed'))" >/dev/null; sleep 0.8
ev "(()=>{window.__busy19=null;const t0={v:0};document.addEventListener('pointerdown',()=>{t0.v=performance.now()},true);const mo=new MutationObserver(()=>{if(window.__busy19===null&&document.querySelector('[data-testid=busy]'))window.__busy19=Math.round(performance.now()-t0.v)});mo.observe(document.body,{childList:true,subtree:true});return 1})()" >/dev/null
rclick19 "document.querySelector('[data-testid=notebook-switcher]')"; sleep 0.6
rclick19 "[...document.querySelectorAll('.nb-menu [role=menuitem], .nb-menu button')].find(b=>b.textContent.includes('Other19'))"
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Other19')" 20
B19=$(ev "String(window.__busy19)")
[[ "$B19" =~ ^[0-9]+$ && "$B19" -lt 100 ]] && pass "Busy pill $B19 ms after the click" || fail "Busy state on switch" "$B19"
waitfor "[...document.querySelectorAll('.minotes-toast')].some(t=>t.textContent.includes('Opened “Other19”'))" 10 \
  && pass "Toast: Opened “Other19”" || fail "Switch toast" "$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' ¦ ')")"
is "No busy state left" "$(ev "!!document.querySelector('[data-testid=busy]')")" "false"
ev "window.__MINOTES__.switchNotebook('$HOME19')" >/dev/null; waitfor "!document.querySelector('[data-testid=busy]')" 20; sleep 1

step "Form controls are the app's own in WebKitGTK (dark theme): the Theme select and a checkbox"
"$DC" key ctrl+comma; waitfor "!!document.querySelector('.settings-slide-panel')" 10
R=$(ev "(()=>{const s=document.querySelector('.settings-slide-panel select');const cs=getComputedStyle(s);const root=getComputedStyle(document.documentElement);return cs.webkitAppearance+'|'+(cs.color.replace(/\\s/g,'')!=='rgb(0,0,0)')+'|'+(cs.backgroundColor!=='rgb(255,255,255)')})()")
is "Select: appearance none, theme colours" "$R" "none|true|true"
"$DC" shot "d19-settings-select" >/dev/null
"$DC" key Escape; sleep 0.4

step "Ctrl+Shift+\\ (real key) hides the sidebar; it stays hidden after a restart; again shows it"
"$DC" key ctrl+shift+backslash; sleep 0.6
is "Hidden" "$(ev "document.querySelector('.sidebar').getClientRects().length")" "0"
"$DC" restart >/dev/null; waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30; sleep 1
is "Still hidden after a restart (remembered on this device)" "$(ev "document.querySelector('.sidebar')?.getClientRects().length")" "0"
"$DC" shot "d19-sidebar-hidden" >/dev/null
"$DC" key ctrl+shift+backslash; sleep 0.6
is "Shown again" "$(ev "document.querySelector('.sidebar').getClientRects().length>0")" "true"

# ═══════════════════════════════════════════════
journey "D23. The visual views under a real mouse and keyboard (UX review Wave 4)"
# Real X input (xdotool): the local graph, its search and arrow keys; a kanban
# card dragged to DONE (the task line changes in the database) and edited in
# the card panel; Ctrl+click on a link in a mind map node; a whiteboard arrow
# that stays on its box when the box moves, rubber-band selection, Delete and
# Ctrl+Z; the image lightbox; a link preview converted to a plain link.
# ═══════════════════════════════════════════════
A23="const api=await import('/src/lib/api.ts');"
X23="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
xy23() { ev "(()=>{const e=$1;if(!e)return '';const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()"; }
rclick23() { local xy; xy=$(xy23 "$1"); [[ -n "$xy" ]] && "$DC" click $xy >/dev/null; }
# Real drag: press at (x0,y0), move in small steps, release at (x1,y1).
rdrag23() {
  local x0=$1 y0=$2 x1=$3 y1=$4 n=${5:-12}
  DISPLAY="$X23" xdotool mousemove "$x0" "$y0" mousedown 1; sleep 0.15
  for i in $(seq 1 "$n"); do DISPLAY="$X23" xdotool mousemove $((x0+(x1-x0)*i/n)) $((y0+(y1-y0)*i/n)); sleep 0.05; done
  sleep 0.15; DISPLAY="$X23" xdotool mouseup 1; sleep 0.4
}
device w23 || true
api "navigateTo('Getting Started')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Getting Started'" 10
S23=$(date +%s)
ev "localStorage.removeItem('minotes-graph-local');localStorage.removeItem('minotes-graph-color-by')" >/dev/null

step "Graph: Local (real click) shows only this page's neighbours; typed search + Enter; arrow keys; Enter opens"
ev "(async()=>{$A23 const ps=[];for(let i=0;i<12;i++)ps.push(await api.createPage('D23g$S23 p'+i));for(let i=1;i<12;i++)await api.createBlock(ps[i].id,'next to [[D23g$S23 p'+(i-1)+']]');return 1})()" >/dev/null
api "navigateTo('D23g$S23 p5')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='D23g$S23 p5'" 10; sleep 0.5
"$DC" key Escape; "$DC" key ctrl+g; waitfor "!!document.querySelector('.graph-view canvas')?.dataset.nodes" 15
rclick23 "document.querySelector('.graph-local-btn')"; sleep 1
is "Local graph: p4, p5, p6" "$(ev "(()=>{const c=document.querySelector('.graph-view canvas');return c.dataset.nodes+'|'+c.__minotesGraph.nodes().map(n=>n.title.split(' ').pop()).sort().join(',')+'|'+(c.dataset.current===c.__minotesGraph.nodes().find(n=>n.current)?.id)})()")" "3|p4,p5,p6|true"
rclick23 "document.querySelector('.graph-search-input')"; "$DC" type "p6"; sleep 0.4; "$DC" key Return; sleep 0.5
is "Typed 'p6' + Enter: p6 is the keyboard's node, the graph has focus" "$(ev "(()=>{const c=document.querySelector('.graph-view canvas');return c.dataset.matches+'|'+(c.__minotesGraph.nodes().find(n=>n.id===c.dataset.selected)?.title.split(' ').pop())+'|'+(document.activeElement===c)})()")" "1|p6|true"
MOVED23=""
for k in Left Right Up Down; do
  "$DC" key "$k"; sleep 0.3
  T=$(ev "(()=>{const c=document.querySelector('.graph-view canvas');return c.__minotesGraph.nodes().find(n=>n.id===c.dataset.selected)?.title||''})()")
  [[ "$T" == *" p5" ]] && { MOVED23="$T"; break; }
done
[[ -n "$MOVED23" ]] && pass "Arrow key $k moved to the linked page p5" || fail "Graph arrow keys" "selected=$T"
"$DC" shot "d23-graph-local" >/dev/null
"$DC" key Return; sleep 1.5
is "Enter opened it (graph closed)" "$(ev "!!document.querySelector('.graph-view')+'|'+window.__MINOTES__.getCurrentPage()")" "false|D23g$S23 p5"
ev "localStorage.removeItem('minotes-graph-local')" >/dev/null

step "Kanban: Status (real click), then a real drag of the DOING card onto DONE changes the task in the database"
R=$(ev "(async()=>{$A23 const p=await api.createPage('D23k$S23');const h=await api.createBlock(p.id,'## Work');await api.createBlock(p.id,'TODO Write23 the plan',h.id);const b=await api.createBlock(p.id,'DOING Build23 it',h.id);return b.id})()")
B23="$R"
api "navigateTo('D23k$S23')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='D23k$S23'" 10; sleep 0.5
"$DC" key Escape; "$DC" key ctrl+shift+k; waitfor "!!document.querySelector('.kanban-container')" 10; sleep 0.5
rclick23 "document.querySelector('[data-testid=kanban-group-status]')"; waitfor "!!document.querySelector('.kanban-column[data-status=done]')" 10; sleep 0.5
FROM=$(xy23 "[...document.querySelectorAll('.kanban-card')].find(c=>c.textContent.includes('Build23'))")
TO=$(xy23 "document.querySelector('.kanban-column[data-status=done] .kanban-column-body, .kanban-column[data-status=done]')")
rdrag23 $FROM $TO 20; sleep 1.5
is "Dragged card: the block now reads DONE" "$(db w23 "select content from blocks where id='$B23'")" "DONE Build23 it"
is "…and it sits in the DONE column" "$(ev "!![...document.querySelectorAll('.kanban-column[data-status=done] .kanban-card')].find(c=>c.textContent.includes('Build23'))")" "true"
"$DC" shot "d23-kanban-status" >/dev/null

step "Card panel (real right-click → Open): typing in its block editor saves the card"
XY=$(xy23 "[...document.querySelectorAll('.kanban-card')].find(c=>c.textContent.includes('Write23'))")
DISPLAY="$X23" xdotool mousemove $XY click 3; sleep 0.6
rclick23 "[...document.querySelectorAll('.kanban-ctx-menu button')].find(b=>b.textContent==='Open')"; waitfor "!!document.querySelector('.kanban-card-panel .ProseMirror')" 10; sleep 0.5
rclick23 "document.querySelector('.kanban-card-panel .kanban-card-editor-rich .ProseMirror')"; sleep 0.3
"$DC" key End; "$DC" type " edited23"; sleep 0.3
"$DC" key Escape; sleep 1.5
is "Card saved through the panel editor" "$(db w23 "select content from blocks where content like '%Write23%'")" "TODO Write23 the plan edited23"
rclick23 "[...document.querySelectorAll('.kanban-card-panel .kanban-status-opt')].find(b=>b.textContent==='DONE')"; sleep 1.5
is "Status control (real click): DONE" "$(db w23 "select content from blocks where content like '%Write23%'")" "DONE Write23 the plan edited23"
"$DC" shot "d23-card-panel" >/dev/null
"$DC" key Escape; sleep 0.4; rclick23 "document.querySelector('.canvas-back-btn')"; sleep 0.6

step "Mind map: Ctrl+click (real) on a [[link]] in a node opens that page"
ev "(async()=>{$A23 const p=await api.createPage('D23m$S23');const a=await api.createBlock(p.id,'Idea23 see [[Getting Started]]');await api.createBlock(p.id,'Detail23',a.id);return 1})()" >/dev/null
api "navigateTo('D23m$S23')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='D23m$S23'" 10; sleep 0.5
"$DC" key Escape; "$DC" key ctrl+m; waitfor "!!document.querySelector('.mm-link')" 15; sleep 1.5
# The link may wrap: aim at its first line box, not the middle of its bounding box.
XY=$(ev "(()=>{const r=document.querySelector('.mm-link').getClientRects()[0];return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()")
DISPLAY="$X23" xdotool mousemove $XY keydown ctrl click 1 keyup ctrl; sleep 1.5
is "Ctrl+click opened Getting Started, the map closed" "$(ev "!!document.querySelector('.mindmap-overlay')+'|'+window.__MINOTES__.getCurrentPage()")" "false|Getting Started"

step "Whiteboard (real mouse): an arrow from box to box stays attached when the box moves"
ev "(async()=>{$A23 const p=await api.createPage('D23w$S23');await api.createBlock(p.id,'Board below');return 1})()" >/dev/null
api "navigateTo('D23w$S23')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='D23w$S23'" 10; sleep 0.5
"$DC" key Escape; "$DC" key ctrl+shift+w; waitfor "!!document.querySelector('.whiteboard-canvas')" 10; sleep 0.8
CV=$(ev "(()=>{const r=document.querySelector('.whiteboard-canvas').getBoundingClientRect();return Math.round(r.left)+' '+Math.round(r.top)})()")
read -r CX CY <<< "$CV"
tool23() { rclick23 "[...document.querySelectorAll('.whiteboard-toolbar button')].find(b=>b.textContent==='$1')"; sleep 0.3; }
tool23 Box
rdrag23 $((CX+100)) $((CY+100)) $((CX+220)) $((CY+190))
rdrag23 $((CX+420)) $((CY+260)) $((CX+540)) $((CY+350))
tool23 Arrow
rdrag23 $((CX+160)) $((CY+145)) $((CX+480)) $((CY+305))
tool23 Select
BOARD23="document.querySelector('.whiteboard').__minotesBoard"
is "Arrow attached to both boxes" "$(ev "(()=>{const d=$BOARD23.data();const a=d.arrows[0];return d.boxes.length+'|'+!!(a&&a.from&&a.to&&a.to.id===d.boxes[1].id)})()")" "2|true"
rdrag23 $((CX+530)) $((CY+340)) $((CX+530)) $((CY+540))
sleep 1
R=$(ev "(()=>{const d=$BOARD23.data();const a=d.arrows[0],b=d.boxes[1];return Math.round(b.y)+'|'+(a.x2>=b.x-5&&a.x2<=b.x+b.width+5&&a.y2>=b.y-5&&a.y2<=b.y+b.height+5)+'|'+(a.to&&a.to.id===b.id)})()")
IFS='|' read -r BY ON ST <<< "$R"
[[ "$BY" -ge 400 && "$ON" == "true" && "$ST" == "true" ]] 2>/dev/null && pass "Box dragged down (y=$BY); the arrow end is still on its border" || fail "Connector after a real drag" "$R"
"$DC" shot "d23-whiteboard-connector" >/dev/null

step "Rubber band (real drag on empty canvas) selects both boxes and the arrow; Delete, then Ctrl+Z (real keys)"
rdrag23 $((CX+40)) $((CY+40)) $((CX+640)) $((CY+640))
is "3 selected" "$(ev "$BOARD23.selection().length+'|'+(document.querySelector('[data-testid=wb-multi]')?.textContent||'')" )" "3|3 selected Delete"
"$DC" key Delete; sleep 0.6
is "Delete removed all three" "$(ev "(()=>{const d=$BOARD23.data();return d.boxes.length+'|'+d.arrows.length})()")" "0|0"
"$DC" key ctrl+z; sleep 0.8
is "Ctrl+Z brought them back (the page's undo didn't run instead)" "$(ev "(()=>{const d=$BOARD23.data();return d.boxes.length+'|'+d.arrows.length})()")" "2|1"
"$DC" key Escape; sleep 0.3; "$DC" key Escape; sleep 1

step "Image lightbox: a real click on an image opens it large; Esc (real) closes it"
ev "(async()=>{$A23 const c=document.createElement('canvas');c.width=320;c.height=160;const x=c.getContext('2d');x.fillStyle='#1e66f5';x.fillRect(0,0,320,160);const b=await new Promise(r=>c.toBlob(r,'image/png'));const a=await api.storeAttachment('d23.png','image/png',new Uint8Array(await b.arrayBuffer()));const p=await api.createPage('D23i$S23');await api.createBlock(p.id,'Intro23');await api.createBlock(p.id,'![d23 pic|240](attachment:'+a.hash+'/d23.png)');return 1})()" >/dev/null
api "navigateTo('D23i$S23')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='D23i$S23'" 10; sleep 1
"$DC" key Escape; sleep 0.3
waitfor "!!document.querySelector('.block-static img[data-width]')?.naturalWidth" 10
is "Rendered 240 px wide from ![…|240]" "$(ev "Math.round(document.querySelector('.block-static img[data-width]')?.getBoundingClientRect().width||0)")" "240"
rclick23 "document.querySelector('.block-static img[data-width]')"; sleep 0.8
is "Lightbox open with the image" "$(ev "!!document.querySelector('[data-testid=lightbox] .lightbox-img')?.naturalWidth+'|'+(document.querySelector('[data-testid=lightbox] .lightbox-caption')?.textContent||'')")" "true|d23 pic"
"$DC" shot "d23-lightbox" >/dev/null
"$DC" key Escape; sleep 0.6
is "Esc closed it; the page is still open" "$(ev "!!document.querySelector('[data-testid=lightbox]')+'|'+window.__MINOTES__.getCurrentPage()")" "false|D23i$S23"

step "Link preview: Convert to a plain link (real hover + click)"
R=$(ev "(async()=>{$A23 const p=await api.createPage('D23l$S23');await api.createBlock(p.id,'Reading');const b=await api.createBlock(p.id,'{{link-preview:https://d23.invalid/article}}');return b.id})()")
L23="$R"
api "navigateTo('D23l$S23')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='D23l$S23'" 10
waitfor "['loaded','failed'].includes(document.querySelector('.link-preview-card')?.dataset.previewState)" 15
XY=$(xy23 "document.querySelector('.link-preview-card')"); DISPLAY="$X23" xdotool mousemove $XY; sleep 0.5
rclick23 "document.querySelector('.link-preview-convert')"; sleep 1.5
is "The block is now a plain link" "$(db w23 "select content from blocks where id='$L23'")" "<https://d23.invalid/article>"
is "…shown as a link, not a card" "$(ev "!!document.querySelector('.link-preview-card')+'|'+!![...document.querySelectorAll('a')].find(a=>a.href==='https://d23.invalid/article')")" "false|true"
"$DC" shot "d23-link-converted" >/dev/null
journey "D20. Sync set up, joined and resolved entirely in the app (UX review Wave 4)"
# Device A types a remote address in Settings → Sync & Backup, tests a wrong
# and a right one, and sets sync up (init + first push). Device B joins through
# "Join an existing notebook…". Both change the same two lines; the conflict
# copy's banner opens Compare, where Keep both / Keep theirs resolve it — the
# database and the other device follow. Real typing and clicks (xdotool);
# WebDriver reads back. The remote is a local bare repository inside both
# scratch homes (B's home is a folder of A's), so it is typed, never picked.
# ═══════════════════════════════════════════════
if command -v git >/dev/null; then
A20="const api=await import('/src/lib/api.ts');"
HB20="d20a/devB"                       # device B's profile (its HOME is inside A's)
R20="$STATE/$HB20/Repos/notes20.git"
DBB20="$STATE/$HB20/MiNotes/Joined20/notebook.minotes"
HOST20=$(hostname)
xy20() { ev "(()=>{const e=$1;if(!e)return '';e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()"; }
rclick20() { local xy; xy=$(xy20 "$1"); [[ -n "$xy" ]] && "$DC" click $xy >/dev/null; }
# typein20 <css> <text>: click the field, select all, type (real keys).
typein20() { rclick20 "document.querySelector('$1')"; sleep 0.2; "$DC" key ctrl+a; "$DC" type "$2"; sleep 0.3; }
ready20() { waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 40; sleep 1.5; }
phase20() { ev "(document.querySelector('[data-testid=sync-chip]')?.dataset.phase||'none')"; }
idle20() { sleep 1; waitfor "!document.querySelector('[data-testid=sync-chip]') || document.querySelector('[data-testid=sync-chip]').dataset.phase!=='syncing'" 60; sleep 1; }
syncnow20() { ev "window.dispatchEvent(new Event('minotes-sync-now'))" >/dev/null; sleep 0.5; idle20; }
order20() { sqlite3 "$1" "select group_concat(content,' | ') from (select content from blocks where page_id=(select id from pages where title='Plan20') and parent_id is null order by position)" 2>&1; }
result20() { ev "(()=>{const r=document.querySelector('[data-testid=$1-result]');return r?r.dataset.status+'|'+r.innerText.replace(/\\n/g,' '):''})()"; }
DBA20="$STATE/d20a/.minotes/default.db"

step "Device A: a page, then Settings → Sync & Backup with a typed address"
device d20a || { sleep 2; device d20a; } || true
ready20
mkdir -p "$STATE/$HB20/Repos"
git init -q --bare -b main "$R20"
for h in d20a "$HB20"; do printf '[user]\n\tname = %s\n\temail = d20@example.test\n[init]\n\tdefaultBranch = main\n' "${h##*/}" >"$STATE/$h/.gitconfig"; done
ev "(async()=>{$A20 const p=await api.createPage('Plan20');await api.createBlock(p.id,'alpha base');await api.createBlock(p.id,'beta base');await api.createBlock(p.id,'gamma steady');return 1})()" >/dev/null
api "openSettings()" >/dev/null; sleep 0.8
rclick20 "[...document.querySelectorAll('.settings-index-link')].find(b=>b.textContent.includes('Sync'))"; sleep 0.8
is "No remote yet: the Set up form" "$(ev "String(!!document.querySelector('[data-testid=sync-setup]'))")" "true"

step "Test connection on a wrong address (real typing): Not found — nothing set"
typein20 "[data-testid=sync-remote-input]" "~/devB/Repos/nothere20.git"
rclick20 "document.querySelector('[data-testid=sync-remote-test]')"
waitfor "!!document.querySelector('[data-testid=sync-remote-result]')" 30
R=$(result20 sync-remote)
[[ "$R" == not_found*"Not found"* ]] && pass "Wrong address: $R" || fail "Test connection (wrong)" "$R"
typein20 "[data-testid=sync-remote-input]" "ext::sh -c touch% $STATE/pwned20"
rclick20 "document.querySelector('[data-testid=sync-remote-test]')"
waitfor "!!document.querySelector('[data-testid=sync-remote-result]')" 30
R=$(result20 sync-remote)
[[ "$R" == invalid*"run a program"* && ! -e "$STATE/pwned20" ]] && pass "ext:: refused, nothing ran" || fail "ext:: address" "$R"
"$DC" shot "d20-test-wrong" >/dev/null

step "Test connection on the right one: an empty repository — then Set up sync pushes the notebook"
typein20 "[data-testid=sync-remote-input]" "~/devB/Repos/notes20.git"
rclick20 "document.querySelector('[data-testid=sync-remote-test]')"
waitfor "!!document.querySelector('[data-testid=sync-remote-result]')" 30
R=$(result20 sync-remote)
[[ "$R" == empty*"Reachable"* ]] && pass "Right address: $R" || fail "Test connection (right)" "$R"
rclick20 "document.querySelector('[data-testid=sync-setup]')"
waitfor "!!document.querySelector('[data-testid=sync-remote-url]')" 60; idle20
R=$(ev "document.querySelector('[data-testid=sync-remote-url]')?.textContent||'none'")
[[ "$R" == "$R20" ]] && pass "Remote set: $R" || fail "Remote after Set up sync" "$R (want $R20)"
is "Sync is on" "$(ev "String(document.querySelector('[data-testid=sync-enable]')?.checked)")" "true"
FILES20=$(git --git-dir="$R20" ls-tree -r --name-only main 2>/dev/null | grep -c '^Plan20\.md$')
is "The first push reached the remote (Plan20.md)" "$FILES20" "1"
[[ "$(ev "document.querySelector('[data-testid=sync-chip]')?.textContent||''")" == Synced* ]] && pass "Chip: $(ev "document.querySelector('[data-testid=sync-chip]')?.textContent")" || fail "Chip after setup" "$(phase20)"
"$DC" shot "d20-set-up" >/dev/null
api "closePanel()" >/dev/null; sleep 0.4
PID20=$(sqlite3 "$DBA20" "select id from pages where title='Plan20'")

step "Device B joins through the notebook menu (real clicks and typing)"
device "$HB20" keep || true   # keep: the remote lives in this home
ready20
rclick20 "document.querySelector('[data-testid=notebook-switcher]')"; sleep 0.5
rclick20 "document.querySelector('[data-testid=menu-join]')"
waitfor "!!document.querySelector('[data-testid=join-notebook-dialog]')" 10
typein20 "[data-testid=join-remote-input]" "~/Repos/notes20.git"
rclick20 "document.querySelector('[data-testid=join-remote-test]')"
waitfor "!!document.querySelector('[data-testid=join-remote-result]')" 30
R=$(result20 join-remote)
[[ "$R" == reachable*"already holds notes"* ]] && pass "Test connection in Join: $R" || fail "Join: test connection" "$R"
typein20 "[data-testid=join-name]" "Joined20"
"$DC" shot "d20-join-dialog" >/dev/null
rclick20 "document.querySelector('[data-testid=join-go]')"
waitfor "!document.querySelector('[data-testid=join-notebook-dialog]')" 90; idle20
is "B is in Joined20" "$(ev "(document.querySelector('[data-testid=notebook-switcher]')?.textContent||'').includes('Joined20')")" "true"
is "Plan20 arrived with A's page id" "$(sqlite3 "$DBB20" "select id from pages where title='Plan20'" 2>&1)" "$PID20"
is "…with its blocks" "$(order20 "$DBB20")" "alpha base | beta base | gamma steady"
is "One Getting Started (A's)" "$(sqlite3 "$DBB20" "select count(*) from pages where title like 'Getting Started%'" 2>&1)" "1"
[[ "$(ev "document.querySelector('[data-testid=sync-chip]')?.textContent||''")" == Synced* ]] && pass "B syncs: $(ev "document.querySelector('[data-testid=sync-chip]')?.textContent")" || fail "B's chip after join" "$(phase20)"
is "No “Sync it here” question (set up here)" "$(ev "String(!!document.querySelector('[data-testid=sync-confirm-banner]'))")" "false"

step "Both change the same two lines: A first (not yet synced), then B (synced)"
device d20a keep || true
ready20; idle20
ev "(async()=>{$A20 const t=await api.getPageTree('Plan20');await api.updateBlock(t.blocks[0].id,'alpha by A');await api.updateBlock(t.blocks[1].id,'beta by A');return 1})()" >/dev/null
sleep 1
device "$HB20" keep || true
ready20; idle20
ev "(async()=>{$A20 const t=await api.getPageTree('Plan20');await api.updateBlock(t.blocks[0].id,'alpha by B');await api.updateBlock(t.blocks[1].id,'beta by B');return 1})()" >/dev/null
syncnow20
git --git-dir="$R20" show main:Plan20.md 2>/dev/null | grep -q "alpha by B" && pass "B's version is on the remote" || fail "B's push" "$(git --git-dir="$R20" show main:Plan20.md 2>&1 | head -5)"

step "A syncs on start: a conflict copy named after the other device; its banner opens Compare"
device d20a keep || true
ready20; idle20
waitfor "[...document.querySelectorAll('.minotes-toast')].some(t=>t.textContent.includes('Sync conflict'))" 30
COPY20=$(sqlite3 "$DBA20" "select title from pages where title like 'Plan20 (conflict from %' and id not in (select page_id from trash)")
is "Conflict copy" "$COPY20" "Plan20 (conflict from $HOST20)"
is "A's page kept A's lines" "$(order20 "$DBA20")" "alpha by A | beta by A | gamma steady"
rclick20 "[...document.querySelectorAll('.minotes-toast')].find(t=>t.textContent.includes('Sync conflict'))?.querySelector('button')"
waitfor "!!document.querySelector('[data-testid=conflict-banner]')" 15
R=$(ev "document.querySelector('[data-testid=conflict-banner]')?.innerText.replace(/\\n/g,' ')||'none'")
[[ "$R" == "Conflict with $HOST20"*"Compare"* ]] && pass "Banner: Conflict with $HOST20 — Compare" || fail "Conflict banner" "$R"
"$DC" shot "d20-conflict-banner" >/dev/null
rclick20 "document.querySelector('[data-testid=conflict-compare-open]')"
waitfor "!!document.querySelector('[data-testid=conflict-rows]')" 15
R=$(ev "[...document.querySelectorAll('[data-testid=conflict-rows] > li')].map(r=>[...r.querySelectorAll('.conflict-version')].map(v=>v.textContent).join(' => ')).join(' ## ')")
is "Only the two changed blocks, side by side" "$R" "alpha by A => alpha by B ## beta by A => beta by B"
"$DC" shot "d20-compare" >/dev/null

step "Keep both for the first, Keep theirs for the second, Resolve (real clicks)"
rclick20 "document.querySelector('[data-testid=conflict-choice-0-both]')"; sleep 0.2
rclick20 "document.querySelector('[data-testid=conflict-choice-1-theirs]')"; sleep 0.2
rclick20 "document.querySelector('[data-testid=conflict-resolve]')"
waitfor "!document.querySelector('[data-testid=conflict-compare]')" 15; sleep 1
is "A's page in the database" "$(order20 "$DBA20")" "alpha by A | alpha by B | beta by B | gamma steady"
is "The copy is in the Trash" "$(sqlite3 "$DBA20" "select count(*) from trash t join pages p on p.id=t.page_id where p.title like 'Plan20 (conflict from %'")" "1"
is "It shows the page" "$(ev "window.__MINOTES__.getCurrentPage()")" "Plan20"
syncnow20

step "Device B gets the resolution"
device "$HB20" keep || true
ready20; idle20
is "B's page in the database" "$(order20 "$DBB20")" "alpha by A | alpha by B | beta by B | gamma steady"
is "No live conflict copy on B" "$(sqlite3 "$DBB20" "select count(*) from pages where title like 'Plan20 (conflict from %' and id not in (select page_id from trash)")" "0"
"$DC" shot "d20-b-resolved" >/dev/null
fi
journey "D21. Finding my way back, and acting on many pages at once (UX review Wave 4: navigation)"
# Real keys and mouse (xdotool): the Back arrow, Ctrl+[ / Ctrl+], the mouse's
# back/forward buttons, Back across a notebook switch made from the palette, a
# typo in search, a palette command, All Pages bulk move and Trash multi-restore
# with real clicks — checked in the database.
# ═══════════════════════════════════════════════
A21="const api=await import('/src/lib/api.ts');"
X21="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
xy21() { ev "(()=>{const e=$1;if(!e)return '';e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()"; }
rclick21() { local xy; xy=$(xy21 "$1"); [[ -n "$xy" ]] && "$DC" click $xy >/dev/null; }
cur21() { api "getCurrentPage()"; }
nb21() { ev "(async()=>{$A21 return (await api.getNotebookSession()).name})()"; }
row21() { echo "[...document.querySelectorAll('.sidebar .page-item')].find(e=>e.textContent.replace(/⋮/g,'').trim()==='$1')"; }
device w21 || true
ev "(async()=>{$A21 for(const t of ['Nav21 A','Nav21 B','Roadmap21']){const p=await api.createPage(t);await api.createBlock(p.id,'text of '+t)}await api.createFolder('Proj21');for(const t of ['Bin21 one','Bin21 two','Bin21 three']){const p=await api.createPage(t);await api.createBlock(p.id,'line of '+t);await api.trashPage(p.id)}const o=await api.createNotebook('Other21');window.dispatchEvent(new Event('minotes-sidebar-refresh'));window.dispatchEvent(new Event('minotes-notebooks-changed'));return 1})()" >/dev/null; sleep 1.5
api "navigateTo('Nav21 A')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 A'" 10; sleep 0.5
HOME21=$(nb21)

step "Real clicks: A → B in the sidebar, then the Back arrow; Ctrl+] and Ctrl+[ (real keys)"
rclick21 "$(row21 'Nav21 B')"; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 B'" 10
rclick21 "document.querySelector('[data-testid=tab-back]')"; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 A'" 10
is "Back arrow → Nav21 A" "$(cur21)" "Nav21 A"
"$DC" shot "d21-back-arrow" >/dev/null
"$DC" key ctrl+bracketright; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 B'" 10
is "Ctrl+] → Nav21 B" "$(cur21)" "Nav21 B"
"$DC" key ctrl+bracketleft; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 A'" 10
is "Ctrl+[ → Nav21 A" "$(cur21)" "Nav21 A"

step "The mouse's forward / back buttons (X buttons 9 / 8)"
XY=$(xy21 "document.querySelector('.main')")
DISPLAY="$X21" xdotool mousemove $XY click 9; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 B'" 8
is "Forward button → Nav21 B" "$(cur21)" "Nav21 B"
DISPLAY="$X21" xdotool mousemove $XY click 8; waitfor "window.__MINOTES__.getCurrentPage()==='Nav21 A'" 8
is "Back button → Nav21 A" "$(cur21)" "Nav21 A"

step "Switch notebooks from the palette (real typing), then Ctrl+[ comes back"
rclick21 "document.querySelector('.main-header h2, .main-header')"; sleep 0.3
"$DC" key Escape; sleep 0.2
"$DC" key ctrl+k; waitfor "!!document.querySelector('.command-palette-input')" 10
"$DC" type ">swtich notebok"; sleep 0.6
is "Typo still finds Switch Notebook…" "$(ev "document.querySelector('[data-testid=palette-command]')?.dataset.commandId||'none'")" "switch-notebook"
"$DC" key Return; waitfor "document.querySelectorAll('[data-testid=palette-pick-item]').length>0" 10
"$DC" type "Other21"; sleep 0.4; "$DC" key Return
waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('Other21')" 20
is "Now in Other21" "$(nb21)" "Other21"
"$DC" key ctrl+bracketleft
waitfor "window.__MINOTES__?.getCurrentPage?.()==='Nav21 A'" 20
is "Ctrl+[ → back in the first notebook at Nav21 A" "$(nb21)|$(cur21)" "$HOME21|Nav21 A"
# Whatever Back did, the rest of the journey needs the first notebook (a failure above must not cascade).
if [[ "$(nb21)" != "$HOME21" ]]; then
  ev "(async()=>{$A21 const n=(await api.listNotebooks()).find(x=>x.name==='$HOME21');await window.__MINOTES__.switchNotebook(n.key);return 1})()" >/dev/null
  waitfor "(document.querySelector('[data-testid=notebook-switcher]')?.innerText||'').includes('$HOME21')" 20; sleep 1.5
fi

step "A typo in search (real typing) finds the page; Enter opens it"
"$DC" key ctrl+k; waitfor "!!document.querySelector('.command-palette-input')" 10
"$DC" type "roadmp"; sleep 1
is "First result: Roadmap21, highlighted" "$(ev "(()=>{const r=document.querySelector('[data-testid=search-section-pages] .command-palette-item');return (r?.textContent||'none')+'|'+(r?.querySelectorAll('mark').length>0)})()")" "Roadmap21|true"
"$DC" shot "d21-typo-search" >/dev/null
"$DC" key Return; waitfor "window.__MINOTES__.getCurrentPage()==='Roadmap21'" 10
is "Opened Roadmap21" "$(cur21)" "Roadmap21"

step "All Pages from the palette; tick two rows and Move to… Proj21 (real clicks)"
"$DC" key ctrl+k; waitfor "!!document.querySelector('.command-palette-input')" 10
"$DC" type ">all pgaes"; sleep 0.5; "$DC" key Return
waitfor "!!document.querySelector('[data-testid=all-pages-view]')" 10
is "All Pages is in the main pane, the sidebar stays" "$(ev "!!document.querySelector('[data-testid=all-pages-view]')+'|'+(document.querySelector('.sidebar').getClientRects().length>0)")" "true|true"
"$DC" type "Nav21"; sleep 0.6
rclick21 "[...document.querySelectorAll('[data-testid=all-pages-row]')].find(r=>r.textContent.includes('Nav21 A'))?.querySelector('[data-testid=all-pages-check]')"; sleep 0.2
rclick21 "[...document.querySelectorAll('[data-testid=all-pages-row]')].find(r=>r.textContent.includes('Nav21 B'))?.querySelector('[data-testid=all-pages-check]')"; sleep 0.3
is "Bulk bar: 2 selected" "$(ev "document.querySelector('.all-pages-bulk-count')?.textContent||'none'")" "2 selected"
rclick21 "document.querySelector('[data-testid=bulk-move]')"; sleep 0.5
rclick21 "[...document.querySelectorAll('[data-testid=move-target]')].find(b=>b.textContent.includes('Proj21'))"; sleep 1.2
is "Both pages are in Proj21 (database)" "$(db w21 "select count(*) from pages p join folders f on f.id=p.folder_id where f.name='Proj21' and p.title like 'Nav21 %'")" "2"
"$DC" shot "d21-all-pages-moved" >/dev/null

step "Trash view: tick two items, Restore 2 (real clicks)"
rclick21 "document.querySelector('[data-testid=sidebar-trash]')"; waitfor "!!document.querySelector('[data-testid=trash-view]')" 10; sleep 0.5
rclick21 "[...document.querySelectorAll('[data-testid=trash-item]')].find(e=>e.textContent.includes('Bin21 one'))?.querySelector('[data-testid=trash-check]')"; sleep 0.2
rclick21 "[...document.querySelectorAll('[data-testid=trash-item]')].find(e=>e.textContent.includes('Bin21 two'))?.querySelector('[data-testid=trash-check]')"; sleep 0.3
is "The preview shows the last item ticked" "$(ev "document.querySelector('[data-testid=trash-preview] h3')?.textContent||'none'")" "Bin21 two"
"$DC" shot "d21-trash-selected" >/dev/null
rclick21 "document.querySelector('[data-testid=trash-restore-selected]')"; sleep 1.2
is "Two restored, one still in the Trash (database)" "$(db w21 "select count(*) from trash t join pages p on p.id=t.page_id where p.title like 'Bin21 %'")" "1"
is "…and gone from the list" "$(ev "[...document.querySelectorAll('[data-testid=trash-item]')].map(e=>e.textContent).filter(t=>t.includes('Bin21')).length")" "1"
"$DC" key Escape; sleep 0.4
is "Esc closes the Trash view" "$(ev "!!document.querySelector('[data-testid=trash-view]')")" "false"
journey "D22. The editor under real keys and mouse (UX review Wave 4)"
# Real X input (xdotool): the / menu by keyboard (a heading, a callout, a
# natural-language date), the code-language dropdown, a user template saved from
# a block's right-click menu and inserted with /, "Link" on an unlinked mention,
# a typed key:: value, and a 5,000-block page that opens at once and types smoothly.
# ═══════════════════════════════════════════════
A22="const api=await import('/src/lib/api.ts');"
X22="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
xy22() { ev "(()=>{const e=$1;if(!e)return '';const r=e.getBoundingClientRect();return Math.round(r.left+Math.min(r.width/2,60))+' '+Math.round(r.top+r.height/2)})()"; }
rclick22() { local xy; xy=$(xy22 "$1"); [[ -n "$xy" ]] && "$DC" click $xy >/dev/null; }
rmenu22() { local xy; xy=$(xy22 "$1"); [[ -n "$xy" ]] && DISPLAY="$X22" xdotool mousemove $xy click 3; }
blk22() { echo "document.querySelector('.block-list > .block[data-block-id=\"$(api "getBlockTree()[$1].id")\"] .block-content')"; }
S22=$(date +%s)
# The 5,000-block page goes in through the CLI (a markdown import) before the app opens.
device w22 || true
"$DC" down >/dev/null 2>&1
mkdir -p "$STATE/big22"
python3 -c "
import sys
with open(sys.argv[1], 'w') as f:
    for i in range(5000):
        f.write('- ' + ('big22 start ' if i == 0 else '') + 'Row %d with **bold** and [[Getting Started]]\n' % i)
" "$STATE/big22/Big22.md"
echo "w22" > "$STATE/profile"; "$DC" cli import dir "$STATE/big22" >/dev/null 2>&1
device w22 keep || true
waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
ev "(async()=>{$A22 const p=await api.createPage('Slash22 $S22');for(let i=0;i<3;i++)await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('Slash22 $S22')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Slash22 $S22'" 10; sleep 1

step "The / menu by keyboard: ↓ ↓ Enter picks Heading 3; /warn Enter makes a warning callout"
rclick22 "$(blk22 0)"; sleep 0.4
"$DC" type "Plan for today /"; sleep 0.8
is "The menu shows its groups" "$(ev "[...document.querySelectorAll('.slash-menu-group')].map(e=>e.textContent).slice(0,2).join('|')")" "Basic|Lists"
"$DC" key Down; sleep 0.2; "$DC" key Down; sleep 0.2; "$DC" key Return; sleep 1.2
rclick22 "$(blk22 1)"; sleep 0.4
"$DC" type "Mind the gap /warn"; sleep 0.8; "$DC" key Return; sleep 1
"$DC" key Escape; sleep 1.5
is "Heading 3 saved" "$(db w22 "select content from blocks where content like '%Plan for today%'")" "### Plan for today"
is "Warning callout saved as > [!warning]" "$(db w22 "select content from blocks where content like '%Mind the gap%'")" "> [!warning] Mind the gap"
is "…and drawn as a callout" "$(ev "document.querySelector('.block-list .callout-warning')?.getAttribute('data-callout-label')||'none'")" "Warning"
"$DC" shot "d22-callout" >/dev/null

step "/date next friday (typed) links the coming Friday's journal page"
NF22=$(ev "(()=>{const d=new Date();const n=new Date(d.getFullYear(),d.getMonth(),d.getDate()+(((5-d.getDay()+7)%7)||7));return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0')})()")
rclick22 "$(blk22 2)"; sleep 0.4
"$DC" type "Ship it /date next friday"; sleep 0.9
is "The menu offers that day" "$(ev "document.querySelector('.slash-menu-item-title')?.textContent||'none'")" "Date: $NF22"
"$DC" key Return; sleep 0.8; "$DC" key Escape; sleep 1.5
is "Saved as a journal link" "$(db w22 "select content from blocks where content like 'Ship it%'")" "Ship it [[Journal/$NF22]]"

step "The code block's language label is a dropdown (real click, type, Enter)"
ev "(async()=>{$A22 const p=await api.createPage('Code22 $S22');await api.createBlock(p.id,'\`\`\`python\nprint(22)\n\`\`\`');return 1})()" >/dev/null
api "navigateTo('Code22 $S22')" >/dev/null; waitfor "!!document.querySelector('.block-list .code-lang-btn')" 10; sleep 0.5
rclick22 "document.querySelector('.block-list .code-lang-btn')"; sleep 0.8
is "The language list is open with its filter focused" "$(ev "document.activeElement?.className||''")" "code-lang-filter"
"$DC" type "rust"; sleep 0.3; "$DC" key Return; sleep 1; "$DC" key Escape; sleep 1.5
is "The fence language changed in the database" "$(db w22 "select substr(content,1,7) from blocks where content like '%print(22)%'")" '```rust'
"$DC" shot "d22-code" >/dev/null

step "Save a block and its children as a template (right-click menu), then insert it with /"
ev "(async()=>{$A22 const p=await api.createPage('Tpl22 $S22');const a=await api.createBlock(p.id,'## Checklist22');await api.createBlock(p.id,'TODO pack',a.id);await api.createBlock(p.id,'TODO book',a.id);const q=await api.createPage('Use22 $S22');await api.createBlock(q.id,'');return 1})()" >/dev/null
api "navigateTo('Tpl22 $S22')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Tpl22 $S22'" 10; sleep 1
rmenu22 "$(blk22 0)"; sleep 0.8
rclick22 "document.querySelector('[data-action=save-template]')"; sleep 0.8
"$DC" key ctrl+a; "$DC" type "Pack22"; "$DC" key Return; sleep 1.5
is "Stored as a template" "$(db w22 "select replace(content, char(10), '/') from templates where name='Pack22'")" "## Checklist22/  TODO pack/  TODO book"
api "navigateTo('Use22 $S22')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Use22 $S22'" 10; sleep 1
rclick22 "$(blk22 0)"; sleep 0.4
"$DC" type "/pack22"; sleep 1.2; "$DC" key Return; sleep 2.5
"$DC" key Escape; sleep 1
is "Inserted nested: two children under the heading" "$(db w22 "select count(*) from blocks c join blocks p on c.parent_id=p.id join pages g on p.page_id=g.id where g.title='Use22 $S22' and p.content='## Checklist22'")" "2"
"$DC" shot "d22-template" >/dev/null

step "Link on an unlinked mention (real click) wraps it in [[ ]]"
ev "(async()=>{$A22 await api.createPage('Hub22 $S22');const m=await api.createPage('Mention22 $S22');await api.createBlock(m.id,'call hub22 $S22 today');return 1})()" >/dev/null
api "navigateTo('Hub22 $S22')" >/dev/null; waitfor "!!document.querySelector('.unlinked-refs-toggle-btn')" 15
ev "document.querySelector('.unlinked-refs')?.scrollIntoView({block:'center'})" >/dev/null; sleep 0.5
rclick22 "document.querySelector('.unlinked-refs-toggle-btn')"; sleep 0.8
waitfor "!!document.querySelector('[data-testid=unlinked-link]')" 10 || rclick22 "document.querySelector('.unlinked-refs-toggle-btn')"
ev "document.querySelector('[data-testid=unlinked-link]')?.scrollIntoView({block:'center'})" >/dev/null; sleep 0.5
rclick22 "document.querySelector('[data-testid=unlinked-link]')"; sleep 1.5
is "The mention is a link now" "$(db w22 "select content from blocks where content like 'call %$S22%'")" "call [[hub22 $S22]] today"
waitfor "(document.querySelector('.backlinks h4')?.textContent||'').startsWith('Backlinks (1)')" 10 && pass "The backlinks list it" || fail "Backlinks after Link" "$(ev "document.querySelector('.backlinks h4')?.textContent||'none'")"
"$DC" shot "d22-link" >/dev/null

step "A typed key:: value line becomes a block property"
ev "(async()=>{$A22 const p=await api.createPage('Prop22 $S22');await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('Prop22 $S22')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Prop22 $S22'" 10; sleep 1
rclick22 "$(blk22 0)"; sleep 0.4
"$DC" type "Ship the release"; "$DC" key shift+Return; "$DC" type "status:: done"; sleep 0.3
"$DC" key Escape; sleep 1.5
is "The text has no property line" "$(db w22 "select content from blocks b join pages g on b.page_id=g.id where g.title='Prop22 $S22'")" "Ship the release"
is "…and the block has the property" "$(db w22 "select p.key||'='||p.value from properties p join blocks b on p.entity_id=b.id join pages g on b.page_id=g.id where g.title='Prop22 $S22'")" "status=done"
is "…shown as a chip" "$(ev "document.querySelector('.block-list .block-properties .prop-chip')?.innerText.replace(/\\s+/g,' ').trim()||'none'")" "status done ×"

step "A 5,000-block page opens at once (windowed) and typing deep inside it is smooth"
api "navigateTo('Getting Started')" >/dev/null; sleep 1.5
R=$(ev "(async()=>{const M=window.__MINOTES__;const t0=performance.now();let first=null,last=t0,stall=0;M.navigateTo('Big22');await new Promise(res=>{const tick=()=>{const n=performance.now();stall=Math.max(stall,n-last);last=n;const el=document.querySelector('.block-list .block .ProseMirror');if(first===null&&el&&el.textContent.includes('big22 start'))first=n-t0;if((first!==null&&n-t0>first+1500)||n-t0>30000)return res();setTimeout(tick,0)};setTimeout(tick,0)});return Math.round(first)+'|'+Math.round(stall)+'|'+M.isWindowed()+'|'+M.getRenderedBlockCount()+'|'+M.getBlockCount()})()")
IFS='|' read -r F22 ST22 W22 RC22 BC22 <<< "$R"
[[ "$W22" == "true" && "$BC22" == "5000" && "$RC22" -lt 250 && "$F22" -lt 2000 && "$ST22" -lt 1000 ]] 2>/dev/null && pass "Opened: first block ${F22} ms, longest stall ${ST22} ms, $RC22 of $BC22 blocks in the DOM" || fail "5,000-block page open" "$R"
api "focusBlock(2750)" >/dev/null; sleep 1.2
ev "(()=>{const ed=document.activeElement.closest('.ProseMirror');window.__k22={list:[]};const k=window.__k22;window.addEventListener('keydown',e=>{if(e.key.length===1){k.cur={down:performance.now(),frame:null};k.list.push(k.cur)}},true);k.mo=new MutationObserver(()=>{const c=k.cur;if(c&&c.frame===null){c.frame=-1;requestAnimationFrame(()=>{c.frame=performance.now()-c.down})}});k.mo.observe(ed,{childList:true,subtree:true,characterData:true});return 1})()" >/dev/null
"$DC" key End; "$DC" type " smooth22 typing in a big page"; sleep 1
R=$(ev "(()=>{const f=window.__k22.list.map(c=>c.frame).filter(x=>x>0);return f.length+'|'+Math.round(Math.max(...f))+'|'+Math.round(f.reduce((a,b)=>a+b,0)/f.length)})()")
IFS='|' read -r K22 MX22 AV22 <<< "$R"
"$DC" key Escape; sleep 1.5
is "Every key landed in the deep block (database)" "$(db w22 "select count(*) from blocks where content like 'Row 2750 %smooth22 typing in a big page'")" "1"
[[ "$K22" -ge 25 && "$MX22" -lt 150 ]] 2>/dev/null && pass "$K22 keys, frame after each key: avg ${AV22} ms, max ${MX22} ms" || fail "Typing latency in the big page" "$R"
"$DC" shot "d22-big-page" >/dev/null

# ═══════════════════════════════════════════════
journey "D24. Indent like a document, with the real keyboard (option B)"
# Real X keys (xdotool): type, Tab, Enter on an empty child (outdents), Enter on
# an empty top-level line (stays), Backspace at the start of a nested line
# (outdents, text intact), Shift+Tab (GDK ISO_Left_Tab), Ctrl+Z after an Enter
# outdent. The stored outline (parent ids) is read straight from SQLite.
# ═══════════════════════════════════════════════
A24="const api=await import('/src/lib/api.ts');"
S24=$(date +%s); P24="Indent24 $S24"
xy24() { ev "(()=>{const e=$1;if(!e)return '';const r=e.getBoundingClientRect();return Math.round(r.left+Math.min(r.width/2,60))+' '+Math.round(r.top+r.height/2)})()"; }
# outline24: every block of the page as content<parent content, in outline order (the app's own order).
outline24() { db w24 "with recursive t(id,content,parent,path) as (select b.id,b.content,'-',printf('%012.4f',b.position) from blocks b join pages g on b.page_id=g.id where g.title='$P24' and b.parent_id is null union all select c.id,c.content,t.content,t.path||'/'||printf('%012.4f',c.position) from blocks c join t on c.parent_id=t.id) select group_concat(content||'<'||parent,'|') from (select * from t order by path)"; }
ui24() { ev "window.__MINOTES__.getBlockTree().map(b=>b.depth).join(',')"; }
device w24 || true
ev "(async()=>{$A24 const p=await api.createPage('$P24');await api.createBlock(p.id,'');return 1})()" >/dev/null
api "navigateTo('$P24')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='$P24'" 10; sleep 1

step "Type, Enter, type, Tab: the second line is a child"
XY=$(xy24 "document.querySelector('.block-list .block-content')"); "$DC" click $XY >/dev/null; sleep 0.5
"$DC" type "Topic24"; "$DC" key Return; sleep 0.8; "$DC" type "Detail24"; sleep 0.3
"$DC" key Tab; sleep 0.8
is "Tab indented it (depths)" "$(ui24)" "0,1"

step "Enter (new empty child), Enter again: the empty line steps out to the top level"
"$DC" key Return; sleep 0.8
D1=$(ui24)
"$DC" key Return; sleep 0.8
is "Child line, then outdented by the second Enter" "$D1 → $(ui24)" "0,1,1 → 0,1,0"
"$DC" key Return; sleep 0.8
is "A third Enter on the empty top-level line adds nothing" "$(ui24)" "0,1,0"
"$DC" type "Next24"; sleep 0.3; "$DC" key Escape; sleep 1.5
is "Stored: Next24 is a top-level block after Topic24's child" "$(outline24)" "Topic24<-|Detail24<Topic24|Next24<-"

step "Tab, then Home + Backspace at the start of the nested line: outdented, text intact"
XY=$(xy24 "document.querySelectorAll('.block-list .block-content')[2]"); "$DC" click $XY >/dev/null; sleep 0.5
"$DC" key Tab; sleep 0.8
is "Tab nested it under Topic24" "$(ui24)" "0,1,1"
"$DC" key Home; "$DC" key BackSpace; sleep 0.8
is "Backspace at the start outdented it" "$(ui24)" "0,1,0"
is "…the caret is still at its start" "$(api 'getCaretInBlock(2)')" "1"
"$DC" key Escape; sleep 1.5
is "Stored: text intact, top level again" "$(outline24)" "Topic24<-|Detail24<Topic24|Next24<-"

step "Tab then Shift+Tab (ISO_Left_Tab) round-trips"
XY=$(xy24 "document.querySelectorAll('.block-list .block-content')[2]"); "$DC" click $XY >/dev/null; sleep 0.5
"$DC" key Tab; sleep 0.8; D1=$(ui24)
"$DC" key shift+Tab; sleep 0.8
is "Tab → depth 1, Shift+Tab → depth 0" "$D1 → $(ui24)" "0,1,1 → 0,1,0"

step "Ctrl+Z after an Enter outdent puts the line back at its depth"
"$DC" key End; "$DC" key Return; sleep 0.8; "$DC" key Tab; sleep 0.8
"$DC" type "Sub24"; sleep 0.3; "$DC" key Return; sleep 0.8
D1=$(ui24)
"$DC" key Return; sleep 0.8; D2=$(ui24)
"$DC" key ctrl+z; sleep 1.2; D3=$(ui24)
is "Empty child → Enter outdents → Ctrl+Z restores" "$D1 / $D2 / $D3" "0,1,0,1,1 / 0,1,0,1,0 / 0,1,0,1,1"
"$DC" type "Sub24b"; sleep 0.3; "$DC" key Escape; sleep 1.5
is "Stored outline after all of it" "$(outline24)" "Topic24<-|Detail24<Topic24|Next24<-|Sub24<Next24|Sub24b<Next24"
"$DC" shot "d24-indent" >/dev/null

# ═══════════════════════════════════════════════
journey "D25. Tabs under real keys and a real mouse (PRD-tabs §7)"
# Ctrl+T, Ctrl+Tab, Alt+2, Ctrl+W (X keys); a REAL middle-click (X button 2) on a
# [[link]] opens a background tab and pastes nothing (the X primary selection is
# loaded first); the mouse's back button (X button 8) acts on the active tab; the
# row comes back after an app restart; Ctrl+Shift+W makes a whiteboard; and an
# encrypted notebook's page titles, shown in tabs, are in no file outside its
# database (the D13 leak scan, with tabs open).
# ═══════════════════════════════════════════════
A25="const api=await import('/src/lib/api.ts');"
X25="localhost:${DESKTOP_CHECK_DISPLAY:-97}"
tsum25() { ev "(()=>{const t=window.__MINOTES__.tabs();return t.tabs.length+'|'+t.active+'|'+t.tabs.map(x=>(x.pinned?'*':'')+(x.pageTitle||x.view||x.date||'?')).join(';')})()"; }
cur25() { api "getCurrentPage()"; }
xy25() { ev "(()=>{const e=$1;if(!e)return '';e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()"; }
blocks25() { db w25 "select group_concat(b.content,' ¦ ') from blocks b join pages p on b.page_id=p.id where p.title='$1' order by b.position"; }
device w25 || true
ev "(async()=>{$A25 for(const t of ['Tab25 A','Tab25 B','Tab25 C']){const p=await api.createPage(t);await api.createBlock(p.id,'text of '+t)}const l=await api.createPage('Link25');await api.createBlock(l.id,'go to [[Tab25 B]] now');await api.createBlock(l.id,'second block');return 1})()" >/dev/null
api "navigateTo('Tab25 A')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Tab25 A'" 10; sleep 1

step "Ctrl+T (real key) opens a tab on today's journal"
"$DC" key ctrl+t; sleep 1.5
R="$(tsum25)"
[[ "$R" == 2\|1\|Tab25\ A\;* ]] && [[ "$(cur25)" == Journal/* ]] && pass "Ctrl+T → 2 tabs, the new one active on a journal ($R)" || fail "Ctrl+T" "$R / $(cur25)"
"$DC" wshot "d25-new-tab" >/dev/null

step "Ctrl+Tab and Alt+2 move between tabs"
"$DC" key ctrl+Tab; sleep 1
R1="$(ev "window.__MINOTES__.tabs().active")|$(cur25)"
"$DC" key alt+2; sleep 1
R2="$(ev "window.__MINOTES__.tabs().active")|$(cur25)"
[[ "$R1" == "0|Tab25 A" ]] && pass "Ctrl+Tab wraps to the first tab ($R1)" || fail "Ctrl+Tab" "$R1"
[[ "$R2" == 1\|Journal/* ]] && pass "Alt+2 → the second tab ($R2)" || fail "Alt+2" "$R2"

step "Ctrl+W closes the active tab; with one tab left it does nothing"
"$DC" key ctrl+w; sleep 1
R="$(tsum25)"
[[ "$R" == "1|0|Tab25 A" ]] && pass "Ctrl+W closed the journal tab ($R)" || fail "Ctrl+W" "$R"
"$DC" key ctrl+w; sleep 1
is "Ctrl+W with one tab: still there" "$(tsum25)" "1|0|Tab25 A"
is "…and the window is still open" "$(cur25)" "Tab25 A"

step "A real middle-click on a [[link]]: a background tab, and nothing is pasted"
api "navigateTo('Link25')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Link25'" 10; sleep 1
B0="$(blocks25 'Link25')"
# the X primary selection is what a middle-click pastes on Linux
DISPLAY="$X25" bash -c 'printf "PASTED25" | xclip -selection primary -i' >/dev/null 2>&1; sleep 0.3
XY=$(xy25 "document.querySelector('.wiki-link')")
DISPLAY="$X25" xdotool mousemove $XY sleep 0.3 click 2; sleep 1.5
R="$(tsum25)"
[[ "$R" == "2|0|Link25;Tab25 B" ]] && pass "Middle-click → Tab25 B in a background tab, Link25 stays active ($R)" || fail "Middle-click on a link" "$R"
sleep 1.5
is "Nothing pasted into the live page" "$(ev "String(document.body.innerText.includes('PASTED25'))")" "false"
is "Nothing pasted into the stored blocks" "$(blocks25 'Link25')" "$B0"
is "No block anywhere contains the pasted text" "$(db w25 "select count(*) from blocks where content like '%PASTED25%'")" "0"
"$DC" wshot "d25-middle-click" >/dev/null

step "The mouse's back button (X button 8) goes back in the ACTIVE tab only"
api "navigateTo('Tab25 A')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Tab25 A'" 10
XY=$(xy25 "document.querySelector('.main, .main-content, body')")
DISPLAY="$X25" xdotool mousemove 700 500 sleep 0.3 click 8; sleep 1.2
R="$(cur25)|$(tsum25)"
[[ "$R" == "Link25|2|0|Link25;Tab25 B" ]] && pass "Back button → Link25 in tab 1; the other tab untouched ($R)" || fail "Mouse back" "$R"
DISPLAY="$X25" xdotool mousemove 700 500 sleep 0.3 click 9; sleep 1.2
is "Forward button → Tab25 A again" "$(cur25)" "Tab25 A"

step "Tabs come back after an app restart: three tabs, the same active one"
api "openInBackgroundTab('Tab25 C')" >/dev/null; sleep 1
ev "window.__MINOTES__.activateTab(1)" >/dev/null; sleep 1
BEFORE="$(tsum25)|$(cur25)"
sleep 1.5
"$DC" restart >/dev/null && waitfor "window.__MINOTES__ && !!window.__MINOTES__.navigateTo" 30
waitfor "window.__MINOTES__.tabs().tabs.length===3" 20 || true; sleep 1.5
AFTER="$(tsum25)|$(cur25)"
[[ "$BEFORE" == 3\|* ]] && is "Same tabs, same order, same active tab after a restart" "$AFTER" "$BEFORE" || fail "Tabs before restart" "$BEFORE"
"$DC" wshot "d25-restored" >/dev/null

step "Ctrl+Shift+W (real keys) starts a whiteboard; Ctrl+W alone does not"
ev "document.activeElement?.blur()" >/dev/null; sleep 0.3
N0=$(ev "window.__MINOTES__.tabs().tabs.length")
"$DC" key ctrl+shift+w; waitfor "!!document.querySelector('canvas')" 10 && pass "Ctrl+Shift+W → a whiteboard canvas" || fail "Ctrl+Shift+W" "no canvas"
is "…and no tab was closed" "$(ev "window.__MINOTES__.tabs().tabs.length")" "$N0"
"$DC" key Escape; sleep 0.8

step "Encrypted notebook: page titles shown in tabs are in no file outside its database"
EH25="$STATE/enc25"; ETMP25="$STATE/enc25-tmp"; EKC25="$STATE/enc25-keychain"
TMPDIR_ORIG25="${TMPDIR:-}"; rm -rf "$ETMP25" "$EKC25"; mkdir -p "$ETMP25"
export TMPDIR="$ETMP25" MINOTES_FAKE_KEYCHAIN_DIR="$EKC25"
device enc25 || true
PASS25="tabs twenty five staple"
T1="Quokka25Alpha"; T2="Quokka25Beta"; T3="Quokka25Gamma"
setv25() { ev "(()=>{const i=document.querySelector('$1');if(!i)return 'no input';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'$2');i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >/dev/null; }
leaks25() { grep -rlaF -e "$T1" -e "$T2" -e "$T3" "$EH25" "$ETMP25" "$STATE/app.log" 2>/dev/null | grep -v '/shots/' | head -5; }
R=$(ev "(async()=>{$A25 const r=await api.createEncryptedNotebook('Vault25',undefined,'$PASS25');const n=await import('/src/lib/notebooks.ts');await n.switchNotebook(r.notebook.key);for(const t of ['$T1','$T2','$T3']){const p=await api.createPage(t);await api.createBlock(p.id,'body of '+t)}return (await api.getNotebookSession()).encrypted})()")
is "Encrypted notebook created with three pages" "$R" "true"
api "navigateTo('$T1')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='$T1'" 10; sleep 1
api "openInBackgroundTab('$T2')" >/dev/null; sleep 1; api "openInBackgroundTab('$T3')" >/dev/null; sleep 1
ev "window.__MINOTES__.activateTab(1)" >/dev/null; sleep 2.5
is "Three tabs are open in the vault" "$(ev "window.__MINOTES__.tabs().tabs.length")" "3"
C25=$(grep -rlaF -e "Tab25 B" "$STATE/w25/.minotes" 2>/dev/null | head -1)
[[ -n "$C25" ]] && pass "Control: the same scan does find a title in the plaintext notebook" || fail "Leak scan control" "no hit for a title in the unencrypted notebook"
L=$(leaks25); [[ -z "$L" ]] && pass "Unlocked, tabs open: no title in any file (HOME, TMPDIR, app log)" || fail "Title found outside the database (open)" "$L"
"$DC" restart >/dev/null
waitfor "!!document.querySelector('[data-testid=unlock-screen]')" 30 && pass "The vault opens locked" || fail "Not locked" "$(ev "document.body.innerText.slice(0,160)")"
is "The locked screen shows no tab title" "$(ev "String(document.body.innerText.includes('Quokka25'))")" "false"
L=$(leaks25); [[ -z "$L" ]] && pass "Locked after a restart: still no title in any file" || fail "Title found outside the database (locked)" "$L"
setv25 "[data-testid=unlock-passphrase]" "$PASS25"; "$DC" wclick "[data-testid=unlock-submit]" >/dev/null
waitfor "!!window.__MINOTES__?.tabs && window.__MINOTES__.tabs().tabs.length===3" 30 && pass "Unlocked: the three tabs are back (saved inside the encrypted database)" || fail "Tabs after unlock" "$(tsum25)"
L=$(leaks25); [[ -z "$L" ]] && pass "After unlocking and restoring: still no title in any file" || fail "Title found outside the database (restored)" "$L"
unset MINOTES_FAKE_KEYCHAIN_DIR
if [[ -n "$TMPDIR_ORIG25" ]]; then export TMPDIR="$TMPDIR_ORIG25"; else unset TMPDIR; fi

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
