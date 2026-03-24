# MiNotes UX PRD — Editor & Interaction Overhaul

## Context

MiNotes has all 25 PRD features implemented, but the editing experience is rough compared to Logseq. The current UX has several friction points:

1. **Block creation is a separate input** — a text field at the bottom with an "Add" button, rather than seamless inline creation
2. **No keyboard-driven block navigation** — can't arrow between blocks, Enter doesn't create new blocks, Tab doesn't indent
3. **No block hierarchy in the UI** — blocks are flat despite the backend supporting parent_id nesting
4. **No visual outliner** — no bullets, no collapse/expand, no indent guides
5. **No block selection/focus mode** — can't select a block with arrow keys, zoom into a sub-tree
6. **No right sidebar** — can't view two pages side-by-side
7. **Journal doesn't auto-focus** — need to manually click the input to start writing

This PRD addresses these gaps to make MiNotes feel as fluid as Logseq while avoiding Logseq's known pain points.

---

## Design Principles

1. **Start typing immediately** — journal opens with cursor in first block. New pages start with an empty focused block.
2. **Keyboard-first, mouse-optional** — every action reachable by keyboard. Mouse enhances, never required.
3. **Blocks flow naturally** — Enter creates, Backspace merges, Tab nests. No separate "add block" input.
4. **Show hierarchy, don't force it** — visual indentation and collapse/expand, but flat blocks are fine too.
5. **Avoid Logseq's mistakes** — no mandatory outliner, no overloaded bullet click, no rigid page layout.

---

## UX-001: Seamless Block Creation

**Current:** Separate `<input>` at bottom with "Add" button.
**Target:** Pressing Enter at the end of any block creates a new sibling block below and moves cursor there.

### Behavior

| Key | Context | Action |
|-----|---------|--------|
| `Enter` | End of block content | Create new empty sibling block below, focus it |
| `Enter` | Middle of block | Split block at cursor — content after cursor moves to new block |
| `Shift+Enter` | Anywhere | New line within the same block (soft return) |
| `Backspace` | Start of empty block | Delete this block, move cursor to end of previous block |
| `Backspace` | Start of non-empty block | Merge this block's content into previous block |

### Implementation

- Remove the "Add a block" input and "Add" button from PageView
- Handle Enter/Backspace in the TipTap editor's `handleKeyDown`
- On Enter: call `api.createBlock(pageId, "", null, positionAfterCurrent)`, then focus the new block
- On Backspace at position 0: call `api.updateBlock(prevId, prevContent + currentContent)` then `api.deleteBlock(currentId)`
- New pages and journals auto-create one empty block and focus it

### Files to modify
- `src/editor/useBlockEditor.ts` — add Enter/Backspace handlers
- `src/components/PageView.tsx` — remove Add input, add block creation callbacks, manage focus
- `src/components/BlockItem.tsx` — accept onEnter, onBackspaceAtStart, onFocusRequest callbacks

---

## UX-002: Block Indent/Outdent (Outliner)

**Current:** Blocks are flat. Backend supports `parent_id` but UI ignores it.
**Target:** Tab/Shift+Tab to nest/un-nest blocks visually and in the database.

### Behavior

| Key | Action |
|-----|--------|
| `Tab` | Indent block — make it a child of the block above |
| `Shift+Tab` | Outdent block — move it up one level in hierarchy |
| `Alt+Shift+Up` | Move block up among siblings |
| `Alt+Shift+Down` | Move block down among siblings |

### Visual

- Indented blocks render with progressive left padding (20px per level)
- Parent blocks show a collapse/expand triangle (▶/▼)
- Clicking triangle collapses children (shows child count badge)
- Vertical indent guide lines connecting parent to children

### Implementation

- `PageView` builds a tree from flat blocks using `parent_id`
- Recursive `BlockTree` component renders children with depth
- Tab calls `api.moveBlock(blockId, prevSiblingId, position)` to reparent
- Shift+Tab moves block to grandparent's children
- Collapse state stored in block's `collapsed` field (already in model)

### Files to modify
- `src/components/PageView.tsx` — build block tree, recursive rendering
- `src/components/BlockItem.tsx` — accept depth prop, render children, collapse toggle
- `src/editor/useBlockEditor.ts` — handle Tab/Shift+Tab
- `src/styles.css` — indent guides, collapse triangle, depth-based padding

---

## UX-003: Block Navigation with Arrow Keys

**Current:** No keyboard navigation between blocks. Must click each block.
**Target:** Arrow up/down moves cursor between blocks when at block boundaries.

### Behavior

| Key | Context | Action |
|-----|---------|--------|
| `ArrowUp` | Cursor at first line of block | Move cursor to end of previous block |
| `ArrowDown` | Cursor at last line of block | Move cursor to start of next block |
| `Escape` | Editing a block | Exit edit mode, enter block selection mode |
| `ArrowUp/Down` | Block selection mode | Move selection highlight between blocks |
| `Enter` | Block selection mode | Re-enter edit mode for selected block |
| `Delete` | Block selection mode | Delete selected block |

### Implementation

- PageView maintains a `focusedBlockIndex` state
- BlockItem exposes `focus()` imperative handle via `useImperativeHandle`
- ArrowUp/Down at boundaries detected via TipTap's `handleKeyDown` checking cursor position
- Block selection mode: a CSS highlight on the selected block div, keyboard handled at PageView level

### Files to modify
- `src/components/PageView.tsx` — focus management, block selection state
- `src/components/BlockItem.tsx` — expose focus ref, report cursor-at-boundary events
- `src/editor/useBlockEditor.ts` — detect cursor at top/bottom of block

---

## UX-004: Auto-Focus on Page Open

**Current:** Opening a page shows content but cursor isn't in any block. Journal requires clicking.
**Target:** Opening any page focuses the first block (or last block for journals). New empty pages create and focus a starter block.

### Behavior

- Navigate to page → first block auto-focuses
- Navigate to journal → last block auto-focuses (you continue where you left off)
- Create new page → empty block created, auto-focused
- Create page from template → first empty block auto-focused

### Implementation

- PageView useEffect on `page.id` change: focus block[0] (or block[last] for journals)
- If blocks array is empty, auto-create one empty block then focus it
- BlockItem ref array managed by PageView for programmatic focus

---

## UX-005: Right Sidebar (Split View)

**Current:** Single content area. No way to view two pages simultaneously.
**Target:** Shift+Click any [[wiki link]] or page opens it in a right sidebar panel.

### Layout

```
┌──────────┬─────────────────────┬──────────────────┐
│ Sidebar  │ Main Content        │ Right Sidebar    │
│ (nav)    │ (current page)      │ (shift-clicked)  │
│          │                     │                  │
│          │                     │ PageView #2      │
│          │                     │                  │
└──────────┴─────────────────────┴──────────────────┘
```

### Behavior

- `Shift+Click` on any [[wiki link]], page item, or search result opens in right sidebar
- Right sidebar shows a simplified PageView (title + blocks, no sidebar within sidebar)
- Multiple panels stack vertically, each collapsible
- Close button (×) per panel
- Drag to resize main/right split
- `T then R` or `Ctrl+\` toggles right sidebar visibility

### Implementation

- App.tsx: `rightSidebarPages` state (array of page IDs)
- New `RightSidebar` component rendering stacked `MiniPageView` panels
- Pass `onShiftClick` to all components that render [[links]]
- CSS: `.app` becomes three-column flex when right sidebar is open

### Files to create
- `src/components/RightSidebar.tsx`
- `src/components/MiniPageView.tsx` (simplified PageView for sidebar panels)

---

## UX-006: Block Zoom (Focus Mode)

**Current:** No way to focus on a sub-tree of blocks.
**Target:** Click a block's bullet to zoom into it — show only that block and its children with breadcrumb navigation back.

### Behavior

- Click bullet → zoom into block (URL updates, breadcrumb shows path)
- Breadcrumb at top: `Page > Parent Block > Current Block` — each segment clickable
- `Alt+Right` zooms into current block
- `Alt+Left` zooms back out
- Zoomed view shows the block's children as the full page content

### Implementation

- PageView: `zoomedBlockId` state — when set, filter blocks to show only that sub-tree
- Breadcrumb component at top showing ancestor chain
- Bullet click handler triggers zoom (distinct from edit click — use the bullet dot element)

---

## UX-007: Improved Visual Design

**Current:** Minimal styling. Blocks are plain text with small bullet dots.
**Target:** Polished visual hierarchy with clear affordances.

### Changes

1. **Bullet redesign**: Larger bullet dots (6px circles). Hover reveals drag handle (⠿) to the left. Click bullet = zoom.
2. **Indent guides**: Thin vertical lines (1px, `var(--border)`) from parent bullet down to last child.
3. **Block hover state**: Subtle background highlight on hover (`var(--bg-surface)` at 50% opacity).
4. **Active block glow**: The currently-editing block has a left border accent (2px `var(--accent)`).
5. **Empty state redesign**: Instead of "Welcome to MiNotes" + input, show "Press Enter to start writing" with a blinking cursor placeholder in an empty block.
6. **Block spacing**: Slightly more vertical padding between blocks (6px → 8px).
7. **Breadcrumb bar**: When zoomed or viewing nested page, show clickable path at top of content area.

---

## UX-008: TODO/Task Cycling

**Current:** Task lists via markdown checkbox syntax only.
**Target:** `Ctrl+Enter` cycles block between TODO → DOING → DONE → plain text, matching Logseq's workflow.

### Behavior

- `Ctrl+Enter` on any block: if no status, prepend "TODO"; if "TODO", change to "DOING"; if "DOING", change to "DONE"; if "DONE", remove prefix.
- Status renders as a colored badge: TODO (yellow), DOING (blue), DONE (green, strikethrough).
- Works independently of the property system — it's a content prefix like Logseq uses.

---

## UX-009: Quick Capture in Journal

**Current:** Journal opens but requires navigating to it and manually adding blocks.
**Target:** The journal is the default landing page. Opening the app = cursor in today's journal, ready to type.

### Behavior

- App launch → auto-open today's journal
- First empty block auto-focused
- If journal has blocks from earlier today, cursor goes to a new empty block at the bottom
- Sidebar shows "today" prominently (already mostly done)

---

## UX-010: Inline Block References

**Current:** `((block-uuid))` syntax is supported in backend but not rendered in the editor.
**Target:** Typing `((` opens a block search, selecting inserts a live reference that shows the referenced block's content inline.

### Behavior

- Type `((` → dropdown searches blocks by content
- Select a block → inserts an inline read-only chip showing the block's text
- Click the chip → navigates to the source block's page
- Hover shows the full block content in a tooltip
- In markdown, saved as `((uuid))` — the existing backend link parsing handles it

### Implementation

- New TipTap node: `BlockRefNode` (similar to WikiLinkNode but for blocks)
- Suggestion plugin triggered by `((`
- Renders as inline chip with referenced content fetched from API

---

## Priority Order

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| UX-001 | Seamless block creation (Enter/Backspace) | Critical | Medium | P0 |
| UX-004 | Auto-focus on page open | High | Small | P0 |
| UX-009 | Journal as default landing | High | Small | P0 |
| UX-003 | Arrow key navigation between blocks | High | Medium | P0 |
| UX-002 | Block indent/outdent (Tab) | High | Large | P1 |
| UX-007 | Visual design polish | Medium | Medium | P1 |
| UX-008 | TODO cycling (Ctrl+Enter) | Medium | Small | P1 |
| UX-006 | Block zoom (focus mode) | Medium | Medium | P1 |
| UX-005 | Right sidebar (split view) | Medium | Large | P2 |
| UX-010 | Inline block references | Medium | Medium | P2 |

---

## Anti-Patterns to Avoid (from Logseq)

1. **Don't overload the bullet** — Logseq's bullet handles zoom, drag, collapse, and context menu. Separate these: bullet = zoom, drag handle = drag, triangle = collapse.
2. **Don't force outliner** — Allow flat blocks without mandatory nesting. Some content is naturally linear.
3. **Don't make properties verbose** — Logseq's `property:: value` syntax is clunky. Keep our chip-based UI.
4. **Don't hide the cursor** — Always show where you are. Active block should be visually obvious.
5. **Don't lag on mobile** — If/when mobile ships, sync before edit, never lose keystrokes.
