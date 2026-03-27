# MiNotes Sidebar Navigation PRD

## Problem Statement

As users accumulate pages, the sidebar becomes overwhelmed. The current layout shows all folders expanded, all pages visible, and a separate "Recent Journals" section — creating a long, unscannable list. At 30+ pages, users stop using the sidebar and rely entirely on Ctrl+K search, which means the sidebar is failing its primary job: **quick spatial navigation**.

### Current Sidebar (what's broken)

```
┌─────────────────────┐
│ 🔍 Search...        │
│ 📅 Journal  + Project│
│ ⭐ Favorites        │  ← buried, not discoverable
│ 📁 Work             │  ← always expanded
│   ...12 pages...    │
│ 📁 Personal         │  ← also expanded
│   ...8 pages...     │
│ Pages (15)          │  ← unfiled, long list
│ Recent Journals     │  ← separate section, redundant
│   📅 Mar 26         │
│   📅 Mar 25         │
│ ─────────────────── │
│ 📊Graph 🧠Mind ...  │
└─────────────────────┘
```

**Problems:**
1. Everything expanded = no information hierarchy
2. Folders compete with Pages compete with Journals — too many sections
3. Favorites buried and not discoverable (right-click only)
4. Recent Journals split from Recent Pages — artificial separation
5. Sidebar scrolling becomes the bottleneck at 30+ pages
6. New users see 5 empty sections — intimidating

## Design: New Sidebar Layout

```
┌─────────────────────┐
│ 🔍 Search     [+ New]│  ← always visible, two primary actions
│                       │
│ 📅 Thu, Mar 26    [📅]│  ← 1 line, calendar toggle on right
│                       │
│ QUICK ACCESS          │  ← merged Pinned + Recent
│ 📌 Project Alpha      │  ← pinned (stable, user-curated)
│ 📌 Meeting Notes      │  ← pinned (stable)
│    Sprint Board       │  ← recent (auto-tracked, no pin icon)
│    Research Notes     │  ← recent (auto-tracked)
│                       │
│ PROJECTS              │  ← max 2 open at a time
│ ▾ Work                │  ← expanded
│     API Design        │
│     Bug Tracker       │
│     ...+8 more        │  ← expands inline on click
│ ▸ Personal            │  ← collapsed
│ ▸ Archive             │  ← collapsed
│                       │
│ PAGES                 │  ← unfiled, collapsed by default
│ ▸ 7 unfiled pages     │
│                       │
│ ─────────────────────│
│📊Graph 🧠Mind 🎨Draw 🗂Kanban│
└─────────────────────┘
```

## Key Design Decisions

### 1. Search + New Always Visible

**What**: `🔍 Search` and `[+ New]` side by side at the top. Always visible, never scroll away.

**Why**: The two most frequent sidebar actions — find something, create something. Every app puts these at the top (Notion, Obsidian, Linear, Slack).

**+ New**: Creates a new page. Future: dropdown with "New Page" / "New Project" / "New Journal Entry". For v1, just new page.

### 2. Journal: One Line, Not a Section

**What**: `📅 Thu, Mar 26` — single line. Click text → open today's journal. Click 📅 icon → expand calendar dropdown for other dates.

**Why**: Journals are a daily habit but don't need two lines of prime sidebar space. One line gives instant access. Calendar handles browsing.

**Soft-create**: Clicking a date with no journal shows "No entry yet / + Start writing" (already built). No empty page pollution.

### 3. Quick Access (Merged Pinned + Recent)

**What**: One section combining pinned pages (user-curated, stable) and recent pages (auto-tracked, dynamic). Pinned pages show 📌 icon, recent pages don't.

**Why**:
- Two separate sections (Pinned, Recent) create choice paralysis — "where do I look?"
- Merged section answers one question: "what are my active pages right now?"
- Pinned pages are always at the top (stable). Recent pages fill below (dynamic).
- If a recent page is also pinned, it shows once (in pinned position).

**Pinning**:
- Hover any page → 📌 pin icon appears. One click to pin.
- Pinned pages reorderable via drag.
- Max 7 pins. Right-click → Unpin to remove.
- NOT buried in right-click context menu only — visible on hover.

**Recent**:
- Last 5 unique pages opened (pages + journals mixed).
- Already tracked via `recentFiles.ts` localStorage.
- Auto-updates. No user action needed.

### 4. Projects (Renamed from Folders)

**What**: "Folders" renamed to "Projects". Max 2 projects open simultaneously. Opening a 3rd closes the oldest. Shift+click to force a third open.

**Why**:
- "Projects" matches how users think about grouped work
- Strict single-accordion (one open at a time) breaks cross-project comparison
- 2-max balances focus vs flexibility
- Page count shows on hover only (not when collapsed) — avoids "pile of work" anxiety

**Expand/collapse**:
- Click project name → toggle expand
- If 2 already open and a 3rd is clicked → oldest auto-collapses
- Shift+click → force open without closing others
- Remember expanded state in localStorage

**Capped pages**:
- Show first 8 pages when expanded
- If more: `...+N more` that expands inline (not a navigation event)
- Expanded state shows all pages within the sidebar, scrollable

### 5. Unfiled Pages (Collapsed by Default)

**What**: Root pages not in any project. Collapsed by default showing count: `▸ 7 unfiled pages`. Click to expand.

**Why**: Unfiled pages are usually the "inbox" — things not yet organized. Showing them collapsed keeps the sidebar clean while still giving access.

### 6. Progressive Disclosure

**What**: Sections appear only when they have content.

**Why**: New user with 0 pages sees:
```
🔍 Search        [+ New]
📅 Thu, Mar 26
Getting Started         ← seeded page
```
Not five empty sections. Quick Access appears after first pin or second page open. Projects appears after first project creation.

**Rules**:
- Journal: always visible
- Quick Access: visible when ≥1 pinned page OR ≥2 recent pages
- Projects: visible when ≥1 project exists
- Pages: visible when ≥1 unfiled page exists

## Information Hierarchy

The sidebar reads top-to-bottom as layers of decreasing urgency:

| Section | Purpose | Visible Items | Behavior |
|---------|---------|---------------|----------|
| **Search + New** | Find / Create | 1 row | Always visible, sticky |
| **Journal** | Today's entry point | 1 line | Always visible |
| **Quick Access** | Active context | 5-12 (pinned + recent) | Pinned stable, recent auto |
| **Projects** | Deep work contexts | Max 2 expanded | Accordion, max 8 pages each |
| **Pages** | Unfiled inbox | Collapsed count | Click to expand |
| **Mode buttons** | Canvas views | 1 row | Always visible, sticky bottom |

**Total visible at any time**: ~20-25 items. Fits on screen without scrolling.

## Interactions

### Pin a Page
- Hover any page item → 📌 icon appears on right
- Click 📌 → pinned (appears in Quick Access with 📌 prefix)
- Right-click pinned page → "Unpin"
- Drag pinned pages to reorder within Quick Access
- Max 7 pinned pages

### Expand/Collapse Project
- Click project name → toggle expand
- Max 2 expanded simultaneously
- Opening 3rd auto-collapses oldest
- Shift+click → force open without collapse
- `...+N more` link expands inline within sidebar
- Page count shown on hover (not always)

### Create New Page
- `[+ New]` button → creates untitled page, opens in editor
- Future: dropdown with New Page / New Project / New Journal

### Create New Project
- Click `+` next to PROJECTS section header
- Inline text input → Enter to create
- New project auto-expands

### Move Page to Project
- Drag page → drop on project header
- Right-click page → "Move to..." → project list

## Empty States

### New user (0 pages)
```
🔍 Search        [+ New]
📅 Thu, Mar 26

Welcome to MiNotes!
Click [+ New] to create your first page.
```

### No pinned pages
Quick Access section hidden until first pin or second page opened.

### Empty project
```
▾ Work
  No pages yet — create or drag one here
```

### No unfiled pages
Pages section hidden entirely.

## Implementation Phases

### Phase 1: Restructure Layout
- [ ] Reorder sections: Search+New → Journal → Quick Access → Projects → Pages → Modes
- [ ] Rename "Folders" → "Projects" in all UI text
- [ ] Merge Pinned + Recent into Quick Access section
- [ ] Add unified Recent from `getRecentPages()` below pinned
- [ ] Remove "Recent Journals" section
- [ ] Journal as single line with calendar toggle
- [ ] Progressive disclosure (hide empty sections)

### Phase 2: Pin Discoverability + Accordion
- [ ] Pin icon visible on hover for every page item
- [ ] Max 2 projects expanded simultaneously
- [ ] Auto-collapse oldest when 3rd opened
- [ ] Cap expanded project to 8 pages + "...+N more" inline expand
- [ ] Remember expanded projects in localStorage
- [ ] Page count on hover for collapsed projects

### Phase 3: Polish
- [ ] Smooth expand/collapse animations (150ms)
- [ ] Drag to reorder pinned pages
- [ ] "Move to project" in page context menu
- [ ] Shift+click to force-open third project
- [ ] Keyboard shortcuts: Ctrl+1-7 for pinned pages

### Phase 4: All Pages View
- [ ] New canvas mode: 📄 Pages
- [ ] Searchable, sortable table of all pages
- [ ] Filter by project, tag, date range
- [ ] Bulk actions: move, delete, tag

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` | Focus search (existing) |
| `Ctrl+N` | New page (existing) |
| `Ctrl+J` | Open today's journal (existing) |
| `Ctrl+1` through `Ctrl+7` | Open pinned page by position |
| `Ctrl+[` / `Ctrl+]` | Previous / next project |

## CSS Constraints

- Sidebar width: 240-280px (existing)
- Section headers: 10px uppercase, muted, letter-spacing
- Page items: 13px, single line with text-overflow ellipsis
- Project headers: 13px, 600 weight, with expand chevron
- Pinned items: 13px, 📌 prefix
- Pin icon on hover: 12px, right-aligned, opacity transition
- Mode buttons: sticky bottom, compact single row
- Max sidebar content height: should rarely scroll with 2-max accordion
