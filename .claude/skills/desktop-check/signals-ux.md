# UX signal tools

Four scripts that turn the "other signals" list in SKILL.md into repeatable runs
against the REAL desktop app. Each one:

- starts the app on its own throwaway profile (`--profile friction|silent|deadends|shortcuts`)
  with `--webdriver`, seeds the demo pages, and installs `signal-hooks.js`
- drives the app, mostly with real X input (xdotool), and confirms results with `eval`
- writes a markdown report into `$DESKTOP_CHECK_DIR/signals/`, with screenshots next to it
- shuts the app down (pass `--keep-up` to leave it running and poke at a finding)
- exits 0 unless the tool itself breaks, and is safe to re-run

Common flags: `--no-build` (reuse `target/debug/minotes-app`) and `--keep-up`.
To run several at once, give each run its own `DESKTOP_CHECK_DIR`, `DESKTOP_CHECK_DISPLAY`
and `DESKTOP_CHECK_WD_PORT`. Each tool takes 5–15 min under Xvfb.

Shared pieces:

| File | Role |
|---|---|
| `signal-lib.sh` | sourced helpers: `sig_up/sig_down`, `ev/evs/js`, counted real input (`rclick`, `rrclick`, `rtype`, `rkey`), `center '<js element>'`, `goto`, `blur`, `shot` |
| `signal-hooks.js` | installs `window.__sig`; see below |

**`signal-hooks.js`** records into `window.__sig.events` (each tagged with the running
scenario, `__sig.mark`):

- every Tauri command that rejects. `__TAURI_INTERNALS__.invoke` is non-writable and
  non-configurable, so the hook wraps `fetch`. Every command goes out as
  `fetch("ipc://localhost/<cmd>")` and comes back with the header `Tauri-Response: ok|error`.
- `console.error` / `console.warn`, uncaught errors, unhandled rejections
- failed `img`/`script` loads (capture-phase `error` events)
- CSP violations

For each event it also records what was visible 250 ms and 1.5 s later:
`seenNow`/`seenLater` hold any toast, the red `lastError` banner, or inline
error/alert elements, excluding anything already on screen when the scenario started.

It also replaces `alert`/`confirm`/`prompt`. The calls are recorded in
`__sig.dialogs`, and the answer comes from `__sig.answer`. This is needed because a
native GTK dialog blocks WebDriver. As a result, Ctrl+N and Ctrl+P are tested
without the real dialog appearing.

---

## friction.sh: journey friction

**What it measures**

- **Static part** (`friction_static.py`): for each journey in `tests/user-journey-test.sh`
  it counts steps, asserted outcomes, and actions. Actions are split three ways:
  key presses, clicks/dispatched events, and test-API calls. It also counts the actions
  that **bypass the UI** (direct `api.*` mutations), plus sleeps.
  It ranks journeys by actions per outcome.
- **Live part**: 8 core tasks done through the real UI with real X input, counting
  clicks and keystrokes and checking each outcome:
  1. create a page
  2. add three lines
  3. make a TODO and complete it (Ctrl+Enter, `[ ]`, `/todo`)
  4. link to another page and follow the link
  5. find a page via search (Ctrl+K and the button)
  6. open today's journal (click, and Ctrl+J from neutral and from an editor)
  7. move a page into a project
  8. delete a page, then undo and restore it

  It also runs a **type-ahead probe**: "one⏎two⏎three" typed at 30/80/150/300 ms
  per key, plus the measured time from Enter to the new block getting focus
  (`friction-probe.js`).

**Run:** `friction.sh [--no-build] [--static-only]` → `signals/friction.md`
(`--static-only` needs no app).

**Reading it**

- *bypass %* is the share of a journey's actions the test suite performs through
  the backend API instead of the UI. A journey at 100% proves nothing about the UX
  of that feature. It also points at UI paths that are hard to automate:
  context menus, drag-drop, native prompts.
- In the live table, typed text counts one key per character and a chord counts
  as one, so compare paths for the same task, not absolute totals.
- *visible control?* answers "could a user find this without knowing a shortcut?"
- In the type-ahead table, anything other than `one ¦ two ¦ three` means
  keystrokes typed right after Enter landed in the wrong block.
- Findings are tagged BUG / UX in the list at the end.

**Limits:** HTML5 drag-and-drop (moving pages onto projects) cannot be driven with
xdotool in WebKitGTK. Ctrl+N's title prompt is answered by the hook.

## silent-errors.sh: errors nobody sees

**What it measures:** ~70 scenarios defined in `silent-scenarios.js`:

- every view the UX tour visits, plus the query and review panels and page info
- every command-palette command
- error-prone actions:
  - missing, non-PDF and relative PDF paths
  - non-existent page titles and ids, a mistyped title, `[[links]]` to missing pages
  - impossible journal dates
  - odd search input: `"`, `*`, `(`, `%`, `AND`, `foo:bar`, 500 characters, emoji
  - renaming to an existing, empty, 600-character or slash-containing title
  - creating pages with those titles, plus a duplicate project name
  - editing or opening a page after trash and after permanent delete
  - 25 navigations in one tick, rapid panel toggling
  - invalid or write SQL
  - missing or remote images, a missing whiteboard, a broken block ref, raw HTML/script

For every problem the hooks record, it checks whether the user was told.

**Run:** `silent-errors.sh [--no-build] [--only '<substring>']` →
`signals/silent-errors.md`, raw data in `silent-errors.json`, and `se-NN.png` for
every scenario that produced a problem. Add a scenario by adding a key to
`window.__scn` in `silent-scenarios.js` (async function returning a short outcome
string; no single quotes).

**Reading it**

- **"Errors the user never sees"** is the key table: a rejected command or
  exception with no toast, banner or inline error.
- **"Every scenario"** also catches the opposite failure: *no* error recorded, but
  an odd outcome. Examples: a page silently created, a command that opened nothing,
  data saved into a trashed page. Read the outcome column, not just the counts.
- *feedback* lists only what appeared during the scenario.
- A `banner:` entry is the red `lastError` bar. Check its wording too: it is often
  generic, e.g. "Failed to save — check your connection" for a deleted block.
- Scenarios that THREW are harness problems, not app findings.

**Limits:**

- Scenarios use DOM clicks and filled inputs (with `fill` setting React-controlled
  values) rather than xdotool, for speed.
- `navigateTo` is the test API; the user-facing equivalent is clicking a `[[link]]`.
  Confirm user-facing claims by hand with real input before reporting them.

## dead-ends.sh: can the user always get out?

**What it measures:** ~36 views, panels, menus and modes:

- search palette and command mode
- settings, query, review, plugins, sync and CSS panels
- graph, mind map, kanban, draw (also with a tool armed), all pages
- PDF viewer (good file and missing file)
- block context menu, sidebar page/project menus (right-click and ⋮)
- project settings
- slash menu and `[[` menu
- page info, outline, calendar, trash list
- inline create/rename fields, block properties
- block zoom (Alt+→), multi-selection, right sidebar, a future journal day

For each, it tries three exits on a freshly opened view:

- a real Escape (WebDriver, then xdotool, then twice more)
- a visible close/back/cancel/Esc/× control, clicked with the real pointer. For
  toggles and nav-style exits, the probe passes the control explicitly; these show
  as `toggle/nav:`.
- a real click outside (overlays and menus only)

After closing, it records whether you are still on the starting page and where
keyboard focus went.

**Run:** `dead-ends.sh [--no-build] [--only '<substring>']` → `signals/dead-ends.md`,
with `de-<view>-escape|control|noopen|DEADEND.png` for every failed exit.

**Reading it**

- **DEAD END** means no Escape, no visible control and no click-outside. Always
  open the screenshot: the sidebar may still offer a way out, so judge whether the
  user is really stuck.
- **COULD NOT OPEN** means the tool's entry point didn't produce the view. That is
  either a broken entry point (check it by hand) or a selector drift in the tool.
- **Same page = another title** means opening or closing the view navigated you away.
- **Focus before → after** of `block editor → nothing (body)` means the user's
  cursor is lost after closing.
- *glyph only* means the close control is a bare `×` with no title or aria-label,
  so screen readers can't name it.

**Limits:**

- "Visible control" is found by label heuristics. A close button with an unusual
  label shows up as `none`, so check the screenshot.
- Probes on the home page can leave text behind (e.g. `/`, `[[`); `recover` resets it.

## shortcuts.sh: docs vs behaviour

**What it measures**

- `shortcuts_collect.py` gathers every **advertised** shortcut from:
  - Settings › Keyboard Shortcuts (source, plus the live list in the report header)
  - the Getting Started tutorial (`onboarding.ts`)
  - `title`/`placeholder` hints such as "Search (Ctrl+K)" and the Bubble toolbar
  - command-palette hints, the search placeholder, and README.md/CLAUDE.md

  It also gathers every **key handler** in `crates/minotes-app/src`.
- `shortcuts.sh` presses ~40 combos in the real app. Each runs on a fresh page
  (alpha [[Project Alpha]] / beta / gamma nested under beta), from a **neutral**
  state and/or from **inside a block editor**. It uses a WebDriver key event first
  and xdotool if that had no effect, then verifies the claimed effect.

**Run:** `shortcuts.sh [--no-build] [--only 'Ctrl+J']` → `signals/shortcuts.md`
(plus `shortcuts-advertised.tsv`, `shortcuts-handlers.tsv`).

**Reading it**

The four sections answer the brief directly:

- **advertised-and-works**
- **advertised-but-broken**: always says which context failed. Many global
  shortcuts are deliberately suppressed inside editors (`!inEditor` in App.tsx),
  so "broken in editor" means the docs over-promise, e.g. "Ctrl+J … anytime".
- **works-but-undocumented**
- **conflicts**: the same key doing different things by context (Esc = close vs.
  Esc = outdent), and overrides of common platform meanings (Ctrl+W, Ctrl+Q,
  Ctrl+R, Ctrl+P…).

The *input* column says whether the effect came from a WebDriver event (`wd`) or
needed real X input (`xdo`). `neither` with a correct-looking setup is a real
failure; confirm with `--keep-up` and a screenshot.

**Limits:**

- Checks are expressed against DOM/test-API state; a shortcut whose effect is
  only visual (e.g. a theme change applied without a class or attribute) would
  read as broken.
- The handler grep is regex-based and approximate. It lists candidates; it does
  not prove reachability.
