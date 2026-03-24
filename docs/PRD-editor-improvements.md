# MiNotes Editor & UX Improvements PRD

## Overview

A collection of high-impact editor and UX features drawn from the top 100 Obsidian plugins analysis. These are features that should be native to MiNotes — not plugins — because they are core to the daily note-taking experience. Organized by priority tier.

---

## High Priority

### 1. Recent Files in Sidebar

**What**: A "Recent" section at the top of the sidebar showing the last 5-8 pages you visited, ordered by last-opened time.

**Why**: Users constantly switch between a handful of pages. Scrolling through the full page list or using search for pages you were just on is friction. The #20 Obsidian plugin (962K downloads).

**Design**:
```
── Recent ──
  📄 Design Doc                    2m ago
  📅 2026-03-24                    5m ago
  📄 Sprint Review                15m ago
  📄 Research Notes               1h ago
  📄 Project Alpha                3h ago
```

**Implementation**:
- Track `lastOpenedAt` per page in a lightweight store (localStorage or in-memory with persistence)
- Not the same as `updated_at` — opening a page without editing still updates recency
- Show top 5-8, configurable in settings
- Click navigates to page; right-click removes from recent
- Collapsible section header

**Files to modify**:
- `Sidebar.tsx` — add Recent section above Favorites
- `App.tsx` — track page opens in a recency list
- `settings.ts` — add `recentFilesCount` setting

---

### 2. Table Editor — WYSIWYG Tables

**What**: Create and edit tables visually — click to add rows/columns, Tab to navigate cells, resize columns by dragging. No raw markdown pipe syntax.

**Why**: Tables in markdown are painful. The #5 Obsidian plugin (2.7M downloads). Essential for meeting notes, comparisons, project tracking.

**Design**:
```
┌──────────────────────────────────────────┐
│  + Add Column                            │
├──────────┬──────────┬──────────┬────┤
│ Feature  │ Status   │ Owner    │  + │
├──────────┼──────────┼──────────┤    │
│ Search   │ ✅ Done  │ Alice    │    │
│ Sync     │ 🔄 WIP  │ Bob      │    │
│ Export   │ ⏳ Todo  │ Charlie  │    │
├──────────┴──────────┴──────────┤    │
│  + Add Row                     │    │
└──────────────────────────────────────┘
```

**Interactions**:
- `/table` slash command creates a 3x3 table
- Tab / Shift+Tab to navigate cells
- Click column/row headers to select entire column/row
- Right-click cell → Insert row above/below, Insert column left/right, Delete row/column
- Drag column borders to resize
- Supports markdown formatting inside cells (bold, links, code)

**Implementation**:
- TipTap already has `Table`, `TableRow`, `TableCell`, `TableHeader` extensions loaded
- Need: toolbar buttons for table operations, Tab key handling in cells, visual resize handles
- Create `TableToolbar.tsx` — appears when cursor is in a table
- Add `/table` to slash commands
- CSS for table styling (borders, cell padding, header row)

**Files to modify**:
- `slashCommands.ts` — add `/table` command
- New `TableToolbar.tsx` — contextual toolbar for table operations
- `useBlockEditor.ts` — handle Tab key in table context
- `styles.css` — table styles
- `editor.css` — ProseMirror table styles

---

### 3. Dynamic Templates with Variables

**What**: Templates that insert dynamic content when applied — current date, page title, cursor placement, custom variables.

**Why**: The #2 Obsidian plugin (3.9M downloads). Users create the same structures repeatedly (meeting notes, project pages, weekly reviews). Static templates exist; dynamic ones save real time.

**Design**:

Template definition:
```markdown
---
template: true
name: Meeting Notes
---

# {{title}}

**Date**: {{date:YYYY-MM-DD}}
**Attendees**: {{cursor}}

## Agenda

-

## Discussion

-

## Action Items

- [ ] {{input:Assignee}}:
```

**Variable types**:
| Variable | Description | Example Output |
|----------|-------------|---------------|
| `{{title}}` | Current page title | "Sprint Review" |
| `{{date}}` | Today's date (ISO) | "2026-03-24" |
| `{{date:format}}` | Formatted date | "March 24, 2026" |
| `{{time}}` | Current time | "14:30" |
| `{{cursor}}` | Place cursor here after insertion | (cursor position) |
| `{{input:Label}}` | Prompt user for value | Shows input dialog |
| `{{yesterday}}` | Yesterday's date | "2026-03-23" |
| `{{tomorrow}}` | Tomorrow's date | "2026-03-25" |

**Implementation**:
- Extend existing template system (we have `create_template`, `apply_template`)
- Add variable parser: regex `\{\{(\w+)(?::([^}]+))?\}\}`
- On apply: replace variables, collect `{{input:*}}` prompts, set cursor at `{{cursor}}`
- Template picker: `/template` slash command or Ctrl+T

**Files to modify**:
- New `templateEngine.ts` — variable parsing and substitution
- `slashCommands.ts` — add `/template` command
- Existing template API — no backend changes needed (variables resolved client-side)
- `App.tsx` — template picker dialog

---

### 4. Multi-Color Text Highlighting

**What**: Highlight text in multiple colors — yellow, blue, green, red, purple. Not just the single default highlight.

**Why**: The #29 Obsidian plugin (610K downloads). Users highlight for different purposes — important (red), question (blue), idea (green), reference (yellow).

**Design**:
- Bubble toolbar gets a highlight dropdown: 🟡 🔵 🟢 🔴 🟣
- Clicking a color applies `==text==` with a color class
- Markdown format: `==highlighted text=={.highlight-blue}` or use mark syntax

**Implementation**:
- TipTap `Highlight` extension already supports `color` attribute
- Extend `Highlight.configure({ multicolor: true })`
- Update `BubbleToolbar.tsx` — replace single H button with color picker
- CSS for each highlight color
- Markdown serialization: `==text==` for yellow (default), extended syntax for colors

**Files to modify**:
- `useBlockEditor.ts` — configure Highlight with multicolor
- `BubbleToolbar.tsx` — highlight color picker
- `styles.css` — `.highlight-yellow`, `.highlight-blue`, etc.
- `editor.css` — ProseMirror highlight styles

---

### 5. Outline / TOC Panel

**What**: A panel showing the heading structure of the current page as a clickable table of contents. Clicking a heading scrolls to it.

**Why**: The #77 Obsidian plugin (264K downloads). Essential for long pages — meeting notes, design docs, research. Helps users understand page structure at a glance.

**Design**:
```
── Outline ──
  # Sprint Review
    ## Agenda
    ## Demo Items
    ## Discussion
      ### Technical Debt
      ### Timeline
    ## Action Items
```

**Implementation**:
- Parse blocks for heading content (`# `, `## `, `### `)
- Render as an indented list in the right sidebar
- Click → scroll to that block (using `data-block-id`)
- Updates live as user edits headings
- Show in right sidebar panel (collapsible)

**Files to modify**:
- New `OutlinePanel.tsx` — heading tree with click-to-scroll
- `PageView.tsx` — extract heading structure from blocks
- `App.tsx` — add outline to right sidebar
- `styles.css` — outline panel styles

---

## Medium Priority

### 6. Kanban View for Pages

**What**: View a page as a kanban board where top-level blocks are columns and their children are cards. Drag cards between columns.

**Why**: The #8 Obsidian plugin (2.2M downloads). Project management inside notes — no need for a separate tool.

**Design**:
```
Page: "Project Board"
View: [Blocks] [Kanban]

┌─ Backlog ────┐  ┌─ In Progress ─┐  ┌─ Done ────────┐
│ Search UI    │  │ Git Sync      │  │ Whiteboard    │
│ Templates   │  │ Encryption    │  │ Bubble Menu   │
│              │  │               │  │ URL Paste     │
│              │  │               │  │ Hover Preview │
└──────────────┘  └───────────────┘  └───────────────┘
```

**Implementation**:
- Top-level blocks = kanban columns (their `content` = column title)
- Child blocks = cards within the column
- Drag card between columns = `reparent_block` to new parent
- Toggle between block view and kanban view per page
- Store view preference as page property (`view:: kanban`)

**Files to modify**:
- New `KanbanView.tsx` — kanban board renderer
- `PageView.tsx` — view mode toggle (blocks vs kanban)
- `api.ts` — use existing `reparent_block` for card moves
- `styles.css` — kanban board and card styles

---

### 7. Inline Dataview Queries — Live Rendering

**What**: Write queries inside blocks that render live results. Like Obsidian Dataview but simpler.

**Why**: The #3 Obsidian plugin (3.8M downloads). Users want to see "all pages tagged #project" or "all TODOs across my notes" rendered inline.

**Design**:

Block content:
```
```query
pages where tags contains "project"
sort updated desc
limit 10
```​
```

Renders as:
```
── Query Results (3 pages) ──
📄 Project Alpha         Updated 2h ago
📄 Project Board         Updated 1d ago
📄 Sprint Review         Updated 3d ago
```

**Query types**:
- `pages where ...` — list pages matching filter
- `blocks where ...` — list blocks matching content/property filter
- `tasks where ...` — list TODO/DOING/DONE items across pages
- `tags` — list all tags with counts

**Implementation**:
- Detect code blocks with language `query` or `dataview`
- Parse simple query syntax (already have `run_query` backend command)
- Render results inline below the code block
- Results update on page refresh (not real-time)
- Extend existing `QueryPanel` logic for inline use

**Files to modify**:
- `BlockItem.tsx` — detect query blocks, render results inline
- New `InlineQuery.tsx` — query parser and result renderer
- Extend backend `run_query` if needed for new filter types

---

### 8. Periodic Notes (Weekly / Monthly)

**What**: Alongside daily journal pages, support weekly and monthly review pages with templates.

**Why**: The #30 Obsidian plugin (609K downloads). Weekly reviews, monthly goals, quarterly planning — all follow the same pattern as daily journals but at different cadences.

**Design**:
```
── Journals ──
  📅 2026-03-24              (daily)
  📅 2026-03-23
  📅 Week 13 (Mar 24-30)     (weekly)
  📅 March 2026              (monthly)
```

**Implementation**:
- `journal_type` field: `daily`, `weekly`, `monthly`
- Weekly: `YYYY-Www` format (ISO week), auto-created on first day of week
- Monthly: `YYYY-MM` format, auto-created on first day of month
- Each type has its own template (configurable)
- Navigation: "← Prev Week" / "Next Week →" in journal header
- Sidebar groups by type

**Files to modify**:
- Backend: extend `get_journal` to accept `type` parameter
- `PageView.tsx` — periodic navigation buttons
- `Sidebar.tsx` — group journals by period
- `settings.ts` — weekly/monthly templates configuration

---

### 9. Natural Language Dates

**What**: Type "next Tuesday" or "in 3 days" in a block and it resolves to an actual date. Rendered as a clickable date chip.

**Why**: The #41 Obsidian plugin (475K downloads). Useful for task deadlines, meeting scheduling, journal references.

**Design**:
- Type `@next tuesday` or `@march 30` → resolves to `2026-03-31`
- Rendered as: `📅 Mar 31, 2026` (clickable chip → opens that journal day)
- Trigger: `@` followed by date-like text
- Also works in properties: `deadline:: next friday` → `deadline:: 2026-03-27`

**Implementation**:
- Use `chrono` on backend or a lightweight date parser
- TipTap suggestion plugin triggered by `@`
- Date suggestion dropdown showing parsed interpretation
- Stores as ISO date string, renders as formatted chip

**Files to modify**:
- New `DateSuggestion.ts` — TipTap suggestion plugin for `@`
- New `DateNode.ts` — inline node for rendered dates
- New `dateParser.ts` — natural language → date resolution
- `useBlockEditor.ts` — add DateSuggestion extension

---

### 10. URL Auto-Title Fetch

**What**: When pasting a bare URL (no selection), automatically fetch the page title and create `[Page Title](url)` instead of `[url](url)`.

**Why**: Combined with the existing URL-to-link paste, this completes the "smart paste" experience. The #59 Obsidian plugin (343K downloads).

**Design**:
- Paste `https://github.com/anthropics/claude-code`
- Immediately shows: `[https://github.com/anthropics/claude-code](https://github.com/anthropics/claude-code)`
- After 1-2 seconds (async fetch): updates to `[claude-code - GitHub](https://github.com/anthropics/claude-code)`
- If fetch fails: keeps the URL as the link text

**Implementation**:
- Backend Tauri command: `fetch_url_title(url) → Option<String>`
- Uses `reqwest` with 3-second timeout, parses `<title>` from HTML
- Frontend: paste inserts `[url](url)` immediately, then async-replaces link text
- Mock backend: returns URL hostname as title

**Files to modify**:
- Backend: new `fetch_url_title` command
- `useBlockEditor.ts` — async title fetch after URL paste
- `api.ts` — add `fetchUrlTitle` function
- `mockBackend.ts` — mock title fetcher

---

## Implementation Priority

| # | Feature | Effort | Impact | Dependencies |
|---|---------|--------|--------|-------------|
| 1 | Recent Files | Small | High | None |
| 2 | Table Editor | Medium | High | TipTap Table (already loaded) |
| 3 | Dynamic Templates | Medium | High | Existing template system |
| 4 | Multi-Color Highlight | Small | Medium | TipTap Highlight (already loaded) |
| 5 | Outline/TOC Panel | Small | Medium | Right sidebar (exists) |
| 6 | Kanban View | Large | High | Block tree system |
| 7 | Inline Queries | Medium | High | Existing query engine |
| 8 | Periodic Notes | Medium | Medium | Journal system |
| 9 | Natural Language Dates | Medium | Medium | Date parser |
| 10 | URL Auto-Title | Small | Medium | Backend HTTP fetch |

**Recommended build order**: 1 → 4 → 5 → 10 → 2 → 3 → 7 → 8 → 6 → 9

Start with the quick wins (Recent Files, Highlight Colors, Outline, URL Title) to deliver visible improvements fast, then tackle the heavier features (Tables, Templates, Queries, Kanban).
