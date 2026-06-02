# MiNotes Red-Team Bug Hunt

**Date:** 2026-06-01
**Method:** 7 parallel red-team analysis agents across the product's subsystems (sync/CRDT, AI features, editor, export/import/trash, frontend journeys, CLI/plugins, core data layer). All `file:line` claims verified against source at the time of writing. No code was modified during the hunt.

**Scope / ICP mapping.** MiNotes is a local-first notes app, not a SaaS funnel product, so the requested ICPs were mapped onto this domain:
- *Non-technical founder → casual note-taker* (onboarding, journals, basic editing)
- *Technical builder → CLI / plugin power user*
- *Growth/PM → the "AI" organization features* (auto-tagging, link suggestions, TODO extraction — the only analytics-like surface)
- *Startup team → multi-device sync / CRDT* (the collaboration story)
- *Power user → export/import/automation/edge cases*

**Headline.** The multi-device sync story — the core premise of a local-first collaboration tool — is **not safe**. It silently loses data in normal use. The production git-sync path has no real merge and uses title/filename as identity; the snapshot "CRDT" path is not a CRDT (no tombstones, no clocks, unconditional last-writer-wins).

**Totals:** 34 numbered bugs (5 Critical, 21 High, 8 Medium) + 13 abbreviated lower-severity findings.

---

## CRITICAL — Silent, permanent data loss

### Bug #1: Git sync regenerates every block UUID on import, destroying block identity
- **ICP:** Multi-device user · **Journey:** Device imports remote changes
- **Repro:** Device A exports DB→markdown (`export.rs:107` writes `- content` bullets with **no block ID**). Remote has changes → `sync_page` deletes every existing block (`sync.rs:196-200`) and recreates them with brand-new UUIDs.
- **Expected:** Block identity stable across a round-trip.
- **Actual:** Every block gets a new UUID on any import. Flashcards (`cards.block_id` ON DELETE CASCADE) silently deleted; block-ref links `((id))`, highlights, version history all break.
- **Severity:** Critical · **Area:** Sync/Data
- **Root cause:** Lossy markdown format (no ID) + delete-all/recreate in `sync.rs:196-200`.
- **Fix:** Embed block IDs in exported markdown (Logseq `id::` or HTML comment); match-and-update by ID instead of delete-recreate.

### Bug #2: Concurrent edits to the same page cause whole-file last-writer-wins data loss
- **ICP:** Multi-device user · **Journey:** Two devices edit the same page between syncs
- **Repro:** Both have page [X,Y]. A adds Z, B adds W. A pushes first. B pulls → git conflict → `auto_resolve_conflicts` runs `git checkout --ours .` (`git_cmd.rs:143`) on the whole tree.
- **Expected:** Union of Z and W, or a conflict copy.
- **Actual:** Entire losing file discarded — no `.orig`, no marker, no version entry. One device's new block permanently destroyed.
- **Severity:** Critical · **Area:** Sync/Data
- **Root cause:** Conflict resolution is file-level checkout, not content merge. There is **no real merge** in the production sync path.
- **Fix:** On conflict, write `Page (conflict <host> <ts>).md` keeping both, or do block-level 3-way merge. Never `checkout --ours .` wholesale.

### Bug #3: Title-as-identity conflates distinct pages across devices
- **ICP:** Multi-device user · **Journey:** Two devices create same-titled pages, or a page is renamed
- **Repro:** A creates "Meeting" (uuid a1, about Alpha); B creates "Meeting" (uuid b2, about Beta). Both export to `Meeting.md` (`export.rs:36`); import matches by title via `get_page_by_title` (`sync.rs:178`), which `LIMIT`-lessly takes the first row.
- **Expected:** Distinct UUIDs stay distinct.
- **Actual:** Pages conflated; one overwrites the other. Page UUID ignored entirely in the git path — identity is the filename.
- **Severity:** Critical · **Area:** Sync/Data
- **Fix:** Persist page UUID in frontmatter, match on it; disambiguate colliding filenames.

### Bug #4: `FolderSettingsPanel.refreshSidebar()` is infinitely recursive — guaranteed crash
- **ICP:** Casual note-taker · **Journey:** Folder Settings → change icon/color or rename
- **Repro:** Open a folder's Settings, click any icon or color swatch.
- **Expected:** Sidebar refreshes.
- **Actual:** `const refreshSidebar = () => { refreshSidebar(); window.dispatchEvent(...) }` (`FolderSettingsPanel.tsx:93-95`) calls **itself** first → "Maximum call stack size exceeded". Icon/color/rename throw; dispatch never runs.
- **Severity:** Critical (trivially-hit crash on a common interaction) · **Area:** Frontend
- **Fix:** Delete the self-call; body should be just the `dispatchEvent`.

### Bug #5: Navigating away mid-typing silently drops the last edit
- **ICP:** Casual note-taker · **Journey:** Type in a block, immediately click another page
- **Repro:** Type "important note" (no Enter), immediately click another page in the sidebar.
- **Expected:** Text saved.
- **Actual:** Editor only saves on `onBlur`, wrapped in `setTimeout(…,50)`. Navigation swaps `activePage` synchronously and unmounts the editor; no unmount flush, so on a fast click the timer never fires and the edit is lost with no error.
- **Severity:** Critical · **Area:** Frontend (editor + nav)
- **Root cause:** `useBlockEditor.ts` save-on-blur only; no cleanup flush. `App.tsx` `openPage` doesn't flush pending edits.
- **Fix:** Add unmount-time flush in `useBlockEditor` cleanup (read markdown, call `onSave` if changed).

---

## HIGH — Correctness, crashes, trust-breaking

### Bug #6: Full-text search returns blocks from trashed AND archived pages
- **ICP:** All (especially privacy-sensitive) · **Journey:** Trash/archive a page, then search · *(Found independently by 3 agents.)*
- **Repro:** Create "Secret" with "launch codes 1234". Trash it. Ctrl+K → "launch codes".
- **Expected:** Excluded (trash is hidden from `list_pages`).
- **Actual:** Block appears; clicking navigates to a "deleted" page. Trash/archive are soft-deletes — `blocks`/`blocks_fts` rows persist and `search.rs:9-16` has no trash/archive predicate (contrast `pages.rs:106`).
- **Severity:** High · **Area:** Search/Data
- **Fix:** Add `AND b.page_id NOT IN (SELECT page_id FROM trash)` + archive to the query (and to backlinks/`get_unlinked_references`).

### Bug #7: FTS search throws a syntax error on ordinary punctuation
- **ICP:** Power user / developer · **Journey:** Search a code/quoted term
- **Repro:** Search `C++`, `foo:bar`, `"unterminated`, or `*`.
- **Expected:** Literal-text results.
- **Actual:** Raw input bound to `MATCH ?1` → FTS5 grammar errors bubble up as a failed search/error toast. Search unusable for code snippets.
- **Severity:** High · **Area:** Search
- **Fix:** Quote the input as an FTS5 string literal (`"{}"` with `"`→`""`) or tokenize and re-join.

### Bug #8: `row_to_card` / `row_to_highlight` panic across the FFI boundary on malformed data
- **ICP:** Power user / multi-device · **Journey:** A card/highlight with a non-RFC3339 `created_at` or bad UUID (from CRDT merge, git import, or older build)
- **Repro:** Insert a card with `created_at = "2024-01-01"` (date only) → call `get_due_cards`.
- **Expected:** Graceful `Err`.
- **Actual:** `Uuid::parse_str(...).unwrap()` and `parse_from_rfc3339(...).unwrap()` (`cards.rs:255-275`, `highlights.rs:178-190`) **panic** inside a `query_map` closure, unwinding across Tauri FFI — aborts the command or crashes the app. (Contrast `row_to_block`/`row_to_page` which use `unwrap_or_default`.)
- **Severity:** High · **Area:** Backend/Data
- **Fix:** Return `rusqlite::Result` from these mappers; use `?`/fallback like the block/page mappers.

### Bug #9: CRDT snapshot merge is additive-only — deletions never propagate, restore is non-faithful
- **ICP:** Multi-device user · **Journey:** Delete a block on A, sync to B; or restore an old version
- **Repro:** A deletes block Y, snapshots. B applies → `apply_automerge` only upserts present blocks, "leaves local-only blocks in place" (`crdt.rs:223-229`, `let _ = snapshot_block_ids; // reserved for future tombstone logic`).
- **Expected:** Y deleted on B.
- **Actual:** Y survives forever and resurrects on A on the next sync. Same defect makes `restore_version` a *union* with current state, not a restore — deleted content reappears.
- **Severity:** High · **Area:** Sync/Data
- **Fix:** Record tombstones in the snapshot; delete locally-present-but-tombstoned blocks. Restore should replace the block set exactly.

### Bug #10: CRDT merge is unconditional LWW — stale snapshot clobbers newer local edits
- **ICP:** Multi-device user · **Journey:** An older snapshot arrives after newer local edits
- **Repro:** Block X = "v3" locally. Stale snapshot with X="v1" arrives → `apply_automerge` upserts unconditionally, stamps `updated_at = now` (`crdt.rs:250-251`), no timestamp/version comparison.
- **Expected:** Newer content retained.
- **Actual:** Stale wins, and is stamped "now" so it looks freshest going forward. Re-applying the same message also re-stamps and appends a duplicate version entry (idempotency violation).
- **Severity:** High · **Area:** Sync/Data
- **Fix:** Compare incoming `updated_at`/version per block; only overwrite if strictly newer; preserve snapshot timestamps; dedupe version log by hash.

### Bug #11: Sync delete-missing can mass-delete the whole DB on a bad git state — and bypasses trash
- **ICP:** Multi-device user · **Journey:** Pull leaves working tree empty/partial, then import runs
- **Repro:** `detect_deleted_pages` (`sync.rs:247-266`) hard-`delete_page`s any non-journal page not seen on disk; no guard against an empty/suspiciously-small scan. `delete_page` (`pages.rs:123-125`) is a real DELETE, not trash.
- **Expected:** Don't fire on an empty tree; route to trash.
- **Actual:** One bad git state wipes the DB with no safety net. (Common path passes `delete_missing=false`, but CLI `sync-dir` and future callers don't.)
- **Severity:** High · **Area:** Sync/Data
- **Fix:** Abort delete-missing if scan saw drastically fewer files than DB pages; route sync deletions to trash.

### Bug #12: Markdown export emits blocks in wrong hierarchical order
- **ICP:** Power user · **Journey:** Export graph to markdown
- **Repro:** Root A (pos 1.0), root B (pos 2.0), child A1 under A (pos 1.0 — positions are per-parent). `get_page_blocks` does `ORDER BY position` **globally** (`blocks.rs:212`); A and A1 both at 1.0 sort arbitrarily.
- **Expected:** DFS order (`- A` / `  - A1` / `- B`).
- **Actual:** Children interleave with parents' siblings; deeper trees scramble. Re-import flattens to root anyway — permanent hierarchy loss.
- **Severity:** High · **Area:** Backend/Data
- **Fix:** Recursive DFS walk in `render_page_markdown`, children sorted within each parent.

### Bug #13: Export doesn't escape content — multi-line blocks split into many on round-trip
- **ICP:** Power user · **Journey:** Export then re-import a block containing newlines (e.g. a template-created code block)
- **Repro:** `export.rs:107` does `format!("{indent}- {}\n", block.content)`. A block with `\n` becomes multiple markdown lines; import splits on `\n` and strips bullet prefixes (`export.rs:202-207`), so one block silently becomes several. No escaping of leading `#`/backticks/`-`.
- **Severity:** High · **Area:** Backend/Data
- **Fix:** Escape leading markdown markers on export; treat indented non-bullet lines as continuations on import (or fence each block).

### Bug #14: Obsidian `Vault.modify` destroys the block tree on every plugin write
- **ICP:** Power user (plugins) · **Journey:** Any compat plugin calls `vault.modify(file, content)` (very common)
- **Repro:** Page with nested blocks → plugin calls `modify` → `Vault.ts:63-77` deletes every block and recreates one flat block per non-empty line.
- **Expected:** Update content, preserve identity.
- **Actual:** Hierarchy, block IDs (breaking `((id))` refs), positions, per-block properties, and blank-line spacing all destroyed. Irreversible.
- **Severity:** High · **Area:** Integration
- **Fix:** Diff against existing blocks; update in place; preserve top-level IDs; treat markdown as a tree.

### Bug #15: PluginLoader = RCE gated only by a page-readable localStorage flag
- **ICP:** Power user · **Journey:** Enable unsafe plugin loading, load a plugin
- **Repro:** `PluginLoader.ts:36` checks `localStorage.getItem("minotes-allow-unsafe-plugin-loading")==="1"`, then `new Function('module','exports','require', code)` (`:58`) runs arbitrary code in the main webview with full access to the obsidian shim → real Tauri `invoke()`. Any XSS (e.g. via CSS snippet) can flip the flag for the next reload. Default-off path makes the whole UI a silent no-op the user can't tell is disabled.
- **Severity:** High (Critical from a security framing) · **Area:** Security/Integration
- **Fix:** Run plugins in a Worker/sandboxed iframe with a narrow postMessage bridge; gate via compile-time feature or backend capability, not page localStorage; disable the button when loading is off.

### Bug #16: Multi-graph selection is non-persistent and the file-watcher is pinned to `default.db`
- **ICP:** Power user · **Journey:** Switch graph, edit, restart
- **Repro:** `current_graph` inits to `"default"` (`lib.rs:1260`); `switch_graph` swaps in-memory state but persists nothing. The watcher hard-codes `wal_name = "default.db-wal"` (`lib.rs:1244`).
- **Expected:** Active graph persists; watcher tracks it.
- **Actual:** Restart reverts to `default` (selection lost); while on "work", live-refresh fires on the wrong DB and never on the active one.
- **Severity:** High · **Area:** Backend/Integration
- **Fix:** Persist active graph, read on startup, re-point watcher on switch (or watch the dir).

### Bug #17: Global keyboard shortcuts fire while typing in the editor
- **ICP:** All · **Journey:** Type in a block, hit Ctrl+N/P/W/J/R/G
- **Repro:** `App.tsx:355-468` runs the keydown handler unconditionally; only Ctrl+Z guards `.ProseMirror`. Ctrl+N opens a blocking `prompt("Page title:")` mid-sentence, Ctrl+W creates a whiteboard on the current page, etc.
- **Expected:** Editor-disruptive chords ignored while editing.
- **Actual:** Interrupts/abandons the edit (compounds with Bug #5 → text lost).
- **Severity:** High · **Area:** Frontend
- **Fix:** Bail out at handler top when `closest(".ProseMirror")`/`isContentEditable`/INPUT is focused (whitelist Ctrl+K/Ctrl+,).

### Bug #18: `handleEnter` on a block with children orphans the subtree and desyncs positions
- **ICP:** Casual note-taker · **Journey:** Cursor mid-text in a parent block, press Enter
- **Repro:** "Parent" with children A,B; Enter after "Parent" → new block gets `parent_id = parent.parent_id`, spliced at `idx+1` (`PageView.tsx:341-349`) — landing visually between parent and first child; children keep old `parent_id`. Backend appends position (no explicit position passed to `createBlock`), so on refresh the block jumps.
- **Severity:** High · **Area:** Data/Editor
- **Fix:** When splitting a parent, make the new block a first child or compute an explicit position; pass position to `createBlock`/`reorderBlock`.

### Bug #19: `focusBlockIndex` uses raw-array indices but refs are keyed by the *filtered* list — typing lands in the wrong block
- **ICP:** Casual note-taker · **Journey:** Page whose first block is a hidden `# Title`, then Enter/Arrow/Backspace
- **Repro:** Handlers compute `idx` from raw `blocks` (`PageView.tsx:312,352,…`) but `blockRefs` are keyed by `filteredVisibleBlocks` map index (`:1160`). The hidden H1 (and collapsed subtrees) shift the index space → focus lands off-by-N or fails.
- **Severity:** High · **Area:** Editor/Frontend
- **Fix:** Compute focus targets against `filteredVisibleBlocks`, or key refs by block id and focus by id.

### Bug #20: `handleBackspaceAtStart` reads stale `blocks` closure and full-refreshes — can overwrite the previous block
- **ICP:** Casual note-taker · **Journey:** Edit block A, then Backspace-merge block B into A while A's save is in flight
- **Repro:** `prevBlock = blocks[idx-1]` from a captured closure; `mergedContent = prevBlock.content + …` then `updateBlock(prevBlock.id, merged)` (`PageView.tsx:359-362`). If A's optimistic edit hasn't propagated into the closure, A's latest text is overwritten with a stale value; then unconditional `onRefreshPage()` discards optimistic state.
- **Severity:** High · **Area:** Data/Editor
- **Fix:** Read latest via `localBlocksRef.current`; sequence after pending saves; update local state instead of full refresh.

### Bug #21: `skipSyncRef` single-shot guard + no in-flight Enter guard → setContent clobbers in-progress edits
- **ICP:** Power user (fast outlining) · **Journey:** Rapid typing + fast Enter presses
- **Repro:** `skipSyncRef` is a one-shot boolean consumed by the first sync-effect run (`useBlockEditor.ts:455`); if `content` changes twice before the effect runs, the second change calls `setContent`, wiping complex nodes (the documented "two sync effects = corruption"). No in-flight guard on `handleEnter` → concurrent calls both splice `idx+1`.
- **Severity:** High · **Area:** Editor/Data
- **Fix:** Make `skipSyncRef` a counter or compare-by-content; add an in-flight guard to `handleEnter`.

### Bug #22: Tag extractor matches hex colors, `#include`, URL fragments, and issue numbers as tags
- **ICP:** Growth/PM (the "AI" features) · **Journey:** Note containing CSS/code, then the "AI Suggested Tags" banner
- **Repro:** Block `background: #fff; color: #1a2b3c;` → suggests `#fff`, `#1a2b3c`. Also `#include`, URL `#section`, "fixed in #123", `#2bug`. Regex `tagExtractor.ts:19` has no code-fence/URL/boundary awareness and allows leading digits.
- **Expected:** Only genuine `#topic` tags.
- **Actual:** Accepting writes garbage into the page's `tags` property.
- **Severity:** High · **Area:** AI logic/Frontend
- **Fix:** Require whitespace/boundary before `#`; strip code regions; exclude pure-hex and all-digit; skip URL fragments.

### Bug #23: Rust TODO text extraction is off-by-one — leaves a stray `]` and drops a character
- **ICP:** Growth/PM · **Journey:** Open the aggregated TODO list
- **Repro:** Block `- [ ] Task one` → `trimmed[3..].trim()` (`ai_suggestions.rs:84,131`) strips only `"- ["` (3 bytes; the prefix `- [ ] ` is 6) → text = `"] Task one"`.
- **Severity:** High · **Area:** Backend/AI
- **Fix:** Strip through the first `]`: `trimmed[trimmed.find(']').map(|i|i+1).unwrap_or(0)..].trim()`.

### Bug #24: Sidebar TODO badge and frontend extractor disagree on what counts as a TODO
- **ICP:** Growth/PM · **Journey:** Compare the badge number vs. the visible TODOs
- **Repro:** `+ [ ] x` → Rust counts, frontend ignores (no `+`). Empty `- [ ]`/`TODO:` → Rust counts, frontend requires text. `-  [ ]  x` (two spaces) → frontend regex matches, Rust `starts_with("- [ ]")` fails. Two independent non-equivalent detectors (`ai_suggestions.rs:36-51` vs `todoExtractor.ts:28-29`).
- **Severity:** High · **Area:** Backend+Frontend/Analytics
- **Fix:** Share one canonical detector or align rules exactly.

### Bug #25: Link suggestions are driven by stopword overlap and show >100% match scores
- **ICP:** Growth/PM · **Journey:** Edit any prose page; "AI Suggested Links" banner
- **Repro:** Tokenize by `split(/\s+/).filter(w.length>=4)` with no stopword removal; score `overlap*20`, labeled `${score}% match`, uncapped (`PageView.tsx:67-88`). A page titled "These That With" scores 60 from stopwords; 6-word overlap renders "120% match". The richer `linkSuggestions.ts` exists but is **dead/unused**.
- **Severity:** High · **Area:** AI logic/Frontend
- **Fix:** Use `linkSuggestions.ts` ratio scoring + stopword list; clamp the percentage.

### Bug #26: `git checkout --ours` direction contradicts the stated "most recent wins" intent
- **ICP:** Multi-device user · **Journey:** Conflict during `pull --rebase`
- **Repro:** During rebase, `--ours` is the upstream (remote) being rebased onto; `--theirs` is the local replayed commit. Comment (`git_cmd.rs:141`) says "remote wins (most recent)" then runs `checkout --ours .` — discarding the *local, newer* edit. Oldest effectively wins.
- **Severity:** High · **Area:** Sync
- **Fix:** Decide a real policy; preferably preserve both (see Bug #2).

---

## MEDIUM — Integrity gaps, misleading behavior, races

### Bug #27: `run_query` SELECT-only guard is an unsound string-prefix check
- **ICP:** Power user · **Journey:** Query console (or any `run_query` caller, incl. plugins)
- **Repro:** Guard is `trimmed.to_uppercase().starts_with("SELECT")` (`db.rs:268`). Rejects legitimate read-only `WITH`/`EXPLAIN`; validation by prefix, not `stmt.readonly()`. High-risk if `run_query` becomes reachable by plugin content.
- **Severity:** Medium · **Area:** Backend/Security
- **Fix:** After `prepare`, check `stmt.readonly()`; or use a read-only connection.

### Bug #28: AI "Suggested Links" insert button navigates away instead of inserting
- **ICP:** Growth/PM · **Journey:** Click "+" on a suggested `[[Title]]` chip
- **Repro:** `PageView.tsx:1146` `onClick={() => onPageLinkClick(s.pageId)}` — navigates, abandoning the current page; nothing is inserted (contrast Tags "+").
- **Severity:** Medium · **Area:** Frontend
- **Fix:** Insert `[[Title]]` into a block and dismiss the suggestion.

### Bug #29: Permanently deleting a page leaks orphaned `properties` rows forever
- **ICP:** Power user · **Journey:** Empty trash / permanent delete
- **Repro:** `properties` table has **no FK** to pages/blocks (`db.rs:54-64`); `delete_page` only `DELETE FROM pages` (`pages.rs:123`). Property rows survive indefinitely; queries scanning `properties` surface stale data for deleted pages.
- **Severity:** Medium · **Area:** Backend/Data
- **Fix:** Add explicit `DELETE FROM properties WHERE entity_id=?1` to `delete_page`/`delete_block`.

### Bug #30: `permanently_delete_folder` misses pages in nested subfolders (orphans to root)
- **ICP:** Power user · **Journey:** Empty trash on a folder with subfolders
- **Repro:** `get_folder_pages_including_trash` is non-recursive (`trash.rs:259-263`, `WHERE folder_id=?1` only). `pages.folder_id ON DELETE SET NULL` means subfolder pages survive as root pages instead of being deleted. Data the user believed purged reappears at top level.
- **Severity:** Medium · **Area:** Backend/Data
- **Fix:** Walk the full subtree (mirror `restore_folder`'s BFS) before deleting folders.

### Bug #31: `get_unlinked_references` substring-matches short titles ("AI" matches "RAID", "maintain")
- **ICP:** Casual note-taker · **Journey:** Unlinked References panel for a short title
- **Repro:** Query is `content LIKE '%AI%'` (`links.rs:75`), case-insensitive substring, no word boundary. Floods the panel with noise.
- **Severity:** Medium · **Area:** Links/Data
- **Fix:** Word-boundary match (FTS/tokenizer); skip very short titles.

### Bug #32: `sync_block_links` auto-creates a page for every `[[typo]]`, permanently polluting the page list
- **ICP:** Casual note-taker · **Journey:** Type a wiki link with a typo, fix it
- **Repro:** `blocks.rs:22-27` auto-creates a page for any non-existent `[[title]]` on every save (blur/debounce). Typo "Meething Notes" becomes a real page, never cleaned up. Intermediate saves while typing can create `[[M]]`, `[[Me]]`… junk pages. Compounds with Bug #11 (`detect_deleted_pages` then deletes these file-less auto-pages on sync).
- **Severity:** Medium · **Area:** Links/Data
- **Fix:** Create targets only on explicit action, or mark as "stub" pages; wrap create+link-sync in a transaction.

### Bug #33: Dismissed AI tag suggestions reappear on every edit; sidebar TODO badge never refreshes
- **ICP:** Growth/PM · **Journey:** Dismiss a suggested tag, keep typing / complete TODOs
- **Repro:** Tag effect calls `setDismissedTags(new Set())` on every `blocks` change (`PageView.tsx:59`), so dismissed tags return on the next keystroke. Separately, the badge fetch effect has `[]` deps with no event listener (`Sidebar.tsx:151-154`) — count frozen at mount-time.
- **Severity:** Medium · **Area:** Frontend/AI
- **Fix:** Persist dismissals per page; add `refreshKey`/event subscription to the badge fetch.

### Bug #34: CSS snippet edit does delete-then-re-add (data-loss window) with no sanitization
- **ICP:** Power user · **Journey:** Edit a CSS snippet, Save
- **Repro:** `CssSnippetManager.tsx:57-91` `handleUpdate` deletes then re-adds (changing id/created_at; total loss if the re-add throws) because `update_snippet_css` exists in `snippets.rs:111` but is **not wired as a Tauri command**. Injected CSS is unsanitized (`@import url()`, `background:url()` exfiltration, clickjacking overlays).
- **Severity:** Medium · **Area:** Frontend/Integration/Security
- **Fix:** Expose `update_snippet_css` and do an atomic UPDATE; strip `@import`/external `url()`.

---

## Additional verified lower-severity findings

- **CLI `search --format text` panics** on multibyte UTF-8 — `&content[..80]` byte-slice (`output.rs:91`).
- **CLI OPML export doesn't escape newlines** in `text="..."` attributes (`output.rs:275`) → invalid XML.
- **CLI `query` String-first coercion** mistypes integers/text and silently drops BLOBs to null (`query.rs:19-31`).
- **`delete_property` emits a "deleted" event before the delete and even when nothing existed** (`properties.rs:103-114`) — corrupts the undo/event log.
- **`commit_all` has an inverted/misnamed `has_changes` boolean** (`git_cmd.rs:78-82`) — happens to early-return correctly but reports "nothing committed" if `diff` errors.
- **`sync_page` "unchanged" fast-path compares only flat content lists** (`sync.rs:191`) — silently drops re-indents/reorders/format changes.
- **`db-changed` watcher has no debounce**; combined with non-transactional delete-then-recreate in `sync_page`, the UI can flash all-blocks-gone mid-import (`lib.rs:1247`, `sync.rs:196-200`).
- **Aliases can shadow real page titles**; `get_page_by_title` (title-first) and `resolve_alias` (alias-first) disagree (`aliases.rs:94`, `pages.rs:80`).
- **`empty_trash` swallows per-item errors** (`trash.rs:235` `let _ =`) — reports success while zombies remain.
- **Mock backend miscounts "Follow up:"** TODOs — tests regex against only the first token (`mockBackend.ts:766`), reducing browser-mode test fidelity.
- **Built-in templates insert empty/duplicate blocks** and no `{{date}}` substitution exists anywhere (`slashCommands.ts:113-125`).
- **Journal "today" uses UTC date** (`new Date().toISOString().slice(0,10)`) while the sidebar uses local date — Ctrl+J can open a different day than the highlighted "Today"; also force-creates empty journal pages on every launch.
- **`TodoPanel` jump passes `sourceBlockId` where a page id is expected** (`TodoPanel.tsx:95`) — dead code today, breaks if wired.

---

## Priority fix order

1. **Bug #4** — `refreshSidebar` recursion (one-line fix, guaranteed crash on a common action).
2. **Bug #6** — search leaks trashed/archived content (one-line query fix, trust/privacy).
3. **Bugs #5, #20, #21** — editor data-loss on navigate/merge/rapid-Enter.
4. **Bug #8** — card/highlight `unwrap()` FFI panics (app crash on bad data).
5. **Bug #17** — shortcuts firing in the editor (compounds #5).
6. **Bugs #1, #2, #3, #9, #10, #11** — the sync/CRDT data-loss cluster. Larger design effort: the production git-sync path has no real merge and uses title/filename as identity; the snapshot path is not a CRDT (no tombstones, no clocks). The single biggest risk to the product's core promise.
