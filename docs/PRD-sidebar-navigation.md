# MiNotes Sidebar Navigation PRD

## Problem Statement

As users accumulate pages, the sidebar becomes overwhelmed. The current layout shows all folders expanded, all pages visible, and a separate "Recent Journals" section — creating a long, unscannable list. At 30+ pages, users stop using the sidebar and rely entirely on Ctrl+K search, which means the sidebar is failing its primary job: **quick spatial navigation**.

### Current Sidebar (what's broken)

```
┌─────────────────────┐
│ 🔍 Search...        │
│ 📅 Journal  + Project│
│                     │
│ ⭐ Favorites        │  ← good, but buried
│                     │
│ 📁 Work             │  ← always expanded
│   Page 1            │
│   Page 2            │
│   ...12 more...     │
│ 📁 Personal         │  ← also expanded
│   ...8 pages...     │
│ Pages (15)          │  ← unfiled pages, long list
│   ...               │
│ Recent Journals     │  ← separate section, redundant
│   📅 Mar 26         │
│   📅 Mar 25         │
│   📅 Mar 24         │
│ ─────────────────── │
│ 📊Graph 🧠Mind ...  │
└─────────────────────┘
```

**Problems:**
1. Everything expanded = no information hierarchy
2. Folders compete with Pages compete with Journals — too many sections
3. No "pinned" quick-access for daily drivers
4. Recent Journals is separate from Recent Pages — artificial split
5. As pages grow, sidebar scrolling becomes the bottleneck

## Design: New Sidebar Layout

```
┌─────────────────────┐
│ 🔍 Search...        │  ← always visible, Ctrl+K
│                     │
│ 📅 TODAY             │  ← one-tap to today's journal
│   Thursday, Mar 26  │     📅 calendar toggle
│                     │
│ ★ PINNED            │  ← 3-7 starred pages, drag to reorder
│   Project Alpha     │
│   Meeting Notes     │
│   Sprint Board      │
│                     │
│ 🕐 RECENT            │  ← last 5 opened (pages + journals mixed)
│   Research Notes    │
│   Journal/Mar 25    │
│   Bug Tracker       │
│                     │
│ 📁 PROJECTS          │  ← accordion: one open at a time
│ ▸ Work (12)         │  ← collapsed, shows count
│ ▾ Personal (4)      │  ← expanded (last opened)
│     Ideas           │
│     Reading List    │
│     Goals           │
│     Recipes         │
│ ▸ Archive (23)      │  ← collapsed
│                     │
│ 📄 Pages (7)        │  ← unfiled pages, collapsible
│                     │
│ ─────────────────── │
│ 📊Graph 🧠Mind 🎨Draw 🗂Kanban │
└─────────────────────┘
```

## Key Design Decisions

### 1. Journal Gets a Dedicated Top Slot

**What**: Single "Today" entry always visible at the top. Calendar dropdown behind 📅 icon for browsing other dates.

**Why**: Journals are a daily habit. One tap to today. Calendar handles date browsing. No need for a "Recent Journals" list — journals appear in the unified Recent section.

**Soft-create**: Clicking a date with no journal shows "No entry yet / + Start writing" (already built). Only materializes the page when user starts writing.

### 2. Pinned Section (Favorites Upgraded)

**What**: Right-click any page → "Pin to sidebar". Max 7 pins. Drag to reorder. Always visible below Journal.

**Why**: Every user has 3-5 pages they open daily. These shouldn't require scrolling or searching. The existing "Favorites" feature already supports this — just needs better placement and a rename.

**Implementation**: Reuse existing `addFavorite`/`removeFavorite` API. Rename "Favorites" to "Pinned". Move to top of sidebar.

### 3. Unified Recent Section

**What**: Last 5 opened pages (any type — regular pages and journals mixed). Already tracked via `recentFiles.ts` localStorage.

**Why**: Replaces "Recent Journals" with a unified list. Users don't think in categories ("is this a journal or a page?") — they think "what was I working on?"

**Implementation**: Already have `getRecentPages()` returning last 10 entries. Show top 5 in sidebar. Remove the separate "Recent Journals" section.

### 4. Accordion Projects (One Open at a Time)

**What**: Click a project/folder → it expands, all others collapse. Show page count badge: `▸ Work (12)`. Remember last-opened project in localStorage.

**Why**: At 3+ projects with 10+ pages each, having all expanded is unusable. Accordion enforces focus — you're working in one project context at a time.

**Rename**: "Folders" → "Projects". More meaningful, matches how users think about grouped work.

**Implementation**:
- Track `expandedProjectId` in state (single string, not a set)
- Click project header → `setExpandedProjectId(id)`
- Page count from `folder.pages.length`
- Persist in localStorage

### 5. Capped Page Lists

**What**: Within an expanded project, show first 8 pages. If more, show "Show all (47)" link that opens a searchable list in the main content area.

**Why**: Prevents any single project from dominating the sidebar. Users with 50-page projects get the same sidebar footprint as users with 5-page projects.

**Implementation**: `pages.slice(0, 8)` in the folder renderer. "Show all" link opens an "All Pages" filtered view.

### 6. "All Pages" Canvas View (Future)

**What**: New canvas mode `📄 Pages` showing a searchable, sortable table of all pages. Filter by project, tag, date range. Sort by title, modified date, word count.

**Why**: The sidebar is for quick access to known pages. Discovery and bulk management belong in a dedicated view, not a scrollable list.

**Scope**: Future phase. The sidebar redesign works without this.

## Information Hierarchy

The sidebar should feel like layers of urgency:

| Section | Purpose | Items | Persistence |
|---------|---------|-------|-------------|
| **Journal** | What's happening today | 1 (today) | Always |
| **Pinned** | My daily drivers | 3-7 | User-curated |
| **Recent** | What I was just doing | 5 | Auto-tracked |
| **Projects** | Deep work contexts | 1 expanded | Accordion |
| **Pages** | Unfiled pages | Max 8 shown | Collapsible |

Total visible items at any time: ~20-25. Fits on screen without scrolling for most users.

## Interactions

### Pin a Page
- Right-click page → "Pin to sidebar" (or ⭐ icon)
- Pinned pages show at top with ★ prefix
- Right-click pinned page → "Unpin"
- Drag pinned pages to reorder

### Expand/Collapse Project
- Click project name → expand (others collapse)
- Click again → collapse (no project expanded)
- Page count badge updates in real-time
- Transition: smooth 150ms height animation

### Create New Project
- `+ Project` button in sidebar header
- Inline text input → Enter to create
- New project auto-expands

### Move Page to Project
- Drag page from anywhere → drop on project header
- Right-click page → "Move to..." → project list

## Migration

- **Favorites → Pinned**: Rename in UI, same underlying API
- **Recent Journals → Recent**: Remove section, journals appear in unified recent
- **Folders → Projects**: Rename in UI, same data model
- **Expanded state**: Default all projects collapsed, remember user's last choice

## Implementation Phases

### Phase 1: Restructure (MVP)
- [ ] Reorder sections: Journal → Pinned → Recent → Projects → Pages
- [ ] Rename "Folders" → "Projects", "Favorites" → "Pinned"
- [ ] Add unified Recent section from `getRecentPages()`
- [ ] Remove "Recent Journals" section
- [ ] Move calendar toggle next to Journal entry

### Phase 2: Accordion + Caps
- [ ] Single-project-expanded accordion behavior
- [ ] Page count badges on collapsed projects
- [ ] Cap expanded project to 8 pages + "Show all" link
- [ ] Remember expanded project in localStorage

### Phase 3: Polish
- [ ] Smooth expand/collapse animations
- [ ] Drag to reorder pinned pages
- [ ] "Move to project" context menu option
- [ ] Empty project state: "No pages yet — create or drag one here"

### Phase 4: All Pages View
- [ ] New canvas mode: 📄 Pages
- [ ] Searchable, sortable table of all pages
- [ ] Filter by project, tag, date range
- [ ] Bulk actions: move, delete, tag

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` | Focus search (existing) |
| `Ctrl+J` | Open today's journal (existing) |
| `Ctrl+1-7` | Open pinned page by position |
| `Ctrl+[` / `Ctrl+]` | Prev/next project |

## CSS Sizing Constraints

- Sidebar width: 240-280px (existing)
- Section title: 11px uppercase, muted
- Page items: 13px, single line with ellipsis
- Project header: 13px, bold, with count badge
- Pinned items: 13px, ★ prefix
- Max sidebar scroll: should rarely need to scroll with accordion
