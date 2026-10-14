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
- **Whiteboard per-block** — content `{{whiteboard:<id>}}`, data in the SQLite `whiteboards` table (`get_whiteboard`/`save_whiteboard`), utils in `lib/whiteboardUtils.ts`. Legacy `minotes-whiteboard-<id>` localStorage entries are imported into the DB on first open (the localStorage copy is kept as a backup). Git sync exports each referenced board to `<syncdir>/.minotes-whiteboards/<id>.json` (newer `updated_at` wins); markdown/site export writes the same sidecars. Boards are never deleted with their block (undo must be able to restore it) — `gc_whiteboards()` removes unreferenced ones after empty-trash / permanent deletes; a deleted/edited block keeps its board (and attachments) referenced for `EVENT_HORIZON_DAYS` (30). The event log is a bounded change feed for sync (compacted past the horizon), not an undo history — there is no backend undo.
- **Mirror / sync dir trust rules** — never read or write through a symlink below the mirror root: use `export::read_below` / `symlink_below` / `link_in_the_way` and `atomic_write` (refuses links), not `fs::read`/`fs::write`. All git goes through `git_cmd::run_git` (hooks, fsmonitor, `ext::` and symlinks disabled on every call). A folder notebook whose sync was set up on another machine (no token in `~/.minotes/sync-trust.json`) does not sync until `confirm_sync` (UI: "Sync it here" banner). Enabling sync flushes the mirror first and imports only what the pull changed.
- **Markdown mirror ↔ outside edits** — the mirror (`mirror.rs`) records a sha256 per page file; it never overwrites or prunes a file whose hash changed. `outside.rs` imports such edits (id-preserving reconcile; removed lines → a Trash page; both sides changed → "(edited outside)" copy; new file → page; deleted file → trash, mass-delete guarded). The app watches the mirror folder (`notebooks.rs`, event `outside-edits` → `lib/outsideEdits.ts`). Own writes are recognised by hash, never by mtime.
- **Remote images are blocked by default** — a web-address image renders as a `.remote-img` placeholder (Image node `renderHTML`), never an `<img src="https://…">`; `lib/remoteImages.ts` fills it with a `blob:` from the backend `fetch_remote_image` (SSRF-safe, `src-tauri/src/remote_images.rs`) once allowed (Settings → Privacy: Never/Ask/Always, per-notebook always, page bar). The CSP has no `https:` in `img-src`, so never load a remote image any other way.
- **React Fast Refresh** — component .tsx files must ONLY export React components. Utility exports break HMR.
- **Cross-notebook** — `[[Notebook::Page]]` links live in `notebook_links` (target notebook key + page id), never in `links`; other notebooks are only opened via `cross_notebook::open_read_only` (no migrations, no lock). Search palette "All notebooks" toggle → `search_other_notebooks`; CLI `search --all-notebooks`. See PRD-notebooks §10 (Android storage: §11).
- **Encrypted notebooks** (PRD-encryption) — whole database via SQLCipher; key slots in `notebook.json` (`encryption`, format 2, no name); `core/src/encryption.rs` holds the process-wide unlocked-key cache that `Notebook::open_db` / `open_read_only` consult (`Error::Locked` otherwise). In the app `AppState.db` is `Option<Database>` — always go through `state.db_guard()?` (a locked notebook → `NOTEBOOK_LOCKED: …`); `LockGate` unmounts the app while locked. Encrypted notebooks have **no plaintext mirror** (`mirror::run` refuses them); git sync moves only encrypted `.mne` files (`core/src/sync_encrypted.rs`: per-block merge after decryption, fails closed on another notebook's remote, other devices "Join encrypted notebook…" with the passphrase), attachments live in the DB (`attachment_blobs`), recent pages in `ui_state`, never localStorage. Tests use the debug-only fake keychain (`MINOTES_FAKE_KEYCHAIN_DIR`) — never the real OS keychain. CLI: `MINOTES_PASSPHRASE` or a TTY prompt.

## Build & test

```bash
# Install frontend dependencies (required first time)
cd crates/minotes-app && npm install

# Frontend dev server (browser mode with mock backend)
cd crates/minotes-app && npx vite --port 1420

# TypeScript check (must run from crates/minotes-app/)
cd crates/minotes-app && npx tsc --noEmit

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
- 65 user journeys, ~473 assertions in `tests/user-journey-test.sh` (browser + mock by default; `JOURNEY_BACKEND=desktop` runs them on the real app); journey 65 = encrypted notebooks. Desktop journeys D1–D13 (~252 assertions) in `tests/desktop-journey-test.sh`; D7 covers outside edits of the markdown copy, D8 cross-notebook search and links, D9 notebook zip export/import, D13 encrypted notebooks + the leak scan, D14 two-device encrypted sync. A journey must define the shell helpers it uses (they may run on their own).
- `get_page_blocks`/`getPageTree` return blocks in **outline order** (depth-first, siblings by position). Positions are per-parent — never sort a page's blocks by position alone.
- ProseMirror doesn't respond to CDP keyboard events — use `window.__MINOTES__` API instead
- Browser-mode tests use the mock backend and don't enforce the CSP. For anything Tauri-only use the `desktop-check` skill (Xvfb + xdotool + screenshots against a throwaway HOME).
- PDFs open via the `read_pdf_file` command (bytes over IPC); the webview can't fetch filesystem paths.

## CI (GitHub Actions, `.github/workflows/`)

- **`ci.yml`** — every push to `main` and every PR (superseded runs cancelled): `rust` (`cargo check -p minotes-app -p minotes-cli`, `cargo test --workspace`, both `--locked`), `frontend` (`npm ci`, `tsc --noEmit`, `vite build`), `journeys` (vite on :1591 + `JOURNEY_URL=http://localhost:1591 bash tests/user-journey-test.sh` in headless Chrome via `agent-browser@0.22.1`; screenshots + logs uploaded on failure), `audit` (`cargo audit`, `npm audit --omit=dev --audit-level=high`).
- **`nightly.yml`** — 03:17 UTC daily + manual: builds the debug app, then `tests/desktop-journey-test.sh` and `JOURNEY_BACKEND=desktop DESKTOP_NO_BUILD=1 bash tests/user-journey-test.sh` on Xvfb (tauri-driver + WebKitWebDriver); shots, logs and `results.tsv` uploaded on failure.
- **`release-android.yml`** — manual or `v*` tag: debug APK for x86_64 + aarch64 (NDK 27.0.12077973, JDK 17), uploaded as an artifact. No signing secrets.
- Rules: `permissions: contents: read`, no secrets, `pull_request` only (never `pull_request_target`), third-party actions pinned to full commit SHAs (bump the SHA and its `# vX` comment together). Lint workflow edits with `actionlint`.
- Reproduce a job locally by running its `run:` lines from the repo root (journeys: a free port, never 1420). Runners have no git identity, so the workflows set one system-wide; the journeys use `AGENT_BROWSER_ARGS=--disable-gpu,--disable-software-rasterizer` and their own `AGENT_BROWSER_SESSION`.

## Important gotchas

- **Never export non-components from .tsx files** — breaks Vite React Fast Refresh, blanks the app
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
