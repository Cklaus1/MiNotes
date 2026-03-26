# MiNotes Kanban Board PRD

## Overview

A kanban board view for any block subtree in MiNotes. Any block with children can be viewed as a kanban board — the block's children become columns and their children become cards. Works at any level: a full page, a zoomed-in section, or any parent block. Same data, different view. Toggle between Block View and Kanban View with one click.

Built with **@atlaskit/pragmatic-drag-and-drop** for drag-and-drop — the same library powering Trello and Jira. ~4.7 kB gzipped, framework-agnostic core, React 19 compatible.

## Problem Statement

Outliner-style block views are great for writing but poor for project management. Users tracking tasks, sprints, or workflows need a spatial board — not a nested list. The Kanban plugin is #8 on Obsidian (2.2M downloads), showing strong demand.

MiNotes already has the data: blocks with parent/child relationships form a natural column-card hierarchy. The missing piece is the visualization.

## Architecture: Any-Block Kanban

The kanban view works at **any level of the block tree**, not just the page level:

```
Page: "My Project"
├── Block: "Notes"                    ← regular block (no kanban here)
│   └── Block: "some notes..."
├── Block: "Sprint Board"             ← zoom in → kanban view available
│   ├── Block: "Backlog"              → Column 1
│   │   ├── Block: "Search UI"       → Card
│   │   └── Block: "Templates"       → Card
│   ├── Block: "In Progress"          → Column 2
│   │   └── Block: "Git Sync"        → Card
│   └── Block: "Done"                 → Column 3
│       └── Block: "Whiteboard"       → Card
└── Block: "Roadmap"                  ← zoom in → another kanban
    ├── Block: "Q1"                   → Column
    │   └── Block: "Foundation"       → Card
    └── Block: "Q2"                   → Column
        └── Block: "Launch"           → Card
```

- **Page level**: top-level blocks are columns → works like a full-page kanban
- **Zoomed in**: zoom into "Sprint Board" → its children are columns
- **Multiple boards per page**: "Sprint Board" and "Roadmap" are independent kanbans
- Uses the **existing zoom-in feature** — no new navigation needed
- View preference is stored per block context (page ID + optional zoomed block ID)

## Goals

1. Any block with children can be viewed as a kanban — no special page type needed
2. Same data, different view — edits in blocks or kanban stay in sync
3. Drag cards between columns (reparent) and reorder within columns
4. Add new cards and columns inline without switching to block view
5. Visual: card colors from block properties, TODO/DOING/DONE badges
6. Persist view preference per page

## Non-Goals

- Swimlanes or multi-level nesting (v1 = flat cards in columns)
- WIP limits or workflow automation (future)
- Real-time collaborative kanban (future)
- Custom card templates (future)
- Filtering/grouping cards by property (future — see query engine PRD)

## Library Choice: pragmatic-drag-and-drop

### Why Not Build From Scratch

The whiteboard uses a custom Canvas API because drawing is highly specialized. Kanban drag-and-drop is a solved problem with standard semantics (drag card → drop on column/between cards). Using a library avoids reimplementing drop zone detection, hit testing, scroll-during-drag, keyboard accessibility, and mobile touch support.

### Why pragmatic-drag-and-drop Over Alternatives

| Capability | pragmatic-drag-and-drop | @dnd-kit | @hello-pangea/dnd |
|-----------|------------------------|----------|-------------------|
| Bundle size | ~4.7 kB gzipped | ~12 kB | ~30 kB |
| React 19 | Yes (framework-agnostic core) | v6 no; v0.x pre-release | No |
| Maintenance | Atlassian (Trello, Jira) | Single maintainer | Stale |
| TypeScript | First-class | First-class | Yes |
| Kanban example | First-class (it's Trello's lib) | Community examples | Community examples |
| Touch support | Native HTML5 DnD | Custom pointer events | Custom pointer events |
| Keyboard DnD | Addon package available | Built-in | Built-in |

**Trade-off**: pragmatic-drag-and-drop is lower-level than dnd-kit's sortable preset — requires ~150-300 lines of custom wiring for drop indicators and reorder logic. But MiNotes gets full control over the UI, consistent with how the mindmap and whiteboard are built.

### Packages Needed

```
@atlaskit/pragmatic-drag-and-drop        # Core draggable/droppable
@atlaskit/pragmatic-drag-and-drop-hitbox  # Closest-edge detection for reorder
```

Optional (Phase 2+):
```
@atlaskit/pragmatic-drag-and-drop-react-drop-indicator  # Styled drop lines
@atlaskit/pragmatic-drag-and-drop-auto-scroll           # Scroll while dragging
```

## Data Model

No new data structures needed. Kanban reads from the existing block tree relative to a **root context** (page root or zoomed-in block):

```
Root context (page or zoomed block)
├── Block: "Backlog"              → Column 1
│   ├── Block: "Search UI"       → Card
│   ├── Block: "Templates"       → Card
│   └── Block: "Dark mode"       → Card
├── Block: "In Progress"          → Column 2
│   ├── Block: "Git Sync"        → Card
│   └── Block: "Encryption"      → Card
└── Block: "Done"                 → Column 3
    ├── Block: "Whiteboard"       → Card
    └── Block: "Bubble Menu"      → Card
```

### Block-to-Kanban Mapping

| Block Field | Kanban Element |
|-------------|---------------|
| Direct child of root `content` | Column title |
| Direct child of root `id` | Column ID |
| Grandchild block `content` | Card text (markdown stripped to plain text) |
| Grandchild block `id` | Card ID |
| Grandchild block `parent_id` | Which column the card belongs to |
| Grandchild block `position` | Card order within column |
| Block property `todo` | TODO/DOING/DONE badge on card |
| Page property `view` | `"kanban"` to remember view preference |
| Page property `kanban_root` | Zoomed block ID (if not page-level) |

### Card Display

Cards show a condensed view of block content:

```
┌──────────────────────┐
│ DOING                │  ← TODO state badge (if present)
│ Implement Git Sync   │  ← First line of content (plain text)
│ 3 sub-blocks         │  ← Child count (if card has children)
└──────────────────────┘
```

### API Operations

All operations use existing backend APIs — no new Tauri commands needed:

| Kanban Action | API Call |
|--------------|----------|
| Move card to another column | `moveBlock(cardId, newColumnId, position)` |
| Reorder card within column | `reorderBlock(cardId, columnId, newPosition)` |
| Add new card | `createBlock(pageId, "", columnId)` |
| Add new column | `createBlock(pageId, "New Column", null)` |
| Edit card text | `updateBlock(cardId, newContent)` |
| Edit column title | `updateBlock(columnId, newTitle)` |
| Delete card | `deleteBlock(cardId)` |
| Delete column | `deleteBlock(columnId)` (cascades to cards) |
| Persist view mode | `setProperty(pageId, "page", "view", "kanban")` |

## UI Design

### View Toggle

Kanban toggle lives in the **canvas mode bar** alongside Graph/Mindmap/Draw. This keeps it consistent with other view modes and avoids cluttering the page header.

```
┌─────────────────────────────────────────────────────────────┐
│ ← Notes    [Graph] [Mindmap] [Draw] [Kanban]                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Backlog ─────┐  ┌─ In Progress ──┐  ┌─ Done ────────┐  │
│  │ ...           │  │ ...            │  │ ...           │  │
```

- Accessed via canvas mode switcher (same as Graph/Mindmap/Draw)
- Kanban edits real block data (unlike read-only Graph)
- Keyboard shortcut: `Ctrl+Shift+K` to toggle
- When zoomed into a block, kanban shows that block's children as columns
- View preference persisted in localStorage (keyed by pageId + zoomedBlockId)

### Board Layout

```
┌─ Backlog ──────┐  ┌─ In Progress ──┐  ┌─ Done ──────────┐  ┌─ + ─┐
│ ┌────────────┐ │  │ ┌────────────┐ │  │ ┌────────────┐  │  │     │
│ │ Search UI  │ │  │ │ DOING      │ │  │ │ DONE       │  │  │ Add │
│ └────────────┘ │  │ │ Git Sync   │ │  │ │ Whiteboard │  │  │ col │
│ ┌────────────┐ │  │ │ 2 sub-blks │ │  │ └────────────┘  │  │     │
│ │ Templates  │ │  │ └────────────┘ │  │ ┌────────────┐  │  └─────┘
│ └────────────┘ │  │ ┌────────────┐ │  │ │ DONE       │  │
│ ┌────────────┐ │  │ │ Encryption │ │  │ │ Bubble Menu│  │
│ │ Dark mode  │ │  │ └────────────┘ │  │ └────────────┘  │
│ └────────────┘ │  │                │  │                  │
│                │  │                │  │                  │
│  + Add card    │  │  + Add card    │  │  + Add card      │
└────────────────┘  └────────────────┘  └──────────────────┘
```

- Columns scroll horizontally if they overflow
- Cards scroll vertically within each column
- Column width: 280px fixed
- Card gap: 8px
- Column header: editable inline (click to edit)
- "+" button at bottom of each column adds a new card
- "+" column at the end adds a new column

### Drag Interactions

| Action | Behavior |
|--------|----------|
| Drag card within column | Blue drop indicator line appears between cards |
| Drag card to another column | Column highlights, drop indicator shows position |
| Drag card over empty column | Column shows "Drop here" placeholder |
| Drag column header | Reorder columns (reorder top-level blocks) |

### Card Interactions

| Action | Behavior |
|--------|----------|
| Click card | Opens card in a side panel or inline editor |
| Double-click card | Edit card text inline |
| Right-click card | Context menu: Edit, Duplicate, Delete, Move to... |
| Click "+" | Creates empty card at bottom, focuses for editing |
| `Enter` in card editor | Save and create next card below |
| `Escape` in card editor | Save and close editor |

### Color Coding

Cards inherit color from TODO state:

| State | Card Style |
|-------|-----------|
| (none) | Default card (subtle border) |
| TODO | Left border: blue (#89b4fa) |
| DOING | Left border: yellow (#f9e2af) |
| DONE | Left border: green (#a6e3a1), strikethrough text |

### Empty State

When a page has no blocks, the kanban view shows:

```
┌──────────────────────────────────┐
│                                  │
│  This page is empty.             │
│  Add your first column to start  │
│  a kanban board.                 │
│                                  │
│        [+ Add Column]            │
│                                  │
└──────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Core Board (MVP)

**Scope**: Read-only kanban view with drag-and-drop between columns.

**New files**:
- `src/components/KanbanView.tsx` — board renderer (~400 lines)
- `src/components/KanbanCard.tsx` — card component (~80 lines)
- `src/components/KanbanColumn.tsx` — column component (~120 lines)

**Modified files**:
- `src/components/PageView.tsx` — view mode toggle (Blocks / Kanban)
- `src/styles.css` — kanban styles (~150 lines)
- `package.json` — add pragmatic-drag-and-drop deps

**Features**:
- [x] Render top-level blocks as columns, children as cards
- [x] Drag cards between columns (`moveBlock`)
- [x] Reorder cards within a column (`reorderBlock`)
- [x] TODO/DOING/DONE colored badges on cards
- [x] View toggle in page header (Blocks / Kanban)
- [x] Persist view preference as page property
- [x] Child count badge on cards with grandchildren
- [x] Horizontal scroll for many columns

**Effort**: Medium (2-3 days)

### Phase 2: Editing

**Scope**: Full CRUD from the kanban view.

**Features**:
- [ ] Inline edit card text (click to edit, Enter to save)
- [ ] Inline edit column title
- [ ] Add new card (+ button at bottom of column)
- [ ] Add new column (+ button at end)
- [ ] Delete card (context menu or keyboard)
- [ ] Delete column with confirmation (cascades to cards)
- [ ] Drag to reorder columns

**Effort**: Medium (1-2 days)

### Phase 3: Polish

**Scope**: Smooth animations, keyboard nav, advanced interactions.

**Features**:
- [ ] Auto-scroll during drag (pragmatic-drag-and-drop-auto-scroll)
- [ ] Keyboard navigation (arrow keys between cards/columns, Enter to edit)
- [ ] Card click → side panel with full block editor (TipTap)
- [ ] Column collapse (click header to minimize)
- [ ] Card count in column header ("Backlog (3)")
- [ ] Drag column to reorder
- [ ] Card search/filter

**Effort**: Medium (2 days)

### Phase 4: Integration

**Scope**: Deep integration with MiNotes features.

**Features**:
- [ ] Wiki-links in cards rendered as clickable links
- [ ] Card properties (tags, dates) shown as badges
- [ ] "Move to..." submenu in context menu (lists columns)
- [ ] Keyboard shortcut `Ctrl+Shift+K` to toggle view
- [ ] Export board as markdown table or image

**Effort**: Low-Medium (1-2 days)

## Styling

### CSS Variables (Catppuccin Mocha theme)

```css
.kanban-board {
  display: flex;
  gap: 12px;
  padding: 16px;
  overflow-x: auto;
  height: 100%;
  align-items: flex-start;
}

.kanban-column {
  width: 280px;
  min-width: 280px;
  background: var(--bg-secondary);
  border-radius: 10px;
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 120px);
}

.kanban-column-header {
  padding: 12px 14px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border);
  cursor: grab;
}

.kanban-column-body {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kanban-card {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  cursor: grab;
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-primary);
  transition: box-shadow 0.15s, border-color 0.15s;
}

.kanban-card:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.kanban-card.dragging {
  opacity: 0.5;
}

.kanban-card[data-todo="TODO"] { border-left: 3px solid #89b4fa; }
.kanban-card[data-todo="DOING"] { border-left: 3px solid #f9e2af; }
.kanban-card[data-todo="DONE"] { border-left: 3px solid #a6e3a1; }
.kanban-card[data-todo="DONE"] .kanban-card-text { text-decoration: line-through; color: var(--text-muted); }

.kanban-drop-indicator {
  height: 2px;
  background: var(--accent);
  border-radius: 1px;
  margin: -4px 0;
}

.kanban-add-card {
  padding: 8px;
  text-align: center;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  font-size: 12px;
}

.kanban-add-card:hover {
  background: var(--bg-surface);
  color: var(--text-secondary);
}
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Shift+K` | Toggle Blocks ↔ Kanban view |
| `Arrow Left/Right` | Move focus between columns |
| `Arrow Up/Down` | Move focus between cards |
| `Enter` | Edit focused card |
| `Escape` | Close card editor / deselect |
| `n` | New card in focused column |
| `N` | New column |
| `Delete` | Delete focused card (with confirmation) |

## Performance

- Lazy render cards outside viewport (virtual scroll for 100+ cards per column)
- Debounce API calls during rapid drag operations (save final position only)
- Optimistic updates — move card in UI immediately, sync to backend async
- Use `React.memo` on KanbanCard to prevent re-renders during drag

## Migration / Compatibility

- No database changes needed
- Existing pages work as kanban boards immediately (top-level blocks = columns)
- Users who never use kanban view are unaffected — default view stays "Blocks"
- Block changes in kanban view are visible in block view and vice versa
- Kanban view preference stored as page property — syncs with Git sync feature
