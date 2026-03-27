# MiNotes Sidebar Navigation PRD

## Problem Statement

As users accumulate pages, the sidebar becomes overwhelmed. The current layout shows all folders expanded, all pages visible, and a separate "Recent Journals" section — creating a long, unscannable list. At 30+ pages, users stop using the sidebar and rely entirely on Ctrl+K search, which means the sidebar is failing its primary job: **quick spatial navigation**.

## Competitive Analysis

### How the best apps handle growing page counts

| | Notion | Obsidian | Logseq | Bear | Linear | Roam |
|--|--------|----------|--------|------|--------|------|
| Sidebar philosophy | File browser | File browser | Launcher | Launcher | Launcher | Launcher |
| Search | Sidebar top | Sidebar tab | Top bar | Sidebar top | Overlay | Top bar |
| Favorites | Section | Bookmarks tab | Section | Pin in list | Section | Shortcuts |
| Recent | Home page only | Plugin | Section | Sort by date | My Activity | None |
| Folders | Infinite nesting | File tree | None | None (tags) | Teams | None |
| Shows all items? | Yes (nested) | Yes (file tree) | No | No | No | No |
| Scale strategy | Collapse tree | Collapse tree | Favs+Recent only | Tags only | Views only | Links only |

### Key insight

The apps that scale best (Bear, Linear, Logseq, Roam) **never put all pages in the sidebar**. The sidebar is a curated launcher — favorites, recent, structure. Discovery happens in a separate full-screen view or via search.

**MiNotes approach**: Camp B (launcher) — sidebar shows curated entry points, not every page. "All Pages" view handles discovery.

### What MiNotes does differently

| Feature | MiNotes | Why it's better |
|---------|---------|----------------|
| Quick Access | Merged Pinned + Recent in one section | Cleaner than Logseq's separate Favorites + Recent |
| Projects | Max 2 open accordion | Novel constraint — prevents scroll bloat that Notion/Obsidian suffer |
| Journal | 1 line with calendar toggle | More compact than Logseq's full section |
| Progressive disclosure | Hide empty sections | Matches Notion's best onboarding pattern |
| Mode buttons | Graph/Mind/Draw/Kanban | Unique — no competitor has this density of views |

## Design: New Sidebar Layout

```
┌───────────────────────────┐
│ 🔍 Search          [+ New]│  ← sticky top, two primary actions
│                           │
│ 📅 Thu, Mar 26        [📅]│  ← 1 line, calendar toggle
│                           │
│ QUICK ACCESS              │  ← merged Pinned + Recent
│ 📌 Project Alpha          │  ← pinned (stable, user-curated)
│ 📌 Meeting Notes          │  ← pinned (hover → 📌 visible)
│    Sprint Board           │  ← recent (auto-tracked)
│    Research Notes         │  ← recent (auto-tracked)
│                           │
│ PROJECTS              [+] │  ← [+] creates new project
│ ▾ Work                [+] │  ← [+] on hover: new page inside
│     API Design            │
│     Bug Tracker           │
│     ...+8 more            │  ← inline expand on click
│ ▸ Personal                │  ← collapsed
│ ▸ Archive                 │  ← collapsed
│                           │
│ PAGES                 [+] │  ← [+] creates unfiled page
│ ▸ 7 unfiled pages         │
│                           │
│ ─────────────────────── │
│📊Graph 🧠Mind 🎨Draw 🗂Kanban│  ← sticky bottom
└───────────────────────────┘
```

### Progressive Disclosure (new user)

New user with 0 pages, 0 projects:
```
┌───────────────────────────┐
│ 🔍 Search          [+ New]│
│ 📅 Thu, Mar 26        [📅]│
│                           │
│ Welcome to MiNotes!       │
│ Click [+ New] to create   │
│ your first page.          │
│                           │
│ ─────────────────────── │
│📊Graph 🧠Mind 🎨Draw 🗂Kanban│
└───────────────────────────┘
```

Sections appear as they gain content:
- **Quick Access**: after first pin or 2+ pages opened
- **Projects**: after first project created
- **Pages**: after first unfiled page exists

## Key Design Decisions

### 1. Search + New Always Visible (Sticky Top)

`🔍 Search` and `[+ New]` side by side. Always visible, never scroll away.

The two most frequent sidebar actions — find something, create something. Every major app puts these at the top.

`[+ New]` creates a new unfiled page (most common action). Future: dropdown with "New Page" / "New Project" / "New Journal Entry".

### 2. Journal: One Line, Not a Section

`📅 Thu, Mar 26` — single line. Click text → open today's journal. Click 📅 → expand calendar dropdown.

Soft-create: clicking a date with no journal shows "No entry yet / + Start writing". No empty page pollution.

### 3. Quick Access (Merged Pinned + Recent)

One section combining:
- **Pinned** (📌, top, stable) — user-curated, reorderable, max 7
- **Recent** (below pinned, dynamic) — last 5 unique pages, auto-tracked

If a recent page is also pinned, it shows once (in pinned position). Removes the artificial "are journals different from pages?" split.

**Pin discoverability**: Hover any page item → 📌 icon appears on right. One-click pin. Not buried in right-click menu.

### 4. Projects (Renamed from Folders)

"Folders" → "Projects". Max 2 expanded simultaneously. Opening a 3rd closes the oldest (Shift+click to override).

**[+] buttons** (Notion hover-to-add pattern):
- `PROJECTS [+]` — creates new project (inline name input)
- `▾ Work [+]` — creates new page inside that project (on hover)
- `PAGES [+]` — creates unfiled page

**Capped pages**: Show first 8 per project. `...+N more` expands inline within the sidebar (not a navigation event).

**Page count**: Shown on hover only for collapsed projects. Avoids "pile of work" anxiety.

### 5. Unfiled Pages (Collapsed by Default)

Root pages not in any project. Collapsed showing count: `▸ 7 unfiled pages`. Click to expand. These are the "inbox" — things not yet organized.

### 6. All Pages View (Pressure Valve)

New canvas mode: `📄 Pages`. Searchable, sortable table of all pages. Filter by project, tag, date. This is what lets the sidebar stay compact — discovery and bulk management happen here, not in the sidebar.

**This is essential, not optional** — every app that scales well has a dedicated "all items" view separate from the sidebar (Logseq's All Pages, Bear's Notes list, Linear's issue views, Apple Notes' middle pane).

## Interactions

### Pin a Page
- Hover any page item → 📌 appears on right (one-click)
- Pinned pages move to Quick Access with 📌 prefix
- Drag pinned pages to reorder
- Right-click pinned → "Unpin"
- Max 7 pins

### Create New Page
- `[+ New]` at top → creates untitled page, opens in editor
- `PAGES [+]` → same, creates unfiled
- `▾ Work [+]` (hover) → creates inside that project

### Create New Project
- `PROJECTS [+]` → inline text input, Enter to create
- New project auto-expands

### Expand/Collapse Project
- Click project name → toggle expand
- Max 2 expanded simultaneously
- Opening 3rd → auto-collapse oldest
- Shift+click → force open without collapse
- `...+N more` → expand all pages inline (scrollable within sidebar)

### Move Page to Project
- Drag page → drop on project header
- Right-click page → "Move to..." → project list

## Information Hierarchy

Top-to-bottom = decreasing urgency:

| Section | Purpose | Visible Items | Behavior |
|---------|---------|---------------|----------|
| **Search + New** | Find / Create | 1 row | Sticky top |
| **Journal** | Today's entry | 1 line | Always visible |
| **Quick Access** | Active context | 5-12 | Pinned stable, recent auto |
| **Projects** | Deep work | Max 2 expanded, 8 pages each | Accordion |
| **Pages** | Inbox | Collapsed count | Click to expand |
| **Modes** | Canvas views | 1 row | Sticky bottom |

Total visible: ~20-25 items. Fits on screen without scrolling.

## Implementation Phases

### Phase 1: Restructure Layout
- [ ] Reorder sections: Search+New → Journal → Quick Access → Projects → Pages → Modes
- [ ] Rename "Folders" → "Projects" in all UI text
- [ ] Merge Pinned + Recent into Quick Access section
- [ ] Add unified Recent from `getRecentPages()` below pinned
- [ ] Remove "Recent Journals" section
- [ ] Journal as single line with calendar toggle
- [ ] Progressive disclosure (hide empty sections)
- [ ] `[+ New]` button next to search
- [ ] `PROJECTS [+]` and `PAGES [+]` section buttons

### Phase 2: All Pages View + Pin Discoverability
- [ ] New canvas mode: 📄 Pages (searchable, sortable table)
- [ ] Filter by project, tag, date range
- [ ] Pin icon visible on hover for every page item (one-click pin)
- [ ] `▾ Project [+]` hover button to add page inside project

### Phase 3: Accordion + Caps
- [ ] Max 2 projects expanded simultaneously
- [ ] Auto-collapse oldest when 3rd opened
- [ ] Cap expanded project to 8 pages + "...+N more" inline expand
- [ ] Remember expanded projects in localStorage
- [ ] Page count on hover for collapsed projects

### Phase 4: Polish
- [ ] Smooth expand/collapse animations (150ms)
- [ ] Drag to reorder pinned pages
- [ ] "Move to project" in page context menu
- [ ] Shift+click to force-open third project
- [ ] Keyboard shortcuts: Ctrl+1-7 for pinned pages
- [ ] Bulk actions in All Pages view: move, delete, tag

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
- `[+]` buttons: 12px, muted, visible on section/project hover
- Mode buttons: sticky bottom, compact single row
- Max sidebar content height: should rarely scroll with 2-max accordion
