## Likely causes (reviewer's reading of the code, run of 2026-10-10)

Measured on Xvfb/software rendering, debug build: compare across sizes only.

1. **Opening a 2,000-block page freezes the UI for ~21–24 s; leaving it, ~12–14 s.**
   One uninterrupted main-thread stall (longest gap between two `setTimeout(0)`
   polls ≈ the whole duration), independent of notebook size. `PageView.tsx` renders
   `filteredVisibleBlocks.map(block => <BlockItem …>)` with no windowing, and
   every `BlockItem` creates its own TipTap/ProseMirror editor (`useBlockEditor` →
   `useEditor`): 2,000 editors, ~15–18k DOM nodes. Leaving destroys them all.
   Not IPC: the same 2,000 `get_properties` calls the page makes (one per block,
   `BlockItem.tsx` "Load properties" effect) take ~150 ms in parallel when issued
   alone. Fix direction: virtualise the block list and/or mount editors lazily
   (static render until focus); batch properties into the page-tree call.
2. **Typing in that page lags 100–240 ms per key** (key event → next frame,
   including input queueing). Per-key work is ~10–25 ms inside the handler, but
   keys arrive every 15 ms, so the queue grows (event age at handler rises
   key by key). Likely per-keystroke work proportional to the page (PageView
   state update re-rendering the 2,000-item list / `blockTreeInfo` recomputation).
   Same keys in a 10-block page: ≤10 ms.
3. **Backlinks panel is N+1 over IPC.** `BacklinksPanel.tsx` calls
   `api.getBlock(link.from_block)` once per backlink, sequentially, plus a
   `listPages(500)` for titles: 1,001 backlinks → 1,019 IPC calls, 0.7 s; the
   calls are linear in backlinks (the SUPER-LINEAR flag is against total blocks).
   All items are rendered (no cap). Also, sources on pages beyond the first 500
   `listPages` results show no page title. Fix: return block content + page title
   from `get_backlinks` in one query.
4. **Sidebar renders every page.** 1,004 page rows / 3,040 nodes at L (×18.6 for
   ×8.8 blocks — it tracks page count); refresh still only 56 ms, so not yet a
   problem, but every sidebar refresh (triggered by the DB watcher) re-renders
   the full list.
5. **`get_graph_data` grows fastest of the backend calls** (×13 for ×8.8 blocks,
   26 ms at L): `graph.rs` runs two correlated `COUNT(*)` subqueries per page
   (`block_count`, `link_count`) over unindexed-by-page scans. Small in absolute
   terms; the graph view itself drops to 42 fps at 1,000 nodes while the force
   layout runs.
6. **Opening a small page gets slower with notebook size** (90 → 159 ms): the open
   path issues ~25–31 IPC calls (11 `get_properties` for 10 blocks, `list_pages`
   ×2, `get_folder_tree`, `get_pending_todo_count`, `list_trash`, `list_archived`…,
   i.e. sidebar refreshes ride along with navigation); the whole-notebook ones
   (`list_pages`, `get_folder_tree`, `get_pending_todo_count` — 9/10/24 ms at L)
   are what grow. `get_pending_todo_count` scans every block's text in Rust.
7. **Cold start is flat (~2 s to a stable screen)** once launched on a private
   D-Bus session. On this box, a launch on the host session bus first blocks
   ~25 s in a D-Bus call (strace: connect to `/run/user/0/bus`, then silence until
   the D-Bus default timeout) — an environment/harness issue, but a real user on
   a desktop where that service hangs would see the same 25 s.
8. **Seeding**: `minotes import dir` ≈ 4 ms/block, nearly flat (S 3.6 → L 4.4):
   each block is its own transaction + event row + FTS update.
