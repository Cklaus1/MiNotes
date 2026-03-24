# MiNotes Git Sync PRD

## Overview

Git-based sync for MiNotes that uses a standard Git repository as the sync transport between devices. Each device pushes and pulls markdown files to/from a shared Git remote (GitHub, GitLab, self-hosted, or any bare repo). This gives users version history, conflict visibility, offline-first sync, and full ownership of their data — no proprietary sync service required.

## Problem Statement

MiNotes is local-first — data lives in a SQLite database on your machine. Users need a way to:

1. Access their notes on multiple devices (laptop, desktop, work machine)
2. Have automatic version history without manual snapshots
3. Recover from mistakes (deleted pages, bad edits)
4. Own their data in an open format (plain markdown files, not opaque blobs)
5. Optionally share specific folders with collaborators

Today, MiNotes has two incomplete sync primitives:
- **`sync_dir`**: Bidirectional filesystem ↔ database sync (import/export markdown files)
- **`crdt.rs`**: Snapshot-based version history with peer sync stubs

Neither is connected to Git. The `sync_dir` feature syncs to a local folder but doesn't push/pull. The CRDT module tracks versions but has no transport layer.

**Git Sync bridges this gap** — it connects `sync_dir` to a Git remote, giving users real sync with history.

## Goals

1. One-click sync: push local changes, pull remote changes, resolve conflicts
2. Works with any Git remote (GitHub, GitLab, Gitea, bare SSH, local path)
3. Markdown files on disk — readable, grep-able, portable
4. Automatic version history via Git commits
5. Conflict detection with user-friendly resolution
6. Works offline — sync when connectivity is available
7. Compatible with Obsidian Git plugin users (same folder structure)
8. Integrates with encrypted folders (encrypted content syncs as ciphertext)

## Non-Goals

- Real-time collaborative editing (Google Docs style)
- Proprietary sync protocol or server
- Binary attachment sync optimization (Git LFS — future enhancement)
- Three-way merge at block level (use page-level merge for v1)
- Mobile sync (Git on mobile is complex — future via cloud relay)

## How It Works

### Architecture

```
┌──────────────────────────────────────────────┐
│                  MiNotes App                  │
│                                               │
│  SQLite DB ◄──► sync_dir ◄──► Git Working Dir │
│                                               │
│                    │                          │
│              git add/commit                   │
│              git pull --rebase                │
│              git push                         │
│                    │                          │
│              ┌─────▼─────┐                    │
│              │ Git Remote │                    │
│              │ (GitHub,   │                    │
│              │  GitLab,   │                    │
│              │  SSH, etc) │                    │
│              └────────────┘                    │
└──────────────────────────────────────────────┘
```

### Sync Cycle

Every sync operation follows this sequence:

```
1. DB → Filesystem    (export changed pages as .md files)
2. git add -A         (stage all changes)
3. git commit         (auto-commit with timestamp message)
4. git pull --rebase  (fetch remote changes, rebase local on top)
5. Handle conflicts   (if any — see Conflict Resolution)
6. git push           (push to remote)
7. Filesystem → DB    (import any new/changed files from remote)
```

### Folder Structure on Disk

```
~/.minotes/sync/default/
├── .git/
├── .minotes-sync.json          ← Sync metadata (device ID, last sync)
├── Getting Started.md
├── Research Notes.md
├── Project Alpha/              ← Folder = subdirectory
│   ├── Design Doc.md
│   └── Sprint Notes.md
├── Private Journal/            ← Encrypted folder
│   ├── .encrypted              ← Marker file (signals encrypted folder)
│   ├── 2026-03-24.md.enc      ← Encrypted page content
│   └── 2026-03-25.md.enc
└── Journals/
    ├── 2026-03-22.md
    ├── 2026-03-23.md
    └── 2026-03-24.md
```

### Markdown File Format

Each page becomes a markdown file with YAML frontmatter:

```markdown
---
id: 019587a3-7e4f-7000-8000-abcdef123456
title: Design Doc
created: 2026-03-15T10:30:00Z
updated: 2026-03-24T14:22:00Z
icon: 📐
tags: [design, architecture]
aliases: [Design Document, Arch Doc]
---

# Design Doc

First block content here.

- Nested block as list item
  - Child block indented
  - Another child

> A blockquote block

- [ ] A todo item
- [x] A completed todo
```

**Block mapping rules:**
- Each top-level block = one paragraph or list item
- Nested blocks (children) = indented list items under parent
- Block properties stored as inline `key:: value` (Logseq-compatible)
- Block IDs not stored in markdown (matched by position + content hash on import)

### Journals

Journal pages export to a `Journals/` subdirectory with date-based filenames:

```
Journals/2026-03-24.md
```

This matches Obsidian's daily notes convention, enabling cross-compatibility.

## Conflict Resolution

### When Conflicts Happen

Conflicts occur when:
- Two devices edit the same page between syncs
- A page is deleted on one device and edited on another
- A folder is renamed on one device and pages added on another

### Resolution Strategy

**v1: Page-level, user-assisted**

```
┌─────────────────────────────────────────────┐
│  ⚠ Conflict: "Design Doc.md"               │
│                                              │
│  Your version and the remote version both    │
│  changed since the last sync.                │
│                                              │
│  ┌─────────────┐  ┌─────────────┐           │
│  │ Your Version│  │Remote Version│           │
│  │             │  │              │           │
│  │ Block 1     │  │ Block 1 mod │           │
│  │ Block 2 new │  │ Block 2     │           │
│  │ Block 3     │  │ Block 3 del │           │
│  └─────────────┘  └─────────────┘           │
│                                              │
│  [Keep Mine] [Keep Theirs] [Keep Both] [Open │
│                                     Editor]  │
└─────────────────────────────────────────────┘
```

**Options:**
- **Keep Mine**: Force-overwrite remote with local version
- **Keep Theirs**: Accept remote version, discard local changes
- **Keep Both**: Save local as `Design Doc (conflict 2026-03-24).md`, keep remote as `Design Doc.md`
- **Open Editor**: Open a diff view showing both versions side-by-side for manual merge

**Auto-resolution (no conflict UI needed):**
- Same content on both sides → no conflict
- Only one side changed → take the changed version
- Non-overlapping changes (different pages) → both applied automatically
- Page created on both devices with same title → rename one with `(device-name)` suffix

### Future: Block-Level Merge (v2)

Block-level three-way merge using the common ancestor from Git history:
- Parse both versions and ancestor into block trees
- Match blocks by content hash + position
- Merge non-conflicting block changes automatically
- Only prompt user for true block-level conflicts (same block edited differently)

## Configuration

### Setup Flow

```
┌────────────────────────────────────────────┐
│  📁 Set Up Git Sync                        │
│                                             │
│  Sync your notes to a Git repository.       │
│  Works with GitHub, GitLab, or any remote.  │
│                                             │
│  Remote URL:                                │
│  [git@github.com:user/my-notes.git    ]    │
│                                             │
│  ─── or ───                                 │
│                                             │
│  [Create new repo on GitHub]                │
│  [Use existing local folder]                │
│                                             │
│  Sync directory:                            │
│  [~/.minotes/sync/default            ] [📁] │
│                                             │
│  Branch: [main                        ]     │
│                                             │
│  Sync frequency:                            │
│  (•) Manual only                            │
│  ( ) Every 5 minutes                        │
│  ( ) Every 15 minutes                       │
│  ( ) Every hour                             │
│                                             │
│  Author name:  [Chris                  ]    │
│  Author email: [chris@example.com      ]    │
│                                             │
│  [Cancel]                     [Set Up Sync] │
└────────────────────────────────────────────┘
```

### Settings Storage

```json
{
  "git_sync": {
    "enabled": true,
    "remote_url": "git@github.com:user/my-notes.git",
    "sync_dir": "~/.minotes/sync/default",
    "branch": "main",
    "auto_sync_interval_minutes": 0,
    "author_name": "Chris",
    "author_email": "chris@example.com",
    "device_id": "macbook-pro-2024",
    "last_sync": "2026-03-24T14:22:00Z",
    "sync_journals": true,
    "sync_encrypted_folders": true,
    "commit_message_format": "sync: {device} @ {timestamp}"
  }
}
```

### .minotes-sync.json (in Git repo)

```json
{
  "version": 1,
  "devices": {
    "macbook-pro-2024": {
      "last_sync": "2026-03-24T14:22:00Z",
      "minotes_version": "0.1.0"
    },
    "work-desktop": {
      "last_sync": "2026-03-24T12:00:00Z",
      "minotes_version": "0.1.0"
    }
  }
}
```

## Selective Sync

Not every folder needs to sync. Users can configure per-folder sync:

| Folder | Sync Setting | Behavior |
|--------|-------------|----------|
| Project Alpha | Sync | Pushed to remote, pulled from remote |
| Private Journal | Sync (encrypted) | Pushed as `.enc` files, encrypted at rest |
| Work Notes | Don't sync | Stays local only |
| Journals | Sync | Pushed to `Journals/` directory |

**UI**: Right-click folder → "Sync Settings" → toggle sync on/off

## Git Authentication

### Supported Methods

1. **SSH key** (recommended) — uses `~/.ssh/id_ed25519` or `~/.ssh/id_rsa`
2. **HTTPS + credential helper** — uses system git credential manager
3. **HTTPS + personal access token** — stored in MiNotes settings (encrypted)
4. **Local path** — no auth needed (`/mnt/nas/notes-repo`)

### WSL Considerations

- SSH keys: use Linux `~/.ssh/` keys (not Windows `C:\Users\...\.ssh\`)
- Git credential manager: can bridge to Windows credential manager via `git credential-manager`
- Default: prompt user to set up SSH key if none found

## API / Tauri Commands

### New Commands

```rust
#[tauri::command]
fn setup_git_sync(config: GitSyncConfig) -> Result<(), String>
// Initialize sync dir, git init, git remote add, initial export + commit + push

#[tauri::command]
fn git_sync() -> Result<GitSyncResult, String>
// Full sync cycle: export → commit → pull → resolve → push → import

#[tauri::command]
fn git_sync_status() -> Result<GitSyncStatus, String>
// Check for uncommitted changes, unpushed commits, remote ahead

#[tauri::command]
fn git_sync_pull() -> Result<GitSyncResult, String>
// Pull-only: fetch + rebase + import (no push)

#[tauri::command]
fn git_sync_push() -> Result<GitSyncResult, String>
// Push-only: export + commit + push (no pull)

#[tauri::command]
fn git_sync_history(limit: Option<i32>) -> Result<Vec<GitCommitInfo>, String>
// Git log — show recent sync commits

#[tauri::command]
fn git_sync_diff() -> Result<Vec<GitFileDiff>, String>
// Show what would be committed (git diff --staged + untracked)

#[tauri::command]
fn git_sync_resolve_conflict(file: String, resolution: ConflictResolution) -> Result<(), String>
// Resolve a specific conflict (keep-mine, keep-theirs, keep-both)

#[tauri::command]
fn git_sync_disable() -> Result<(), String>
// Stop syncing (doesn't delete the git repo)

#[tauri::command]
fn get_git_sync_config() -> Result<Option<GitSyncConfig>, String>
// Return current sync configuration
```

### Data Structures

```rust
#[derive(Serialize, Deserialize)]
struct GitSyncConfig {
    remote_url: String,
    sync_dir: String,
    branch: String,
    auto_sync_interval_minutes: u32,
    author_name: String,
    author_email: String,
    device_id: String,
    sync_journals: bool,
    sync_encrypted_folders: bool,
    commit_message_format: String,
}

#[derive(Serialize)]
struct GitSyncResult {
    success: bool,
    pages_exported: u32,
    pages_imported: u32,
    pages_conflicted: u32,
    conflicts: Vec<GitConflict>,
    commit_hash: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct GitSyncStatus {
    configured: bool,
    remote_url: Option<String>,
    branch: Option<String>,
    last_sync: Option<String>,
    uncommitted_changes: u32,
    unpushed_commits: u32,
    remote_ahead: u32,
    conflicts: Vec<String>,
}

#[derive(Serialize)]
struct GitCommitInfo {
    hash: String,
    short_hash: String,
    message: String,
    author: String,
    timestamp: String,
    files_changed: u32,
}

#[derive(Serialize)]
struct GitConflict {
    file_path: String,
    page_title: String,
    conflict_type: String,  // "both-modified", "delete-modify", "add-add"
    local_content: String,
    remote_content: String,
}

#[derive(Deserialize)]
enum ConflictResolution {
    KeepMine,
    KeepTheirs,
    KeepBoth,
    Manual(String),  // User-edited merged content
}
```

## UX Design

### Sync Button in Sidebar

```
┌──────────────────┐
│ ☁ Sync           │  ← Always visible in stats bar
│   Last: 2m ago   │
│   2 pending      │
└──────────────────┘
```

States:
- **Not configured**: `☁ Set up Sync` (links to setup)
- **Synced**: `☁ Synced` with last sync time
- **Pending changes**: `☁ 3 pending` with count
- **Syncing**: `☁ Syncing...` with spinner
- **Conflict**: `⚠ 1 conflict` in warning color
- **Error**: `✗ Sync failed` with error detail on hover
- **Offline**: `☁ Offline` (grayed out)

### Sync Panel (Ctrl+Shift+S)

```
┌──────────────────────────────────────────┐
│  ☁ Git Sync                              │
│                                           │
│  Remote: github.com:user/my-notes.git     │
│  Branch: main                             │
│  Last sync: 2026-03-24 14:22              │
│  Device: macbook-pro-2024                 │
│                                           │
│  Status: 3 pages changed locally          │
│          1 new commit on remote           │
│                                           │
│  [↕ Sync Now]  [↓ Pull]  [↑ Push]        │
│                                           │
│  ── Recent Syncs ──                       │
│  8bc9edd  sync: macbook @ 14:22   3 files │
│  a172466  sync: desktop @ 12:00   1 file  │
│  527b0d8  sync: macbook @ 09:15   5 files │
│                                           │
│  ── Pending Changes ──                    │
│  M  Project Alpha/Design Doc.md           │
│  A  Research Notes.md                     │
│  D  Old Page.md                           │
│                                           │
│  [Settings]              [View on GitHub] │
└──────────────────────────────────────────┘
```

### Conflict Resolution Panel

```
┌──────────────────────────────────────────────┐
│  ⚠ Sync Conflict: Design Doc.md             │
│                                               │
│  Both you and another device edited this      │
│  page since the last sync.                    │
│                                               │
│  ┌─ Your version ──────┐┌─ Remote version ──┐│
│  │ # Design Doc        ││ # Design Doc      ││
│  │                     ││                    ││
│  │ Updated intro       ││ New intro text     ││
│  │ paragraph here.     ││ from other device. ││
│  │                     ││                    ││
│  │ ## Architecture     ││ ## Architecture    ││
│  │ Same content...     ││ Same content...    ││
│  │                     ││ + New section      ││
│  └─────────────────────┘└────────────────────┘│
│                                               │
│  [Keep Mine] [Keep Theirs] [Keep Both] [Edit] │
└──────────────────────────────────────────────┘
```

### Auto-Sync Indicator

When auto-sync is enabled, a subtle indicator shows in the bottom bar:

```
5 pages · 42 blocks · 12 links    ☁ Auto-sync: 5m    Graph  ⚙
```

## Obsidian Compatibility

MiNotes Git Sync is designed to be compatible with Obsidian Git plugin users:

| Feature | MiNotes | Obsidian Git | Compatible? |
|---------|---------|-------------|-------------|
| File format | `.md` with YAML frontmatter | `.md` with YAML frontmatter | Yes |
| Folder structure | Subdirectories = folders | Subdirectories = folders | Yes |
| Daily notes | `Journals/2026-03-24.md` | `Daily Notes/2026-03-24.md` | Configurable |
| Wiki links | `[[Page Name]]` in content | `[[Page Name]]` in content | Yes |
| Properties | `key:: value` inline | `key:: value` inline | Yes |
| Frontmatter | Standard YAML | Standard YAML | Yes |
| Attachments | `attachments/` subfolder | User-configurable | Configurable |
| Auto-commit | Timestamp-based messages | Timestamp-based messages | Yes |

**Migration path**: An Obsidian user can point MiNotes at their existing Obsidian vault Git repo and import everything. MiNotes writes back in a compatible format.

## Integration with Encrypted Folders

When an encrypted folder has sync enabled:

1. **Export**: Encrypted content is written as `.md.enc` files (ciphertext, not plaintext markdown)
2. **Marker file**: `.encrypted` file in the folder signals it's encrypted
3. **Git sees**: Opaque binary changes in `.enc` files
4. **Other devices**: Must have the passphrase to decrypt after pulling
5. **Conflict resolution**: Conflicts on encrypted files can only be resolved as keep-mine/keep-theirs (no diff view)

```
Private Journal/
├── .encrypted                    ← Signals encrypted folder
├── .encryption-meta.json         ← Salt, wrapped FEK (needed to unlock on other devices)
├── 2026-03-24.md.enc            ← AES-256-GCM ciphertext
└── 2026-03-25.md.enc
```

## Implementation Plan

### Phase 1: Git Operations Core (Rust)

1. Add `git2` crate (libgit2 bindings) to `minotes-core`
2. Create `git_sync.rs` module:
   - `init_sync_repo(dir, remote_url, branch)` — git init + remote add
   - `clone_sync_repo(remote_url, dir, branch)` — git clone for first-time setup
   - `commit_all(dir, message, author)` — add all + commit
   - `pull_rebase(dir)` — fetch + rebase
   - `push(dir, branch)` — push to remote
   - `get_status(dir)` — uncommitted changes, unpushed, remote ahead
   - `get_log(dir, limit)` — recent commits
   - `get_conflicts(dir)` — list conflicted files
   - `resolve_conflict(dir, file, resolution)` — write resolution, mark resolved
3. Error handling for: no remote, auth failure, network down, conflicts

### Phase 2: Sync Cycle (Rust)

4. Create `sync_manager.rs`:
   - `full_sync(config)` — the complete export → commit → pull → push → import cycle
   - Calls existing `sync_dir` for DB ↔ filesystem
   - Calls new git operations for filesystem ↔ remote
   - Handles conflict detection and tracking
5. Wire up to existing `sync_dir` bidirectional sync
6. Frontmatter generation on export (id, title, created, updated, tags)
7. Frontmatter parsing on import (restore page metadata)
8. Journal file naming convention (`Journals/YYYY-MM-DD.md`)

### Phase 3: Tauri Commands

9. Implement all `git_sync_*` Tauri commands
10. Store `GitSyncConfig` in a JSON file (`~/.minotes/sync-config.json`)
11. Background auto-sync timer (when configured)
12. SSH key detection and validation

### Phase 4: Frontend — Setup & Sync Panel

13. Git Sync setup wizard (remote URL, branch, auth, interval)
14. Sync button in stats bar with status indicator
15. Sync Panel (Ctrl+Shift+S) — status, history, pending changes
16. Manual sync trigger (button click or keyboard shortcut)

### Phase 5: Frontend — Conflict Resolution

17. Conflict detection notification (toast + badge on sync button)
18. Conflict resolution panel with side-by-side diff
19. Keep Mine / Keep Theirs / Keep Both / Manual Edit options
20. Post-resolution: auto-commit + push the resolution

### Phase 6: Auto-Sync & Polish

21. Background auto-sync with configurable interval
22. Debounce: don't sync while user is actively typing (wait 30s after last edit)
23. Offline detection: queue sync, retry when online
24. Sync progress indicator for large repos
25. "View on GitHub" button (open remote URL in browser)

### Phase 7: Encrypted Folder Sync

26. Export encrypted folders as `.md.enc` files
27. Include `.encrypted` marker and `.encryption-meta.json`
28. Import encrypted files: store ciphertext in DB, decrypt only when folder is unlocked
29. Conflict resolution for encrypted files (keep-mine/keep-theirs only)

### Phase 8: Testing

30. Unit tests: git operations (init, commit, push, pull, conflict)
31. Integration tests: full sync cycle with two simulated devices
32. Conflict resolution tests: all four resolution strategies
33. Encrypted folder sync tests
34. User journey tests: setup → sync → conflict → resolve → verify

## Dependencies

### Rust Crates

- `git2` — libgit2 bindings for Git operations (clone, commit, push, pull, status, diff)
- `serde_yaml` — YAML frontmatter parsing/generation
- Existing: `minotes-core` sync_dir module (filesystem ↔ DB sync)

### System Dependencies

- `libgit2` — native library (bundled by `git2` crate with `vendored` feature)
- SSH agent or key file for SSH auth
- Git credential helper for HTTPS auth

### Frontend

- No new npm packages — uses existing Tauri invoke pattern
- Diff view: simple text diff (highlight changed lines), no external lib needed for v1

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Credentials stored on disk | SSH keys managed by OS; PAT stored encrypted in settings |
| Sensitive content in Git history | Encrypted folders sync as ciphertext; unencrypted folders are user's choice |
| Commit messages leak info | Default message is `sync: {device} @ {timestamp}` — no page titles |
| Force push data loss | MiNotes never force pushes; rebase conflicts halt sync |
| Shared repo access | Git repo permissions (read/write) managed by hosting provider |
| Man-in-the-middle | SSH or HTTPS — standard Git transport security |

## Metrics & Monitoring

Track (locally, not phoned home):

- Sync frequency and duration
- Conflict rate (conflicts per sync)
- Pages synced per cycle
- Sync failures and error types
- Time since last successful sync

Displayed in Sync Panel for user visibility.

## Future Enhancements

- **Block-level merge**: Three-way merge at block granularity using common ancestor
- **Selective page sync**: Sync individual pages, not just folders
- **Git LFS**: Large attachment support for images and PDFs
- **Mobile relay**: Cloud service that syncs on behalf of mobile devices (no Git on phone)
- **Shared cursors**: Show which device last edited a page (via commit metadata)
- **Branch workflows**: Feature branches for experimental note reorganization
- **Webhook triggers**: Auto-sync when remote receives a push (GitHub webhook → local pull)
- **Sync dashboard**: Visualize sync activity over time (graph of commits per day)
