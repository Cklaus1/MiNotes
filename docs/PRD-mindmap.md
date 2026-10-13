# PRD: Mind Map View

Status: ~90% built (export labels, persisted collapse and label fixes since done) · Revised 2026-10-10, updated 2026-10-12 · Owner: Chris Klaus

> **What changed in this revision.** The spec now describes the built view
> (`crates/minotes-app/src/components/mindmap/`) instead of the plan. Changes:
> (1) A status column was added, and several "done" claims were corrected after
> checking the code. Collapse state is not persisted. PNG/SVG export likely
> captures only the canvas's first `<svg>`, not the HTML nodes. On an empty page
> the first node can't be added from the map. (2) Three recent label fixes (2-line
> clamp + tooltip, no duplicate title node, TODO keyword stripped) exist on the
> `ux-int` branch and are **not yet merged to main**. (3) Where the build is better
> than the plan, the spec now follows the build: the map is a mode of the shared
> canvas layer, focus mode is in the context menu, the minimap is hidden until
> wanted, and radial layout and empty-block skipping were added. (4) The
> remaining work is re-prioritised, with plugin extension points. (5) There is a
> new "Where AI helps" section. About 600 lines of code sketches were removed;
> the code is the reference.

## 1. Overview

Any page can be viewed as a mind map. The page's block tree *is* the map: the
title is the centre, blocks are nodes, `parent_id` gives the edges. It is the
same data in a different view, so every edit on the map is an ordinary block edit
(undo, sync and backlinks all just work). Built with **ReactFlow (`@xyflow/react`)
+ dagre**. ReactFlow was chosen over Markmap because the map has to be editable.

## 2. Goals / non-goals

Goals
1. Any page, no special page type. One shortcut (Ctrl+M) to switch.
2. Edit on the map: rename, add, delete and reparent nodes, all as block operations.
3. Explore big pages: collapse, focus a subtree, minimap, keyboard navigation.
4. Share: image and outline export.
5. Smooth at 100+ blocks. Usable at 500.

Non-goals
- A freeform canvas (that is the Whiteboard).
- Mind maps not backed by blocks, cross-page maps, real-time co-editing.
- Custom node shapes or free node positions (layout is always computed).

## 3. How it works (as built)

- **Entry**: Ctrl+M (or the Mindmap button) opens the **canvas layer**
  (`CanvasMode.tsx`) in mind map mode. The layer has a switcher (Graph · Mindmap
  · Draw · Kanban · Pages), so users move between views without exiting. Esc
  leaves focus mode first, then closes.
- **Mapping** (`blocksToFlow.ts`): root node = page title (double-click renames
  the page; journals get a display title instead). Each non-empty block is a node.
  **Empty blocks are skipped** and their children attach to the nearest visible
  ancestor, so blank lines don't leave stray nodes. Siblings are ordered by
  `position` within the parent. Labels have markdown stripped, show the first
  line only, and are truncated (§4 row "Label clamp").
- **Node display** (`MindMapNode.tsx`): depth styling, TODO/DOING/DONE icon (DONE
  struck through), `color:: <name>` gives a coloured border (8 named colours),
  `{{whiteboard:…}}` shows as "(Whiteboard)", and a `+N` / `−` collapse badge.
- **Layouts**: horizontal (LR), vertical (TB), and **radial** (dagre TB output
  mapped to rings around the centre, with handles facing the centre).
- **Motion**: positions tween over 300 ms on every re-layout, with a settle timer
  so the layout still lands when `requestAnimationFrame` doesn't fire (hidden tab,
  headless). New nodes fade in. Selecting a node highlights its path to the root
  and dims other edges.
- **Large pages**: on pages with more than 50 blocks, branches at depth 3 and
  below start collapsed.
- **Minimap**: hidden by default. It appears on bottom-right hover or while M is
  held, and supports click-to-jump. (This is better than the planned always-on minimap.)

## 4. Feature status

| Feature | Status | Where |
|---|---|---|
| Open via Ctrl+M / canvas switcher; Esc closes | Done | `App.tsx`, `components/CanvasMode.tsx` |
| Blocks → nodes/edges, dagre layout, empty-block skipping, cycle guards | Done | `mindmap/blocksToFlow.ts` |
| Editable centre node (rename page / journal display title) | Done | `mindmap/MindMapNode.tsx` |
| Inline edit (double-click; Enter/blur saves, Esc cancels) | Done | `MindMapNode.tsx` |
| Tab = child, Enter = sibling, new node opens in edit mode | Done (Enter appends as *last* sibling, not directly below) | `mindmap/MindMapView.tsx` |
| Add the first node on an empty page | **Not working**: Tab and the context menu need a block node, and the root has none | `MindMapView.tsx` |
| Delete (key; confirms if children) | Done. Context-menu delete does **not** confirm | `MindMapView.tsx` |
| Context menu: add child/sibling, focus subtree, copy branch, delete | Done | `MindMapView.tsx` |
| Drag to reparent (nearest node within 150 px; no self/descendant drops) | Partial: no drop-target highlight; can't reorder among siblings | `MindMapView.tsx` (`onNodeDragStop`) |
| Collapse/expand via badge | Partial: local to the session, not written to block `collapsed` | `MindMapView.tsx` (`collapsedIds`) |
| Auto-collapse deep branches on large pages | Done | `MindMapView.tsx` |
| LR / TB / radial layouts | Done | `blocksToFlow.ts` |
| Layout tween, entrance animation, path highlight | Done | `MindMapView.tsx` |
| Exit animation for deleted nodes; edge draw-in on expand | Not started | n/a |
| Focus subtree + breadcrumb | Done (via context menu, not double-click, which edits) | `MindMapView.tsx` |
| Arrow-key navigation | Done | `MindMapView.tsx` |
| Minimap (hover / hold M, click-to-jump) | Done | `MindMapView.tsx` |
| Export Markdown outline; copy branch | Done | `MindMapView.tsx` (`blocksToOutline`) |
| Export PNG / SVG | Partial, **likely broken**: serialises the first `.react-flow svg` (background/edges). Nodes are HTML, so labels are missing | `MindMapView.tsx` (`handleExportPng/Svg`) |
| Label clamp to 2 lines + tooltip; no duplicate `# Title` node; TODO keyword stripped | Done on branch `ux-int`, **not merged** | `ux-int:…/mindmap/blocksToFlow.ts` |
| Remember the view per page (`view::` property) | Not started | n/a |
| Ctrl+click `[[link]]` in a node opens the page | Not started | n/a |
| Search highlights matching nodes | Not started | n/a |
| Journey tests (open, nodes render, layout switch, close, mode switch) | Done | `tests/user-journey-test.sh` journeys 33, 35 |
| Unit tests for `blocksToFlow` / `extractLabel` | Not started (no frontend unit-test runner) | n/a |

## 5. Remaining work, re-prioritised

**P0: fix what users will hit (each is small)**
1. **Merge the `ux-int` label fixes** (clamp + tooltip, no duplicate title node,
   TODO keyword stripped).
2. **Empty page**: Tab or Enter on the centre node creates the first root block.
   Show a hint ("Press Tab to add your first idea").
3. **Fix PNG/SVG export**: render nodes and edges together, e.g. with
   `html-to-image` on the viewport after `fitView`, or nodes drawn into SVG. Add a
   journey that checks the exported image is non-trivial (size or label text in
   the SVG). If not fixed this cycle, hide PNG/SVG and keep Markdown.
4. Context-menu delete confirms like the key does when the node has children.

**P1: make it feel native**
5. **Persist collapse** to the block's `collapsed` field, so map and outline agree
   and collapse survives reopening. Auto-collapse stays view-only.
6. **Remember the view per page**: store the last mode and layout (e.g. `view::
   mindmap`, `mindmap-layout:: radial`) and reopen in it. Write the property only
   on an explicit "Open this page as a mind map" toggle, not on every visit, so
   sync isn't churned by browsing.
7. **Drag feedback**: highlight the drop target. Dropping *between* siblings
   reorders them (using `reorder_block` semantics; see CLAUDE.md gotchas for
   root-level moves).
8. Enter inserts the sibling **directly after** the selected node.
9. Ctrl+click on a `[[link]]` in a node opens that page.

**P2: nice to have**
10. Search highlight (dim non-matching nodes while the find bar is open).
11. Unit tests for `blocksToFlow` and the label helpers (needs a Vitest setup,
    shared with kanban).

**Cut**
- Exit animation for deleted nodes and edge draw-in on expand. The 300 ms tween
  already gives continuity, these add timers that interact badly with headless
  tests and rapid edits, and nobody has asked for them.
- Hover scale effects beyond the current CSS.
- Presentation mode, standalone (non-block) maps, multi-page maps, node images,
  edge labels: out of scope for a block-backed view.

**Plugin extension points** (`PRD-plugin-architecture.md`), not core work
- **Exporters**: OPML, FreeMind `.mm`, XMind, image formats with themes, via the
  importer/exporter extension point (Phase 2). The built-in Markdown outline
  export stays.
- **Mind map templates** (SWOT, project plan, brainstorm) are ordinary page
  templates or a plugin command that inserts a block tree. No mind-map-specific
  feature is needed.
- **Alternative tree views** (org chart with cards, timeline, fishbone) via the
  *page view* extension point (Phase 3). The built-in mind map stays built in.
- An inline `{{mindmap}}` embed of a subtree could be a code-fence renderer plugin
  if users ask for it. Not planned in core.

## 6. Where AI helps

These are **block-tree actions**, not mind-map-only features. They run on the
outline too, and the map is one surface for them. All run through **the AI
platform (`PRD-ai-assistant.md`)**. They are off by default and use only the
provider the user configured (cloud model with their key, or a local model).
Nothing leaves the device unless the user chose that provider, and only the
selected page or branch text is sent. Every result is shown as a **ghost preview**
(dashed nodes) and applied as one undoable step.

| Idea | Why an LLM beats code | User value | Priority |
|---|---|---|---|
| **Map from a long page or pasted text**: turn prose (meeting notes, an article, a pasted document) into a hierarchical outline, then view it as a map | Finding the topics and hierarchy in prose is a language task. Heading-splitting only works on documents that already have structure. | The main reason people open a mind map: "help me see the structure of this". | P1 |
| **Suggest groupings**: select 10–40 sibling nodes (a brainstorm dump) and get proposed clusters with headings | Semantic clustering with good names. Keyword or embedding clustering gives poor labels. | Turns a flat brainstorm into a structure in one step. The preview shows moves before applying (reparents only, no text changes). | P2 |
| **Summarise a branch** into one line, inserted as a note on the branch or offered as the collapsed label | Abstractive summary. | Large maps stay readable when collapsed. | P3 |

Rejected: AI layout or styling (dagre is deterministic, fast and stable, and a
model adds nothing). "Expand this node" brainstorming children: low-quality
filler is the common failure, and it's a generic chat ability the AI platform can
offer everywhere. It doesn't need a mind-map-specific feature. Automatic
restructuring without a preview is also rejected.

## 7. Integration notes

- **Undo / sync / encryption**: no special handling. All edits are block API
  calls. An encrypted notebook's map is available only while unlocked, like every
  other view.
- **Kanban** shares label helpers with the map. Keep them in `blocksToFlow.ts`
  (not in a `.tsx`; see CLAUDE.md on Fast Refresh).
- No backend changes are needed for anything in §5 except persisting collapse,
  which uses the existing block `collapsed` field and API.

## 8. Success metrics

- Mind map opened on > 10% of active days. More than 20% of map sessions include an edit.
- Pages with a remembered mind-map view (after P1 #6).
- Export used, with zero "blank image" reports after the P0 fix.
- 500-block page: open in < 500 ms, re-layout after an edit in < 100 ms (desktop-check scale tool).

## 9. Open questions

1. Should collapse be shared between map and outline (P1 #5), or should the map
   keep its own collapse so exploring the map doesn't fold the outline?
2. Remembered view: a synced page property (`view::`), or local per-device UI
   state that doesn't touch the page?
3. Is radial layout worth keeping as it grows? The ring layout overlaps on wide
   trees, and fixing that needs a real radial tree algorithm.
4. For "map from pasted text": create a new page, or insert under the selected node?
