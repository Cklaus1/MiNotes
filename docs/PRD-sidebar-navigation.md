# MiNotes Sidebar Navigation PRD

Status: 80% built · Revised 2026-10-10 · Owner: Chris Klaus

> **What changed in this revision.** Added a status column checked against the
> code (`crates/minotes-app/src/components/Sidebar.tsx`, plus the `ux-int` and
> `feat-tc` worktrees, merging soon). The layout now reflects what shipped: a
> **Pinned** section (Recent was never merged in), an unfiled **Pages (n)** list
> that still exists, TODO / Review badges and Archived/Trash entries the original
> design didn't have. Added the **notebook switcher** in the header
> (`PRD-notebooks.md` Phase 1). Re-prioritised the rest: keep Recent and All Pages
> filters, demote "every page must be in a project", cut `Ctrl+[`/`Ctrl+]`.
> Removed the competitor table and CSS constraints (decisions stand; detail was
> stale). Added "Where AI helps".

## Problem

At 30+ pages a sidebar that lists everything becomes unscannable, and users fall
back to `Ctrl+K`. The sidebar's job is **quick spatial navigation to what you're
working on** — a curated launcher, not a file browser. Discovery and bulk
management live in the full-screen **All Pages** view.

Principle (unchanged): apps that scale (Bear, Linear, Logseq) never put every
page in the sidebar. The sidebar should stay bounded at ~20–25 visible rows.

## Layout (as built, with planned additions marked ◇)

```
┌───────────────────────────────┐
│ MiNotes · Work notebook ▾  ⚙  │  ◇ notebook switcher (PRD-notebooks Ph.1)
│ [ Search (Ctrl+K) ]   [+ New] │  sticky
│ Sat, Oct 10              ▾    │  one line; ▾ opens calendar
├───────────────────────────────┤
│ 📌 PINNED                     │  drag to reorder; soft cap 7, "+N more"
│   Project Alpha               │
│ ◇ RECENT (last 5, not pinned) │  ◇ planned; recentFiles.ts exists
│ ☐ 4 TODOs     🃏 Review 6 due │  badges; Review only when cards exist
│ PROJECTS               [▾]    │  collapse/expand all
│   + New Project               │
│ ▾ Work               [⋮]      │  max 2 expanded (Shift+click overrides)
│     API Design …  ...+9 more  │  8 pages, then inline expand
│ ▸ Personal                    │
│ ⋯ 4 more                      │  projects 6+ in a dropdown
│ PAGES (12)                    │  unfiled pages, newest first, scroll cues
├───────────────────────────────┤
│ Archived · Trash              │  sticky bottom
│ Graph Mind Draw Kanban Pages  │  canvas modes
└───────────────────────────────┘
```

## Features and status

Paths under `crates/minotes-app/src/`. "ux-int" / "feat-tc" = worktree, merging soon.

| Feature | Status | Where |
|---|---|---|
| Sticky Search + New; settings gear | Done | `components/Sidebar.tsx` |
| Journal as one line + calendar toggle; "Recent Journals" section removed | Done | `Sidebar.tsx`, `CalendarWidget.tsx` |
| Pinned section, drag to reorder, soft cap 7 with "+N more" | Done | `Sidebar.tsx` (`DraggablePage`) |
| `Ctrl+1`–`Ctrl+7` open pinned page | Done | `App.tsx` |
| Pin / Unpin, Rename, Move to… project in page ⋮ menu | Done | `Sidebar.tsx` |
| One-click 📌 on hover | Partial — pin is one item inside the ⋮ hover menu | `Sidebar.tsx` |
| "Folders" → "Projects"; + New Project (inline input) | Done — placed at top of the list, not bottom | `Sidebar.tsx` |
| Accordion: max 2 expanded, Shift+click override, remembered in localStorage | Done | `Sidebar.tsx` (`MAX_EXPANDED`) |
| 8 pages per project + "...+N more"; 5 projects + "⋯ N more" | Done | `Sidebar.tsx` (`PAGE_CAP`) |
| Collapse/expand all projects; expand/collapse animation; page count on hover when collapsed | Done | `Sidebar.tsx`, `styles.css` |
| Drag page onto project | Done | `Sidebar.tsx` |
| All Pages canvas view: search, sort by title/project/updated | Done | `components/AllPagesView.tsx` |
| TODO count badge | Done (not in original spec) | `Sidebar.tsx` |
| "Review N due" flashcard badge | Done (feat-tc) | `Sidebar.tsx` |
| Archived / Trash entries, Empty trash | Done (not in original spec) | `Sidebar.tsx` |
| 24px targets, "PAGES (n)" count, scroll edge cues, contrast fix | Done (ux-int) | `Sidebar.tsx`, `styles.css` |
| Recent pages in the sidebar | Not started — `lib/recentFiles.ts` feeds only the search palette | `SearchPanel.tsx` |
| Remove unfiled "Pages" section | Not started — reconsidered, see below | `Sidebar.tsx` |
| All Pages: filter by tag / date; bulk move/delete/tag | Not started | `AllPagesView.tsx` |
| Progressive disclosure / welcome state for empty notebook | Not started (Projects header always shows) | `Sidebar.tsx` |
| Notebook switcher in header | Done (`PRD-notebooks.md` Ph.1) | `NotebookSwitcher.tsx` in the sidebar header; the Graph view shows a read-only `NotebookLabel.tsx` |
| `Ctrl+[` / `Ctrl+]` previous/next project | Not started — cut | — |

### Obsolete or changed decisions

- **"Quick Access = Pinned + Recent merged."** Shipped as Pinned only. Keep the
  sections separate (see below): mixing stable and churning rows in one list
  makes pinned items harder to find by position, which `Ctrl+1–7` relies on.
- **"No unfiled pages — every page lives in a project."** Not built, and forcing
  it is the wrong default: quick captures, imports and journal spin-offs are
  naturally unfiled. The `PAGES (n)` list now shows the count and scrolls with
  cues. Instead of removing it, cap it (see next steps).
- **`[+ New]` creates in the active/last-used project** — built as a plain new
  page; keep that. Creating inside a project is the project's ⋮ / hover action.
- **Competitor table and CSS constraints** — removed; the code and `styles.css`
  are the reference.

## Remaining work, prioritised

**Next**

1. **Notebook switcher in the header** — specified in `PRD-notebooks.md` Phase 1;
   the sidebar only hosts it. Replaces the Graph-view dropdown.
2. **Recent section** (5 most recently opened, excluding pinned, journals
   included), below Pinned, collapsible. `recentFiles.ts` already tracks it.
   Small; the biggest daily-navigation gain left.
3. **Cap the unfiled Pages list** at 8 + "Show all in All Pages →", so the sidebar
   stays bounded at any page count. Small.
4. **All Pages filters and bulk actions**: filter by project (incl. "No project"),
   tag, updated-in-range; multi-select → Move to project / Archive / Trash / Add
   tag. This is the pressure valve that makes (3) acceptable. Medium.

**Later**

5. Hover 📌 as a direct button (one click, not menu → Pin). Small.
6. Empty-notebook welcome state (hide Projects/Pages headers until they have content). Small.

**Cut**

- `Ctrl+[` / `Ctrl+]` project cycling — low discoverability, conflicts with
  indent/outdent habits in editors, and `Ctrl+K` already jumps anywhere.
- Merging Recent into Pinned (see above).

**Plugin extension point**

- New sidebar sections (calendar, highlights inbox, reading list) come from the
  **Sidebar panel** extension point (`PRD-plugin-architecture.md` §4, Phase 2),
  rendered below Projects, collapsible, never above Pinned. Core sections stay built in.
- Extra page ⋮ menu items use the **page context-menu item** extension point.

## Where AI helps

All ideas run through the AI platform (`PRD-ai-assistant.md`): off by default,
user-chosen provider (cloud key or local model), suggestions only — nothing in
the sidebar changes without a click, and every applied change is undoable.

| Idea | Verdict | Why |
|---|---|---|
| **"Jump to" natural-language search** — in the search palette, a query like "the pricing meeting notes from last week" falls back to an AI-ranked result list when keyword search is weak | **Keep — P1** | Fuzzy recall ("what was that page about…") is exactly where keywords fail and an LLM (over titles, snippets, dates, ideally embeddings) wins. Lives in search, not the sidebar list. Privacy: titles/snippets sent only on explicit query; local model recommended |
| **Suggest a project for unfiled pages** — in All Pages "No project" filter, a "Suggest projects" action proposes a project per page; user accepts per row or in bulk | **Keep — P2** | Classification by meaning across existing project names is a real LLM strength and turns a chore into review. Deterministic fallback (link/tag overlap) is weaker. Batch, previewed, one undo |
| **Auto-group a long unfiled list** into proposed new projects | **Keep as part of the above — P3** | Useful after an import (`PRD-import.md`); same review UI, proposes new project names. Never runs on its own |
| **Daily "resume where you left off"** | **Reject** | Recent pages + today's journal + open TODOs already answer this deterministically; an AI summary adds latency and a privacy surface for little gain |
| AI reordering pinned/recent/projects by predicted relevance | **Reject** | The sidebar's value is spatial memory; anything that moves on its own breaks it |

## Keyboard shortcuts

| Key | Action | Status |
|---|---|---|
| `Ctrl+K` | Search | Done |
| `Ctrl+N` | New page | Done |
| `Ctrl+J` | Today's journal | Done |
| `Ctrl+1`–`7` | Open pinned page by position | Done |
| `Ctrl+[` / `Ctrl+]` | Previous / next project | Cut |

## Open questions for the owner

1. Keep the unfiled **Pages** section (capped at 8) — or move unfiled pages
   entirely into All Pages and show only a "12 unfiled →" link?
2. Should Recent include journals, or are journals reachable enough via the
   journal line and calendar?
3. Pinned cap: hard 7 (matches `Ctrl+1–7`) or keep the soft cap with "+N more"?
4. With notebooks in the header, should Pinned and expanded-project state be
   per notebook? (Recommendation: yes.)
5. Is AI "jump to" acceptable with a cloud provider sending page titles and
   snippets, or should it require a local model / local embeddings?
