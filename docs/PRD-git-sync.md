# MiNotes Git Sync PRD

## Overview

Git-based sync for MiNotes that uses a standard Git repository as the sync transport between devices. Each device pushes and pulls markdown files to/from a shared Git remote (GitHub, GitLab, self-hosted, or any bare repo). This gives users version history, offline-first sync, and full ownership of their data — no proprietary sync service required.

## Problem Statement

MiNotes is local-first — data lives in a SQLite database on your machine. Users need a way to:

1. Access their notes on multiple devices (laptop, desktop, work machine)
2. Have automatic version history without manual snapshots
3. Recover from mistakes (deleted pages, bad edits)
4. Own their data in an open format (plain markdown files, not opaque blobs)

Today, MiNotes has two incomplete sync primitives:
- **`sync_dir`**: Bidirectional filesystem ↔ database sync (import/export markdown files)
- **`crdt.rs`**: Snapshot-based version history with peer sync stubs

Neither is connected to Git. The `sync_dir` feature syncs to a local folder but doesn't push/pull. The CRDT module tracks versions but has no transport layer.

**Git Sync bridges this gap** — it connects `sync_dir` to a Git remote, giving users real sync with history.

## Goals

1. One-toggle sync: enable auto sync, everything else is automatic
2. Works with any Git remote (GitHub, GitLab, Gitea, bare SSH, local path)
3. Markdown files on disk — readable, grep-able, portable
4. Automatic version history via Git commits
5. Works offline — sync when connectivity is available
6. Compatible with Obsidian Git plugin users (same folder structure)

## Non-Goals

- Real-time collaborative editing (Google Docs style)
- Proprietary sync protocol or server
- Binary attachment sync optimization (Git LFS — future enhancement)
- Manual conflict resolution UI — most recent change wins, old version recoverable via git history
- Per-folder selective sync — sync the whole repo, exclude files via `.gitignore`
- Multi-graph sync — v1 syncs the default graph only
- Mobile sync — future, via Git hosting REST API (GitHub/GitLab) instead of git binary

## How It Works

### Git Approach: System Git (not libgit2)

MiNotes calls the system `git` binary via `std::process::Command`. No bundled `git2`/libgit2. This means:

- **Inherits existing credentials** — SSH keys, SSH agent, `~/.ssh/config`, credential helpers, `.gitconfig` — all work automatically
- **Requires git installed** — but anyone doing git-based sync already has it
- **Easier to debug** — users can run the same git commands manually if something goes wrong
- **Zero native dependencies** — no libgit2/OpenSSL build issues

### Architecture

```
┌──────────────────────────────────────────────┐
│                  MiNotes App                  │
│                                               │
│  SQLite DB ◄──► sync_dir ◄──► Git Working Dir │
│                                               │
│                    │                          │
│          std::process::Command                │
│              git add/commit                   │
│              git pull --rebase                │
│              git push                         │
│                    │                          │
│              ┌─────▼─────┐                    │
│              │ Git Remote │                    │
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
5. Auto-resolve       (if conflict — most recent wins)
6. git push           (push to remote)
7. If push fails      (remote updated between pull and push), retry steps 4-6 once
8. Filesystem → DB    (import any new/changed files from remote)
```

### When Auto-Sync Triggers

Every trigger runs a **full sync** (export → commit → pull → push → import):

- **On save** — after 30s of no edits (debounced)
- **On app open** — grab changes from other devices + push any local changes
- **On app focus** — when user alt-tabs back to MiNotes

No polling intervals. Event-driven. If no remote is configured, sync still exports + commits locally.

### Folder Structure on Disk

```
~/MiNotes_Sync/
├── .git/
├── Getting Started.md
├── Research Notes.md
├── Project Alpha/              ← Folder = subdirectory
│   ├── Design Doc.md
│   └── Sprint Notes.md
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

### Auto-Merge Behavior

Most syncs resolve automatically with no user interaction:

| Scenario | What happens | User sees |
|----------|-------------|-----------|
| Different pages edited on different devices | Git auto-merges | Nothing — fully automatic |
| Same page, different sections | Git auto-merges the text | Nothing — fully automatic |
| Same page, same lines | Most recent change wins | Toast: "Conflict resolved — previous version in history" |
| Page deleted on one device, edited on another | Keep the edited version | Nothing — fully automatic |

**In practice, conflicts are rare for a single user on multiple devices** — you'd have to edit the exact same lines of the same page on two devices between syncs.

### Most Recent Wins + Git History

**No conflict UI.** When git cannot auto-merge (same lines edited on both sides):

1. MiNotes accepts the most recent change (by commit timestamp)
2. The "losing" version is preserved in git history — nothing is ever lost
3. A toast notification: *"Sync conflict on 'Design Doc' — resolved with latest version. Previous version available in git history."*

## Configuration

### Auto-Create on Enable

When the user toggles "Enable Sync" on:

1. MiNotes checks if `~/MiNotes_Sync/` exists
2. If not, creates it and runs `git init`
3. Exports the entire DB to markdown files (first sync)
4. Commits with message `sync: {hostname} @ {timestamp}`
5. If a remote is configured, pushes

The user only needs to add a remote to sync across devices:

```bash
cd ~/MiNotes_Sync
git remote add origin git@github.com:user/MiNotes_Sync.git
```

After that, all syncs push/pull automatically. Without a remote, MiNotes still exports to markdown and commits locally — giving version history even without a remote.

### Settings Panel — Sync Toggle

- **Git not installed**: "Sync" option is hidden
- **Git installed**: Shows the toggle

```
┌────────────────────────────────────────────┐
│  ☁ Sync                               │
│                                             │
│  [■] Enable Sync                      │
│                                             │
│  Sync directory: ~/MiNotes_Sync             │
│  Remote: git@github.com:user/MiNotes_Sync   │
│  Branch: main                               │
│                                             │
│  Last synced: 2 minutes ago                 │
└────────────────────────────────────────────┘
```

One toggle. Directory is always `~/MiNotes_Sync`. Remote and branch are read-only labels detected from the git repo (remote shows "not configured" if none set).

### Settings Storage

```json
{
  "git_sync": {
    "enabled": true,
    "last_sync": "2026-03-24T14:22:00Z"
  }
}
```

Sync dir is always `~/MiNotes_Sync`. Everything else (remote, branch, author) is read from the git repo.

## Git Authentication

All authentication is inherited from the user's existing git setup. MiNotes does not manage or store any credentials.

- **SSH key** (recommended) — uses `~/.ssh/id_ed25519`, `~/.ssh/id_rsa`, or SSH agent
- **HTTPS + credential helper** — uses system git credential manager
- **Local path** — no auth needed (`/mnt/nas/notes-repo`, bare repos)

If git auth fails during sync, MiNotes surfaces the git error message in a toast.

## API / Tauri Commands

```rust
#[tauri::command]
fn git_available() -> bool
// Check if git is installed (used by Settings to show/hide toggle)

#[tauri::command]
fn git_sync_enable() -> Result<GitSyncStatus, String>
// Create ~/MiNotes_Sync if needed, git init, initial export + commit + push

#[tauri::command]
fn git_sync_disable() -> Result<(), String>
// Stop syncing (doesn't delete the repo)

#[tauri::command]
fn git_sync() -> Result<GitSyncResult, String>
// Full sync cycle: export → commit → pull (most-recent-wins) → push → import

#[tauri::command]
fn git_sync_status() -> Result<GitSyncStatus, String>
// Current state: enabled, remote, branch, last sync
```

### Data Structures

```rust
#[derive(Serialize)]
struct GitSyncStatus {
    enabled: bool,
    remote_url: Option<String>,   // None if no remote configured
    branch: Option<String>,
    last_sync: Option<String>,
}

#[derive(Serialize)]
struct GitSyncResult {
    success: bool,
    pages_exported: u32,
    pages_imported: u32,
    conflicts_resolved: u32,
    error: Option<String>,
}
```

## UX

### Stats Bar Indicator

When sync is enabled, shows in the bottom bar:

```
5 pages · 42 blocks · 12 links    ☁ Synced 2m ago    Graph  ⚙
```

States:
- **Synced**: `☁ Synced 2m ago`
- **Syncing**: `☁ Syncing...` with spinner
- **Error**: `✗ Sync failed` with error detail on hover
- **Offline**: `☁ Offline` (grayed out)

### Conflict Toast

```
┌──────────────────────────────────────────────┐
│  ☁ Sync conflict on "Design Doc" — resolved  │
│  with latest version. Previous version        │
│  available in git history.                     │
└──────────────────────────────────────────────┘
```

## Obsidian Compatibility

MiNotes Git Sync is compatible with Obsidian Git plugin users:

| Feature | MiNotes | Obsidian Git | Compatible? |
|---------|---------|-------------|-------------|
| File format | `.md` with YAML frontmatter | `.md` with YAML frontmatter | Yes |
| Folder structure | Subdirectories = folders | Subdirectories = folders | Yes |
| Daily notes | `Journals/2026-03-24.md` | `Daily Notes/2026-03-24.md` | Configurable |
| Wiki links | `[[Page Name]]` in content | `[[Page Name]]` in content | Yes |
| Properties | `key:: value` inline | `key:: value` inline | Yes |
| Frontmatter | Standard YAML | Standard YAML | Yes |
| Auto-commit | Timestamp-based messages | Timestamp-based messages | Yes |

An Obsidian user can point MiNotes at their existing Obsidian vault Git repo and import everything.

## Implementation Plan

### Phase 1: Git Operations Core (Rust)

1. Create `git_cmd.rs` — thin wrapper around `std::process::Command` for git:
   - `git_available()` — run `git --version`, return bool
   - `init_repo(dir)` — `git init` if `~/MiNotes_Sync` doesn't exist yet
   - `repo_info(dir)` — read remote URL, branch from existing repo
   - `commit_all(dir, message)` — add all + commit (author from git config, message: `sync: {hostname} @ {timestamp}`)
   - `pull_rebase(dir)` — fetch + rebase
   - `push(dir, branch)` — push to remote, retry pull-rebase-push once on failure
   - `auto_resolve_conflicts(dir)` — on conflict, accept most recent change, continue rebase
   - `has_remote(dir)` — check if a remote is configured (skip push/pull if not)
2. Error handling: parse git stderr for auth failure, network down, merge conflicts

### Phase 2: Sync Cycle (Rust)

3. Create `sync_manager.rs`:
   - `full_sync(config)` — export → commit → pull → auto-resolve → push → import
   - Calls existing `sync_dir` for DB ↔ filesystem
   - Calls `git_cmd` for filesystem ↔ remote
4. Wire up to existing `sync_dir` bidirectional sync
5. Frontmatter generation on export (id, title, created, updated, tags)
6. Frontmatter parsing on import (restore page metadata)
7. Journal file naming convention (`Journals/YYYY-MM-DD.md`)

### Phase 3: Tauri Commands + Auto-Sync

8. Implement `git_available`, `git_sync_enable`, `git_sync_disable`, `git_sync`, `git_sync_status`
9. Store config in `~/.minotes/sync-config.json`
10. Event-driven triggers: sync on save (30s debounce), on app open, on app focus
11. Offline detection: queue sync, retry when online

### Phase 4: Frontend

12. "Sync" toggle in Settings panel (hidden when no git repo detected)
13. Stats bar sync indicator (`☁ Synced 2m ago`)
14. Toast notifications for errors and auto-resolved conflicts

### Phase 5: Testing

15. Unit tests: git operations (commit, push, pull, auto-resolve)
16. Integration tests: full sync cycle with two simulated devices
17. Conflict auto-resolution tests (most recent wins, version preserved in history)
18. User journey tests: enable → sync → conflict → toast

## Dependencies

### Rust

- `serde_yaml` — YAML frontmatter parsing/generation
- Existing: `minotes-core` sync_dir module (filesystem ↔ DB sync)
- No `git2` crate — all git operations via `std::process::Command`

### System

- `git` — must be installed (MiNotes hides sync toggle if missing)
- User's existing SSH keys / credential helpers for authentication

### Frontend

- No new npm packages — uses existing Tauri invoke pattern

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Credentials | MiNotes stores no credentials — delegated entirely to system git |
| Sensitive content in history | User's choice what goes in the repo; use encryption PRD for sensitive folders |
| Commit messages | Default: `sync: {hostname} @ {timestamp}` — no page titles |
| Force push | MiNotes never force pushes |
| Transport security | SSH or HTTPS — standard Git |

## Future Enhancements

- **Version History UI**: Browse and restore past versions of any page via git log
- **Encrypted folder sync**: `.md.enc` files with passphrase-protected content
- **Block-level merge**: Three-way merge at block granularity using common ancestor
- **Git LFS**: Large attachment support for images and PDFs
- **Mobile sync**: Use GitHub/GitLab REST API to commit/pull files directly — no git binary needed on phone
- **Selective sync**: Per-folder sync/don't-sync toggles
- **Multi-graph sync**: Sync multiple graphs (currently v1 syncs the default graph only)
