# MiNotes

A local-first knowledge management engine built with Rust and TypeScript. MiNotes combines the power of block-based outlining, bidirectional linking, and graph-based knowledge organization in a fast, privacy-respecting desktop application.

## Features

- **Block-based outliner** — Hierarchical blocks with drag-and-drop, collapsing, and inline editing
- **Bidirectional linking** — `[[Wiki Links]]` and `((block references))` with automatic backlink tracking
- **Folder hierarchy** — Nested folders with drag-and-drop page organization
- **Daily journal** — Auto-created journal pages with keyboard shortcut access
- **Full-text search** — SQLite FTS5-powered search with command palette (`Ctrl+K`)
- **Properties & metadata** — Typed key-value properties on pages, blocks, and folders
- **Event sourcing** — Append-only audit log tracking all mutations with actor attribution
- **Markdown import/export** — Bidirectional filesystem sync, bulk import from markdown directories
- **Graph analysis** — Page relationship graph with neighbor traversal and statistics
- **CLI interface** — 40+ commands for scripting and agent integration (`minotes` binary)

## Architecture

```
crates/
├── minotes-core/     # Rust data engine — SQLite, models, repo layer, search, sync
├── minotes-cli/      # CLI binary — Clap 4, 40+ subcommands, JSON/table output
└── minotes-app/      # Desktop app — Tauri 2 backend + React 19 frontend
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Core engine | Rust, SQLite (rusqlite), WAL mode |
| Full-text search | SQLite FTS5 |
| Desktop shell | Tauri 2 (~20MB binary) |
| Frontend | React 19, TypeScript, Vite |
| CLI | Clap 4 |
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
git clone https://github.com/your-org/MiNotes.git
cd MiNotes

# Install frontend dependencies
cd crates/minotes-app && npm install && cd ../..

# Run the desktop app (dev mode)
cd crates/minotes-app && npm run tauri dev

# Or build the CLI
cargo build --release -p minotes-cli
```

### CLI Usage

```bash
# Page operations
minotes page create "My Page"
minotes page list
minotes page get "My Page" --tree

# Block operations
minotes block create <page-id> "Block content with [[wiki links]]"
minotes block update <block-id> "Updated content"

# Search
minotes search "query" --limit 20

# Folders
minotes folder create "Projects"
minotes folder list

# Journal
minotes journal          # Today's journal
minotes journal 2026-03-23

# Graph & stats
minotes graph stats
minotes graph neighbors <page-id> --depth 2

# Export/Import
minotes export --format markdown
minotes import ./notes/ --format auto

# Event log
minotes events --since 0 --follow
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open search |
| `Ctrl+J` | Open today's journal |
| `Ctrl+N` | Create new page |

## Data Storage

All data is stored locally in SQLite at `~/.minotes/default.db`. No cloud services, no telemetry, no external API calls.

## Project Status

**Phase 2 — Desktop app in active development.**

Core engine features (blocks, pages, folders, links, search, events, export/import, sync) are functional. The Tauri desktop app provides a working UI with folder tree navigation, inline block editing, search, backlinks, and journal access.

Planned: graph visualization, PDF annotation, flashcards (FSRS), CRDT sync, plugin system.

## License

This work is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/).

See [LICENSE](LICENSE) for details.
