//! Git Sync manager — orchestrates the full sync cycle.
//! Connects the existing `sync_dir` (DB ↔ filesystem) to git (filesystem ↔ remote).

use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::git_cmd;

/// Fixed sync directory: ~/MiNotes_Sync
pub fn default_sync_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join("MiNotes_Sync")
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = home.join(".minotes");
    std::fs::create_dir_all(&dir).ok();
    dir.join("sync-config.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub enabled: bool,
    pub last_sync: Option<String>,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            last_sync: None,
        }
    }
}

fn read_config() -> SyncConfig {
    let path = config_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(config: &SyncConfig) -> Result<()> {
    let path = config_path();
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, json)
        .map_err(|e| Error::Git(format!("Failed to write sync config: {e}")))?;
    Ok(())
}

// ── Public types returned to frontend ──

#[derive(Debug, Clone, Serialize)]
pub struct GitSyncStatus {
    pub enabled: bool,
    pub remote_url: Option<String>,
    pub branch: Option<String>,
    pub last_sync: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitSyncResult {
    pub success: bool,
    pub pages_exported: u32,
    pub pages_imported: u32,
    pub conflicts_resolved: u32,
    pub error: Option<String>,
}

// ── Public API ──

/// Check if git is available on the system.
pub fn git_available() -> bool {
    git_cmd::git_available()
}

/// Get current sync status by reading config + git repo state.
pub fn get_sync_status() -> Result<GitSyncStatus> {
    let config = read_config();
    let sync_dir = default_sync_dir();

    if !config.enabled || !git_cmd::is_git_repo(&sync_dir) {
        return Ok(GitSyncStatus {
            enabled: config.enabled,
            remote_url: None,
            branch: None,
            last_sync: config.last_sync,
        });
    }

    let remote_url = git_cmd::get_remote_url(&sync_dir)?;
    let branch = git_cmd::get_branch(&sync_dir)?;

    Ok(GitSyncStatus {
        enabled: config.enabled,
        remote_url,
        branch,
        last_sync: config.last_sync,
    })
}

/// Enable git sync: create ~/MiNotes_Sync if needed, git init, initial export + commit.
pub fn enable_sync(db: &Database) -> Result<GitSyncStatus> {
    if !git_cmd::git_available() {
        return Err(Error::Git("Git is not installed".to_string()));
    }

    let sync_dir = default_sync_dir();

    // Create and init repo if needed
    if !git_cmd::is_git_repo(&sync_dir) {
        git_cmd::init_repo(&sync_dir)?;
        // Add .gitignore for OS/editor artifacts
        let gitignore = sync_dir.join(".gitignore");
        if !gitignore.exists() {
            let _ = std::fs::write(&gitignore, ".DS_Store\nThumbs.db\n*.swp\n*~\n");
        }
    }

    // If remote is configured, pull existing content first
    if git_cmd::has_remote(&sync_dir) {
        // Pull remote content (ignore errors — remote might be empty/unreachable)
        let _ = git_cmd::pull_rebase(&sync_dir);
        // Import any pulled files into DB
        let _ = db.sync_dir(&sync_dir, "git-sync", false, false);
    }

    // Export: DB → filesystem (merges local + remote content)
    db.sync_dir(&sync_dir, "git-sync", false, true)?;

    // Commit
    let message = format!("sync: {} @ {}", git_cmd::get_hostname(), Utc::now().to_rfc3339());
    git_cmd::commit_all(&sync_dir, &message)?;

    // Push if remote is configured
    if git_cmd::has_remote(&sync_dir) {
        let _ = git_cmd::push(&sync_dir);
    }

    // Save config
    let mut config = read_config();
    config.enabled = true;
    config.last_sync = Some(Utc::now().to_rfc3339());
    write_config(&config)?;

    get_sync_status()
}

/// Disable sync (does not delete the git repo).
pub fn disable_sync() -> Result<()> {
    let mut config = read_config();
    config.enabled = false;
    write_config(&config)?;
    Ok(())
}

/// Phase 1 of sync: export DB → filesystem + commit. Requires DB access.
/// Returns pages_exported count.
pub fn sync_export(db: &Database) -> Result<u32> {
    let sync_dir = default_sync_dir();
    // Export only — no import. Uses export_markdown to avoid the double import from sync_dir.
    let exported = db.export_markdown(&sync_dir)?;

    // Commit
    let message = format!("sync: {} @ {}", git_cmd::get_hostname(), Utc::now().to_rfc3339());
    git_cmd::commit_all(&sync_dir, &message)?;
    Ok(exported.len() as u32)
}

/// Phase 2 of sync: git pull/push. No DB access needed — pure git operations.
/// Returns (remote_had_changes, conflicts_resolved, error).
pub fn sync_git_ops() -> Result<(bool, u32, Option<String>)> {
    let sync_dir = default_sync_dir();
    let has_remote = git_cmd::has_remote(&sync_dir);

    if !has_remote {
        return Ok((false, 0, None));
    }

    let mut conflicts_resolved: u32 = 0;

    // Pull with rebase
    let mut remote_had_changes = match git_cmd::pull_rebase(&sync_dir) {
        Ok(_) => true,  // Conservative: assume remote had content, import is idempotent
        Err(ref e) if e.to_string().contains("merge_conflict") => {
            let resolved = git_cmd::auto_resolve_conflicts(&sync_dir)?;
            conflicts_resolved = resolved.len() as u32;
            true
        }
        Err(e) => {
            return Ok((false, 0, Some(e.to_string())));
        }
    };

    // Push
    match git_cmd::push(&sync_dir) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("push_rejected") => {
            // Retry pull-rebase-push once
            match git_cmd::pull_rebase(&sync_dir) {
                Ok(_) => { remote_had_changes = true; }
                Err(ref e2) if e2.to_string().contains("merge_conflict") => {
                    let resolved = git_cmd::auto_resolve_conflicts(&sync_dir)?;
                    conflicts_resolved += resolved.len() as u32;
                    remote_had_changes = true;
                }
                Err(_) => {}
            }
            if let Err(e2) = git_cmd::push(&sync_dir) {
                return Ok((remote_had_changes, conflicts_resolved,
                    Some(format!("Push failed after retry: {e2}"))));
            }
        }
        Err(e) => {
            return Ok((remote_had_changes, conflicts_resolved, Some(e.to_string())));
        }
    }

    Ok((remote_had_changes, conflicts_resolved, None))
}

/// Phase 3 of sync: import filesystem → DB. Requires DB access.
/// Only called if remote had changes.
pub fn sync_import(db: &Database) -> Result<u32> {
    let sync_dir = default_sync_dir();
    let import_result = db.sync_dir(&sync_dir, "git-sync", false, false)?;
    Ok((import_result.pages_created.len() + import_result.pages_updated.len()) as u32)
}

/// Update the last_sync timestamp in the config file.
pub fn update_last_sync() -> Result<()> {
    let mut config = read_config();
    config.last_sync = Some(Utc::now().to_rfc3339());
    write_config(&config)
}

/// Full sync cycle, split into 3 phases to minimize DB lock time:
/// Phase 1 (DB lock): export DB → filesystem, commit
/// Phase 2 (no lock): git pull --rebase, resolve conflicts, push
/// Phase 3 (DB lock): import remote changes → DB (only if remote had changes)
pub fn full_sync(db: &Database) -> Result<GitSyncResult> {
    let config = read_config();
    if !config.enabled {
        return Ok(GitSyncResult {
            success: false,
            pages_exported: 0,
            pages_imported: 0,
            conflicts_resolved: 0,
            error: Some("Sync is not enabled".to_string()),
        });
    }

    let sync_dir = default_sync_dir();
    if !git_cmd::is_git_repo(&sync_dir) {
        return Err(Error::Git("Sync directory is not a git repo".to_string()));
    }

    // Phase 1: Export (needs DB)
    let pages_exported = sync_export(db)?;

    // Phase 2: Git network ops (no DB needed)
    let (remote_had_changes, conflicts_resolved, git_error) = sync_git_ops()?;

    if let Some(err) = git_error {
        return Ok(GitSyncResult {
            success: false,
            pages_exported,
            pages_imported: 0,
            conflicts_resolved,
            error: Some(err),
        });
    }

    // Phase 3: Import (needs DB) — only if remote had changes
    let pages_imported = if remote_had_changes {
        sync_import(db)?
    } else {
        0
    };

    // Update last_sync timestamp
    let mut config = read_config();
    config.last_sync = Some(Utc::now().to_rfc3339());
    write_config(&config)?;

    Ok(GitSyncResult {
        success: true,
        pages_exported,
        pages_imported,
        conflicts_resolved,
        error: None,
    })
}
