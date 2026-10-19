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

rm -rf "$STATE"/{persist,devA,devB,nbook,outside,xnb,zip8,barrier10,trust10,rimg,img10,remote.git,enc13,enc13-tmp,enc13-keychain,enc14a,enc14b,enc14c,enc14-tmp,remote14.git} "$STATE/results.tsv"
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

step "The not-found chip explains; nothing is created over there"
api "navigateTo('Links8')" >/dev/null; sleep 1.5
ev "document.querySelectorAll('.block .xnb-link')[1]?.click()" >/dev/null
waitfor "[...document.querySelectorAll('.minotes-toast')].some(t=>t.textContent.includes('has no page'))" 5 \
  && pass "A toast says Office8 has no such page" || fail "Not-found click" "$(ev "[...document.querySelectorAll('.minotes-toast')].map(t=>t.textContent).join(' | ')")"
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

step "I draw on a NEW board (Ctrl+W) and switch at once: its block and board stay home"
api "navigateTo('Edit10')" >/dev/null; waitfor "window.__MINOTES__.getCurrentPage()==='Edit10'"; sleep 1
"$DC" press "Control+w"; waitfor "!!document.querySelector('canvas.whiteboard-canvas')" 10
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
