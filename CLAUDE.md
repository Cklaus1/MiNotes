# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# MiNotes — Project Guide

## What is this?

Local-first knowledge management app (Logseq/Obsidian alternative). Rust backend + React/TypeScript frontend + Tauri 2 desktop shell.

## Architecture

```
crates/
├── minotes-core/     # Rust library — SQLite, models, repo layer, search, sync, CRDT
├── minotes-cli/      # CLI binary — `minotes` command, Clap 4, 5 output formats
└── minotes-app/
    ├── src/           # React 19 frontend (TypeScript, Vite)
    │   ├── components/   # UI: Sidebar, PageView, BlockItem, Whiteboard, etc.
    │   ├── editor/       # TipTap editor: useBlockEditor, WikiLinkNode, slashCommands, BubbleToolbar
    │   └── lib/          # api.ts (Tauri invoke), mockBackend.ts (browser dev), settings, testApi
    └── src-tauri/src/    # Tauri 2 backend commands (lib.rs)
```

## Key patterns

- **`api.ts` auto-detects Tauri vs browser** — uses real `invoke()` in Tauri, mock handlers in Chrome
- **`mockBackend.ts`** — in-memory mock for browser dev/testing. Seeds 6 pages.
- **`localBlocks` in PageView** — optimistic state for blocks. Prevents full re-render on Enter/edit.
- **Block tree** — blocks have `parent_id` + `position`. Tree computed in `blockTreeInfo`.
- **Block refs / embeds** — `((uuid))` is an inline chip whose text comes from `lib/blockRefs.ts` (one app-wide cache, batched `get_blocks`, relabels every `.block-ref` chip when the source changes — `noteBlockContent` on saves); the markdown only stores the uuid. `{{embed ((uuid))}}` (Logseq syntax) is the same node with `embed`, shown as a card under the block (BlockItem `EmbedCard`).
- **Whiteboard per-block** — content `{{whiteboard:<id>}}`, data in the SQLite `whiteboards` table (`get_whiteboard`/`save_whiteboard`), utils in `lib/whiteboardUtils.ts`. Legacy `minotes-whiteboard-<id>` localStorage entries are imported into the DB on first open (the localStorage copy is kept as a backup). Git sync exports each referenced board to `<syncdir>/.minotes-whiteboards/<id>.json` (newer `updated_at` wins); markdown/site export writes the same sidecars. Boards are never deleted with their block (undo must be able to restore it) — `gc_whiteboards()` removes unreferenced ones after empty-trash / permanent deletes; a deleted/edited block keeps its board (and attachments) referenced for `EVENT_HORIZON_DAYS` (30). The event log is a bounded change feed for sync (compacted past the horizon), not an undo history — there is no backend undo. A board always belongs to the page it is opened from: Ctrl+W / sidebar Draw start a NEW board whose block is appended to the current page on its first content (the canvas bar says "New board · added to “Page” when you draw"); the Draw tab with no board open offers that page's boards or a new one; the open board is forgotten when the canvas closes. Boards follow the app theme (`canvasTheme: "auto"`; colours are stored as the dark palette and drawn as their Latte twins on a light canvas). An arrow drawn on a shape stores `from`/`to` refs and its ends are recomputed whenever a shape changes (`lib/whiteboardGeometry.ts`, pure + tested); the board handles its own Ctrl+Z/Y (stopped at the board, so the page undo never runs).
- **Mirror / sync dir trust rules** — never read or write through a symlink below the mirror root: use `export::read_below` / `symlink_below` / `link_in_the_way` and `atomic_write` (refuses links), not `fs::read`/`fs::write`. All git goes through `git_cmd::run_git` (hooks, fsmonitor, `ext::` and symlinks disabled on every call). A folder notebook whose sync was set up on another machine (no token in `~/.minotes/sync-trust.json`) does not sync until `confirm_sync` (UI: "Sync it here" banner). Enabling sync flushes the mirror first and imports only what the pull changed.
- **Markdown mirror ↔ outside edits** — the mirror (`mirror.rs`) records a sha256 per page file; it never overwrites or prunes a file whose hash changed. `outside.rs` imports such edits (id-preserving reconcile; removed lines → a Trash page; both sides changed → "(edited outside)" copy; new file → page; deleted file → trash, mass-delete guarded). The app watches the mirror folder (`notebooks.rs`, event `outside-edits` → `lib/outsideEdits.ts`). Own writes are recognised by hash, never by mtime.
- **Git sync status** — one store, `lib/syncStatus.ts` (App runs cycles, the sidebar `SyncChip` and Settings read it; "Sync now" = `requestSyncNow()`). `last_sync` means a push reached the remote (never set without a remote, hidden while a copied folder waits for "Sync it here"); the last error and its `sync_error_kind` (offline / remote_not_found / auth / other) live in the sync config — only network failures are "offline". Two devices' same-titled pages: numbering is idempotent (`unique_page_title`: "X (2)" → "X (3)"); this device's untouched onboarding page (`mark_onboarding_seed`, in `ui_state`) gives way to a pulled page of that title.
- **Sync setup in the app (UX Wave 4)** — Settings → Sync & Backup (`SyncRemoteSettings`, `RemoteAddressField`): address → Test connection → Set up sync; Change… / Remove. Core `sync_remote.rs` validates every address before git runs (no `<helper>::` like `ext::`, no leading `-`, no control chars, no password/token in a URL, no `git://`; local paths only in home — not a hidden top-level dir — or on external drives, or picked via `pick_sync_remote_folder`, which is the only way to allow another folder) and classifies `git ls-remote` (20 s). `sync_manager::setup_sync_with` / `change_remote` / `remove_sync_remote`; `get_sync_status` shows the remote while sync is off. MiNotes never handles credentials (git's SSH agent / credential helper; prompts off). "Join an existing notebook…" = `join_notebook` (plain: `sync_remote::join_plain`; `ENCRYPTED_REMOTE:` → the dialog asks for the passphrase → `join_from_remote`). Browser mock: `lib/syncMock.ts` (`mockRemotes`).
- **Sync conflict copies** — "<title> (conflict from <device>)", named after the device in the other version's sync commit (`git_cmd::device_of_last_change`), never this machine. Their block ids are `conflict_block_id(copy, original)`, so `repo/conflicts.rs` pairs blocks exactly (older copies: aligned on equal text). Banner + Compare (`ConflictBanner`, `ConflictCompare`); `resolve_conflict` applies Keep mine / theirs / both and trashes the copy in one transaction; undo type `conflict-resolve` → `set_conflict_resolution`. Block search leaves copies out. Held deletions list every item (`HeldDeletions.items`); `git_sync_resolve_deletions(action, keep)` keeps the ticked ones.
- **Remote images are blocked by default** — a web-address image renders as a `.remote-img` placeholder (Image node `renderHTML`), never an `<img src="https://…">`; `lib/remoteImages.ts` fills it with a `blob:` from the backend `fetch_remote_image` (SSRF-safe, `src-tauri/src/remote_images.rs`) once allowed (Settings → Privacy: Never/Ask/Always, per-notebook always, page bar). The CSP has no `https:` in `img-src`, so never load a remote image any other way. Clicking a blocked placeholder loads just that image (this session; not in Never mode).
- **Tasks view, not a page** — the sidebar TODO badge opens `TasksView` (backend `list_tasks`, core `parse_task_line`; its pending lines are exactly the badge's `parse_pending_todo`). Toggles rewrite the task's own line in the real block (`lib/tasks.ts setTaskState`). Never generate a page of `{{todo:…}}` lines again; `cleanup_generated_todo_pages` trashes the old generated "All TODOs" pages once per notebook (`ui_state` flag `cleanup.all-todos-v1`).
- **Window title** — `lib/windowTitle.ts` ("Page — Notebook — MiNotes"; locked: "Locked — Notebook — MiNotes", never a page title), set on `document.title` and the native window. The desktop harness finds the window by a title *ending* in "MiNotes".
- **One UI system (UX Wave 3)** — selects, checkboxes, radios and disabled buttons are styled once in `styles.css` (`:where()` rules, both themes, `color-scheme`); a disabled primary button says why in a `.disabled-reason` next to it (or its `title`). Icons come from `lib/icons.ts` / `<Icon name=…/>` (Lucide shapes as path data) — no emoji as UI icons (`npm test` lint; user-picked page/project icons are content). Colours only from the theme tokens (`--text-muted` is a real colour now: never define a variable from itself — `npm test` lint).
- **Esc rule** — `lib/layers.ts`: every popover / menu / dialog / side panel / canvas registers (`useLayer(open, kind, close)`; `useEscapeToClose` wraps it); Esc closes only the topmost (popover > menu > dialog > panel > canvas, newest first), after every other handler, and never when something used the key (`preventDefault`; `data-escape-local` fields). Canvases with their own Esc steps check `coveredAbove("canvas")`; no new window-level Escape listeners that close things.
- **Tooltips** — keep writing `title=` (and `aria-label` on icon buttons): `lib/tooltip.ts` (installed in `main.tsx`) lifts the title only while hovered and shows the app's bubble — never while a menu/popover/dialog is open (unless inside it), never over a menu, placed away from the pointer.
- **Dialogs** — `Modal` (or `useDialogFocus(ref, open)` for a dialog with its own frame) moves focus in, traps Tab and gives focus back on close; `role="dialog"` + `aria-modal`. No `prompt()`: `promptDialog` (`lib/confirm.ts`), the sidebar's New page field (`lib/newPage.ts`) or a native picker.
- **Progress** — slow operations go through `withBusy(label, fn, { done })` (`lib/busy.ts`): a busy pill in the same task as the click, input held (after `settleInput` lets queued keys land), then a toast. Used by notebook switch, lock, unlock, notebook .zip export/import.
- **Page-title queries** — `api.findPagesByTitle`, `titleInUse`, `findJournalPage`, `listJournalPages`, `linkCandidates` (core `repo/page_titles.rs`, mock too) look at every page. Never `listPages(N)` + a frontend filter: it misses pages past the first N (U-6).
- **Sidebar** — collapsible (header button, Ctrl+Shift+\, remembered in localStorage); a drawer below 900 px (`lib/sidebarLayout.ts`). Ctrl+/ (and the palette) opens the shortcut list (`lib/shortcuts.ts`, also shown in Settings, which has a section index).
- **Visual views (UX Wave 4)** — remembered views are page properties written only on an explicit choice (`view:: kanban|mindmap`, `kanban-group:: status`, `mindmap-layout::`; `lib/pageView.ts`, App opens a page in its view). Card and node text comes from `lib/richText.ts` (link chips, never raw `[[x|id]]`). Graph data carries `folder_id` + inline `tags`; filters / local graph / arrow keys are `lib/graphModel.ts`. Images and files in blocks: `lib/media.ts` + `MediaHost` (lightbox, `![alt|300](src)` width, attachment chips) post-process only `.block-static`, never a live ProseMirror DOM; `reveal_attachment` only shows a file, never opens it.
- **Back / forward (UX Wave 4)** — `lib/navHistory.ts`: App reports where the user is (`noteLocation`: page, journal day, view `tasks|pages|trash|archive|graph`, notebook key) and performs a step (`setNavExecutor`). It lives outside App (the lock gate unmounts App): keys Ctrl+[ / Ctrl+] and mouse buttons 3/4 are installed in `main.tsx`; a step into another notebook switches first and App takes it with `takePendingNav` (after the switch, or after unlocking — so Back into a locked notebook shows its unlock screen, then the page). Arrows: `<NavButtons/>` (sidebar action bar; floating while the sidebar is hidden). Alt+←/→ stay block zoom.
- **Command palette** — commands come from one registry, `lib/commands.ts` (`useCommands(source, build, deps)`; app-wide ones in `lib/appCommands.ts`; `pick` asks a second choice — notebook, project). Add a command there, never a new SearchPanel prop. Ranking everywhere is `lib/fuzzy.ts` (exact > prefix > word start > inside a word > words in any order > letters in order > typos; `rankCommands` adds keywords and recently run commands); search shows Pages / Blocks / Journals / Other notebooks sections with Tab-cycled filters and `<mark class="palette-hit">` highlights.
- **Main-pane views** — App's `mainView` (`tasks | pages | trash | archive`) replaces the page (the sidebar stays): `TasksView`, `AllPagesView` (bulk move/pin/archive/trash, keyboard rows), `TrashView` (Trash and Archive: preview, dates, multi-select, confirm with counts). The sidebar's Trash/Archive entries only open them; its optional Recent section is `lib/sidebarRecent.ts` (live pages only).
- **React Fast Refresh** — component .tsx files must ONLY export React components. Utility exports break HMR.
- **Cross-notebook** — `[[Notebook::Page]]` links live in `notebook_links` (target notebook key + page id), never in `links`; other notebooks are only opened via `cross_notebook::open_read_only` (no migrations, no lock). Search palette "All notebooks" toggle → `search_other_notebooks`; CLI `search --all-notebooks`. A chip into a locked notebook offers "Unlock and open" (in-app passphrase, `unlockAndOpen`); a not-found chip in an existing notebook asks "Create page in <Notebook>" (`lib/crossNotebook.ts`). See PRD-notebooks §10 (Android storage: §11).
- **Encrypted notebooks** (PRD-encryption) — whole database via SQLCipher; key slots in `notebook.json` (`encryption`, format 2, no name); `core/src/encryption.rs` holds the process-wide unlocked-key cache that `Notebook::open_db` / `open_read_only` consult (`Error::Locked` otherwise). In the app `AppState.db` is `Option<Database>` — always go through `state.db_guard()?` (a locked notebook → `NOTEBOOK_LOCKED: …`); `LockGate` unmounts the app while locked. Encrypted notebooks have **no plaintext mirror** (`mirror::run` refuses them); git sync moves only encrypted `.mne` files (`core/src/sync_encrypted.rs`: per-block merge after decryption, fails closed on another notebook's remote, other devices "Join encrypted notebook…" with the passphrase), attachments live in the DB (`attachment_blobs`), recent pages in `ui_state`, never localStorage. Tests use the debug-only fake keychain (`MINOTES_FAKE_KEYCHAIN_DIR`) — never the real OS keychain. CLI: `MINOTES_PASSPHRASE` or a TTY prompt.

## Build & test

```bash
# Install frontend dependencies (required first time)
cd crates/minotes-app && npm install

# Frontend dev server (browser mode with mock backend)
cd crates/minotes-app && npx vite --port 1420

# TypeScript check (must run from crates/minotes-app/)
cd crates/minotes-app && npx tsc --noEmit

# Frontend unit tests (vitest + jsdom: editor markdown round trip, confirm dialog, source lints)
cd crates/minotes-app && npm test

# Vite production build
cd crates/minotes-app && npx vite build

# Rust check
cargo check -p minotes-app
cargo check -p minotes-cli

# Rust unit tests
cargo test

# Run user journey tests (requires dev server on :1420; JOURNEY_URL points elsewhere)
bash tests/user-journey-test.sh
JOURNEY_URL=http://localhost:1591 bash tests/user-journey-test.sh   # vite started with --port 1591

# Desktop app (Tauri dev mode)
cd crates/minotes-app && npm run tauri dev

# Journeys against the REAL desktop app (real backend, production CSP) — see .claude/skills/desktop-check
JOURNEY_BACKEND=desktop bash tests/user-journey-test.sh   # the browser journeys on the real backend
bash tests/desktop-journey-test.sh                        # restart persistence, real typing, CLI interop, 2-device sync
.claude/skills/desktop-check/ux-tour.sh                   # screenshot + UX audit of every main view

# CLI
cargo run -p minotes-cli -- --notebook ~/.minotes/default.db page list
cargo run -p minotes-cli -- --notebook "Work" page list      # by name; also a notebook folder
cargo run -p minotes-cli -- notebook list                     # notebook create|open|rename|delete|current
```

## Testing

- Tests use `agent-browser` (headless Chrome via CDP) — must be installed separately
- Test API exposed on `window.__MINOTES__` for automation
- 95 user journeys, ~735 assertions in `tests/user-journey-test.sh` (browser + mock by default; `JOURNEY_BACKEND=desktop` runs them on the real app); journey 65 = encrypted notebooks, 66–67 = confirmations before permanent deletes / a whole-page delete, 68 = visual views (previews, exports, kanban, graph, mind map, PDF, whiteboard), 69–77 = editor Wave 2 (collapse, drag, split/merge, DONE, / menu, suggestions, backlinks, block refs/embeds, structured paste), 78 = sync status and AI entry points (via `mockSync`), 79–84 = navigation Wave 2 (nested projects, Tasks view, journal days, Manage notebooks order, window title, search results), 85–91 = one UI system Wave 3 (Esc closes the topmost layer, Ctrl+N without a native prompt, switch progress, tooltips vs menus, link suggestions with >100 pages, sidebar collapse/drawer, dialog focus + Ctrl+/), 92–95 = sync Wave 4 (remote setup / Test connection / change / remove, Join plain + encrypted, conflict compare + undo, held-deletion review; mock remotes via `lib/syncMock.ts`). Desktop journeys D1–D20 (~400 assertions) in `tests/desktop-journey-test.sh`; D7 covers outside edits of the markdown copy, D8 cross-notebook search and links, D9 notebook zip export/import, D13 encrypted notebooks + the leak scan, D14 two-device encrypted sync, D15 real input (an image pasted through the X clipboard, typed `#tag` / `==highlight==`, the app's confirm dialog), D16 the outline under real input (collapse-arrow click, real drags, markdown pasted from the X clipboard, typed ```` ```lang ```` + Enter), D17 sync status and a clean join (two devices: one Getting Started, conflict toast + Open, missing remote → error + Retry, Paused after "Not now", Ask against a dead local server), D18 navigation with real clicks (nested project, Tasks tick → DONE in the DB, old All TODOs page trashed on restart, journal Prev, Manage rename, the real window title), D19 the UI system under real input (Ctrl+N without a GTK prompt, Esc layer by layer, real-hover tooltip vs the open page menu, switch busy < 100 ms + toast, app-drawn selects, Ctrl+Shift+\ remembered across a restart), D20 sync set up and resolved in the app (typed remote, Test connection wrong/right, Set up sync, Join from a second device whose HOME is inside the first's so the bare remote is in both homes, a real same-block conflict resolved with Keep both / Keep theirs, both databases checked). A journey must define the shell helpers it uses (they may run on their own).
- `get_page_blocks`/`getPageTree` return blocks in **outline order** (depth-first, siblings by position). Positions are per-parent — never sort a page's blocks by position alone; after a structural change rebuild the list with `outlineOrder` (`lib/blockTree.ts`, also `applyDrop` for drag and drop).
- ProseMirror doesn't respond to CDP keyboard events — use `window.__MINOTES__` API instead
- Browser-mode tests use the mock backend and don't enforce the CSP. For anything Tauri-only use the `desktop-check` skill (Xvfb + xdotool + screenshots against a throwaway HOME).
- PDFs open via the `read_pdf_file` command (bytes over IPC); the webview can't fetch filesystem paths.

## CI (GitHub Actions, `.github/workflows/`)

- **`ci.yml`** — every push to `main` and every PR (superseded runs cancelled): `rust` (`cargo check -p minotes-app -p minotes-cli`, `cargo test --workspace`, both `--locked`), `frontend` (`npm ci`, `tsc --noEmit`, `npm test`, `vite build`), `journeys` (vite on :1591 + `JOURNEY_URL=http://localhost:1591 bash tests/user-journey-test.sh` in headless Chrome via `agent-browser@0.22.1`; screenshots + logs uploaded on failure), `audit` (`cargo audit`, `npm audit --omit=dev --audit-level=high`).
- **`nightly.yml`** — 03:17 UTC daily + manual: builds the debug app, then `tests/desktop-journey-test.sh` and `JOURNEY_BACKEND=desktop DESKTOP_NO_BUILD=1 bash tests/user-journey-test.sh` on Xvfb (tauri-driver + WebKitWebDriver); shots, logs and `results.tsv` uploaded on failure.
- **`release-android.yml`** — manual or `v*` tag: debug APK for x86_64 + aarch64 (NDK 27.0.12077973, JDK 17), uploaded as an artifact. No signing secrets.
- Rules: `permissions: contents: read`, no secrets, `pull_request` only (never `pull_request_target`), third-party actions pinned to full commit SHAs (bump the SHA and its `# vX` comment together). Lint workflow edits with `actionlint`.
- Reproduce a job locally by running its `run:` lines from the repo root (journeys: a free port, never 1420). Runners have no git identity, so the workflows set one system-wide; the journeys use `AGENT_BROWSER_ARGS=--disable-gpu,--disable-software-rasterizer` and their own `AGENT_BROWSER_SESSION`.

## Important gotchas

- **Never export non-components from .tsx files** — breaks Vite React Fast Refresh, blanks the app
- **Never `window.confirm` / `alert` / `prompt`** — in the desktop app the dialog plugin makes `confirm` return a Promise (always truthy) and `prompt` is a bare GTK dialog. Use `await confirmDialog({...})` / `await promptDialog({...})` (`lib/confirm.ts`, rendered by `ConfirmHost`); `npm test` fails on a `confirm(`/`alert(`/`prompt(` in `src`
- **Every editor mark/node needs a markdown serializer AND parser** — add a case to `src/editor/markdownRoundTrip.test.ts` (tiptap-markdown writes `[name]` for a node without one)
- **`PageTree` has no `#[serde(flatten)]`** — frontend expects `tree.page.title` not `tree.title`
- **`move_block` requires non-null parent** — use `reorder_block` for root-level blocks
- **TipTap blur→save→sync cycle** — slash commands that use TipTap API lose formatting during save. Headings use markdown text approach instead.
- **WebKitGTK (Tauri)** needs explicit `editor.commands.focus()` on block click — Chrome handles contenteditable focus automatically
- **`npx tsc` must run from `crates/minotes-app/`** — running from repo root finds wrong tsconfig

## CLI output formats

`--format` / `-f` flag: `json` (default), `text`, `md`, `csv`, `opml`

## CLI gotchas

- **`--notebook <name|folder|path>` (`-n`) selects the database**; without it the CLI uses the app's open notebook (key in `~/.minotes/active_graph`: a legacy `~/.minotes/<name>.db` or a folder notebook). A leading `~` is expanded. An explicit `.db` path that doesn't exist is an error unless `--create` is passed. `--graph <path>` is a hidden, deprecated alias (path only; prints a notice on stderr, never stdout).
- **"graph" means only the link graph** (Graph view, `minotes graph data|neighbors|stats`, `repo/graph.rs`). Databases are "notebooks" everywhere (CLI, Tauri commands `switch_notebook`/`get_current_notebook`, `api.ts`). On-disk names keep the old word: `~/.minotes/active_graph`, `~/.minotes/<name>.db`, `~/MiNotes_Sync[-<name>]` — don't rename them.
- **`minotes notebook create <name>`** makes a folder notebook at `~/MiNotes/<name>` (`--location <dir>` to choose), exactly like the app; `minotes notebooks` still lists.
- **`page delete` moves to trash** (like the app). Hard delete needs `--permanent --yes` (or a TTY confirmation).
- **`page create` has no `--folder` flag** — create the page first, then assign it: `minotes folder add-page <page-id> <folder-id>`. Using `property set folder_id` does nothing (that key is not the DB column).
- **`page get <title>`** returns page + all blocks by default. Use `--no-blocks` for metadata only.

## Android

```bash
cd crates/minotes-app && ANDROID_HOME=~/Android/Sdk NDK_HOME=~/Android/Sdk/ndk/27.0.12077973 \
  RANLIB_x86_64_linux_android=~/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ranlib \
  npx tauri android build --debug --apk --target x86_64   # emulator; drop --target for all ABIs
# → src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

SQLite is **SQLCipher** (`rusqlite` feature `bundled-sqlcipher-vendored-openssl`, workspace-wide):
plaintext notebooks are ordinary SQLite files; OpenSSL is built from source. The NDK only ships
`llvm-ranlib`, so set `RANLIB_<target>` (as above; `RANLIB_aarch64_linux_android` etc. for other ABIs).

- **All paths come from `minotes_core::notebook`** (`base_dir`, `home_dir`, `notebooks_dir`, `default_location`, `legacy_mirror_dir`). Never read `$HOME` directly — Android has none (the pre-fix APK died opening `./.minotes/default.db`). On Android `platform::init_app_storage` injects the app data dir at startup: `<app_data>` = the old `~/.minotes`, folder notebooks in `<app_data>/notebooks/<name>/`.
- **SQLite never runs on a picker `content://` URI.** The picker is only for copies: `export_notebook_zip` / `import_notebook_zip` (core `notebook_zip`), via `tauri-plugin-fs` on Android.
- **Gate desktop-only UI on `useCapabilities()`** (`get_platform_capabilities`), never the user agent. Android: no folder choosing/opening/revealing/moving, no outside-edit watcher, mirror only while git sync is on, no Obsidian/Evernote import, no keychain (`keyring` is not compiled for Android).
- The window is created in `setup` (`"create": false` in tauri.conf.json) after `AppState` is managed — the data dir is only known there on mobile.
- Emulator on this WSL host: `adb start-server` hangs; run `adb -P <port> nodaemon server` in the background instead, and boot with `-no-window -gpu swiftshader_indirect`. Data: `adb shell run-as com.minotes.app ls` (debug APK).

## Running on WSLg

```bash
cd crates/minotes-app && \
  LIBGL_ALWAYS_SOFTWARE=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  GDK_BACKEND=x11 \
  npm run tauri dev
```

Without these flags, WebKit fails silently (MESA/Zink GPU errors) and no window appears.

## PRDs

- `docs/PRD-editor-improvements.md` — 10 editor/UX features (tables, templates, kanban, etc.)
- `docs/PRD-encryption.md` — whole-notebook encryption (SQLCipher, wrapped key, recovery key)
- `docs/PRD-git-sync.md` — Git-based sync with conflict resolution
- `docs/PRD-kanban.md` — Kanban board view
- `docs/PRD-mindmap.md` — ReactFlow + dagre mind map view
- `docs/PRD-sidebar-navigation.md` — Sidebar navigation design
- `docs/PRD-notebooks.md` — notebooks: sidebar switcher, markdown mirror, notebook folders
- `docs/PRD-import.md` — import from Obsidian, Evernote (.enex), markdown folders; attachment store
- `docs/PRD-plugin-architecture.md` — sandboxed (Wasm + iframe) plugins and a free public marketplace
- `docs/ARCH-findings.md` — architecture review (2026-10-12): ~60 findings by layer, P0/P1/P2 plan, target architecture
- `docs/UX-review-2026-10.md` — hands-on UI review of every feature on the real app: 72 features rated 0–10, top bugs, plan by wave
