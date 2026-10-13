---
name: desktop-check
description: Run the REAL MiNotes desktop app (Tauri/WebKitGTK, production CSP, real Rust backend) on a private virtual display — run the user journeys against it, drive it with real input or DOM-level WebDriver, review screenshots, and audit UX. Use to verify anything browser mode can't (CSP, IPC, file access, persistence, sync, CLI interop), when asked to "check the desktop app" or "smoke test Tauri", or to review how the app looks and feels and find UI/UX improvements.
---

# Desktop check

Browser mode (`vite` + mock backend) can't see the real data layer and doesn't
enforce the CSP. This skill runs the actual binary instead, against throwaway
HOMEs — the user's `~/.minotes` is never touched.

Pick the mode that matches the request:

| You want to… | Run |
|---|---|
| Know whether the app works end to end | `bash tests/desktop-journey-test.sh` and `JOURNEY_BACKEND=desktop bash tests/user-journey-test.sh` |
| Check one feature or a fix | the driver (`desktop.sh`) by hand, with `expect` assertions |
| Review look & feel / find UX improvements | `ux-tour.sh`, then the **UX review** below |
| Confirm security rules hold in the shipped app | the **security probes** below |

`D=.claude/skills/desktop-check/desktop.sh` (run from the repo root). Set
`DESKTOP_CHECK_DIR` to a directory in your scratchpad; state, screenshots and
reports land there. `$D` with no arguments prints the full command list.

## 1. Journeys (automatic pass/fail)

- **`tests/desktop-journey-test.sh`** — journeys that only exist in the real app:
  D1 restart persistence (content, ids, nesting, properties, whiteboard, settings,
  pins, collapsed state), D2 real keyboard typing (type, Enter split, Backspace
  merge, Ctrl+Enter, search), D3 CLI ↔ app on one database, D4 two devices syncing
  through a local bare git remote (pull, rename, delete→trash, repeat-sync
  stability, conflicting edits kept as a conflict page).
- **`JOURNEY_BACKEND=desktop bash tests/user-journey-test.sh`** — the 52 browser
  journeys, unchanged, against the real backend. The adapter maps `ev`/`snap`/
  `press`/`ss` onto WebDriver, resolves `import('/src/lib/…')` from
  `window.__MINOTES__.modules`, and `seed-demo` replays the mock's demo pages
  into the real database so the journeys' assumptions hold.

Both build first; set `DESKTOP_NO_BUILD=1` to reuse `target/debug/minotes-app`.
~20 min for the 52 journeys, ~4 min for the desktop ones. To run two at once give
each its own `DESKTOP_CHECK_DIR`, `DESKTOP_CHECK_DISPLAY` and `DESKTOP_CHECK_WD_PORT`.
Both run nightly on a plain Ubuntu runner (`.github/workflows/nightly.yml`); a
failed run uploads the shots, logs and `results.tsv` as an artifact.

**A journey that passes in browser mode but fails here is a mock/real divergence**
— the most valuable kind of finding. Reproduce it by hand with the driver, decide
whether the backend, the mock, or the test's assumption is wrong, and fix that.
(Example found this way: nested blocks rendered under the wrong parent because
the real backend returned blocks in flat position order.)

## 2. Driver

| Command | What it does |
|---|---|
| `$D up [--no-build] [--webdriver] [--keep] [--profile NAME]` | Start Xvfb, build, launch, wait. `--webdriver` enables the DOM commands. `--profile` picks the scratch HOME (two profiles = two devices); `--keep` keeps its data. |
| `$D restart` | Quit and relaunch on the same data (persistence checks). |
| `$D shot <name>` | Screenshot of the display (includes native dialogs) → path. **Read it.** |
| `$D click x y` / `key …` / `type …` | Real X input (xdotool). Window is at 0,0, so screenshot px == click px. Use for typing into the editor. |
| `$D cli <args>` | `minotes` CLI on the current profile's database. |
| `$D js '<body>'` / `eval '<expr>'` | Run JS in the app. `invoke(cmd, args)` calls a Tauri command. |
| `$D press <Combo>` | Real key event through WebDriver (`Control+k`, `Escape`). |
| `$D text <css>` / `wclick <css>` / `wshot <name>` / `snapshot [-i]` | Read / click / screenshot the webview / text snapshot. |
| `$D wait '<expr>' [s]` | Poll until truthy — use instead of `sleep`. |
| `$D expect <label> '<expr>'` / `expect-db <label> '<sql>' <want>` | Assertions; failures save a screenshot. |
| `$D errors` / `$D report` | Uncaught errors + CSP violations seen; pass/fail summary (exit 1 on failure). |
| `$D seed-demo` / `paste-image` / `fixture-pdf` | Demo pages; paste a PNG; make a test PDF. |
| `$D audit` | UX/accessibility signals for the current screen (JSON). |
| `$D status` / `log` / `down` | Health, app stderr, teardown. **Always `down` when finished.** |

Prefer selectors and `wait`/`expect` over pixel clicks and sleeps. Pixel clicks
are for things only real input reaches (typing in ProseMirror, canvas drawing,
native dialogs); take a screenshot first and read positions off it.

## 3. UX review

`ux-tour.sh [--no-build]` visits ~17 views (journal, rich/long/empty pages, editing,
search with/without results, settings, graph, mindmap, kanban, whiteboard, all
pages, trash) on a deliberately messy notebook, and for each writes a screenshot, an
audit JSON and a timing into `$DESKTOP_CHECK_DIR/ux/`, summarised in `tour.md`.

Then do the part a script can't: **look at every screenshot** and judge it. Report
findings as *improvement opportunities*, separate from bugs, each with the
screenshot, what a user would experience, and a concrete suggestion. Rubric:

- **First glance** — is it obvious what this screen is and what to do next? Is the
  primary action the most prominent thing?
- **Empty and edge states** — empty page, no search results, empty trash, first run:
  do they explain themselves and offer a next step, or just look blank/broken?
- **Hierarchy and density** — headings vs body, spacing rhythm, alignment; anything
  cramped, floating, or competing for attention?
- **Stress** — long titles, deep nesting, unbreakable strings, 30+ pages: truncation
  with no tooltip, overflow, wrapping that breaks the layout?
- **Consistency** — same thing styled the same way across views (buttons, panels,
  close affordances, icons vs text labels, terminology: "Project" vs "Folder")?
- **Feedback** — after an action, can the user tell it worked (toast, selection,
  focus)? Are destructive actions undoable or confirmed?
- **Discoverability** — is a feature only reachable by a shortcut nobody is told
  about? Are icon-only buttons understandable?
- **Polish** — misaligned icons, clipped text, inconsistent radii/borders, leftover
  debug-looking UI, emoji used as icons rendering differently per platform.

Use the audit numbers to back the visual judgement, not replace it: low contrast
(WCAG ratio per element), controls with no accessible name, click targets under
24 px, clipped text, missing focus rings, number of distinct font sizes, and view
timings. Treat timings as relative (software rendering under Xvfb is slow).

## 4. Signal tools (find what to improve)

Seven re-runnable tools turn "how can MiNotes be better?" into evidence. Each
writes a markdown report to `$DESKTOP_CHECK_DIR/signals/`, exits 0 unless the
tool itself breaks (findings are not failures), and takes `--no-build`. Full
usage and how to read each report: `signals-ux.md` and `signals-data.md`.

| Tool | Answers | Typical run |
|---|---|---|
| `parity.sh` | Where does the browser tests' mock behave differently from the real backend? 235 checks run side by side in the real app; divergences ranked with verdicts kept in `parity-notes.json` (new = UNREVIEWED, fixed = stale). | ~1 min |
| `friction.sh` | How many actions does each journey cost (static, from the suite) and how many keys/clicks do 8 core tasks take through the real UI? | ~5 min |
| `silent-errors.sh` | Which actions throw, reject or fail an IPC call — and was the user told? (wraps `ipc://` fetches, console, CSP, resource errors) | ~5 min |
| `dead-ends.sh` | For every view/panel/menu: does Escape close it, is there a visible close, does click-outside work, do you land back where you were? | ~5 min |
| `shortcuts.sh` | Does every advertised shortcut do what it says, in neutral state and inside the editor? Which work but are undocumented? | ~5 min |
| `scale-tour.sh [--sizes S,M,L]` | How do open/typing/search/backlinks/sidebar/graph behave at 2.5k / 7k / 22k blocks? | ~1 h for all sizes |
| `visual-diff.sh approve\|check\|noise` | Did any view's pixels change vs approved baselines? Clock frozen, animations off, unstable regions masked; threshold 0.02%. | ~5 min |

How to use them well:
- Run `parity.sh` after any backend or mock change; every new divergence means
  the browser tests may be passing on behaviour the app doesn't have.
- **Re-approve visual baselines** (`visual-diff.sh approve`) only after looking at
  the `check` diffs and agreeing the change is intended.
- Verify a surprising finding a second way (screenshot, DB query) before reporting
  it — the tools can misread the app (e.g. a list that expands upward).
- Treat timings as relative: Xvfb uses software rendering.
- When reporting, tag each finding BUG / UX IMPROVEMENT / TEST-FIDELITY GAP /
  PERFORMANCE / HARNESS LIMITATION, with evidence.

## 5. Security probes (webdriver)

Each must hold in the shipped app:

- `js 'try { eval("1"); return "NOT blocked" } catch { return "blocked" }'` → blocked (CSP)
- `js 'return typeof window.__TAURI__'` → `"undefined"`
- `invoke("read_file_base64", {path: "/etc/passwd"})`, `invoke("read_pdf_file", {path: "/etc/passwd"})` → rejected
- `invoke("switch_notebook", {key: "../../evil"})`, `invoke("run_query", {sql: "BEGIN"})` → rejected
- SSRF: serve a page with a distinctive `<title>` on `127.0.0.1:<port>`, call
  `invoke("fetch_og_metadata", {url})` for `127.0.0.1`, `localhost`, `[::1]`,
  `0.0.0.0` — the title must NOT come back and the server log must show no request.
  (The command returns empty metadata on any failure, so an empty result alone
  proves nothing.)
- **Never call `save_png_to_downloads`** — on WSL it writes into the real Windows
  Downloads folder regardless of the scratch HOME. `save_export_file` (mind map
  exports) opens a native save dialog that blocks the IPC call — intercept it in
  `fetch` as journey 58 does instead of letting it run.
- `down` kills the app's whole process group (tauri-driver, WebKitWebDriver,
  dbus-daemon included). If a run was killed before `down`, check `ps` for stray
  `tauri-driver`/`WebKitWebDriver` before the next run: a leftover app on the same
  display receives your keystrokes too (doubled typed text, bogus failures).

## Limits and gotchas

- Needs `webkit2gtk-driver` (apt) and `tauri-driver` (cargo) for `--webdriver`.
  `withGlobalTauri` is off, so use the `invoke` helper `js` provides.
- ProseMirror ignores synthetic key events: type with `$D click`/`$D type`/`$D key`
  (or `focusBlock(n)` then `$D type`), and read back with `eval`.
- OS file drag-drop can't be simulated; `paste-image` exercises the same insert path.
- JS `prompt()`/`confirm()` are native GTK dialogs: `type` + `key Return`; they show
  in `shot`, not `wshot`.
- Xvfb must use Mesa EGL here (the script sets `__EGL_VENDOR_LIBRARY_FILENAMES`;
  the NVIDIA vendor aborts it) and listens on TCP only (WSLg owns `/tmp/.X11-unix`).
  Never use WSLg's `DISPLAY=:0`.
- Launches run on a private D-Bus session (`dbus-run-session`), which avoids a ~25 s
  stall on the shared bus here; set `DESKTOP_CHECK_DBUS=0` to test the OS keychain.
  `DESKTOP_CHECK_JS_TIMEOUT_MS` raises the 60 s per-script WebDriver limit.
- Don't `pgrep -f`/`pkill -f` a pattern that appears in your own command line; use `$D down`.
- JS passed on a command line must not contain `'`; put longer scripts in a file
  and pass `"$(cat file.js)"`.
