# MiNotes Kanban Board PRD

Status: 85% built · Revised 2026-10-10 · Owner: Chris Klaus

> **What changed in this revision.** The spec now describes the board as built:
> a full-screen **canvas mode** (beside Graph / Mindmap / Draw / Pages), not a
> page-header toggle, with no `view::` page property. Columns are now *sections*
> (headings or blocks with children) rather than "every top-level block", with a
> virtual "No section" column for loose blocks (from the `ux-int` worktree, merging
> soon). A status column was added to the feature list, stale CSS and file-size
> estimates were removed, the remaining work was re-prioritised (any-block boards
> and property badges kept; image export, virtualisation and several shortcuts
> cut), and a "Where AI helps" section was added.

## Overview

A kanban board for any page. Same data, different view: a page's sections become
columns and the blocks under them become cards. Dragging a card moves the real
block, so the outline and the board are always the same document. Open it with
the **Kanban** button in the sidebar mode bar or `Ctrl+Shift+K`.

Drag-and-drop uses **@atlaskit/pragmatic-drag-and-drop** (+ `-hitbox`,
`-auto-scroll`): small, React-19 compatible, maintained by Atlassian.

## Problem

Outlines are good for writing and poor for tracking work. Users with tasks,
sprints or pipelines want a spatial board; the Obsidian Kanban plugin (2M+
downloads) shows the demand. MiNotes already has the hierarchy — the board is a view.

## How a page maps to a board (as built)

Source: `crates/minotes-app/src/components/kanban/kanbanModel.ts` (ux-int).

```
Page: "Sprint 12"
├── # Sprint 12                 ← skipped: leading H1 that repeats the title
├── Remember to demo on Friday  ← loose block → card in "No section"
├── ## Backlog                  ← heading → column
│   ├── TODO Search UI          ← card (badge "TODO", text "Search UI")
│   └── Templates               ← card
├── In progress                 ← block with children → column
│   └── DOING Git sync          ← card
└── ## Done                     ← heading (even when empty) → column
```

| Rule | Behaviour |
|---|---|
| Column | A top-level block that is a markdown heading **or** has children |
| Card | A child of a column; card order = block `position` |
| "No section" | Virtual leading column for other non-empty top-level blocks; shown only when it has cards. Dropping a card here moves it to the page's top level |
| Sticky columns | A block once shown as a column stays a column for that page even after its last card moves out (so it doesn't flip into a card mid-session). Stored in localStorage `kanban-columns-<pageId>` |
| Skipped | A leading H1 equal to the page title (unless it has children); `---` dividers |
| Card text | First line, markdown stripped; the TODO/DOING/DONE keyword is shown as a badge and removed from the text (stored content keeps it) |
| New column | Created as `## New Column`, so an empty column is still a column |

All writes go through existing APIs (`moveBlock`, `reorderBlock`, `createBlock`,
`updateBlock`, `deleteBlock`, `snapshotSubtrees`/`restoreBlocks`). No schema change.

**Why this beats the original rule** ("every top-level block is a column"): real
pages mix a title, a few notes and some sections. The section rule turns such a
page into a sensible board without restructuring it first.

## Features and status

Paths are under `crates/minotes-app/src/components/`. "ux-int" = in the UX worktree, merging soon.

| Feature | Status | Where |
|---|---|---|
| Board as canvas mode; mode-bar button; `Ctrl+Shift+K` toggle | Done | `CanvasMode.tsx`, `App.tsx`, `Sidebar.tsx` |
| Sections → columns, "No section" column, title-H1 skip | Done (ux-int) | `kanban/kanbanModel.ts` |
| Drag cards between / within columns, drop indicator, auto-scroll | Done | `kanban/KanbanView.tsx`, `KanbanCard.tsx` |
| Drag to reorder columns | Done | `KanbanView.tsx` (`columnDragId`) |
| TODO/DOING/DONE badge, coloured left border, keyword stripped from text | Done (strip: ux-int) | `KanbanCard.tsx` |
| Cycle TODO state from card menu | Done | `KanbanCard.tsx` |
| Sub-block count on card | Done | `KanbanCard.tsx` |
| Inline edit card (double-click / Enter); add card; edit column title | Done | `KanbanCard.tsx`, `KanbanColumn.tsx` |
| Add / delete column (confirm, cascades) | Done | `KanbanView.tsx` |
| Delete card with Undo toast (restores original ids, so refs survive) | Done | `KanbanView.tsx` |
| Card context menu with "Move to…" column list | Done | `KanbanCard.tsx` |
| Card count in column header; collapse column | Done | `KanbanColumn.tsx` |
| Card filter (`Ctrl+F` or `/`) | Done | `KanbanView.tsx` |
| Keyboard: arrows between cards/columns, Enter edit, `n` new card, Esc | Done | `KanbanView.tsx` |
| Card detail side panel | Partial — plain textarea + read-only sub-block list, not the TipTap editor | `KanbanView.tsx` (`SidePanelEditor`) |
| Wikilinks on cards | Partial — shown as chips; clicking opens the side panel, not the page | `KanbanCard.tsx` |
| Export | Partial — "Copy as Table" (markdown table to clipboard); no image export | `KanbanView.tsx` |
| Column colours | Partial — per device (localStorage `kanban-colors-<pageId>`), lost on sync | `KanbanView.tsx` |
| Property badges on cards (tags, dates, assignee) | Not started | — |
| Any-block boards (board of a zoomed block; several boards per page) | Not started — board always uses the whole page | `CanvasMode.tsx` |
| Remember "this page opens as a board" | Not started (no `view::` property) | — |

### Obsolete parts of the previous spec

- **Page-header Blocks/Kanban toggle and `view::kanban` / `kanban_root` page
  properties** — replaced by canvas mode. The board is a lens you switch to, like
  the mind map; not a stored page type.
- **"Top-level block = column, grandchild = card"** — replaced by the section rule above.
- **Click card → open panel; double-click → edit** — built as: click focuses,
  double-click/Enter edits, menu opens details.
- **Shortcuts `N` (new column) and `Delete` (delete card)** — not built, dropped
  (menu and the "+ Add column" button cover them; a single-key delete is risky).
- **Virtual scrolling for 100+ cards; debounced drag writes** — dropped until a
  real page shows a problem; a drop already writes once.
- **The CSS block and per-file line estimates** — removed; the code is the reference.

## Remaining work, prioritised

**Next (worth doing)**

1. **Column colours in the document.** Store as a block property on the column
   (`color:: blue`), not localStorage, so they sync, export and survive a device
   change. Same for sticky columns: a heading is already durable, so prefer making
   "+ Add column" and "turn card into column" produce a heading and drop the
   localStorage sticky set once nothing depends on it. Small; fixes silent data loss.
2. **Property badges on cards.** Show up to three chips from block properties and
   inline tags/dates (`#tag`, `due::`, `SCHEDULED`), using the existing tag/date
   extractors. This is what makes a board useful for real tracking. Medium.
3. **Wikilink chips navigate** (click opens the page; Shift+click opens in the
   right sidebar, like everywhere else). Small; current behaviour is surprising.
4. **Side panel uses the real block editor** (TipTap, with children editable) so
   card details aren't a second-class textarea. Medium; reuse `BlockItem`.

**Later**

5. **Board of a zoomed block.** When the outline is zoomed into a block, Kanban
   uses that block as the root. Gives "several boards per page" for free via zoom,
   without a page-type concept. Medium.
6. **Open as board by default** — only if users ask; a per-page `view:: kanban`
   property read on open. Keep it opt-in.

**Cut**

- Image/PNG export (copy-as-table and the markdown mirror cover sharing).
- Swimlanes, WIP limits, automation rules (out of scope for a notes app).

**Becomes a plugin extension point**

- Alternative board layouts (timeline, gallery, calendar-of-cards) belong to the
  **Page view** extension point in `PRD-plugin-architecture.md` §4 (Phase 3).
  Kanban stays built in (principle 5: built-ins stay built in); its section→column
  model (`kanbanModel.ts`) is a good reference for the read-only block-tree API
  that extension point will need.
- Card actions like "Send to Todoist/Linear" use the **block context-menu item**
  extension point; the card menu should host those items too.

## Where AI helps

All ideas run through the AI platform (`PRD-ai-assistant.md`): off by default,
user-chosen provider (cloud key or local model), only the current page is sent,
every change previewed and undoable as one step.

| Idea | Verdict | Why |
|---|---|---|
| **Turn a messy page into a board** — propose sections and which loose blocks go under each, shown as a preview board; accept applies it as moves (+ new headings) in one undo step | **Keep — P1** | The section rule can't group untitled loose notes by meaning; an LLM can. High value at the moment a user first opens Kanban on a real page. Privacy: one page's text |
| **Summarise a column** ("what's in Doing?", "what got done this week?") into a block the user can insert | **Keep — P2** | Good for standups/status notes; output is a draft the user places. Cheap and safe |
| **Suggest a column for a new card** in "No section" | **Reject for now** | With 3–6 columns the user already knows; a TODO state or keyword rule does it more predictably. Revisit as part of "messy page → board" |
| **Draft card text** | **Reject** | Cards are one-liners the user is already typing; the general AI writing actions in the editor cover any real need |
| Auto-moving cards between columns on their own | **Reject** | Boards must be predictable; nothing moves without the user |

## Open questions for the owner

1. Is "headings or blocks-with-children are columns" the right default, or should
   a page with *no* headings fall back to "every top-level block is a column"?
2. Column colours: OK to write a `color::` property onto the column block (visible
   in the outline), or prefer a hidden page-level map?
3. Should the board remember being open per page (`view:: kanban`), or always open
   explicitly? (Recommendation: explicit, until users ask.)
4. Zoomed-block boards — needed for v1.x, or is one board per page enough?
5. Should AI "page → board" also be offered in the outline (e.g. "Organise into
   sections"), since the result is useful without Kanban too?
