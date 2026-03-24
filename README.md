# MiNotes

A local-first knowledge management engine built with Rust and TypeScript. MiNotes combines block-based outlining, bidirectional linking, and graph-based knowledge organization in a fast, privacy-respecting desktop application. Think Logseq meets Obsidian — but built on Rust + Tauri for speed and portability.

## Features

### Core Editor
- **Block-based outliner** — Hierarchical blocks with indent/outdent (Tab/Shift+Tab), collapse/expand, and inline editing
- **Drag-to-reorder blocks** — Grab handle on hover, drag blocks up/down to reorder
- **Rich text editing** — TipTap (ProseMirror) WYSIWYG with headings, bold, italic, strikethrough, code, highlights, blockquotes, task lists, tables
- **Floating toolbar** — Bold, italic, strike, code, highlight, H1-H3 appear on text selection
- **Slash commands** — Type `/` for headings, lists, todos, code blocks, dividers, whiteboards
- **CodeMirror 6 source mode** — Optional Obsidian-style markdown source editor (toggle per block)
- **URL-to-link paste** — Paste a URL over selected text → auto-creates `[text](url)` markdown link
- **TODO cycling** — Ctrl+Enter cycles through TODO → DOING → DONE → plain text

### Knowledge Graph
- **Bidirectional linking** — `[[Wiki Links]]` with automatic backlink tracking
- **Block references** — `((block-id))` inline references
- **`[[` autocomplete** — Type `[[` to search and link pages inline
- **Hover preview** — Hover over `[[links]]` to preview page content (300ms delay, instant on Ctrl)
- **Backlinks panel** — See all pages that reference the current page
- **Unlinked references** — Discover mentions that aren't linked yet
- **Graph visualization** — Interactive force-directed graph of page connections

### Organization
- **Folder hierarchy** — Nested project folders with drag-and-drop page organization
- **Daily journal** — Auto-created journal pages with prev/next navigation (Ctrl+J)
- **Favorites** — Pin frequently used pages (right-click to add/remove)
- **Full-text search** — SQLite FTS5-powered search with command palette (Ctrl+K)
- **Properties & metadata** — Typed key-value properties on blocks and pages

### Whiteboard
- **Per-block whiteboards** — Create via `/whiteboard` slash command or Ctrl+W
- **Drawing tools** — Freehand draw with color picker, sticky notes with text
- **Inline thumbnail** — Whiteboard blocks show a live preview in the page
- **Auto-save** — Saves every 10 seconds + on close
- **Export PNG** — WSL-aware download (saves to Windows Downloads folder in Tauri)

### Visual Modes
- **Clean Document Mode** — Default minimal view with subtle bullets
- **Full Tree Mode** — `├──`/`└──` connector lines showing block hierarchy (toggle in Settings)
- **Light & Dark themes** — Catppuccin Mocha (dark) and Latte (light)

### Developer & Power User
- **CLI with 5 output formats** — JSON, text, markdown, CSV, OPML
- **Event sourcing** — Append-only audit log tracking all mutations
- **Markdown import/export** — Bidirectional filesystem sync
- **Query engine** — SQL queries against the knowledge base
- **Obsidian plugin compatibility** — Plugin loader for community plugins
- **CSS snippet manager** — Custom styling via user CSS

## Architecture

```
crates/
├── minotes-core/     # Rust data engine — SQLite, models, repo layer, search, sync
├── minotes-cli/      # CLI binary — Clap 4, 40+ subcommands, 5 output formats
└── minotes-app/      # Desktop app — Tauri 2 backend + React 19 frontend
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Core engine | Rust, SQLite (rusqlite), WAL mode |
| Full-text search | SQLite FTS5 |
| Desktop shell | Tauri 2 (~20MB binary) |
| Frontend | React 19, TypeScript, Vite |
| Rich editor | TipTap (ProseMirror) + tiptap-markdown |
| Source editor | CodeMirror 6 (optional) |
| CLI | Clap 4 with 5 output formats |
| IDs | UUID v7 (time-sortable) |
| Serialization | Serde |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (system dependencies)

### Build & Run

```bash
# Clone the repository
git clone https://github.com/Cklaus1/MiNotes.git
cd MiNotes

# Install frontend dependencies
cd crates/minotes-app && npm install && cd ../..

# Run the desktop app (dev mode)
cd crates/minotes-app && npm run tauri dev

# Or run the frontend only (browser dev mode with mock backend)
cd crates/minotes-app && npx vite --port 1420

# Or build the CLI
cargo build --release -p minotes-cli
```

### CLI Usage

```bash
# Page operations
minotes page create "My Page"
minotes page list
minotes page get "My Page" --tree

# Output formats: json (default), text, md, csv, opml
minotes -f text page list                        # Human-readable
minotes -f md page get "Design Doc" --tree       # Markdown export
minotes -f csv page list > pages.csv             # Spreadsheet
minotes -f opml page get "Project" --tree        # Outliner import

# Block operations
minotes block create "My Page" "Block content with [[wiki links]]"
minotes block update <block-id> --content "Updated content"

# Search
minotes search "meeting" --limit 20
minotes -f text search "TODO"

# Journal
minotes journal                    # Today's journal
minotes journal 2026-03-24         # Specific date
minotes journal create "Quick note"

# Folders
minotes folder create "Projects"
minotes folder list

# Graph & stats
minotes stats
minotes -f text stats
minotes backlinks "Project Alpha"
minotes forward-links "Research Notes"

# Export/Import
minotes export --format markdown
minotes sync-dir ./my-notes/ --write-back

# Event log
minotes events --limit 10
minotes events --follow            # Real-time tail
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open search / command palette |
| `Ctrl+J` | Open today's journal |
| `Ctrl+N` | Create new page |
| `Ctrl+G` | Toggle graph view |
| `Ctrl+W` | Create whiteboard block |
| `Ctrl+M` | Toggle mind map view (planned) |
| `Ctrl+,` | Open settings |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Enter` | Create new block below |
| `Tab` | Indent block |
| `Shift+Tab` | Outdent block |
| `Ctrl+Enter` | Cycle TODO state |
| `/` | Slash commands menu |
| `[[` | Wiki link autocomplete |
| `((` | Block reference autocomplete |
| `Escape` | Close panel / deselect |

## Testing

```bash
# Full user journey tests (33 journeys, 127 tests)
cd crates/minotes-app && npx vite --port 1420 &
bash tests/user-journey-test.sh

# Rust tests
cargo test
```

## Data Storage

All data is stored locally in SQLite at `~/.minotes/default.db`. No cloud services, no telemetry, no external API calls. Multi-graph support allows switching between separate databases.

## PRDs & Roadmap

Detailed product requirements in `docs/`:

| PRD | Status | Description |
|-----|--------|-------------|
| [Editor Improvements](docs/PRD-editor-improvements.md) | Planned | Table editor, templates, highlight colors, outline panel, kanban, queries, periodic notes |
| [Mind Map](docs/PRD-mindmap.md) | Planned | ReactFlow + dagre mind map view with inline editing and drag-to-rearrange |
| [Git Sync](docs/PRD-git-sync.md) | Planned | Git-based sync via markdown files, conflict resolution, Obsidian compatibility |
| [Encryption](docs/PRD-encryption.md) | Planned | Per-folder AES-256-GCM encryption with Argon2id key derivation |

## Mobile

MiNotes uses Tauri 2, which supports iOS and Android from the same codebase. The mobile UI adapts automatically: sidebar collapses to a top panel on narrow screens with a bottom tab bar for Pages, Journal, Search, Graph, and Menu.

```bash
# Android
cd crates/minotes-app
npm run tauri android dev

# iOS
cd crates/minotes-app
npm run tauri ios dev
```

## License

This work is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/).

See [LICENSE](LICENSE) for details.
