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

---

## UX-011: `[[` Page Link Autocomplete

**Current:** Type `[[Page Name]]` manually. The WikiLink TipTap node converts it to a chip after typing `]]`.
**Target:** Typing `[[` opens an instant dropdown listing existing pages, filtering as you type.

### Behavior

- Type `[[` → dropdown appears immediately below cursor
- Shows top 8 matching pages, filtered in real-time
- Arrow keys navigate, Enter selects and inserts `[[PageName]]` as a WikiLink node
- If no match: Enter creates a new page with that name and inserts the link
- Escape dismisses the dropdown
- Tab accepts the top suggestion

### Logseq's mistake to avoid
- Logseq's `#` autocomplete breaks on multi-word tags. Our implementation should handle spaces naturally since we use `[[...]]` for all links.

### Implementation
- TipTap suggestion plugin (same pattern as slash commands) triggered by `[[`
- Fetch page list from `api.listPages()`, filter client-side
- On select: insert WikiLink node, close brackets

---

## UX-012: Smart Paste

**Current:** Paste inserts raw text into the current block.
**Target:** Multi-line paste splits into separate blocks. Code paste stays in one block.

### Behavior

| Paste content | Result |
|--------------|--------|
| Single line | Insert into current block |
| Multiple lines (paragraphs) | Each paragraph becomes a new block |
| Indented text | Preserves hierarchy (indented lines become child blocks) |
| Code fence (triple backtick) | Paste as single code block, don't split |
| HTML from web page | Convert to markdown, then apply above rules |

### Logseq's mistake to avoid
- Logseq can't paste into code blocks (lines become separate blocks). We should detect when cursor is in a code block and paste as-is.

---

## UX-013: Multi-Block Selection

**Current:** No block selection. Must interact with one block at a time.
**Target:** Shift+Click or Shift+Arrow selects consecutive blocks for batch operations.

### Behavior

- `Shift+Up/Down` in block selection mode: extend selection
- `Shift+Click` on a block: select range from focused block to clicked block
- Selected blocks: blue highlight background
- Operations on selection: Delete, Copy, Cut, Tab (indent all), Shift+Tab (outdent all)
- `Escape` clears selection

---

## UX-014: Link Preview on Hover

**Current:** Clicking a [[wiki link]] navigates to the page.
**Target:** Ctrl+Hover over a link shows a floating preview of the linked page's first few blocks.

### Behavior

- Hover alone: just underline highlight (no popup, avoids accidental triggers)
- Ctrl+Hover: after 200ms, show a floating card with page title + first 5 blocks
- Click: navigate (existing behavior)
- Shift+Click: open in right sidebar (UX-005)
- Preview card: 300px wide, max 200px tall, scrollable, dark theme

### Logseq's mistake to avoid
- Logseq's always-on hover with 2s delay causes accidental popups while scrolling. Require Ctrl modifier.

---

## UX-015: Block Context Menu

**Current:** Right-click on blocks only works for delete via `confirm()` dialog.
**Target:** Rich context menu on right-click with common block operations.

### Menu items

- Copy block reference `((uuid))`
- Copy block content
- Duplicate block
- Delete block
- Add to favorites (if page-level)
- Create flashcard from this block
- Set heading level (H1-H4)
- Add property
- Move to page... (opens page picker)
- Open in right sidebar

---

## UX-016: Reliable Undo/Redo

**Current:** Event-based undo on Ctrl+Z, but only for block create/delete at app level.
**Target:** Global undo stack that works across block boundaries with character-level granularity.

### Behavior

- Ctrl+Z: undo last action (typing, block create, block delete, block merge, indent, property change)
- Ctrl+Shift+Z: redo
- Undo history persists for the session (cleared on app close)
- Works correctly across block boundaries (e.g., undo a merge restores both blocks)

### Logseq's mistake to avoid
- Logseq's undo is "critically broken" — redo history lost on block change, code blocks deleted by undo, merge undo requires 2 presses. This is their #1 technical debt. Doing undo right would be a major differentiator.

### Implementation
- Maintain an in-memory undo stack in the frontend (not event-sourced from backend)
- Each operation pushes an inverse action to the stack
- TipTap handles within-block undo natively; we handle cross-block operations

---

## UX-017: Onboarding / First-Run Experience

**Current:** EmptyState shows "Welcome to MiNotes" with a create page input.
**Target:** Interactive first-run walkthrough that teaches the core concepts by doing.

### Flow

1. First launch → auto-create a "Getting Started" page with tutorial blocks
2. Tutorial blocks teach:
   - "This is a block. Press Enter to create a new one below."
   - "Type `[[` to link to another page."
   - "Press `/` for slash commands."
   - "Press Ctrl+J to open your journal."
   - "Press Ctrl+K to search everything."
3. Each block has a subtle "try it" indicator
4. After user creates their first block, the tutorial fades and journal becomes the landing page
5. No modal dialogs, no forced walkthrough — learn by interacting with real content

### Logseq's mistake to avoid
- Logseq's onboarding is a static document. Users don't learn by reading, they learn by doing. Our tutorial should be blocks the user edits.

---

## UX-018: Subtle Animations

**Current:** No transitions. UI changes are instant.
**Target:** Minimal, performant animations that add polish without lag.

### Animations

| Element | Animation | Duration |
|---------|-----------|----------|
| New block created | Fade in + slight slide down | 150ms |
| Block deleted | Fade out + collapse height | 150ms |
| Sidebar open/close | Slide with ease-out | 200ms |
| Modal panels open | Fade in + scale from 95% | 150ms |
| Page transition | Fade crossfade | 100ms |
| Block hover highlight | Fade in background | 100ms |
| Toast notifications | Slide up + fade in | 200ms |

### Rules
- All animations respect `prefers-reduced-motion` media query
- No animation longer than 200ms
- No animation on scroll or typing (performance critical paths)

---

## Updated Priority Order

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| UX-001 | Seamless block creation (Enter/Backspace) | Critical | Medium | **P0** |
| UX-004 | Auto-focus on page open | High | Small | **P0** |
| UX-009 | Journal as default landing | High | Small | **P0** |
| UX-003 | Arrow key navigation between blocks | High | Medium | **P0** |
| UX-011 | `[[` page link autocomplete | High | Medium | **P0** |
| UX-002 | Block indent/outdent (Tab) | High | Large | **P1** |
| UX-007 | Visual design polish | Medium | Medium | **P1** |
| UX-008 | TODO cycling (Ctrl+Enter) | Medium | Small | **P1** |
| UX-016 | Reliable undo/redo | High | Large | **P1** |
| UX-015 | Block context menu | Medium | Small | **P1** |
| UX-012 | Smart paste | Medium | Medium | **P1** |
| UX-006 | Block zoom (focus mode) | Medium | Medium | **P2** |
| UX-005 | Right sidebar (split view) | Medium | Large | **P2** |
| UX-010 | Inline block references | Medium | Medium | **P2** |
| UX-013 | Multi-block selection | Medium | Medium | **P2** |
| UX-014 | Link preview on hover | Low | Medium | **P2** |
| UX-017 | Onboarding tutorial | Medium | Medium | **P2** |
| UX-018 | Subtle animations | Low | Small | **P2** |

---

## Anti-Patterns to Avoid (from Logseq)

1. **Don't overload the bullet** — Logseq's bullet handles zoom, drag, collapse, and context menu in one tiny target. Separate these: bullet = zoom, drag handle (on hover) = drag, triangle = collapse, right-click = context menu.
2. **Don't force outliner** — Allow flat blocks without mandatory nesting. Some content is naturally linear.
3. **Don't make properties verbose** — Logseq's `property:: value` syntax is clunky. Keep our chip-based UI.
4. **Don't hide the cursor** — Always show where you are. Active block should have a visible left-border accent.
5. **Don't lag on mobile** — Sync before edit, never lose keystrokes.
6. **Don't break undo** — Logseq's undo is critically broken across block boundaries. Invest in a reliable global undo stack.
7. **Don't use always-on hover previews** — Require Ctrl+Hover to avoid accidental popups while scrolling.
8. **Don't paste-split inside code blocks** — Detect code context and paste as-is.
9. **Don't lose redo history on navigation** — Redo stack should persist until a new action is taken.
10. **Don't skip onboarding** — An empty journal with no guidance loses new users. Teach by letting them edit real tutorial content.
