# PRD: Git Sync

Status: 90% built · Revised 2026-10-10 · Owner: Chris Klaus

> **What changed in this revision.** The spec now describes what was built and
> verified in code, not the March plan. (1) **Conflict policy replaced:**
> "most recent wins, old version in git history" is gone; both versions are kept,
> the other device's as a separate "(conflict from <device>)" page. That is safer
> and is what ships. (2) Multi-graph sync, stable block ids in the files, folder
> identity, whiteboard sidecars and the mass-delete guard were all built, so they
> are no longer listed as non-goals or future work. (3) Sync is repositioned on
> top of the **markdown mirror** from `PRD-notebooks.md`. Once that ships, the
> mirror does the export and sync only runs git. (4) Encrypted notebooks follow
> `PRD-encryption.md` §4.5. (5) The remaining work is re-prioritised (§6), plus a
> new "Where AI helps" section (§7). Implementation code sketches were removed;
> the code is the reference.

## 1. Overview

Git sync moves a notebook between devices through any git remote (GitHub, GitLab,
Gitea, SSH, a bare repo on a NAS). Each notebook's content is written as plain
markdown files in a git working directory. MiNotes commits, pulls with rebase,
pushes and imports what came in. The result is offline-first sync, full version
history and data in an open format, with no MiNotes server.

MiNotes runs the **system `git` binary**, not libgit2. It picks up the user's SSH
keys, agent, credential helpers and `.gitconfig`, stores no credentials, and the
user can run the same commands by hand to debug.

## 2. Goals / non-goals

Goals
1. One toggle per notebook; after that, sync is automatic.
2. Works with any git remote; without a remote, it still commits locally (history).
3. Readable markdown on disk, compatible with Obsidian and other markdown tools.
4. **Never lose an edit.** A conflict keeps both versions, a deletion goes to trash,
   and a suspicious mass deletion is refused.
5. Never block typing. Network I/O runs without the database lock.

Non-goals
- Real-time collaboration, or several people writing one notebook at once.
- A proprietary protocol or server.
- Silent automatic merging of conflicting edits to the same block, by code or by AI.
- Selective (per-folder) sync. Notebooks are the unit of separation (see §6, Cut).
- Mobile sync in this PRD. It needs a git-less transport and is owned by the mobile work.

## 3. How it works (as built)

### 3.1 Sync cycle

`sync_manager::sync_cycle_in_dir` serialises cycles in-process and runs three
phases. The database lock is held only in phases 1 and 3.

1. **Export + commit** (DB lock). `export_markdown_synced` writes changed pages,
   folder markers and whiteboard sidecars. It moves stale files into
   `.minotes-trash/` (gitignored), then `git add -A` and commit
   (`sync: <hostname> @ <rfc3339>`). The export time is recorded.
2. **Pull + push** (no lock). `pull --rebase`. On conflict, the auto-resolver runs
   (§3.3). Then push. If the push is rejected because the remote moved, it pulls,
   resolves and pushes **once** more. MiNotes never force-pushes.
3. **Import** (DB lock) **only if HEAD moved** past the last imported commit, which
   is stored in `.git/minotes-sync-state.json`. Pages edited locally after phase 1's
   export are protected, so they are re-exported next cycle and never overwritten.
   Pages or folders whose file or `.minotes-folder.json` the pull deleted are moved
   to **trash**. If the import fails partway, the commit is not marked imported and
   the next cycle retries.

Robustness built in: a stale rebase is aborted at the start of every cycle. Every
git call has a 120 s watchdog and never prompts (`GIT_TERMINAL_PROMPT=0`, no
editor). Stalled HTTP transfers are aborted. Paths are NUL-separated, so non-ASCII
names are safe. Tauri commands are async and check that the active notebook is still
the one being synced, so switching notebooks mid-sync aborts instead of importing
into the wrong notebook.

### 3.2 Files on disk

```
~/MiNotes_Sync[-<name>]/           # one repo per notebook; "default" keeps ~/MiNotes_Sync
├── .gitignore                     # .minotes-trash/, export manifest, OS junk
├── Getting Started.md
├── Project Alpha/
│   ├── .minotes-folder.json       # {id, name, parent}: renames/deletes propagate
│   └── Design Doc.md
├── 2026-10-10.md                  # journals: ordinary pages, `type: journal` + `date`
├── .minotes-whiteboards/<id>.json # whiteboard sidecars
└── .minotes-trash/                # pruned files (local only)
```

Page file:

```markdown
---
id: 019587a3-7e4f-7000-8000-abcdef123456
title: "Design Doc"
status: draft                      # page properties as frontmatter keys
---

- First block <!-- id:0195… -->
  - Child block <!-- id:0195… -->
```

- **Block ids are stored** as trailing `<!-- id:… -->` comments. Import reconciles
  by id (`reconcile_page_blocks`), so references, cards and properties survive a
  round trip. This replaces the old "match by position + content hash" plan.
- File and folder names are derived deterministically and are unique
  case-insensitively, with ties broken by id, so every device picks the same name.
  The frontmatter title wins over the (lossy) filename.
- Journals are **not** in a `Journals/` subfolder (see §6, Cut).

### 3.3 Conflicts: keep both

| Situation | Result | User sees |
|---|---|---|
| Different pages, or different parts of one page | git merges | nothing |
| Same lines of one page changed on both devices | Local version stays. The other device's version becomes a **separate page** `"<title> (conflict from <device>)"` with a fresh page id and fresh block ids, file `<name>.conflict-<host>.md` | Toast: both versions kept, compare and merge or delete the copy |
| Deleted on one device, edited on the other | The edit survives (as the page or as the conflict copy) | toast if a copy was made |
| Upstream deletes > 20 pages or > 50% of the notebook in one pass | **Refused** by the mass-delete guard | nothing today (gap, §6 P0) |
| Same whiteboard changed on both devices | Newer `updated_at` wins (sidecar) | nothing (known limitation) |
| Same-named folder created on both devices | Converges to one folder | nothing |

The resolver handles multi-step rebases (bounded to 50 steps). It refuses to
commit leftover conflict markers and aborts the rebase cleanly instead of leaving
the repo half-rebased.

### 3.4 Triggers

A full cycle runs at app open, on app focus (`visibilitychange`), and 30 s after
the last save. There is no polling. A cycle that is already running is not
duplicated.

### 3.5 Relationship to the notebooks mirror (target design)

`PRD-notebooks.md` Phase 2 makes the markdown mirror continuous and independent
of sync. When it ships:

- **Sync stops owning the export.** Phase 1 of the cycle becomes "flush the
  mirror, then commit". Git sync is "the mirror folder is also a git repo".
- Sync dir = the mirror folder. Legacy notebooks keep `~/MiNotes_Sync[-<name>]`.
  Notebooks in a chosen folder use `<notebook>/notes/`. "Move notebook to a
  folder…" carries `.git` along.
- Outside edits (notebooks Phase 4) and pulled changes go through the **same**
  id-preserving import and the same "(… copy)" policy. There must be one import
  path, not two.
- The mirror's 2 s debounce is independent of sync's 30 s debounce. Sync commits
  whatever the mirror has written.

### 3.6 Encrypted notebooks

Per `PRD-encryption.md` §4.5: until the encrypted mirror exists, **sync is off**
for encrypted notebooks (the toggle is disabled with an explanation). After that,
git moves the encrypted per-page files (opaque names). Ciphertext cannot be
three-way merged, so a conflict becomes "newer file wins per page, and the other
version becomes a conflict-copy page after decryption", the same keep-both rule.
Commit messages must never contain content (they don't today). The remote learns
only file count, sizes and timing.

## 4. Feature status

| Feature | Status | Where |
|---|---|---|
| Git via system binary, watchdog, no prompts, error classification | Done | `core/src/git_cmd.rs` |
| Three-phase cycle, DB lock never held across network I/O | Done | `core/src/sync_manager.rs` |
| Import only when HEAD moved; retry on partial import | Done | `sync_manager.rs` (`pending_import`, `apply_import`) |
| Local edits during the network phase protected | Done | `sync_manager.rs`, `repo/sync.rs` (`protect_modified_after`) |
| Frontmatter (id, title, journal type/date, properties) | Done | `core/src/repo/export.rs` (`render_page_markdown`) |
| Stable block ids in files, id-preserving reconcile | Done | `repo/export.rs`, `repo/sync.rs` |
| Stale-file pruning to `.minotes-trash/` | Done | `repo/export.rs` (`prune_stale_files`) |
| Folder identity files, rename/delete propagate | Done | `repo/export.rs` (`FOLDER_MARKER`), `sync_manager.rs` |
| Whiteboard sidecars, newer wins | Done | `repo/export.rs` (`export_whiteboards`), `repo/sync.rs` |
| Conflict copies as separate pages (fresh ids) | Done | `git_cmd.rs` (`auto_resolve_conflicts`), `repo/sync.rs` (`rewrite_as_conflict_copy`) |
| Upstream deletions → trash; mass-delete guard | Done in core, **not surfaced** | `repo/sync.rs` (`deletion_allowed`) |
| Per-notebook sync dirs and config | Done | `sync_manager.rs` (`sync_dir_for_notebook`) |
| Tauri commands (async, notebook-switch safe) | Done | `minotes-app/src-tauri/src/lib.rs` (`git_sync*`) |
| Triggers: open, focus, 30 s after save | Done | `minotes-app/src/App.tsx` (`triggerSync`) |
| Settings toggle, remote/branch (advanced), last sync, error + retry | Done | `components/SettingsPanel.tsx` |
| Status-bar indicator (synced / syncing / error) | Done | `App.tsx` → status bar |
| "Offline" state | Partial: state exists, never set | `App.tsx` |
| Conflict toast | Done | `App.tsx` |
| Conflict review (list, compare, resolve) | Not started | n/a |
| Add a remote from the app | Not started (terminal only) | n/a |
| Git sync from the CLI | Not started (only `sync-dir`, no git) | `minotes-cli/src/commands/sync.rs` |
| Sync on top of the notebooks mirror | Not started (blocked on notebooks Phase 2) | n/a |
| Encrypted-notebook sync | Not started (blocked on encryption step 5) | n/a |
| Version history UI | Not started | n/a |
| Tests: two-device conflict, rename+edit, whiteboards, folders, deletion, edit-during-network | Done (~48 core tests) | `sync_manager.rs`, `git_cmd.rs`, `repo/sync.rs` |

## 5. UX (as built, plus near-term changes)

- **Settings → Sync & Backup**: "Enable Sync" toggle, hidden when git is missing.
  Last-sync time. "Show advanced" lists remote and branch. On failure: reason and
  Retry.
- **Status bar**: `☁ Synced 2m ago` · `☁ Syncing…` · `✗ Sync failed` (hover for detail).
- **Conflict toast**: "Sync conflict in N page(s): both versions were kept… titled
  '… (conflict from <device>)'. Compare them and merge or delete the copy."
- Remote setup today: `cd ~/MiNotes_Sync && git remote add origin <url>`. This is
  the biggest onboarding hurdle. See §6 P1.

## 6. Remaining work, re-prioritised

**P0: correctness and trust (small)**
1. **Surface the mass-delete guard.** Today it logs to stderr. The other device's
   deletion is then silently undone by the next export. Show a notice: "Another
   device deleted 34 pages. [Review] [Move to trash] [Keep them]". "Move to
   trash" re-runs the import with `force_delete`. Also surface every import error
   in `GitSyncResult` (today `success` reflects git only).
2. **Conflict review.** A "Sync conflicts" list (from the conflict-copy pages),
   a side-by-side block diff of original vs copy, and actions: keep mine (copy →
   trash), keep theirs (swap content, copy → trash), keep both, or merge by
   hand-picking blocks. All are deterministic and undoable. Without this, copies
   accumulate and get forgotten.
3. Set the **offline** state from classified network errors (grey, not red).

**P1: reach**
4. **Add a remote from Settings**: paste a URL, MiNotes runs `git remote add` +
   first push, then shows a "test connection" result. Link to SSH-key help.
5. **CLI**: `minotes sync git [--enable|--disable|--status]` on top of
   `full_sync_with`. Same three phases, exit codes for cron and headless servers.
   Cheap, because the core already does everything.
6. **Move onto the notebooks mirror** (§3.5) when notebooks Phase 2 lands. This is
   mostly deleting sync's own export call and unifying the import path with
   outside-edit import.

**P2: value**
7. **Version history per page**: `git log --follow` on the page file, preview a
   past version, "Restore" as an ordinary undoable edit. Turns "it's in git
   history" into something users can use.
8. **Encrypted-notebook sync** once the encrypted mirror ships (§3.6).
9. Carry the **plugin enablement set and settings** in the repo, re-fetching
   packages by hash (required by `PRD-plugin-architecture.md` §7).

**Cut / deferred**
- `Journals/` subfolder for Obsidian daily-notes compatibility. Cut: it would
  move every journal file in existing repos for a cosmetic gain. Obsidian users
  can point their daily-notes folder at the repo root.
- Block-level three-way merge in code. Cut: keep-both plus the conflict review
  (and the optional AI proposal in §7) covers the real cases with less risk.
- Selective per-folder sync. Cut: use a separate notebook.
- Git LFS. Deferred to the attachments work in `PRD-import.md` §5 (large-file
  warning first).
- Mobile via GitHub/GitLab REST. Deferred to the mobile PRD.
- **Not a plugin extension point.** Plugins have no filesystem or process access
  by design, so a "sync transport" plugin would need a new privileged API for
  marginal gain. Alternative transports (WebDAV, S3) stay first-party if they
  ever happen.

## 7. Where AI helps

All AI features run through **the AI platform (`PRD-ai-assistant.md`)**. They are
off by default, use only the provider the user configured (a cloud model with
their own key, or a local model), and send nothing off the device unless the user
chose that provider. Every result is previewed and applied as an ordinary undoable
edit. All are disabled for encrypted notebooks unless the provider is local.

| Idea | Why an LLM beats code | User value | Privacy | Priority |
|---|---|---|---|---|
| **Propose a merge for a conflict pair** (inside the P0 conflict review) | When both devices rewrote the same block differently, a line diff only shows two walls of text. A model can combine the intent of both ("added the date from A, the new owner from B"). | Turns the most annoying sync moment into one click: review, accept or edit. | Sends only the two conflicting versions of that page. Nothing is applied until the user accepts. The copy is trashed only on accept. | P2 (after the deterministic review ships) |
| **Explain a conflict** in one or two sentences ("Laptop changed the deadline; desktop deleted the paragraph") | Summarising semantic difference in prose is a language task. | Faster decision in the review screen. | Same as above, same call. | P2, bundled with the merge proposal |
| **"What changed" summary in version history** (on demand, for one page version) | Turning a diff into a readable summary is a language task. | Find the right version to restore without reading diffs. | Computed locally on request. Never stored, never pushed. | P3 |

Rejected:
- **AI commit messages.** Sync commits every ~30 s and nobody reads them. A
  content summary in the message would push note content in plaintext to the
  remote (this breaks the "no page titles in commits" rule and the encrypted-
  notebook guarantee). It would also cost a model call per sync.
- **Any automatic AI merge.** Merges must be exact and user-confirmed. The model
  only proposes.
- **AI-chosen conflict winner.** Keep-both is already correct and needs no judgement.

## 8. Security

| Concern | Mitigation |
|---|---|
| Credentials | None stored. Delegated to system git. Prompts disabled. |
| Content in commit metadata | Messages are `sync: <host> @ <time>`, never titles or content. |
| History rewrite | Never force-pushes. Conflicts resolved by keeping both. |
| Plaintext on the remote | User's choice of remote. Encrypted notebooks sync only encrypted files (§3.6). Converting a notebook to encrypted warns that old commits still hold plaintext. |
| Hung git (auth prompt, dead network) | 120 s watchdog, low-speed abort, no TTY. |

## 9. Open questions

1. Should the conflict review offer "always keep this device's version for this
   page" (a per-page pin), or is that a footgun?
2. When the mass-delete guard trips, which is the default: keep the pages
   (today's de facto behaviour) or ask every time?
3. Whiteboards: keep newer-wins, or keep both boards as a conflict copy like pages?
4. Should Settings expose a sync interval for users who want periodic pulls while
   the app is focused but idle?
5. Version history: git-backed only (needs sync enabled), or also from the local
   undo/event log for notebooks without sync?
