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
- **Whiteboard per-block** — content `{{whiteboard:<id>}}`, data in localStorage, utils in `lib/whiteboardUtils.ts`
- **React Fast Refresh** — component .tsx files must ONLY export React components. Utility exports break HMR.

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

# Run user journey tests (requires dev server on :1420)
bash tests/user-journey-test.sh

# Desktop app (Tauri dev mode)
cd crates/minotes-app && npm run tauri dev

# CLI
cargo run -p minotes-cli -- --graph ~/.minotes/default.db page list
```

## Testing

- Tests use `agent-browser` (headless Chrome via CDP) — must be installed separately
- Test API exposed on `window.__MINOTES__` for automation
- 37 user journeys, ~190 assertions in `tests/user-journey-test.sh`
- ProseMirror doesn't respond to CDP keyboard events — use `window.__MINOTES__` API instead

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

- **`--graph` requires an absolute path** — `~` is not expanded by the Rust arg parser. Use `$HOME/.minotes/default.db` or the full path.
- **`page create` has no `--folder` flag** — create the page first, then assign it: `minotes folder add-page <page-id> <folder-id>`. Using `property set folder_id` does nothing (that key is not the DB column).
- **`page get <title>`** returns page + all blocks by default. Use `--no-blocks` for metadata only.
- **Block content starting with `-`** trips up Clap's arg parser — quote it or use `--` before the content.

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
- `docs/PRD-encryption.md` — per-folder AES-256-GCM encryption
- `docs/PRD-git-sync.md` — Git-based sync with conflict resolution
- `docs/PRD-kanban.md` — Kanban board view
- `docs/PRD-mindmap.md` — ReactFlow + dagre mind map view
- `docs/PRD-sidebar-navigation.md` — Sidebar navigation design
