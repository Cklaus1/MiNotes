# MiNotes — Product Requirements Document

## Vision

MiNotes is a local-first knowledge management platform that combines the best features of Logseq (block-based outlining, bidirectional linking, PDF annotation, graph visualization, flashcards, queries) with a Rust + TypeScript architecture purpose-built for agent interoperability. MiNotes is a **data engine, not an AI product** — it stores, indexes, queries, and syncs knowledge with sub-100ms latency. All AI intelligence (summarization, research, NL queries, proactive nudges) lives in external agents like BFlow that interact with MiNotes through its **CLI commands and skills**.

**One-liner:** Logseq's power, rebuilt as a fast data engine that agents can drive.

**Design principle:** MiNotes contains zero LLM clients, zero API keys, zero prompt engineering. It does compute (indexing, search, CRDT sync, vector math). BFlow does intelligence (reasoning, generation, orchestration).

---

## Problem Statement

Existing knowledge management tools (Logseq, Obsidian, Notion, Roam) were designed for human-only interaction:

1. **Opaque data models** — Datalog queries and proprietary formats make programmatic access fragile
2. **No CLI or structured API** — AI agents must screen-scrape or use unstable plugin APIs; no composable CLI commands
3. **Slow builds, slow queries** — ClojureScript/Electron stacks have high startup and query latency
4. **No event streams** — No way for agents to subscribe to changes in real-time
5. **Sync is an afterthought** — Collaboration bolted on rather than built in (CRDTs, RTC)
6. **Heavy runtime** — Electron bundles 200MB+ for a note-taking app
7. **AI bolted in** — Apps adding AI end up with redundant LLM stacks, API key management, and prompt engineering that duplicates what external agents already do better

MiNotes solves 1-6 by making the knowledge graph accessible via a comprehensive CLI (`minotes` command) and a skill library that agents like BFlow can call directly. Event sourcing and a lightweight native runtime complete the picture. It solves 7 by deliberately not including AI — instead exposing clean interfaces for agents that already exist.

---

## Architecture: MiNotes + BFlow Split

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│         MiNotes (Rust + TS)      │    │         BFlow (Python)           │
│         DATA ENGINE              │    │         INTELLIGENCE             │
│                                  │    │                                  │
│  Block graph engine              │    │  LLM routing & model selection   │
│  SQLite storage + WAL            │    │  Session memory (cross-session)  │
│  Tantivy full-text search        │◄──►│  Prompt building & context mgmt  │
│  Vector index (HNSW, local)      │CLI │  Tool dispatch (116+ tools)      │
│  Automerge CRDT sync             │    │  Heartbeat / scheduler           │
│  PDF viewer + annotations        │    │  Personality system (SOUL.md)    │
│  FSRS flashcard scheduler        │    │  74 agent teams                  │
│  Event bus (append-only log)     │    │  Intent routing & filtering      │
│  Plugin host (sandboxed)         │    │  Skill discovery & execution     │
│  CLI: `minotes <command>`        │    │                                  │
│  Skills library (reusable)       │    │  "minotes" skill:                │
│                                  │    │    wraps CLI for BFlow,          │
│  NO LLM client                   │    │    search, create, summarize,    │
│  NO API keys                     │    │    review cards, weekly digest,  │
│  NO prompt engineering           │    │    research → notes pipeline     │
│  NO model selection              │    │                                  │
└──────────────────────────────────┘    └──────────────────────────────────┘
        ~20MB binary                           Existing platform
        Zero cloud dependency                  Already deployed
```

### What lives where

| Capability | MiNotes (compute) | BFlow (intelligence) |
|---|---|---|
| Store and retrieve blocks/pages | Yes | — |
| Full-text search | Yes (Tantivy) | — |
| Vector similarity search | Yes (HNSW index) | — |
| Generate embeddings | Yes (ONNX Runtime, local model) | — |
| FSRS flashcard scheduling | Yes (algorithm) | — |
| CRDT sync | Yes (Automerge) | — |
| "Summarize this page" | — | Yes (LLM call) |
| "Find related notes to X" | Returns vector results | Orchestrates the question |
| "Create notes from this meeting" | Receives blocks via CLI | Transcribes, structures, calls `minotes create-block` |
| "What did I write about X?" | Returns search results | Translates NL → `minotes search`, formats response |
| NL → SQL translation | — | Yes (LLM generates SQL, calls `minotes query`) |
| Proactive nudges ("15 cards due") | — | Yes (heartbeat runs `minotes srs due`) |
| Weekly review digest | — | Yes (runs `minotes query`, summarizes via LLM) |
| Content attribution tracking | Yes (`--actor` flag in events) | Tags its writes as `--actor bflow` |

### Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Core Engine** | Rust | Zero-cost abstractions, WASM compilation, native speed, ownership model for concurrent graph ops |
| **Frontend** | TypeScript + React | Ecosystem maturity, plugin author familiarity, shadcn/ui component system |
| **Desktop Shell** | Tauri | Rust backend + web frontend, 10x smaller than Electron (~20MB vs 200MB) |
| **Mobile** | Tauri Mobile (iOS/Android) | Single codebase, native performance |
| **Database** | SQLite (via rusqlite) | Embedded, zero-config, battle-tested, full-text search via FTS5 |
| **Sync** | Automerge (Rust CRDT) | Local-first, conflict-free, works offline, peer-to-peer capable |
| **Embeddings** | ONNX Runtime (Rust) | Local vector embeddings, no Python, no cloud — pure compute |
| **Full-Text Search** | Tantivy (Rust) | Lucene-equivalent in Rust, sub-50ms on 100K blocks |
| **CLI** | Rust (compiled binary) | `minotes` command with 40+ subcommands — agents call it like any CLI tool |
| **Skills** | Markdown + shell scripts | BFlow-compatible skill definitions that wrap CLI commands for agent discovery |

---

## Target Users

| Persona | Description | Key Need |
|---------|-------------|----------|
| **Power Note-Taker** | Daily journaler, researcher, PKM enthusiast | Block outlining, bidirectional links, PDF annotation, flashcards |
| **AI-Augmented Knowledge Worker** | Uses BFlow or other agents for research, summarization, task management | Clean CLI, fast search, event streams |
| **Developer / Builder** | Extends their tools, writes plugins, automates workflows | Rust SDK, TypeScript plugin API, event streams |
| **Team Collaborator** | Shares knowledge bases with colleagues | Real-time sync, CRDT conflict resolution, permissions |

---

## Feature Requirements

### P0 — Core (Launch Blockers)

#### F-001: Block-Based Outliner
The fundamental unit of content is a **block** — a paragraph-level chunk with a UUID, parent reference, and position. Blocks form a tree (outline) within a page.

- Hierarchical nesting with indent/outdent
- Block CRUD: create, read, update, delete, move, duplicate
- Block collapsing/expanding
- Block references: `((block-uuid))` syntax, rendered inline
- Block properties: typed key-value metadata per block
- Block selection: multi-select for batch operations
- Drag-and-drop reordering within and across pages
- Undo/redo with full history (event-sourced)

**CLI + Skills:**
```
create_block(page, content, parent?, position?, properties?)
update_block(id, content?, properties?)
move_block(id, target_parent, position)
delete_block(id)
get_block(id) → Block
get_children(id) → Block[]
batch_create_blocks(blocks[]) → Block[]
```

#### F-002: Page System
Pages are named containers for blocks. Every page has a title, properties, and a block tree.

- Page CRUD with title, icon, properties
- Page aliases (multiple names for one page)
- Favorites list (pinned pages)
- Recent pages tracking
- Page templates: define a template page, stamp new pages from it
- Namespace pages: `Project/Subpage` hierarchical naming
- Page tags/classes: categorize pages with typed tags

**CLI + Skills:**
```
create_page(title, properties?, template?, tags?)
get_page(title_or_id) → Page with block tree
list_pages(filter?, sort?, limit?) → Page[]
delete_page(title_or_id)
rename_page(old_title, new_title)  # updates all references
get_page_tree(title_or_id) → nested Block tree
```

#### F-003: Bidirectional Linking
Every `[[Page Link]]` and `((block-ref))` creates a bidirectional connection in the graph. The linked-from side automatically shows backlinks.

- `[[Page Name]]` wiki-style page links
- `((block-uuid))` block references with inline preview
- Backlinks panel: all blocks linking to current page
- Unlinked references: mentions of page name not yet linked
- Link graph maintained in dedicated `links` table for O(1) lookup

**CLI + Skills:**
```
get_backlinks(page_or_block_id) → Link[]
get_forward_links(page_or_block_id) → Link[]
```

#### F-004: Daily Journal
Automatic date-based pages for daily capture. Journal pages are auto-created when navigating to today's date.

- Auto-create today's journal on app open
- Journal navigation (prev/next day, date picker)
- Default journal template support
- Scheduled tasks: `SCHEDULED: <2026-03-25>` syntax
- Deadline tasks: `DEADLINE: <2026-03-25>` syntax
- Journal queries: built-in queries for tasks, schedules across dates

**CLI + Skills:**
```
get_journal(date?) → Page  # defaults to today
create_journal_entry(content, date?, properties?)
get_scheduled_tasks(from_date?, to_date?) → Block[]
get_deadlines(from_date?, to_date?) → Block[]
```

#### F-005: Markdown Editor
Rich text editing with Markdown source and live preview. ProseMirror-based for reliable cursor handling and extensibility.

- Full CommonMark + GFM support
- Code blocks with syntax highlighting (50+ languages via Shiki)
- Math blocks: LaTeX rendering via KaTeX
- Tables: create, edit, sort, resize columns
- Checklists: `- [ ]` / `- [x]` task checkboxes with TODO/DOING/DONE states
- Inline formatting: bold, italic, strikethrough, code, highlight
- Image embedding: paste, drag-drop, URL reference
- Media embedding: YouTube, audio, video
- Slash commands: `/` prefix for inserting blocks, templates, properties
- Auto-complete: page links, block refs, properties, templates

#### F-006: Properties & Metadata
Typed properties on blocks and pages. Properties are schema-defined with validation.

- Property types: text, number, date, datetime, URL, email, select, multi-select, checkbox, relation (link to page/block)
- Property schemas: define allowed values, defaults, constraints
- Property inheritance: child blocks can inherit parent properties
- Property display: show/hide per property, configurable order
- Classes: define entity types (e.g., "Book", "Person", "Project") with required properties
- Class hierarchy: classes can extend other classes

**CLI + Skills:**
```
set_property(block_or_page_id, key, value, type?)
get_properties(block_or_page_id) → Properties
define_property_schema(name, type, constraints?)
define_class(name, properties[], parent_class?)
list_instances(class_name) → Page[]
```

#### F-007: Query Engine
SQL-based queries over the block graph with a visual query builder for humans. Agents call `minotes query` directly — no NL translation needed inside MiNotes.

- SQL query syntax over the block graph (familiar to developers and easy for agents to generate)
- Visual query builder UI: drag-drop conditions, grouping, sorting
- Query results display: list, table, board (kanban), calendar views
- Live queries: auto-update when underlying data changes
- Query embedding: embed query results as blocks in any page
- Built-in query templates: "All TODOs", "This week's journal entries", "Pages with tag X"

**CLI + Skills:**
```
query(sql, params?) → Result[]
create_saved_query(name, sql, display_mode?)
list_saved_queries() → Query[]
```

*Note: Natural language → SQL translation is handled by BFlow, which generates the SQL and calls `minotes query`.*

#### F-008: Full-Text & Semantic Search
Dual search: keyword (Tantivy FTS) + semantic (vector embeddings). Both are pure compute — no LLM involved.

- Full-text search across all blocks, pages, properties (Tantivy)
- Fuzzy matching with typo tolerance
- Semantic search: vector similarity over locally-generated embeddings
- Search filters: by page, date range, property values, tags
- Search results: ranked by relevance, grouped by page
- Find-and-replace: within page or across entire graph
- Background indexing: incremental re-index on every block save
- Embedding generation: ONNX Runtime with a small local model (all-MiniLM-L6-v2 or similar, ~80MB)

**CLI + Skills:**
```
search(query, mode: "keyword"|"semantic"|"hybrid", filters?) → Result[]
search_similar(block_id, limit?) → Block[]
reindex(full: bool?)
```

*Note: "What did I write about X last week?" flows through BFlow, which runs `minotes search --mode hybrid "X"` and formats the response for the user.*

#### F-009: Local-First Storage
All data lives on-device in SQLite. No cloud dependency. No API keys. Export everything, import anywhere.

- SQLite database per graph (single `.minotes.db` file)
- Append-only event log for complete history
- Automatic WAL-mode for concurrent read/write
- Attachment storage: small files in SQLite, large files (PDFs, images) on filesystem
- Database export: full SQLite file download
- Markdown export: render entire graph as `.md` files
- OPML export: outline format for interop
- JSON export: structured data export
- Import from: Logseq, Obsidian, Roam, Notion, Markdown folders

**CLI + Skills:**
```
export_graph(format: "sqlite"|"markdown"|"json"|"opml") → file_path
export_page(page_id, format) → string
import_markdown(file_path, target_page?)
get_graph_stats() → {pages, blocks, links, orphans, db_size}
```

#### F-010: Event Sourcing & Event Bus
Every mutation is recorded as a structured event. Events drive sync, undo/redo, plugin notifications, and agent subscriptions.

- Append-only event log in SQLite
- Event types: `block.created`, `block.updated`, `block.moved`, `block.deleted`, `page.created`, `page.renamed`, `property.set`, `link.created`, etc.
- Event payload: full before/after state for each mutation
- Actor tracking: `user`, `plugin:<name>`, `sync`, or agent name (e.g., `bflow`)
- Event subscriptions: agents and plugins can tail events via `minotes events --follow`
- Event replay: reconstruct any past state by replaying events
- Undo/redo: implemented via event reversal

**CLI + Skills:**
```
subscribe_events(event_types?, since_cursor?) → SSE stream
get_events(since?, until?, types?, limit?) → Event[]
```

*BFlow integration: BFlow tails events via `minotes events --follow` to react to user edits in real-time (e.g., auto-tag, suggest links, detect orphan pages).*

---

### P1 — Differentiation Features

#### F-011: CLI + Skills Interface
MiNotes ships a `minotes` CLI binary with 40+ subcommands. This is the primary interface for agents, scripts, and automation. BFlow interacts with MiNotes by executing CLI commands (same pattern as `ms365-cli`). A companion **skill definition** (`SKILL.md` + reference docs) is installed into BFlow's skill directory for agent discovery.

**CLI Design Principles:**
- Every command outputs JSON by default (`--format json`), human-readable with `--format table`
- Consistent flags: `--graph <path>` to target a specific graph, `--actor <name>` to tag the event source
- Batch operations via stdin: pipe JSON arrays for bulk creates/updates
- Exit codes: 0 = success, 1 = error, 2 = not found
- Sub-100ms for read operations, <200ms for writes (Rust binary, no runtime startup)

**Full CLI Command Inventory (40+ commands):**

```bash
# Pages
minotes page create <title> [--template <name>] [--tags <t1,t2>] [--properties '{}']
minotes page get <title_or_id> [--tree] [--format json|table|markdown]
minotes page list [--filter <expr>] [--sort <field>] [--limit <n>]
minotes page delete <title_or_id>
minotes page rename <old> <new>
minotes page merge <source> <target>

# Blocks
minotes block create <page> <content> [--parent <id>] [--position <n>] [--properties '{}']
minotes block get <id> [--context <n>]  # include N surrounding blocks
minotes block update <id> [--content <text>] [--properties '{}']
minotes block delete <id>
minotes block move <id> --parent <target> --position <n>
minotes block children <id>
minotes block batch-create --stdin  # reads JSON array from stdin

# Search
minotes search <query> [--mode keyword|semantic|hybrid] [--filter <expr>] [--limit <n>]
minotes search similar <block_id> [--limit <n>]
minotes backlinks <page_or_block_id>
minotes forward-links <page_or_block_id>
minotes reindex [--full]

# Journal
minotes journal [<date>]  # defaults to today
minotes journal create <content> [--date <iso>] [--properties '{}']
minotes journal tasks [--from <date>] [--to <date>]
minotes journal deadlines [--from <date>] [--to <date>]

# Properties
minotes property set <entity_id> <key> <value> [--type <type>]
minotes property get <entity_id>
minotes property define-schema <name> --type <type> [--constraints '{}']
minotes class create <name> --properties <schema_ids> [--parent <class>]
minotes class list-instances <class_name>

# Query
minotes query <sql> [--params '[]']
minotes query save <name> <sql> [--display list|table|board|calendar]
minotes query list

# Graph
minotes graph data [--center <page>] [--depth <n>] [--filter <expr>]
minotes graph neighbors <page_id> [--depth <n>]
minotes graph shortest-path <from> <to>
minotes graph stats

# Flashcards (SRS)
minotes srs due [--limit <n>]
minotes srs review <card_id> --rating again|hard|good|easy
minotes srs create <block_id> [--type basic|cloze]
minotes srs stats

# Export / Import
minotes export [--format sqlite|markdown|json|opml] [--output <path>]
minotes export page <page_id> [--format markdown|json]
minotes import <path> [--format auto|logseq|obsidian|roam|notion|markdown]

# Events
minotes events [--since <cursor>] [--types <t1,t2>] [--limit <n>] [--follow]
# --follow streams events in real-time (like tail -f)

# Sync
minotes sync status
minotes sync force
minotes sync history <page_id> [--limit <n>]
minotes sync restore <page_id> <version_id>
```

**BFlow Skill Definition:**

A `minotes` skill is installed at `concierge/skills/minotes/` with:
- `SKILL.md` — frontmatter + usage guide (replaces the old `obsidian` skill)
- `scripts/minotes.sh` — thin wrapper that calls the `minotes` CLI binary
- `references/commands.md` — full CLI reference for agent context

This follows the exact same pattern as `ms365-cli` — BFlow's skill system discovers it, the LLM reads the SKILL.md to understand capabilities, and executes commands via the script.

#### F-012: Graph Visualization
Interactive 2D graph view showing pages as nodes and links as edges.

- Force-directed layout (D3-force or Pixi.js)
- Node sizing by connection count
- Node coloring by tag/class
- Edge highlighting on hover
- Click-to-navigate
- Zoom, pan, drag nodes
- Filter by tag, date range, connection depth
- Local graph view: show N-hop neighborhood of current page
- Dark/light mode aware
- Export graph as SVG/PNG

**CLI + Skills:**
```
get_graph_data(center_page?, depth?, filters?) → {nodes, edges}
get_neighbors(page_id, depth?) → Page[]
get_shortest_path(from, to) → Page[]
```

#### F-013: PDF Annotation
Embedded PDF viewer with highlighting, annotation, and block linking.

- PDF.js-based viewer with page navigation
- Text highlighting with multiple colors (yellow, red, green, blue, purple)
- Area/region highlighting for images and diagrams
- Highlight → block: every highlight creates a linked block in a page
- Annotation notes: add text notes to highlights
- Highlight search: find all highlights across all PDFs
- Zotero import: pull PDFs from Zotero library
- Last-page memory: remember reading position per PDF
- Multi-PDF: open multiple PDFs in tabs

**CLI + Skills:**
```
import_pdf(file_path, target_page?)
get_highlights(pdf_page?, color?) → Highlight[]
create_highlight(pdf_id, selection, color?, note?)
search_highlights(query) → Highlight[]
```

#### F-014: Flashcards & Spaced Repetition
FSRS (Free Spaced Repetition Scheduling) algorithm for spaced review of any block. Pure math — no AI.

- Mark any block as a flashcard (front = block content, back = children or explicit)
- Cloze deletion: `{{cloze: hidden text}}` syntax
- FSRS scheduling: scientifically-optimized review intervals
- Review session UI: full-screen card review with Again/Hard/Good/Easy
- Due count badge: show pending reviews in sidebar
- Deck organization: group cards by page or tag
- Statistics: retention rate, review history, streak tracking
- Bulk card creation from highlights or queries

**CLI + Skills:**
```
get_due_cards(limit?) → Card[]
review_card(card_id, rating: "again"|"hard"|"good"|"easy")
create_card(block_id, card_type: "basic"|"cloze")
get_srs_stats() → {due, reviewed_today, retention_rate, streak}
```

*BFlow integration: BFlow heartbeat runs `minotes srs due` on a schedule and nudges the user: "You have 15 flashcards due for review."*

#### F-015: Real-Time Sync (CRDT)
Automerge-based conflict-free sync across devices and collaborators.

- Local-first: works fully offline
- CRDT merging: concurrent edits merge automatically, no conflicts
- Peer-to-peer: sync directly between devices on same network
- Cloud relay: optional cloud relay for remote sync (self-hostable)
- Selective sync: choose which pages/graphs to sync
- Sync status indicator: show connected peers, pending changes
- History: view and restore any previous version
- Permissions: read-only, read-write, admin roles per graph

**CLI + Skills:**
```
get_sync_status() → {peers, pending_changes, last_sync}
force_sync()
get_version_history(page_id, limit?) → Version[]
restore_version(page_id, version_id)
```

#### F-016: Plugin System
TypeScript-based plugin API running in sandboxed iframes. Plugins extend the UI and data layer — they do not include LLM clients (that's BFlow's job). Plugins can also register new CLI subcommands via a plugin manifest.

- Plugin manifest: `minotes-plugin.json` with permissions declaration
- Sandbox execution: plugins run in iframes with postMessage API
- Plugin API surface:
  - Editor: insert/modify blocks, register slash commands
  - UI: add sidebar panels, toolbar buttons, context menu items
  - Data: read/write blocks, pages, properties via typed API
  - Events: subscribe to block/page/property changes
  - Storage: per-plugin persistent key-value storage
  - HTTP: make network requests (with user permission)
  - Settings: plugin configuration UI auto-generated from schema
- Plugin marketplace: browse, install, update, remove
- Hot reload: update plugins without restarting app

---

### P2 — Enhancement Features

#### F-017: Whiteboard / Canvas
Infinite canvas for spatial thinking. Place blocks, pages, shapes, drawings, and images on a 2D canvas.

- Infinite pan/zoom canvas
- Place blocks and pages as cards on canvas
- Draw freeform shapes, arrows, connectors
- Sticky notes with rich text
- Image embedding on canvas
- Group and layer elements
- Canvas ↔ outline interop: convert canvas regions to outlines and back
- Export canvas as PNG/SVG

#### F-018: Template System
Define reusable page and block templates with dynamic variables.

- Template pages: define structure, properties, default content
- Template variables: `{{date}}`, `{{title}}`, `{{input:prompt}}`
- Template insertion: slash command or auto-apply on page creation
- Class-based templates: auto-apply template when creating page with a class
- Template library: browse and share templates

#### F-019: Org-Mode Support
Full Org-mode format support for users migrating from Emacs/Logseq.

- Org-mode parser (Rust-native, tree-sitter grammar)
- Org headings → blocks conversion
- Org properties → MiNotes properties
- Org TODO states mapping
- Org table support
- Export to Org format

#### F-020: Multi-Graph Management
Manage multiple knowledge graphs (personal, work, project-specific) with cross-graph search.

- Graph switcher UI
- Per-graph settings and themes
- Cross-graph search (opt-in)
- Graph import/export
- Graph templates: start new graphs from templates

#### F-021: Web Clipper
Browser extension for capturing web content into MiNotes.

- Clip full page, selection, or simplified article
- Auto-extract title, URL, author, date
- Choose target page and position
- Tag/property assignment on clip
- Image download and local storage

#### F-022: Publishing
Publish pages or entire graphs as static websites.

- Static site generation from graph content
- Custom themes and CSS
- Public URL per published graph
- Selective publishing: choose which pages are public
- Auto-rebuild on change
- Custom domain support

#### F-023: Command Palette
Global command palette (Cmd/Ctrl+K) for fast access to any action.

- Fuzzy search across all commands, pages, blocks
- Recent commands
- Plugin-registered commands
- Keyboard shortcut display
- Command categories and grouping

#### F-024: Theme & Customization
Full visual customization with themes, custom CSS, and layout options.

- Light and dark mode with system-follow option
- Accent color picker
- Font family and size selection
- Custom CSS injection
- Theme marketplace: community themes
- Layout modes: wide, narrow, centered
- Sidebar position: left, right, both

#### F-025: Mobile App
Native mobile experience via Tauri Mobile.

- Touch-optimized block editing
- Swipe gestures for navigation
- Quick capture widget (iOS/Android)
- Camera capture: scan documents, whiteboard photos
- Offline-first with background sync
- Haptic feedback
- Share sheet integration: receive content from other apps

*Note: Voice-to-text is handled by BFlow (which already has the Whisper skill), not by MiNotes.*

---

## BFlow Integration Spec

### BFlow `minotes` Skill

BFlow gets a new skill at `concierge/skills/minotes/` that wraps the `minotes` CLI. This replaces the existing `obsidian` skill. Same architecture as `ms365-cli` — a SKILL.md for agent context, a script that calls the binary, and reference docs.

**Skill structure:**
```
concierge/skills/minotes/
├── SKILL.md              # Frontmatter + usage guide
├── scripts/
│   └── minotes.sh        # Thin wrapper: exec minotes "$@"
└── references/
    ├── commands.md        # Full CLI reference
    ├── query-examples.md  # Common SQL patterns
    └── import-formats.md  # Logseq/Obsidian/Roam import guide
```

**SKILL.md frontmatter:**
```yaml
---
name: minotes
description: Read, write, search, and manage notes in MiNotes knowledge graphs
preferred_model: null  # no model needed — pure CLI calls
---
```

**Example BFlow workflows that drive MiNotes:**

| User says to BFlow | BFlow does | CLI commands called |
|---|---|---|
| "Save this research to my notes" | Structures content, creates page | `minotes page create "Research: X"` + `minotes block batch-create --stdin` |
| "What did I write about CRDT sync?" | Translates to search | `minotes search "CRDT sync" --mode hybrid` |
| "Summarize my notes on Project Alpha" | Gets page tree, sends to LLM | `minotes page get "Project Alpha" --tree` |
| "Create flashcards from today's reading" | Finds highlights, creates cards | `minotes search-highlights` + `minotes srs create` |
| (Heartbeat: 7 AM) "15 cards due" | Polls cards, notifies user | `minotes srs due` + `minotes srs stats` |
| (Heartbeat: Friday) "Weekly digest" | Queries week's journals, summarizes | `minotes query "SELECT ... WHERE journal_date >= ..."` |
| "Find notes related to this email" | Extracts topic, searches | `minotes search --mode semantic "topic"` |
| "Link my meeting notes to Project Alpha" | Parses transcript, creates blocks | `minotes block create` + `minotes property set` |

### Event-Driven Integration

BFlow can tail MiNotes events in real-time using `--follow` (like `tail -f`):

```bash
minotes events --follow --types block.created,page.created
```

```json
{"event_type": "block.created", "actor": "user", "page": "Daily/2026-03-23", "content": "TODO: review Q1 numbers"}
```

BFlow's heartbeat can run this as a background process and react:
```
→ BFlow notices a TODO was created
→ BFlow proactively: "Want me to pull the Q1 numbers from the Stripe dashboard?"
```

This enables BFlow to be proactive without MiNotes needing any AI logic.

---

## Data Model

### Core Entities

```sql
-- Every content unit
CREATE TABLE blocks (
    id          TEXT PRIMARY KEY,  -- UUID v7 (time-sortable)
    page_id     TEXT NOT NULL REFERENCES pages(id),
    parent_id   TEXT REFERENCES blocks(id),
    position    REAL NOT NULL,     -- fractional indexing for O(1) insert
    content     TEXT NOT NULL,     -- Markdown source
    content_html TEXT,             -- Cached rendered HTML
    format      TEXT DEFAULT 'markdown',  -- 'markdown' | 'org'
    collapsed   BOOLEAN DEFAULT FALSE,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Named containers
CREATE TABLE pages (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL UNIQUE,
    icon        TEXT,
    is_journal  BOOLEAN DEFAULT FALSE,
    journal_date TEXT,  -- ISO date for journal pages
    template_id TEXT REFERENCES pages(id),
    class_id    TEXT REFERENCES classes(id),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Bidirectional links (materialized)
CREATE TABLE links (
    id          TEXT PRIMARY KEY,
    from_block  TEXT NOT NULL REFERENCES blocks(id),
    to_page     TEXT REFERENCES pages(id),
    to_block    TEXT REFERENCES blocks(id),
    link_type   TEXT DEFAULT 'reference',  -- 'reference' | 'embed' | 'alias'
    created_at  TEXT NOT NULL
);

-- Typed properties
CREATE TABLE properties (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL,  -- block or page ID
    entity_type TEXT NOT NULL,  -- 'block' | 'page'
    key         TEXT NOT NULL,
    value       TEXT,           -- JSON-encoded value
    value_type  TEXT NOT NULL,  -- 'text' | 'number' | 'date' | 'select' | ...
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(entity_id, key)
);

-- Event log (append-only)
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    payload     TEXT NOT NULL,  -- JSON: before/after state
    actor       TEXT DEFAULT 'user',  -- 'user' | 'bflow' | 'sync' | 'plugin:<name>'
    created_at  TEXT NOT NULL
);

-- Vector embeddings (local ONNX, no cloud)
CREATE TABLE embeddings (
    block_id    TEXT PRIMARY KEY REFERENCES blocks(id),
    vector      BLOB NOT NULL,  -- f32 array, generated locally
    model       TEXT NOT NULL,  -- e.g., 'all-MiniLM-L6-v2'
    updated_at  TEXT NOT NULL
);

-- Flashcards (FSRS algorithm, pure math)
CREATE TABLE cards (
    id          TEXT PRIMARY KEY,
    block_id    TEXT NOT NULL REFERENCES blocks(id),
    card_type   TEXT DEFAULT 'basic',  -- 'basic' | 'cloze'
    due_at      TEXT NOT NULL,
    stability   REAL DEFAULT 0,
    difficulty  REAL DEFAULT 0,
    elapsed_days INTEGER DEFAULT 0,
    reps        INTEGER DEFAULT 0,
    lapses      INTEGER DEFAULT 0,
    state       TEXT DEFAULT 'new',  -- 'new' | 'learning' | 'review' | 'relearning'
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Property schemas
CREATE TABLE property_schemas (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    value_type  TEXT NOT NULL,
    constraints TEXT,  -- JSON: {enum: [...], min, max, pattern, ...}
    default_val TEXT,
    created_at  TEXT NOT NULL
);

-- Entity classes
CREATE TABLE classes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    parent_id   TEXT REFERENCES classes(id),
    properties  TEXT NOT NULL,  -- JSON array of required property schema IDs
    template_id TEXT REFERENCES pages(id),
    created_at  TEXT NOT NULL
);

-- FTS5 virtual table (Tantivy also indexes, but FTS5 for simple SQL queries)
CREATE VIRTUAL TABLE blocks_fts USING fts5(
    content,
    content='blocks',
    content_rowid='rowid',
    tokenize='porter unicode61'
);
```

---

## Non-Functional Requirements

### Performance
| Metric | Target |
|--------|--------|
| App startup (cold) | < 500ms |
| App startup (warm) | < 200ms |
| Block create/update | < 10ms |
| Full-text search (10K blocks) | < 50ms |
| Vector search (10K blocks) | < 100ms |
| Graph render (1K nodes) | < 200ms |
| Query execution (simple) | < 20ms |
| Event processing | < 5ms per event |
| Embedding generation (per block) | < 50ms |
| Sync roundtrip (LAN) | < 100ms |
| CLI command (read) | < 50ms |
| CLI command (write) | < 200ms |
| App binary size | < 30MB (excl. embedding model) |
| Embedding model size | ~80MB (all-MiniLM-L6-v2) |
| Memory usage (10K blocks) | < 150MB |

### Security
- All data stored locally, encrypted at rest (SQLite SEE or sqlcipher)
- Plugin sandbox: no filesystem access, no network without permission
- CLI: runs locally as the current user, no network listener, no auth needed
- Sync encryption: end-to-end encrypted, zero-knowledge relay
- No telemetry without explicit opt-in
- No API keys stored or managed — MiNotes makes zero external API calls

### Accessibility
- Full keyboard navigation
- Screen reader support (ARIA labels, semantic HTML)
- High contrast mode
- Configurable font sizes
- Reduced motion mode

### Platforms
| Platform | Runtime | Status |
|----------|---------|--------|
| macOS (Apple Silicon + Intel) | Tauri | P0 |
| Windows (x64, ARM) | Tauri | P0 |
| Linux (x64, ARM) | Tauri | P0 |
| Web (PWA) | WASM | P1 |
| iOS | Tauri Mobile | P2 |
| Android | Tauri Mobile | P2 |

---

## Development Phases

### Phase 1: Core Engine + CLI (Weeks 1-8)
- Rust core: block graph, page system, SQLite storage, event bus
- `minotes` CLI binary with 20 core commands (page, block, search, journal, events, query)
- Markdown parser (tree-sitter + pulldown-cmark)
- Full-text search (Tantivy)
- Local embedding generation (ONNX Runtime)
- Vector similarity search (HNSW index)
- JSON output mode for all commands
- **BFlow side:** Create `minotes` skill (SKILL.md + script wrapper), replaces `obsidian` skill

### Phase 2: Editor & Desktop (Weeks 9-16)
- Tauri desktop shell
- ProseMirror/TipTap editor with block-level editing
- Bidirectional linking with backlinks panel
- Daily journal with template support
- Properties UI (inline editing, type pickers)
- Visual query builder
- Command palette
- Theme system (dark/light)

### Phase 3: CLI Expansion + Integration (Weeks 17-22)
- CLI expansion to 40+ commands (properties, classes, graph, flashcards, export/import)
- `minotes events --follow` for real-time event tailing
- **BFlow side:** Event-driven workflows (tail events, react to user edits, proactive suggestions)
- **BFlow side:** Heartbeat integration (flashcard nudges, weekly digest, orphan detection)
- Import from Logseq, Obsidian, Roam, Notion

### Phase 4: Graph, PDF, SRS (Weeks 23-28)
- Graph visualization (D3/Pixi.js)
- PDF viewer with highlighting and annotation
- Flashcard system (FSRS algorithm)
- Export (Markdown, OPML, JSON, HTML)

### Phase 5: Sync & Collaboration (Weeks 29-34)
- Automerge CRDT integration
- Peer-to-peer sync (LAN discovery)
- Cloud relay (self-hostable)
- Conflict resolution UI
- Version history and restore

### Phase 6: Plugin Ecosystem & Mobile (Weeks 35-42)
- Plugin API (TypeScript, sandboxed iframe)
- Plugin marketplace
- Mobile app (Tauri Mobile, iOS first)
- Web clipper browser extension
- Publishing system (static site generation)
- Whiteboard/canvas

---

## Success Metrics

| Metric | Target (6 months) | Target (12 months) |
|--------|-------------------|---------------------|
| Active users | 5,000 | 50,000 |
| CLI calls / day (from BFlow + other agents) | 10,000 | 500,000 |
| Plugins published | 20 | 200 |
| Avg blocks per user | 2,000 | 10,000 |
| App store rating | 4.5+ | 4.7+ |
| Startup time p95 | < 500ms | < 300ms |
| Data loss incidents | 0 | 0 |

---

## Open Questions

1. **Org-mode priority** — How many users need full Org-mode vs. Markdown-only? Could defer to P2.
2. **Self-hosted sync** — Docker image for self-hosted relay? Or just document the protocol?
3. **Embedding model bundling** — Ship the 80MB model in the installer, or download on first use?
4. **Monetization** — Open core (free local, paid sync/collab)? Or fully open source with hosted services?
5. **Logseq migration fidelity** — How much effort on 100% Logseq import vs. 90% best-effort?
6. **Canvas/whiteboard scope** — Full Excalidraw-level canvas or simpler spatial view?
7. **Concurrent CLI access** — SQLite WAL handles concurrent reads, but should the CLI support file locking for concurrent writes from multiple agents?
