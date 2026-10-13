# Architecture review: findings and plan

Status: review complete, nothing fixed yet · Owner: Chris Klaus · Reviewed 2026-10-12
Code reviewed: branch `nb5` (main `27929d6` + cross-notebook search/links + Android
storage), ~63k lines: core 30k, frontend 26k, desktop backend 4k, CLI 2.5k.

## 1. How this review was done

Four reviewers worked in parallel, one per layer (core data layer, files/sync/
notebooks, desktop backend + CLI + AI, frontend), read-only, each required to
cite `file:line` and to prove what it could with scratch tests outside the repo.
Every finding carries a confidence level:

- **Verified**: reproduced by a test/probe, or traced through every caller.
- **Likely**: code path read end to end; not executed.
- **Suspected**: needs confirmation before work starts.

I re-checked the highest-impact findings against the code myself (F-1, F-4,
F-6, B-1, B-4, B-8, C-1, C-3, U-1, U-2, U-8) and re-ran the file/sync proof tests:
F-1, F-2, F-5 and F-7 fail their correctness assertions; F-3 and F-4 reproduce
in their output. Duplicates found from two sides are merged (noted per item).

IDs: **C** core data · **F** files/sync/notebooks · **B** backend/CLI/AI ·
**U** frontend · **X** cross-cutting.

## 2. Summary

MiNotes' foundations are better than its size suggests: transactional writes
with fault-injection tests, cycle-safe trees, hash-based mirror ownership,
conservative deletions, a strict production CSP, SSRF-safe link previews, a
read-only tool model for AI, and unusually rich end-to-end tooling. The problems
cluster in six places:

1. **Sync can lose data.** Enabling git sync can revert recent edits and
   hard-delete blocks (F-1, Critical); a concurrent remote edit is silently
   dropped (F-2); block properties never sync (F-7); dropped-in markdown is
   rewritten lossily (F-3). Root cause: several markdown parsers/importers with
   different safety rules (F-8, F-13).
2. **Files and folders from elsewhere are trusted.** Symlinks in the mirror are
   followed (F-4, F-5), git runs repo-local hooks (F-6), and an imported notebook
   zip brings its AI endpoint, CSS and triggers with it (B-1).
3. **One mutex, mostly synchronous commands.** ~139 synchronous commands on the
   UI thread share one `Mutex<Database>` that background work also holds (B-4);
   write transactions start deferred, so the CLI and app collide instantly
   (C-3).
4. **History is unbounded and wrongly coupled.** The event log is never pruned
   and it pins whiteboard/attachment garbage collection, so "Empty trash" never
   frees files (C-1); the backend undo is unused and incorrect (C-2); frontend
   undo is global and can undo invisible changes (U-4).
5. **Schema and derived data drift.** Non-transactional migrations, no
   downgrade guard, half the DDL outside versioning (C-4); restore and title
   changes leave links stale (C-5, C-6, C-7).
6. **Frontend lifecycle is ad hoc.** No save barrier on notebook switch (U-1),
   the open page ignores outside writes (U-2), async handlers act on stale
   pages (U-3), test hooks ship in production (U-8).

And one process gap that makes all of this riskier: **there is no CI** (X-1).

## 3. Action plan

### P0: fix now (data loss and security; mostly small)

| ID | Fix | Effort |
|---|---|---|
| F-1 | **Fixed** (4f43d3a). Flush the mirror before enabling sync; protect recent edits; park removed blocks in Trash | S |
| F-6 | **Fixed** (4f43d3a). Run git with hooks/fsmonitor/ext protocol disabled and `--no-verify`; don't auto-sync folders this machine didn't set up | S |
| F-4, F-5 | **Fixed** (4f43d3a). Refuse symlinks in the mirror (lstat everywhere, canonical containment); `core.symlinks=false` | S |
| B-1, F-16 | Scrub imported zip notebooks: AI settings off, no transcripts/snippets/plugins, drop unknown triggers/views, `trusted_schema=OFF`; exclude `ai_runs` from export | M |
| C-1 | Bound the event log and stop GC from counting events no one can undo, so trash and attachments are actually freed | M |
| U-1 | Save barrier before notebook switch (flush editor + whiteboard) | S |
| B-2 | AI Ask must respect read-only sessions | S |
| C-3 | `BEGIN IMMEDIATE` for outermost transactions + bounded busy retry | S |
| B-14 | Dev-only OpenRouter URL override out of release builds | S |
| B-5 | Attachment open: allowlist of safe types instead of a denylist | S |

### P1: next (correctness and trust)

F-2 (remote edit lost), F-7 (block properties in markdown), F-3/F-8 (one import
pipeline for every file that enters the DB), C-4 (transactional, versioned
migrations + `rebuild_derived()`), C-5 (atomic restore), B-3 (app-level AI spend
ledger), U-2 (refresh the open page on outside writes), U-3, U-4 (page-scoped
undo), C-6, C-7, C-9, B-8 (Windows data dir), B-9 (safe startup), F-9 (exclusive
lock), F-10 (durable state), U-8 (test API out of production), X-1 (CI).

### P2: structural (the target architecture in §5)

Core service layer (B-7, B-10, B-11, C-13), connection model (B-4), single
markdown codec (F-13), app lifecycle store (U-10), generated IPC bindings (U-9),
code splitting (U-14), accessibility (U-15), whiteboard conflict handling
(F-11), outline positions owned by core (C-8), canonical title keys (C-10).

## 4. Findings

### 4.1 Index

| ID | Sev | Conf | Title | Effort |
|---|---|---|---|---|
| F-1 | **Critical** | **Fixed** | Enabling git sync reverts unmirrored edits and hard-deletes new blocks | S |
| F-2 | High | Verified | Remote edit silently discarded when the page was edited locally during sync | M |
| F-3 | High | Verified | Dropped-in markdown rewritten lossily (YAML lists, code fences), no copy kept | M |
| F-4 | High | **Fixed** | Symlinked `.md` in the mirror is imported and re-written as a real file (exfiltration via a shared repo) | S |
| F-6 | High | **Fixed** | Git runs repo-local hooks/fsmonitor in notebook folders the user opened | S |
| F-7 | High | Verified | Block properties are not in the markdown, so never sync | M |
| B-1 | High | Likely | Imported notebook zip carries AI endpoint, CSS snippets, plugins, triggers | M |
| B-2 | High | Verified | AI Ask writes to a notebook open read-only (owned by another window) | S |
| B-3 | High | Verified | Monthly AI cost cap can be exceeded (parallel runs, unknown prices, lost usage, per-notebook) | M |
| B-4 | High | Verified | ~139 sync commands on the UI thread share one DB mutex held by background work | M |
| C-1 | High | Verified | Event log never pruned; it pins whiteboard/attachment GC forever | M |
| C-3 | High | Verified | Deferred transactions: concurrent writers fail instantly with "database is locked" | S |
| C-4 | High | Verified | Migrations not transactional, no downgrade guard, DDL outside versioning | M |
| C-5 | High | Verified | Version restore is non-atomic and leaves links/sync state wrong | M |
| U-1 | High | Likely | Notebook switch doesn't flush edits; the unmount save lands in the other notebook | S–M |
| U-2 | High | Verified | Open page never refreshes after outside writes; stale content can overwrite them | M |
| U-4 | High | Likely | Undo is one global stack: Ctrl+Z can undo invisible changes on other pages | M–L |
| F-5 | Medium | **Fixed** | Mirror writes and prunes through symlinked directories | S |
| F-8 | Medium | Likely | Two markdown importers with different safety policies | M |
| F-9 | Medium | Verified | "Take over" leaves two live writers; lock is check-then-write | M |
| F-10 | Medium | Likely | Lost mirror state silently disables outside-edit protection; writes not durable | S–M |
| F-11 | Medium | Verified | Whiteboards: last-writer-wins by wall clock across devices | M |
| F-12 | Medium | Likely | Re-rendering a just-saved outside file churns block ids | M |
| F-13 | Medium | Verified | No single markdown codec (3 parsers, 2 frontmatter readers, a legacy importer) | M |
| B-5 | Medium | Verified | `open_attachment` denylist misses many dangerous types | S |
| B-6 / U-16 | Medium | Likely | Remote `https:` images load from notes (tracking pixels); inline CSS snippets | M |
| B-7 / U-8 | Medium | Verified | No IPC authorization; test API, module exposure and picker bypass ship in production | L / S |
| B-8 | Medium | Likely | On Windows, data falls into the working directory | S |
| B-9 | Medium | Verified | Startup DB failure panics with no window | M |
| B-10 | Medium | Verified | `lib.rs` god module, string errors, duplicated guards | M |
| B-11 | Medium | Verified | CLI re-implements session logic and ignores the app's lock | M |
| C-2 | Medium | Verified | Backend `undo_last` is unused and wrong (cross-actor, no-ops, data loss) | S (remove) |
| C-6 | Medium | Verified | Renaming a page doesn't backfill links to the new title | S |
| C-7 | Medium | Verified | Title freed from trash leaves link rows on the trashed page | S |
| C-8 | Medium | Verified | Core doesn't own sibling ordering (no tie-break, precision exhaustion) | M |
| C-9 | Medium | Verified | Unlinked references: `LIMIT 50` before filtering | S |
| C-10 | Medium | Verified | Inconsistent title/folder identity (case, Unicode normalisation, root folders) | M |
| C-13 | Medium | Verified | `Database` is one 200-method type behind one mutex; no typed IO/Busy errors | L |
| U-3 | Medium | Verified | Async handlers use a stale `activePage` and navigate back | S |
| U-5 | Medium | Verified | Enter-split create is not atomic; failure duplicates text | S |
| U-6 | Medium | Verified | Client-side filtering over truncated `listPages(N)` | S–M |
| U-7 | Medium | Verified | Every save reloads the sidebar with ~25 IPC calls; no list virtualization | S / M |
| U-9 | Medium | Verified | Mock backend is a hand-written reimplementation; parity unenforced | M–L |
| U-10 | Medium | Verified | `window` event bus + god components; caches not tied to notebook lifecycle | M–L |
| X-1 | Medium | Verified | No CI: no automated tests, lint or audit on any change | S–M |
| B-12 | Low–Med | Verified | AI runs can't be cancelled mid-call; scope filter applied after a 500-hit cap | S–M |
| C-11 | Low–Med | Verified | Lenient row decoding hides corruption (bad timestamps become "now") | S–M |
| C-12 | Low | Verified | Several multi-statement writes outside `tx`; card uniqueness only in code | S |
| C-14 | Low | Verified | Scaling hot spots (O(n·N) ref re-derivation, missing indexes) | S |
| F-14 | Low | Suspected | Interrupted sync phase 3 makes pulled files look like outside edits | S |
| F-15 | Low | Verified | Full passes and `git commit` under the DB lock; `.minotes-trash` grows forever | S–M |
| B-13 | Low | Verified | Cross-notebook link resolution holds the DB lock while opening other notebooks | S |
| B-14 | Low | Verified | Release build honours a dev-only OpenRouter URL override (key goes with it) | S |
| B-15 | Low | Verified | `attachment://` reads whole files into memory | S |
| U-11 | Low | Verified | Tauri `listen()` leaks when cleanup runs before it resolves | S |
| U-12 | Low | Verified | Search results overwritten by a slower older query | S |
| U-13 | Low | Likely | `BlockItem` memo ignores callback props | S |
| U-14 | Low | Verified | No code splitting: 2.2 MB entry chunk includes PDF.js, graph, mind map, mock | S |
| U-15 | Low | Verified | Outline and custom widgets lack ARIA; dialogs lack focus management | M |

### 4.2 Sync, mirror and import (data safety)

**F-1 Enabling git sync imports a stale mirror as truth.** *Critical, Verified.*
`sync_manager.rs:478-481` (`enable_in_dir`) runs `sync_dir_with(..)` before any
mirror flush and without `protect_modified_after`; `reconcile_page_blocks`
calls `delete_block` (hard delete) for blocks missing from a file
(`repo/sync.rs:1064`). Proof test: edit a block and add one, enable sync → only
"old text" remains. Hits anything typed within the 2 s mirror debounce, any page
whose mirror write failed, and on Android (mirror off unless sync is on) every
edit since sync was last disabled. **Fix:** full `mirror::run` (with
outside-edit import) under FS_LOCK + DB lock first; pass
`protect_modified_after`; send removals to the Trash sink; regression test.

> **Fixed** (4f43d3a). `enable_in_dir` now takes the mirror target and runs:
> full mirror pass (outside edits imported first) + commit under FS_LOCK and the
> DB lock → pull → import → mirror pass → commit → push. The import protects
> pages edited after the flush (`protect_modified_after`) **and every page whose
> file the pull did not change** (`SyncOptions::protect_pages`), so a file older
> than the database can never win — the rule that also covers Android and
> mirror-off notebooks. Pull deletions go to the Trash under the mass-delete guard;
> blocks the pull removed are parked in a Trash page "<title> (removed by sync …)"
> (`SyncOptions::park_removed`). Tests: `test_enable_keeps_unmirrored_edits`,
> `test_reenable_after_weeks_with_mirror_off_keeps_the_database`,
> `test_enable_imports_the_pull_and_parks_removed_blocks`.

**F-2 Remote edit discarded when the page was edited locally during the network
phase.** *High, Verified.* Protected pages are skipped (`repo/sync.rs:846`) but
a skip isn't an error, so `imported_head` advances (`sync_manager.rs:672`) and
`adopt_pulled_files` re-baselines the pulled file (`outside.rs:816`); the next
mirror pass overwrites it. Proof test: B's edit to block 2 vanishes on both
devices when A edits block 1 mid-sync. **Fix:** keep the pulled version as a
conflict copy (or 3-way block merge against `git show <imported_head>:path`);
never mark the head imported until skipped pages are absorbed.

**F-3 Dropped-in markdown is rewritten lossily.** *High, Verified.* New files in
`notes/` go through the sync codec, which drops YAML list values
(`sync.rs:1367`) and splits fenced code per line with indentation as nesting; the
file is then overwritten with no copy (`outside.rs:778`). Contradicts PRD-notebooks
Phase 4 ("nothing overwritten without a recoverable copy"). **Fix:** route
id-less files through the importer's codec (`import::split`,
`import::frontmatter`); move the original to `.minotes-trash/` before the first
rewrite.

**F-7 Block properties never reach the markdown.** *High, Verified.*
`render_block_lines` (`export.rs:1256`) writes content and the id marker only;
the mirror fingerprint ignores block properties. Proof test: device B has no
block properties after sync. **Fix:** serialise as indented `key:: value`
lines (or a sidecar), parse in reconcile, include in the fingerprint, two-device
test.

**F-8 / F-13 Two importers, three parsers.** Outside-edit import refuses
oversized/binary/conflict-marker files and parks removals in Trash; git-sync
import (`sync.rs:238-300`) reads every file with `from_utf8_lossy`, no size or
conflict-marker check, hard-deletes removals, and re-imports the whole tree each
pull. Markdown writing and parsing are spread over `export.rs`, `sync.rs`,
`import/frontmatter.rs`, `import/split.rs` and a legacy
`import_markdown_dir`; small round-trip bugs follow (a `'draft'` value loses its
quotes; a line starting with `\` folds into the previous block). **Fix:** one
`markdown_codec` module with property-based round-trip tests, and one import
pipeline (validate → parse → reconcile → removal sink) for enable, pull,
outside edits and drop-ins; phase 3 limited to `changed_paths`; delete the
legacy importer.

**F-9 Two live writers after "Take over"; racy lock.** The original instance
never re-checks the lock and keeps mirroring; both share `mirror-state.json`;
`acquire_lock` is check-then-write without `O_EXCL`; a failed lock write counts
as acquired (`notebooks.rs:94-96`). **Fix:** `create_new`/`flock`; the mirror
worker verifies ownership each pass and drops to read-only when it lost the
lock.

**F-10 Lost mirror state disables protection.** `load_state` falls back to
default on any parse error (`mirror.rs:127`), which turns off the outside-edit
guard and lets a full pass overwrite pending outside edits. `atomic_write`
never fsyncs; several config writes aren't atomic at all. **Fix:** when state is
missing but files exist, guard by content (compare to current rendering →
conflict copy); fsync file and directory; use atomic writes for all state.

**F-11 Whiteboards are last-writer-wins by device clock**, and git conflict
copies of sidecars are pruned. **Fix:** keep the losing board as a conflict
board, or merge by element id.

**F-12 Block-id churn for files being edited outside.** The mirror rewrites a
just-imported file with id markers; the external editor's next save has a stale
buffer, so edited lines lose their ids and a "(removed outside …)" Trash page
appears. **Fix:** don't rewrite recently imported files; or keep a hidden
line→id map in mirror state instead of forcing markers into user files.

**F-14** (Suspected) pulled files become "outside edits" if sync phase 3 was
interrupted; **F-15** full passes and `git add/commit` run under the DB lock
(~0.4 s at 100k blocks) and `.minotes-trash/` is never aged out.

### 4.3 Trust boundaries and security

**F-4 / F-5 Symlinks in the mirror.** `outside.rs` reads candidates with
`fs::metadata`/`fs::read` (follow links) and `safe_join` (`export.rs:1355`) is
lexical only. Proofs: `evil.md -> secret.txt` is imported as page "evil" and the
next pass writes the secret into a regular `evil.md` that git sync would commit;
`notes/Work -> ../elsewhere` makes the mirror write outside its folder. Anyone
who can push to a shared sync repo can commit such a link. **Fix:**
`symlink_metadata` everywhere, refuse symlinks, canonical `starts_with(root)`
before every write/rename, `core.symlinks=false` for the sync repo.

> **Fixed** (4f43d3a). An `lstat` walk below the mirror root (`export::symlink_below`,
> `read_below`, `link_in_the_way`) guards every read (outside-edit candidates incl.
> watcher and tracked paths, `adopt_pulled_files`, sync import, folder markers,
> manifest, whiteboard and attachment sidecars) and every write, mkdir, prune and
> `.minotes-trash` move (full and incremental mirror, export, conflict copies).
> Linked files are left untouched and reported once as "skipped: symbolic link";
> `atomic_write` refuses to replace a link and creates its temp file exclusively.
> The mirror root itself may be a link. `core.symlinks=false` is passed on every git
> run and persisted in the repo (`git_cmd::harden_repo`, on enable and every
> cycle). Tests: `outside::tests::symlinked_*`, `page_file_replaced_by_a_symlink_*`,
> `prune_never_moves_files_through_a_symlinked_trash_dir`,
> `atomic_write_refuses_to_replace_a_symlink`,
> `sync_manager::tests::test_symlink_from_a_shared_remote_is_never_followed`.

**F-6 Git hooks and config from the folder run.** `run_git_timeout`
(`git_cmd.rs:375`) passes only `core.quotePath=off`; no `core.hooksPath`,
`core.fsmonitor` or `--no-verify`. The PRD promise "copy the folder to another
machine and it just works" means a shared folder with
`notes/.git/config: core.fsmonitor=<cmd>` executes code when sync runs on open.
**Fix:** always `-c core.hooksPath=/dev/null -c core.fsmonitor=false
-c protocol.ext.allow=never`, `commit --no-verify`; ask before enabling sync for
a folder this machine didn't create.

> **Fixed** (4f43d3a). Every git run gets `-c core.hooksPath=/dev/null` (Windows:
> an empty dir in `~/.minotes`), `core.fsmonitor=false`, `protocol.ext.allow=never`,
> `core.symlinks=false`, `commit.gpgSign=false`; `commit`/`push` use `--no-verify`;
> diffs use `--no-ext-diff --no-textconv`. The user's global config is not
> overridden (`core.sshCommand`, credential helpers, askpass, proxies keep working).
> Trust: a folder notebook whose own `sync-config.json` says enabled but which has
> no token recorded in this machine's `~/.minotes/sync-trust.json` is not synced
> (`full_sync_with` returns `needs_confirmation`; the app shows a "Sync it here /
> Not now" banner). Confirming — or turning sync on yourself — strips
> command-running keys from that repo's `.git/config` (`core.fsmonitor`,
> `core.sshCommand`, `credential.*helper`, `filter.*`, `merge.*.driver`,
> `diff.*.textconv`, `include*`, `remote.*.uploadpack`, …; `git_cmd::is_command_config_key`)
> and records the token. Legacy notebooks keep their sync config in `~/.minotes`, so
> they count as set up here. Tests: `test_sync_never_runs_repo_hooks_or_fsmonitor`
> (hooks + fsmonitor writing a marker; verified they do run under plain git),
> `test_copied_folder_sync_needs_confirmation`, desktop journey D10.

**B-1 / F-16 An imported notebook zip is trusted wholesale.** AI settings live in
the notebook DB (`ai/settings.rs`), a "local" endpoint may be any `https://` URL
(`settings.rs:175-180`), and local runs skip the cost cap (`ai/mod.rs:454`). A
shared zip with `provider=local, base_url=https://attacker/v1` sends every note
in scope to the attacker on first Ask. Enabled CSS snippets and arbitrary
triggers come along; export ships `ai_runs` transcripts. *(This corrects my
earlier assessment during the Android merge that a hostile imported database
"could only harm itself"; the AI settings make it an exfiltration path.)*
**Fix:** on import reset AI to Off, drop `ai_runs`, disable snippets/plugins,
compare `sqlite_master` to the canonical schema and drop unknown
triggers/views, set `trusted_schema=OFF`; exclude `ai_runs` from export; a
non-loopback "local" endpoint becomes a separately confirmed "custom endpoint".

**B-5 Attachment launch denylist.** The list added in this project
(`import_commands.rs`) misses `.chm .pif .iso .img .vhd .xll .docm .xlsm .pptm
.jnlp .appref-ms .library-ms .terminal .fileloc` and more. **Fix:** allowlist
(images, PDF, audio/video, plain text, macro-free office); reveal everything
else.

**B-6 / U-16 Remote content.** CSP `img-src … https:` plus `staticRender`
keeping `https:` image sources and OG preview images means imported or synced
notes phone home on open. CSS snippets are inline (`style-src 'unsafe-inline'`).
**Fix:** "Load remote images" setting (off for imported content) or a caching
image proxy through the existing SSRF-safe resolver; drop `https:` from
`img-src`.

**B-7 / U-8 No authorization on IPC; test hooks ship.** Any script in the
webview can call all ~150 commands (no AppManifest command ACL); legacy plugin
commands (`plugin_storage_*` with no namespacing, `register_plugin`,
`add_css_snippet`), `run_query` over the whole DB, and broad file reads
(`read_file_base64`, `read_pdf_file` accept any path) remain. `main.tsx:5`
imports `testModules` unconditionally (exposes `api`, `mockBackend` on
`window.__MINOTES__`), and `setNextPickedFolder/ZipPick/ExportDest` let script
skip the native pickers that serve as consent. `PluginLoader`'s `new Function`
can never run under the CSP (dead code). **Fix (S):** gate test hooks behind
`import.meta.env.DEV || VITE_E2E` and a separate e2e build for desktop-check;
import the mock only in browser mode; delete the dead plugin loader. **Fix (L):**
the service layer in §5, command allowlist with per-window capabilities,
restrict file reads to picked paths and the notebook's stores, before any
plugin work.

**B-14** `MINOTES_AI_OPENROUTER_URL` (documented dev-only) is honoured in release
and receives the bearer key; gate on `debug_assertions`.

### 4.4 Concurrency and responsiveness

**B-4 One mutex, synchronous commands.** 139 plain `#[tauri::command]`s (run on
the main thread in Tauri 2) against 21 async; the same `Mutex<Database>` is held
by the startup full mirror pass, sync export/import, import batches, and
`resolve_notebook_links` (which opens other notebooks under it, B-13).
`publish_site`, exports, 200 MB PDF reads and dropped-file copies run on the
main thread; `run_query` has no row cap or interrupt (proof: 2M rows in 3.3 s;
unbounded CTE never returns). A poisoned DB mutex is never recovered. **Fix:**
DB commands `async`; a writer connection plus a read-only pool (WAL allows
it); `sqlite3_progress_handler`/interrupt + row cap for `run_query`; no file I/O
under the DB lock.

**C-3 Deferred transactions.** `Database::tx` opens a deferred `SAVEPOINT`
(`db.rs:308`); most bodies read before writing, so in WAL a commit by another
connection in between yields `SQLITE_BUSY_SNAPSHOT` immediately; `busy_timeout`
doesn't apply (proof: "database is locked after 0.00 s"). The CLI writing while
the app runs intermittently fails the app's next edit. **Fix:** outermost tx
uses `BEGIN IMMEDIATE` (savepoints for nested), bounded retry at the command
boundary, two-connection test.

**C-13 / B-10 / B-11 Structure.** `Database` is ~204 methods over 27 files with a
public `conn`; errors have no `Io`/`Busy`/`Conflict` variants and reach the UI
as strings (the UI matches on `"cancelled"`). `lib.rs` is 1,768 lines of
lock-parse-map_err boilerplate with read-only checks duplicated. The CLI
re-implements session resolution, never takes the notebook lock, and runs
migrations on the app's live DB (version skew). Addressed by §5.

### 4.5 History, undo and garbage collection

**C-1 Unbounded event log pins GC.** Nothing deletes from `events`; whiteboard
and attachment GC count every `block.deleted`/`block.updated` event with
`undone = 0` as a live reference (`whiteboards.rs:160`, `attachments.rs:514`);
`undone` is only set by the backend undo, which the UI never calls. So deleted
boards and attachments (up to 200 MB each) are never collected, and the DB grows
~1 KB per editor save, including no-op saves (`link.*` events for derived rows).
Probe: 20k creates + 20k edits → 80k events, 21 MB. *(The attachment GC rule was
adopted in the import work from the existing whiteboard rule; both inherit this
bug.)* **Fix:** bound the undo horizon (last N user events / 30 days) and count
only events inside it; compact older events except what sync needs; skip no-op
updates; stop logging derived link rows.

**C-2 Backend `undo_last` is unused and wrong.** It undoes other actors' work
(sync, import, outside edits), silently no-ops moves/renames/properties, breaks
links after a rename, and loses properties and cards when restoring a delete.
**Fix:** remove it (and the `undone` coupling) unless a real design replaces it.

**U-4 Frontend undo is one global stack.** Ctrl+Z outside an editor undoes the
top action even if it belongs to another page, with no message; text edits are
not recorded (only ProseMirror history, which dies with the editor); an
`outside-import` undo resets later typing; multi-call undos are moved to redo
before they succeed. **Fix:** page-scoped undo that announces what it undoes,
record commit-saves as `update` actions, atomic backend commands per compound
action, move to redo only on success.

**U-5** Enter-split is `createBlock` then `moveBlock`; a failure after the create
leaves the text duplicated. **Fix:** one `create_block` with parent + position.

### 4.6 Schema and derived data

**C-4 Migrations.** Each SQL batch and its `user_version` bump are separate
autocommit statements (two processes opening a v3 DB both run v4); no guard for
`user_version > latest` (a v99 DB opens silently); five tables are created with
`CREATE TABLE IF NOT EXISTS` on every open outside versioning (whiteboards,
attachments, notebook_links, import runs, AI), so an older build writes blocks
without maintaining them and they can never get an `ALTER`. **Fix:** all DDL in
the numbered list, each step in `BEGIN IMMEDIATE … COMMIT`, refuse writes on a
newer schema, and a `rebuild_derived()` (links, attachments, notebook_links,
FTS) run after migrations and from the CLI. Includes **B-9**: a failed open
panics before any window; fall back to the default notebook or a safe-mode
window.

**C-5 Version restore** (`crdt.rs:195-310`) runs without `tx`, upserts blocks
raw (no link sync; proof: 0 backlinks after restore), writes the old
`updated_at` and emits no events, so git sync never sees the restore. The
"CRDT" is last-writer-wins JSON snapshots stored as one blob. **Fix:** `tx`,
write through `update_block`/`create_block_with_id`, stamp now, a
`page_versions` table, rename the module.

**C-6** rename doesn't backfill links already pointing at the new title;
**C-7** freeing a title from trash leaves link rows on the trashed page;
**C-9** unlinked references apply `LIMIT 50` before filtering (empty panel on
popular pages); **C-10** title uniqueness is case-sensitive while links resolve
case-insensitively, no Unicode normalisation (macOS NFD imports never match),
root folders can duplicate (NULL parent); **C-11** bad timestamps decode as
"now" and win last-writer-wins, bad ids decode as nil UUIDs; **C-12** several
multi-statement writes outside `tx`, no `UNIQUE(block_id)` on cards; **C-14**
O(n·N) ref re-derivation in `restore_blocks`, no index on
`events.created_at`/`blocks.updated_at`. **C-8** positions are computed in the
frontend by halving gaps (collide after ~52 Enters before a sibling), no
`ORDER BY` tie-breaker, renormalisation is N fire-and-forget IPC calls; move
ordering into core (`insert_after`, `move_before/after` with rebalancing in one
`tx`).

### 4.7 Frontend lifecycle and performance

**U-1 No save barrier on notebook switch.** `switchNotebook`
(`lib/notebooks.ts:46`) switches the backend, then the UI unmounts; the editor's
unmount flush and the whiteboard's debounced save then write against the new
notebook (lost edit, or strokes saved into a board that GC deletes). Easiest
trigger: clicking a just-typed `[[Notebook::Page]]` chip. **Fix:** a
`flushPendingEdits()` barrier awaited before the IPC call.

**U-2 The open page ignores outside writes.** `db-changed` only refreshes the
sidebar (`App.tsx:110`); a CLI/agent edit to the visible page doesn't appear,
and a later blur can write stale text over it. D3 navigates before asserting,
so tests miss it. **Fix:** refresh the active page on `db-changed` via the
existing reconcile (which already protects in-progress typing); later, backend
emits changed page ids.

**U-3** `triggerSync`, undo and held-deletion handlers call
`openPage(activePage.page.id)` with a stale closure and pull the user back to a
page they left. **U-6** autocomplete, journal lookup and link suggestions filter
`listPages(100|200)` client-side and miss older pages, while rename checks load
`listPages(100000)`; add backend lookups. **U-7** every save triggers a sidebar
reload of ~25 IPC calls (the watcher fires on the app's own writes) and pages
are never virtualized. **U-10** ~31 `dispatchEvent` sites with string event
names, 19 `useState` in App, module caches not reset per notebook; root cause of
U-1–U-3. **U-11** `listen()` leaks without a disposed guard; **U-12** stale
search results; **U-13** `BlockItem` memo ignores callbacks (works only by ref
discipline); **U-14** no code splitting (2.2 MB entry with PDF.js, d3,
xyflow, the mock); **U-15** no tree semantics, clickable spans, no focus
trapping.

### 4.8 AI

**B-2** `ai_ask` opens the DB read-write (`ai_commands.rs:186`) even when the
session is read-only, runs migrations and writes `ai_runs` into a notebook
another instance owns. **B-3** the cap is read once per run, so parallel runs
each spend up to the cap (proof: $12 against $5); unknown model prices count as
$0 (40 calls recorded $0); a failed stream loses billed usage; settings are per
notebook while the key is global, so N notebooks give N× the cap. **Fix:** an
app-level ledger tied to the key, reserve worst-case cost before each call,
serialize paid runs, refuse or confirm unknown prices, record partial usage.
**B-12** Stop doesn't abort an in-flight call (10 min body timeout); the scope
filter runs after a 500-hit search cap, so narrow scopes get false "not found".

### 4.9 Platform and delivery

**B-8** `home_dir()` falls back to `"."` when `HOME` is unset (the Windows
norm), so Windows data lands in the working directory; use the OS home or
Tauri's path API (as Android now does).

**X-1 No CI.** There is no `.github/` (or other) pipeline: 344 Rust tests,
~400 browser and ~400 real-app journey assertions, `tsc`, parity checks and
dependency audits only run by hand. (`npm audit --omit=dev`: 0 known
vulnerabilities today; no `cargo audit` installed.) **Fix:** CI running
`cargo test`, `tsc`, `vite build`, the browser journeys headless, and
`cargo audit`/`npm audit`; nightly real-app journeys on a Linux runner with
Xvfb (the desktop-check skill already scripts it).

**U-9 The mock backend** (1,900 lines) re-implements backend semantics,
synchronously (so optimistic races never happen in browser tests), returns live
mutable objects, and its "generated" argument tables have no generator.
**Fix:** generate TS bindings and types from Rust (`tauri-specta`), add async
latency and copy-on-return to the mock, run parity in CI; long term run the
real core as WASM + SQLite-WASM in browser mode.

## 5. Target architecture

The fixes above converge on five structural changes. None requires a rewrite;
each can land incrementally behind the existing interfaces.

1. **A core service layer ("host API").** Typed services (outline, pages and
   links, trash, notebooks/session, import, sync, AI) that carry the actor,
   capabilities, notebook session and read-only state, own every invariant
   (positions, title keys, link derivation) and transaction, and return typed
   errors (`code` + message). Tauri commands, the CLI, AI tools and future Wasm
   plugin host functions become thin adapters. Prerequisite for plugins
   (PRD-plugin-architecture) and fixes B-7, B-10, B-11, C-8, C-10, C-13.
   `ai/tools.rs` (`NoteTools` + `ResolvedScope`) is the template.
2. **An explicit connection model.** One writer connection with
   `BEGIN IMMEDIATE`, a small read-only pool, async commands, interruptible long
   operations, no file I/O under the DB lock, and a `minotes_core::session` that
   both app and CLI use to resolve, lock and open notebooks (B-4, B-11, B-13,
   C-3, F-9, F-15).
3. **One markdown codec and one import pipeline.** Every way a file enters the
   DB (enable, pull, outside edit, drop-in, import) goes through validate → parse
   → reconcile → removal sink, with block properties, untrusted-input rules
   (no symlinks, size/encoding/conflict-marker policy) and round-trip property
   tests (F-1–F-8, F-13).
4. **Bounded history.** One undo model (page-scoped, recorded at the service
   layer, atomic per action), a capped and compacted event log, and GC that only
   respects history the user can still reach (C-1, C-2, U-4, U-5).
5. **A frontend lifecycle layer.** A small typed store for notebook key, active
   page and navigation token, a typed event emitter, one transition function
   (flush → backend action → reset caches → refresh), generated IPC bindings,
   and test hooks only in e2e builds (U-1–U-3, U-8–U-11).

## 6. Strengths to keep

- `Database::tx` savepoints with rollback-on-drop and fault-injection tests that
  prove atomicity; cycle-safe tree walks everywhere; outline order documented
  and tested.
- The mirror recognises its own writes by hash, never by mtime; deletions are
  conservative (Trash, mass-delete guard, held deletions, `.minotes-trash`).
- Notebook zip import validates every entry before writing, counts real bytes
  against lying headers, verifies attachment hashes and never writes into an
  existing folder.
- Strong production CSP (no `unsafe-eval`, no inline scripts, `frame-src
  'none'`); link previews resolve DNS through an SSRF-safe resolver with
  re-validated redirects and size/time caps; the webview never chooses where
  files are written.
- AI: read-only, scope-filtered tools; citations validated against the scope;
  answers rendered as text; the key never reaches the webview; a deterministic
  mock provider with recorded streams.
- The editor's static-render / single-live-editor design and its disciplined
  save semantics; optimistic Enter with temp ids and serialized structural ops.
- Verification tooling (desktop-check: real-app journeys, parity, silent
  errors, dead ends, scale, visual diff), which is ready to be automated (X-1).

## 7. Open questions

1. Is git sync with a **shared** remote (team or family repo) a supported use?
   Two different threat cases, both now fixed:
   - **Shared remote** (anyone with push access): git transfers only the tree, so
     the risk is content — symlinks and paths in commits (F-4, F-5). Git never
     transfers `.git/hooks` or `.git/config`, so a remote cannot plant hooks.
   - **Shared or copied folder** (a notebook folder from another computer, a
     shared drive, a zip of the folder): its `notes/.git/` carries someone else's
     hooks and repo-local config (F-6). That is why such a folder now asks once
     before it syncs, and why hooks/fsmonitor are disabled on every git run.
   Whether a shared remote is a *supported* use (permissions, review of others'
   pushes) is still a product decision; it is no longer a security blocker.
2. Keep the backend event log as the future undo/history source (then design it
   properly) or reduce it to what sync needs (then delete `undo_last`)?
3. Remote images: off by default for imported/synced content only, or for all
   notes?
4. CI provider and budget for nightly real-app journeys (needs a Linux runner
   with Xvfb; ~25 min per run).
