# Data signals: parity, scale, visual regression

Three tools that produce evidence a single journey run can't: where the browser
tests' mock lies, how the real app behaves as the graph grows, and whether a
view's pixels changed. Each writes markdown into `$DESKTOP_CHECK_DIR/signals/`,
is re-runnable and non-interactive, and exits 0 unless the tool itself broke
(findings are not failures). Give each run its own `DESKTOP_CHECK_DIR`,
`DESKTOP_CHECK_DISPLAY` and `DESKTOP_CHECK_WD_PORT` if anything else uses the
desktop-check driver at the same time.

Launch note: `desktop.sh` now launches every app under a private `dbus-run-session`,
which removes the ~25 s D-Bus stall this host otherwise causes.

## 1. Mock-vs-real parity — `parity.sh`

**What it measures.** `parity.js` runs ~235 scenarios (pages, blocks, move/
reorder/reparent, page-tree order and shape, search, links/backlinks/unlinked,
properties, favorites, folders, trash, archive, journal, the full
`parse_pending_todo` rule table, templates, `restore_blocks`, malformed/missing
arguments) **inside the real app** against both backends that page contains:
`mockHandlers` from `mockBackend.ts` (what browser journeys talk to) and Tauri
IPC (the product). Every scenario uses titles/tokens tagged with its own id
(`ZQpg13 …`, `zqse01…`) and filters global lists to that tag, so one divergence
can't cascade. Results are shaped (contents, parent contents, positions,
booleans), ids/timestamps are masked, `null`≡`undefined`, and "both threw" is
SAME whatever the wording.

**Run.** `bash .claude/skills/desktop-check/parity.sh [--no-build] [--only 'se|ln'] [--attach]`
(~1 min after the build; fresh `parity` profile; `--attach` reuses a running app).
Single checks by hand: `desktop.sh js "window.__PARITY_ONLY__='pg13'; $(cat parity.js)"`.

**Read the output** (`signals/parity.md`, raw records in `parity.json`):
- area table (checks / same / different), then **Ranked divergences**: check,
  inputs, mock result, real result, verdict, journey lines that touch the same API;
- **Divergence details** with the reviewer's note: which side is right, whether the
  real behaviour itself looks like a bug, and what was verified about journeys;
- **Same on both sides, but wrong** — agreements that are bugs on both sides;
- **Both throw, different wording** — only matters to message assertions.

Verdicts live in `parity-notes.json` (`rank`, `tag`, `right`, `note`, `journeys`,
`suspect`). New divergences show up as **UNREVIEWED**; a note whose check is now
SAME is listed as stale — re-triage both after app changes. Tags: `BUG`
(product behaviour looks wrong), `TEST-FIDELITY GAP` (mock differs; browser tests
can't see the real behaviour). "Journey lines" is a grep, not proof of
dependence — the note says what was checked by reading the journey.

## 2. Scale — `scale-tour.sh`

**What it measures.** For each size — S 50 pages / 500 blocks, M 300 / 5,000,
L 1,000 / 20,000, each plus **Hub** (linked from every page) and **Big Page**
(2,000 blocks); ~15 % of blocks link, ~10 % pending TODOs, nested 3 levels —
`scale-seed.py` writes markdown and `minotes import dir` loads it (no WebDriver
per block). Then, median of 3:
- cold start by direct launch (no WebDriver): process start → window mapped →
  first frame with content → screen stable (pixel captures every 250 ms);
- frontend boot after `location.reload()` (DOM-ready: first block + sidebar);
- backend only (IPC + SQLite, `performance.now()` around `api.*`): page tree small/
  big, search common/rare, folder tree, list pages, graph data, backlinks,
  unlinked refs, TODO count, create page/block;
- views, timed inside the page (`scale-lib.js`): open small page, open/leave the
  2,000-block page (first block, all rendered, painted, **longest main-thread
  stall**, DOM nodes, editor count), keystroke → DOM → next frame in a small page
  and in the big page (real X typing), search panel end to end, sidebar refresh,
  graph view (time to canvas, stall + fps over the next 3 s), Hub backlinks panel;
- IPC calls per action (counted by wrapping `fetch("ipc://…")`), DB size.

**Run.** `bash .claude/skills/desktop-check/scale-tour.sh [--no-build] [--sizes S,M,L] [--runs 3]`
(~1 h for all three sizes, dominated by opening the 2,000-block page;
`--report-only` rebuilds `scale.md` from the TSVs).

**Read the output** (`signals/scale.md`; raw `scale-<S>.tsv`): one row per metric,
a column per size, the L/S ratio and flags — **OVER 1 s**, **SUPER-LINEAR** (grew
>1.3× faster than the block count), **GROWS** (should not depend on graph size but
got >1.5× slower). Xvfb is software rendering: read across a row, never as
absolute numbers. `scale-notes.md` (appended to the report) holds the code reading
behind each call-out — refresh it when the numbers move.

## 3. Visual regression — `visual-diff.sh`

**What it measures.** `visual-tour.sh` is a deterministic copy of `ux-tour.sh`
(same seed, same 17 views, screenshots only). Before the tour, `visual-freeze.js`
freezes the page clock at Tue 24 Mar 2026 09:30 local (the date drives the
sidebar label, journal title and calendar), disables animations/transitions/caret
via a constructable stylesheet (CSP-safe), and the pointer is parked in the
corner before each shot. `visual-compare.py` paints the per-view mask rectangles
from `visual-config.json` on both images, then `compare -metric AE -fuzz` → %
of pixels changed. `layout-only` views (force-directed graph) are blurred and
shrunk to 1/8 first, so only big moves count (available, but for the graph view
the canvas is masked instead: its layout differs completely every run and even
layout-only mode left 1–8 % noise, more than a real change would produce).

Measured noise floor (2 tours, same build): **0.000 % on all 16 views** once the
clock is frozen, motion is off and two masks are applied — `journal-today` (an
error banner showing a random page id: 0.17 % raw) and `graph` (random layout:
1.9 % raw). Hence the default threshold of **0.02 %** (~190 px of 960k), which
still catches a 120×15 px change (0.20 %). Sources neutralised: date (sidebar
"Today · <date>", journal title/header, calendar), caret blink, transitions,
pointer hover, force-directed layout, random ids in the error banner. Not
neutralised: anything the Rust side timestamps — none showed up in the 16 views.

**Run.**
- `visual-diff.sh noise 2` — two tours, no code change → `signals/visual-noise.md`:
  raw (no neutralising) and configured run-to-run % per view = the noise floor,
  with a margin check against each threshold. Run this after changing masks.
- `visual-diff.sh approve [DIR]` — tour (or DIR) → `baselines/` (commit them; PNG,
  ~50–150 KB each).
- `visual-diff.sh check [DIR]` — tour (or DIR) vs baselines → `signals/visual.md`;
  `VISUAL_STRICT=1` makes CHANGED/MISSING exit 1.

**Read the output.** Table view × % changed × threshold × mode × status
(PASS / CHANGED / NEW / MISSING) × changed bounding box; each CHANGED view gets
`signals/visual-diffs/<view>.png` = baseline | current | red diff. A CHANGED view
is a prompt to look, not a verdict. Baselines are only meaningful for the build
they were approved on — re-approve after intended UI changes.
