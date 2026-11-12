//! Git Sync manager — orchestrates the full sync cycle.
//! Connects the existing `sync_dir` (DB ↔ filesystem) to git (filesystem ↔ remote).
//!
//! A cycle is split into phases so the DB lock is never held across network I/O:
//!
//! 1. (DB lock) export DB → files, prune stale files, commit. Record the export time.
//! 2. (no lock)  pull --rebase (auto-resolving conflicts), push.
//! 3. (DB lock) import files → DB, but ONLY if HEAD moved past the last imported
//!    commit, and never overwrite a page edited locally after phase 1's export.
//!    Pages whose file was deleted by the pull are moved to trash, and so are
//!    folders whose `.minotes-folder.json` it deleted. Whiteboard sidecars
//!    (`.minotes-whiteboards/`) are imported when newer than the local board.
//!
//! The last imported commit is persisted in `.git/minotes-sync-state.json`, so an
//! import that failed or was interrupted is retried on the next cycle.
//!
//! **Enabling** sync ([`enable_in_dir`]) is the same cycle with a stricter import:
//! the files are first brought up to date with the database (a full mirror pass,
//! outside edits imported first), and the import afterwards only takes what the
//! pull changed — every other page keeps the database's version, so files older
//! than the database (a mirror that was off, still debouncing, or failed) can
//! never revert it. Blocks the pull removed go to the Trash, not away.
//!
//! **Trust** (F-6): a notebook folder whose `.minotes/sync-config.json` says
//! "enabled" may have been set up on another computer and copied here, with
//! someone else's `.git/config`. Such a folder is not synced automatically: the
//! user confirms once ([`confirm_sync`]), which strips command-running keys from
//! its `.git/config` and records the folder in this machine's private state.

use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::git_cmd;
use crate::mirror::{MirrorTarget, FS_LOCK as SYNC_LOCK};
use crate::repo::export::ExportOptions;
use crate::repo::sync::{SyncOptions, SyncResult};

pub(crate) const IMPORT_ACTOR: &str = "git-sync";
const STATE_FILE: &str = "minotes-sync-state.json";

/// The notebook a sync is for (`key` = the active notebook key).
fn notebook(key: &str) -> crate::notebook::Notebook {
    crate::notebook::resolve(key).unwrap_or_else(|_| crate::notebook::Notebook::legacy("default"))
}

/// Sync directory for a notebook = its markdown mirror. Legacy notebooks keep
/// `~/MiNotes_Sync` ("default") or `~/MiNotes_Sync-<name>` (a nested
/// `~/MiNotes_Sync/<name>` would be tracked by — and imported into — the
/// default notebook's repo); notebooks in a folder sync `<folder>/notes`.
pub fn sync_dir_for_notebook(key: &str) -> PathBuf {
    match crate::notebook::resolve(key) {
        Ok(nb) => nb.mirror_dir(),
        // Not a valid name: never escape HOME.
        Err(_) => crate::notebook::legacy_mirror_dir(&crate::repo::export::sanitize_component(key)),
    }
}

/// Sync directory of the default notebook: ~/MiNotes_Sync
pub fn default_sync_dir() -> PathBuf {
    sync_dir_for_notebook("default")
}

fn config_path(key: &str) -> PathBuf {
    let p = notebook(key).sync_config_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    p
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncConfig {
    pub enabled: bool,
    /// When this notebook last reached the remote (pushed). Never set by a
    /// cycle without a remote: a local commit is not "synced".
    pub last_sync: Option<String>,
    /// The last cycle's error (cleared by a cycle that reached the remote).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// [`sync_error_kind`] of `last_error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_kind: Option<String>,
}

// ── Trust: was sync for this folder set up on this machine? ──

/// This machine's record of sync folders it set up (app-private, never copied
/// with a notebook folder): random tokens, one per repo, each also kept in that
/// repo's `.git/` (which travels with a copy — the record here does not).
const TRUST_FILE: &str = "sync-trust.json";
const TRUST_TOKEN_FILE: &str = "minotes-sync-trust";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrustRecord {
    #[serde(default)]
    tokens: Vec<String>,
}

fn trust_record_path() -> PathBuf {
    crate::notebook::base_dir().join(TRUST_FILE)
}

fn read_trust_record() -> TrustRecord {
    std::fs::read_to_string(trust_record_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn repo_token(dir: &Path) -> Option<String> {
    let p = dir.join(".git").join(TRUST_TOKEN_FILE);
    if crate::repo::export::is_symlink(&p) {
        return None;
    }
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Was git sync for `dir` set up on this machine (see the module docs)?
pub fn repo_trusted(dir: &Path) -> bool {
    match repo_token(dir) {
        Some(t) => read_trust_record().tokens.iter().any(|x| *x == t),
        None => false,
    }
}

/// Record `dir` as set up on this machine. A repo this machine has no record
/// of first loses the command-running keys of its `.git/config`.
pub fn trust_repo(dir: &Path) -> Result<Vec<String>> {
    if !git_cmd::is_git_repo(dir) || repo_trusted(dir) {
        return Ok(vec![]);
    }
    let removed = git_cmd::strip_untrusted_config(dir)?;
    git_cmd::harden_repo(dir)?;
    let token = Uuid::now_v7().simple().to_string();
    crate::repo::export::atomic_write(&dir.join(".git").join(TRUST_TOKEN_FILE), token.as_bytes())
        .map_err(|e| Error::Git(format!("Failed to record the sync folder: {e}")))?;
    let mut rec = read_trust_record();
    rec.tokens.push(token);
    let json = serde_json::to_string_pretty(&rec)?;
    crate::repo::export::atomic_write(&trust_record_path(), json.as_bytes())
        .map_err(|e| Error::Git(format!("Failed to record the sync folder: {e}")))?;
    Ok(removed)
}

/// Is the notebook's sync set up on this machine? Legacy notebooks keep their
/// sync config in this machine's private dir, so their config is the record.
/// A folder notebook carries its config with it: it needs this machine's record.
pub fn sync_trusted(key: &str) -> bool {
    let nb = notebook(key);
    if !nb.is_folder() {
        return true;
    }
    let dir = nb.mirror_dir();
    // No repo yet: nothing of anyone else's can run (enable creates it here).
    !git_cmd::is_git_repo(&dir) || repo_trusted(&dir)
}

/// Sync is on in the notebook's config but was set up elsewhere: ask first.
pub fn needs_confirmation(key: &str) -> bool {
    read_config(key).enabled && !sync_trusted(key)
}

/// The user confirmed syncing a notebook folder set up on another computer.
/// Returns the `.git/config` keys that were removed.
pub fn confirm_sync(key: &str) -> Result<Vec<String>> {
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    trust_repo(&sync_dir_for_notebook(key))
}

fn read_config(key: &str) -> SyncConfig {
    std::fs::read_to_string(config_path(key))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(key: &str, config: &SyncConfig) -> Result<()> {
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(config_path(key), json)
        .map_err(|e| Error::Git(format!("Failed to write sync config: {e}")))?;
    Ok(())
}

/// Per-repo sync state (kept inside `.git`, never committed).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct RepoState {
    /// Commit whose tree has been fully imported into the DB.
    pub(crate) imported_head: Option<String>,
    /// Deletions from another device that the mass-delete guard refused to
    /// apply, waiting for the user. Their files stay deleted (the mirror does not
    /// write them back) until the user picks "Move to trash" or "Keep them".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) held: Option<HeldState>,
    /// Page files a git conflict kept local: the other device's version (blob
    /// ids only) waits to be merged per block once the database is open
    /// (`Database::merge_remote_version`; encrypted notebooks decrypt it first).
    #[serde(default, rename = "enc_merges", skip_serializing_if = "Vec::is_empty")]
    pub(crate) merges: Vec<crate::sync_encrypted::PendingMerge>,
    /// Encrypted notebooks: this device rotated the data key and the repo is not
    /// re-encrypted with the new one yet (see `sync_encrypted`, "Key rotation").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) rekey: Option<crate::sync_encrypted::PendingRekey>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct HeldState {
    pub(crate) page_ids: Vec<Uuid>,
    pub(crate) folder_ids: Vec<Uuid>,
    pub(crate) held_at: String,
}

/// Deletions held back by the mass-delete guard, as shown to the user.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HeldDeletions {
    /// Held pages, not counting journal days.
    pub pages: usize,
    /// Held journal days.
    pub journals: usize,
    pub folders: usize,
    /// Up to 20 page titles (then folder names), for the notice.
    pub titles: Vec<String>,
    /// Pages in the notebook for "34 of 50": not journal days, not in the
    /// Trash or the Archive (as the sidebar and All Pages count them).
    pub total_pages: usize,
    /// Every held page and folder, for the review list (open one, keep some).
    #[serde(default)]
    pub items: Vec<HeldItem>,
}

/// One held deletion in the review list.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HeldItem {
    pub id: Uuid,
    pub title: String,
    /// "page", "journal" or "folder".
    pub kind: &'static str,
}

/// Pages/folders an export must leave out while their deletion is held.
pub fn held_export_options(dir: &Path) -> ExportOptions {
    match read_state(dir).held {
        Some(h) => ExportOptions {
            skip_pages: h.page_ids.into_iter().collect(),
            skip_folders: h.folder_ids.into_iter().collect(),
        },
        None => ExportOptions::default(),
    }
}

pub(crate) fn read_state(dir: &Path) -> RepoState {
    std::fs::read_to_string(dir.join(".git").join(STATE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn write_state(dir: &Path, st: &RepoState) -> Result<()> {
    let json = serde_json::to_string(st)?;
    crate::repo::export::atomic_write(&dir.join(".git").join(STATE_FILE), json.as_bytes())
        .map_err(|e| Error::Git(format!("Failed to write sync state: {e}")))
}

fn set_imported_head(dir: &Path, head: Option<String>) -> Result<()> {
    let mut st = read_state(dir);
    st.imported_head = head;
    write_state(dir, &st)
}

/// Drop held deletions that no longer apply: the page/folder is gone or already
/// trashed, or it was edited here after the hold (an edit beats a deletion).
fn refresh_held(db: &Database, dir: &Path) -> Result<()> {
    let mut st = read_state(dir);
    let Some(mut h) = st.held.clone() else { return Ok(()) };
    let since = DateTime::parse_from_rfc3339(&h.held_at).map(|d| d.with_timezone(&Utc)).ok();
    let edited = match since {
        Some(t) => db.pages_modified_since(t, IMPORT_ACTOR)?,
        None => HashSet::new(),
    };
    let mut keep_pages = Vec::new();
    for id in &h.page_ids {
        if db.get_page(id)?.is_some() && !db.is_trashed(id)? && !edited.contains(id) {
            keep_pages.push(*id);
        }
    }
    let mut keep_folders = Vec::new();
    for id in &h.folder_ids {
        if db.get_folder(id)?.is_some() && !db.list_trash()?.iter().any(|t| t.id == id.to_string()) {
            keep_folders.push(*id);
        }
    }
    h.page_ids = keep_pages;
    h.folder_ids = keep_folders;
    let new = if h.page_ids.is_empty() && h.folder_ids.is_empty() { None } else { Some(h) };
    if new != st.held {
        st.held = new;
        write_state(dir, &st)?;
    }
    Ok(())
}

fn held_summary(db: &Database, dir: &Path) -> Result<Option<HeldDeletions>> {
    let Some(h) = read_state(dir).held else { return Ok(None) };
    let mut titles = Vec::new();
    let mut items = Vec::new();
    let mut journals = 0usize;
    for id in &h.page_ids {
        let Some(p) = db.get_page(id)? else { continue };
        if p.is_journal {
            journals += 1;
        }
        if titles.len() < 20 {
            titles.push(p.title.clone());
        }
        items.push(HeldItem { id: *id, title: p.title, kind: if p.is_journal { "journal" } else { "page" } });
    }
    for id in &h.folder_ids {
        if let Some(f) = db.get_folder(id)? {
            if titles.len() < 20 {
                titles.push(format!("{}/", f.name));
            }
            items.push(HeldItem { id: *id, title: f.name, kind: "folder" });
        }
    }
    // Counted like the sidebar and All Pages count: pages, not journal days
    // (those are counted apart), nothing trashed or archived (UX review: the
    // banner said "25 pages (of 36)" next to a sidebar showing 35).
    let total_pages: usize = db.conn.query_row(
        "SELECT COUNT(*) FROM pages WHERE is_journal = 0
           AND id NOT IN (SELECT page_id FROM trash) AND id NOT IN (SELECT page_id FROM archive)",
        [],
        |r| r.get::<_, i64>(0),
    )? as usize;
    Ok(Some(HeldDeletions {
        pages: h.page_ids.len() - journals,
        journals,
        folders: h.folder_ids.len(),
        titles,
        total_pages,
        items,
    }))
}

/// The user's answer to held deletions. `move_to_trash`: apply them (to trash,
/// recoverable). Otherwise keep the pages: the hold is dropped and the next
/// export writes their files again. Returns how many items were trashed.
///
/// Callers serialise this with sync cycles (hold `mirror::FS_LOCK`, then the DB).
pub fn resolve_held_deletions_in_dir(db: &Database, dir: &Path, move_to_trash: bool) -> Result<usize> {
    resolve_held_deletions_keeping(db, dir, move_to_trash, &HashSet::new())
}

/// [`resolve_held_deletions_in_dir`] with a partial keep: with `move_to_trash`,
/// everything held except `keep` goes to the Trash; the kept ones stay (and the
/// next export writes them back, so the other device gets them again).
pub fn resolve_held_deletions_keeping(db: &Database, dir: &Path, move_to_trash: bool, keep: &HashSet<Uuid>) -> Result<usize> {
    let mut st = read_state(dir);
    let Some(h) = st.held.take() else { return Ok(0) };
    let mut n = 0;
    if move_to_trash {
        db.tx(|| {
            // A kept page inside a trashed folder would go with it: keep the folder.
            let mut keep_folders: HashSet<Uuid> = keep.clone();
            for id in keep {
                let mut f = db.get_page(id)?.and_then(|p| p.folder_id);
                while let Some(fid) = f {
                    keep_folders.insert(fid);
                    f = db.get_folder(&fid)?.and_then(|x| x.parent_id);
                }
            }
            for id in h.folder_ids.iter().filter(|id| !keep_folders.contains(id)) {
                if db.get_folder(id)?.is_some() {
                    db.trash_folder(id)?;
                    n += 1;
                }
            }
            for id in h.page_ids.iter().filter(|id| !keep.contains(id)) {
                if db.get_page(id)?.is_some() && !db.is_trashed(id)? {
                    db.trash_page(id)?;
                    n += 1;
                }
            }
            Ok(())
        })?;
    }
    write_state(dir, &st)?;
    Ok(n)
}

/// [`resolve_held_deletions_in_dir`] for a notebook's sync dir.
pub fn resolve_held_deletions(db: &Database, key: &str, move_to_trash: bool) -> Result<usize> {
    resolve_held_deletions_in_dir(db, &sync_dir_for_notebook(key), move_to_trash)
}

/// [`resolve_held_deletions_keeping`] for a notebook's sync dir.
pub fn resolve_held_deletions_partial(db: &Database, key: &str, keep: &HashSet<Uuid>) -> Result<usize> {
    resolve_held_deletions_keeping(db, &sync_dir_for_notebook(key), true, keep)
}

pub(crate) fn ensure_gitignore(dir: &Path) {
    let path = dir.join(".gitignore");
    if crate::repo::export::is_symlink(&path) {
        return; // never written through
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        ".DS_Store\nThumbs.db\n*.swp\n*~\n".to_string()
    });
    let mut out = existing.clone();
    for line in [
        format!("{}/", crate::repo::export::SYNC_TRASH_DIR),
        crate::repo::export::EXPORT_MANIFEST.to_string(),
    ] {
        if !existing.lines().any(|l| l.trim() == line) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&line);
            out.push('\n');
        }
    }
    if out != existing || !path.exists() {
        let _ = crate::repo::export::atomic_write(&path, out.as_bytes());
    }
}

// ── Import / attachments ──
/// Attachments over the git-sync limit are listed in `_attachments/.gitignore`
/// by the mirror; make sure git also never sees half-copied temp files.
fn ensure_attachment_gitignore(dir: &Path) {
    let gi = dir.join(".gitignore");
    if crate::repo::export::is_symlink(&gi) {
        return;
    }
    let existing = std::fs::read_to_string(&gi).unwrap_or_default();
    let line = format!("{}/**/.*{}", crate::repo::attachments::MIRROR_DIR, crate::repo::export::TMP_SUFFIX);
    if !existing.lines().any(|l| l.trim() == line) {
        let mut out = existing.clone();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&line);
        out.push('\n');
        let _ = crate::repo::export::atomic_write(&gi, out.as_bytes());
    }
}
// ── End import ──

pub(crate) fn commit_message() -> String {
    format!("sync: {} @ {}", git_cmd::get_hostname(), Utc::now().to_rfc3339())
}

// ── Public types returned to frontend ──

#[derive(Debug, Clone, Serialize)]
pub struct GitSyncStatus {
    pub enabled: bool,
    pub remote_url: Option<String>,
    pub branch: Option<String>,
    /// When this device last reached the remote. None without a remote, before
    /// the first push, and while sync waits for confirmation (a copied folder's
    /// config carries the other computer's time).
    pub last_sync: Option<String>,
    /// Sync is on for this folder, but it was set up on another computer: it
    /// does not sync here until the user confirms ([`confirm_sync`]).
    #[serde(default)]
    pub needs_confirmation: bool,
    /// The last cycle's error, if it failed ([`sync_error_kind`] in `last_error_kind`).
    pub last_error: Option<String>,
    pub last_error_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitSyncResult {
    /// Git AND the import went through.
    pub success: bool,
    pub pages_exported: u32,
    pub pages_imported: u32,
    /// Files git conflicted on (page files are merged per block).
    pub conflicts_resolved: u32,
    /// "(conflict from …)" pages kept because a block (or the title, or a page
    /// property) changed on both devices.
    #[serde(default)]
    pub conflict_pages: Vec<String>,
    pub error: Option<String>,
    /// Per-file import problems (the rest of the import still went through;
    /// the commit is re-imported next cycle).
    #[serde(default)]
    pub import_errors: Vec<String>,
    /// Deletions from another device the mass-delete guard held back.
    pub held_deletions: Option<HeldDeletions>,
    /// The remote could not be reached (shown as "offline", not as a failure).
    #[serde(default)]
    pub offline: bool,
    /// Non-fatal notices (e.g. attachments over 50 MB left out of git).
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Nothing ran: the folder's sync was set up on another computer and the
    /// user has not confirmed syncing it here yet.
    #[serde(default)]
    pub needs_confirmation: bool,
    /// [`sync_error_kind`] of `error`.
    #[serde(default)]
    pub error_kind: Option<String>,
    /// The repo has no remote: the cycle only committed locally (nothing was
    /// sent anywhere — not "synced").
    #[serde(default)]
    pub no_remote: bool,
}

impl GitSyncResult {
    pub(crate) fn refused(msg: &str) -> Self {
        GitSyncResult {
            success: false,
            pages_exported: 0,
            pages_imported: 0,
            conflicts_resolved: 0,
            conflict_pages: vec![],
            error: Some(msg.to_string()),
            import_errors: vec![],
            held_deletions: None,
            offline: false,
            warnings: vec![],
            needs_confirmation: false,
            error_kind: None,
            no_remote: false,
        }
    }

    /// Fill `error_kind` (and `offline`) from `error`.
    pub(crate) fn classified(mut self) -> Self {
        // "Git error: Remote not found — …" → the message the user needs.
        if let Some(e) = self.error.as_mut() {
            if let Some(rest) = e.strip_prefix("Git error: ") {
                *e = rest.to_string();
            }
        }
        self.error_kind = self.error.as_deref().map(|e| sync_error_kind(e).to_string());
        self.offline = self.error_kind.as_deref() == Some(SYNC_ERR_OFFLINE);
        self
    }

    fn not_enabled() -> Self {
        Self::refused("Sync is not enabled")
    }

    fn unconfirmed() -> Self {
        GitSyncResult {
            needs_confirmation: true,
            ..Self::refused("This notebook folder's sync was set up on another computer. Confirm to sync it here.")
        }
    }
}

/// Does a git error mean "the remote is unreachable" (offline) rather than a
/// real failure?
///
/// Only network failures: a remote that answers "not found" or refuses the
/// credentials is a real error the user has to fix, never a quiet "Offline"
/// (UX review: a moved remote showed only a grey "Offline").
pub fn is_offline_error(msg: &str) -> bool {
    sync_error_kind(msg) == SYNC_ERR_OFFLINE
}

/// [`sync_error_kind`]: the remote can't be reached (network). Retried quietly.
pub const SYNC_ERR_OFFLINE: &str = "offline";
/// The remote's address leads nowhere: moved, deleted, mistyped.
pub const SYNC_ERR_REMOTE_NOT_FOUND: &str = "remote_not_found";
/// The remote refused the credentials.
pub const SYNC_ERR_AUTH: &str = "auth";
/// Anything else (an import problem, a git failure).
pub const SYNC_ERR_OTHER: &str = "other";

/// What kind of failure a sync error message is, for the UI.
pub fn sync_error_kind(msg: &str) -> &'static str {
    let m = msg.to_lowercase();
    let any = |keys: &[&str]| keys.iter().any(|k| m.contains(k));
    if any(&["authentication failed", "permission denied", "could not read username", "terminal prompts disabled", "returned error: 403", "returned error: 401"]) {
        SYNC_ERR_AUTH
    } else if any(&["remote not found", "does not appear to be a git repository", "repository not found", "' not found", "returned error: 404"]) {
        SYNC_ERR_REMOTE_NOT_FOUND
    } else if any(&[
        "network error",
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "network is unreachable",
        "no route to host",
        "failed to connect",
        "operation timed out",
        "temporary failure in name resolution",
        "connection reset",
    ]) {
        SYNC_ERR_OFFLINE
    } else {
        SYNC_ERR_OTHER
    }
}

/// Outcome of phase 1.
#[derive(Debug, Clone)]
pub struct ExportPhase {
    pub pages_exported: u32,
    /// Attachments left out of git (over the size limit).
    pub large_attachments: Vec<String>,
    /// Where the DB's writes stood when it was read for export. Local edits after
    /// this are protected from being overwritten by the phase-3 import.
    pub mark: crate::repo::sync::SyncMark,
}

/// Outcome of phase 2.
#[derive(Debug, Clone, Default)]
pub struct GitPhase {
    pub conflicts_resolved: u32,
    pub error: Option<String>,
}

/// Work for phase 3, computed without the DB.
#[derive(Debug, Clone)]
pub struct PendingImport {
    pub head: String,
    /// Pages whose file was deleted between the last imported commit and `head`.
    pub removed_page_ids: Vec<Uuid>,
    /// Folders whose `.minotes-folder.json` was deleted in that range.
    pub removed_folder_ids: Vec<Uuid>,
    /// Files the pull changed (None: no earlier import to compare with — all).
    /// The markdown mirror re-baselines them after the import, so they are not
    /// mistaken for outside edits.
    pub changed_paths: Option<Vec<String>>,
    /// The commit the changes are relative to (the merge base for pages edited
    /// here meanwhile).
    pub base: Option<String>,
}

// ── Public API ──

/// Check if git is available on the system.
pub fn git_available() -> bool {
    git_cmd::git_available()
}

/// Get current sync status for a notebook by reading config + git repo state.
pub fn get_sync_status(key: &str) -> Result<GitSyncStatus> {
    let config = read_config(key);
    let sync_dir = sync_dir_for_notebook(key);
    let needs_confirmation = config.enabled && !sync_trusted(key);

    // Waiting for the user's OK: whatever the folder's config says happened
    // happened on another computer (its time, its errors).
    let (last_error, last_error_kind) = if config.enabled && !needs_confirmation {
        (config.last_error.clone(), config.last_error_kind.clone())
    } else {
        (None, None)
    };

    // The remote is shown while sync is off too (turning it back on uses it;
    // Settings offers Change / Remove instead of a second "Set up sync").
    if !git_cmd::is_git_repo(&sync_dir) {
        return Ok(GitSyncStatus {
            enabled: config.enabled,
            remote_url: None,
            branch: None,
            last_sync: None,
            needs_confirmation,
            last_error,
            last_error_kind,
        });
    }

    let remote_url = git_cmd::get_remote_url(&sync_dir)?;
    let branch = git_cmd::get_branch(&sync_dir).ok().flatten();
    // Only a push is "synced": never without a remote (older versions stamped
    // the time a local-only commit was made).
    let last_sync = if !config.enabled || needs_confirmation || remote_url.is_none() { None } else { config.last_sync };

    Ok(GitSyncStatus {
        enabled: config.enabled,
        remote_url,
        branch,
        last_sync,
        needs_confirmation,
        last_error,
        last_error_kind,
    })
}

/// Record a cycle's outcome in the notebook's sync config: the time it reached
/// the remote, or its error.
fn record_outcome(key: &str, reached_remote: bool, error: Option<&str>) -> Result<()> {
    let mut config = read_config(key);
    match error {
        Some(e) => {
            let e = e.strip_prefix("Git error: ").unwrap_or(e);
            config.last_error = Some(e.to_string());
            config.last_error_kind = Some(sync_error_kind(e).to_string());
        }
        None => {
            config.last_error = None;
            config.last_error_kind = None;
            if reached_remote {
                config.last_sync = Some(Utc::now().to_rfc3339());
            }
        }
    }
    write_config(key, &config)
}

/// Enable git sync for a notebook. `lock_db` is called only around the DB work (never
/// across git network calls), so the UI stays responsive.
pub fn enable_sync_with<G, F>(key: &str, lock_db: F) -> Result<GitSyncStatus>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    if !git_cmd::git_available() {
        return Err(Error::Git("Git is not installed".to_string()));
    }
    let (git_error, has_remote) = {
        let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let target = MirrorTarget::for_notebook(&notebook(key));
        // Turning sync on is the user's explicit choice for this folder: an
        // existing repo this machine has no record of loses the command-running
        // keys of its `.git/config` before git runs anything else in it.
        if git_cmd::is_git_repo(&target.dir) && !repo_trusted(&target.dir) {
            git_cmd::strip_untrusted_config(&target.dir)?;
        }
        let e = enable_in_dir(&target, &lock_db)?;
        trust_repo(&target.dir)?;
        (e, git_cmd::has_remote(&target.dir))
    };

    let mut config = read_config(key);
    config.enabled = true;
    if !has_remote {
        // A copied folder's config may carry another computer's time.
        config.last_sync = None;
    }
    write_config(key, &config)?;
    record_outcome(key, has_remote, git_error.as_deref())?;

    get_sync_status(key)
}

/// Convenience wrapper for callers that already own the DB.
pub fn enable_sync(db: &Database, key: &str) -> Result<GitSyncStatus> {
    enable_sync_with(key, || Ok(db))
}

/// Init (if needed), flush the mirror, commit, pull, import what the pull
/// changed, export, commit, push (see the module docs).
///
/// The database is the truth when sync is turned on. Files can be older than the
/// database — edits still in the mirror's debounce, a pass that failed, a mirror
/// that was off (Android, or switched off in the notebook's settings) for weeks —
/// so before anything is read back, a full mirror pass (outside edits imported
/// first, under the caller's FS lock and the DB lock) writes the database out and
/// it is committed. The import after the pull then takes only what the pull
/// changed: every page whose file the pull left alone is protected, and so is
/// every page edited during the network phase. Blocks the pull removed are
/// parked in a Trash page "(removed by sync …)", never deleted.
///
/// Returns the remote's error, if the pull or the push failed (sync is on and
/// everything is committed locally; the next cycle retries).
pub fn enable_in_dir<G, F>(target: &MirrorTarget, lock_db: &F) -> Result<Option<String>>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let sync_dir = target.dir.as_path();
    if lock_db()?.is_encrypted() {
        // Fails closed (before anything is committed or pushed) when the remote
        // holds another notebook.
        let r = crate::sync_encrypted::cycle(sync_dir, lock_db, true)?;
        if let Some(e) = r.error.clone().filter(|_| !r.offline) {
            return Err(Error::Git(e));
        }
        return Ok(r.error);
    }
    let mut remote_error: Option<String> = None;
    if !git_cmd::is_git_repo(sync_dir) {
        git_cmd::init_repo(sync_dir)?;
    }
    git_cmd::harden_repo(sync_dir)?;
    ensure_gitignore(sync_dir);
    git_cmd::abort_stale_rebase(sync_dir)?;

    // 1. (DB lock) The files say what the database says; commit that.
    let (export_mark, flushed_head) = {
        let db = lock_db()?;
        let exp = export_and_commit_target(&db, target)?;
        (exp.mark, git_cmd::rev_parse_head(sync_dir)?)
    };

    // 2. (no DB lock) Bring in what other devices pushed.
    if git_cmd::has_remote(sync_dir) {
        if let Err(e) = pull_with_resolve(sync_dir) {
            // (An empty remote is not an error: the first push creates the branch.)
            eprintln!("[minotes-sync] enable: pull skipped: {e}");
            remote_error = Some(e.to_string());
        }
    }

    // 3. (DB lock) Import only what the pull changed — deletions included (to
    //    the Trash, under the mass-delete guard) — then export and commit.
    if let Some(head) = git_cmd::rev_parse_head(sync_dir)? {
        let db = lock_db()?;
        let pending = pending_between(sync_dir, flushed_head.as_deref(), head)?;
        let mut protect_pages = match &pending.changed_paths {
            Some(paths) => pages_not_changed_by(&db, sync_dir, paths)?,
            // Nothing was committed from here: everything came with the pull.
            None => HashSet::new(),
        };
        for id in &pending.removed_page_ids {
            protect_pages.remove(id); // deleted by the pull: its file is gone, not old
        }
        let opts = SyncOptions {
            protect_modified_after: Some(export_mark),
            protect_pages,
            park_removed: true,
            ..Default::default()
        };
        let r = apply_import_opts(&db, sync_dir, &pending, opts)?;
        // What the pull wrote is not an outside edit; then write the database's
        // version of everything (ids, conflict copies) and commit it.
        if let Err(e) = crate::outside::adopt_pulled_files(&db, target, pending.changed_paths.as_deref()) {
            eprintln!("[minotes-sync] enable: could not re-baseline pulled files: {e}");
        }
        let mut t = target.clone();
        t.skip = held_export_options(sync_dir);
        crate::mirror::run(&db, &t, true)?;
        let committed = git_cmd::commit_all(sync_dir, &commit_message())?;
        // Our own commit holds only database state: imported too, if the pull was.
        if committed && r.errors.is_empty() {
            set_imported_head(sync_dir, git_cmd::rev_parse_head(sync_dir)?)?;
        }
    }

    if git_cmd::has_remote(sync_dir) {
        match git_cmd::push(sync_dir) {
            Ok(_) => remote_error = None,
            Err(e) => {
                eprintln!("[minotes-sync] enable: push failed: {e}");
                remote_error = Some(e.to_string());
            }
        }
    }
    Ok(remote_error)
}

/// Every page except those whose file is among `paths` (changed by a pull):
/// by the frontmatter id, or — for a file without one — by its title.
fn pages_not_changed_by(db: &Database, dir: &Path, paths: &[String]) -> Result<HashSet<Uuid>> {
    let mut all: HashSet<Uuid> = HashSet::new();
    {
        let mut stmt = db.conn.prepare("SELECT id FROM pages")?;
        for r in stmt.query_map([], |r| r.get::<_, String>(0))? {
            if let Ok(id) = Uuid::parse_str(&r?) {
                all.insert(id);
            }
        }
    }
    for p in paths.iter().filter(|p| p.ends_with(".md")) {
        let Ok(text) = crate::repo::export::read_text_below(dir, Path::new(p)) else { continue };
        let file = crate::repo::sync::ImportFile::from_text(Path::new(p), &text);
        let id = match file.fm.id {
            Some(id) => Some(id),
            None => {
                let title = file.fm.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or(file.stem.clone());
                db.get_page_by_title(&title)?.map(|pg| pg.id)
            }
        };
        if let Some(id) = id {
            all.remove(&id);
        }
    }
    Ok(all)
}

/// Disable sync for a notebook (does not delete the git repo).
pub fn disable_sync(key: &str) -> Result<()> {
    let mut config = read_config(key);
    config.enabled = false;
    write_config(key, &config)?;
    Ok(())
}

// ── Remote setup from the app (UX Wave 4; see `sync_remote`) ──

/// The remote changed (or went): "Last synced" and the last error were about
/// the old one.
fn forget_remote_outcome(key: &str) -> Result<()> {
    let mut config = read_config(key);
    config.last_sync = None;
    config.last_error = None;
    config.last_error_kind = None;
    write_config(key, &config)
}

/// "Set up sync" for a notebook without a remote: test the address, then
/// `git init` (if needed) + `remote add origin` + turn sync on (flush, pull —
/// a remote that already has notes is merged in — import, push). If turning
/// sync on fails, the remote is removed again and sync left as it was.
pub fn setup_sync_with<G, F>(key: &str, raw_url: &str, roots: &crate::sync_remote::LocalRoots, lock_db: F) -> Result<GitSyncStatus>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    if !git_cmd::git_available() {
        return Err(Error::Git("Git is not installed".to_string()));
    }
    let dir = sync_dir_for_notebook(key);
    let (v, check) = crate::sync_remote::usable_remote(raw_url, roots, &dir)?;
    {
        let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if !git_cmd::is_git_repo(&dir) {
            git_cmd::init_repo(&dir)?;
        }
        if git_cmd::has_remote(&dir) {
            return Err(Error::InvalidInput("This notebook already has a sync remote — change it instead".into()));
        }
        // A new repo follows the remote's branch (an older repo may use "master").
        if let Some(b) = check.default_branch.as_deref().filter(|b| *b != "main") {
            if git_cmd::rev_parse_head(&dir)?.is_none() {
                let _ = git_cmd::run_git(&dir, &["symbolic-ref", "HEAD", &format!("refs/heads/{b}")]);
            }
        }
        git_cmd::set_remote_url(&dir, &v.url)?;
    }
    let was_enabled = read_config(key).enabled;
    match enable_sync_with(key, lock_db) {
        Ok(status) => Ok(status),
        Err(e) => {
            let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let _ = git_cmd::remove_remote(&dir);
            if !was_enabled {
                let _ = disable_sync(key);
            }
            Err(e)
        }
    }
}

/// Point the notebook's sync at another remote (tested first). "Last synced"
/// starts over; the next sync pulls from and pushes to the new one.
pub fn change_remote(key: &str, raw_url: &str, roots: &crate::sync_remote::LocalRoots) -> Result<GitSyncStatus> {
    let dir = sync_dir_for_notebook(key);
    let (v, _) = crate::sync_remote::usable_remote(raw_url, roots, &dir)?;
    {
        let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if !git_cmd::is_git_repo(&dir) {
            return Err(Error::InvalidInput("Sync isn't set up for this notebook yet — use Set up sync".into()));
        }
        git_cmd::set_remote_url(&dir, &v.url)?;
    }
    forget_remote_outcome(key)?;
    get_sync_status(key)
}

/// Stop sending this notebook anywhere: remove the remote. Sync stays on and
/// keeps committing in the sync folder (history), like before a remote was set.
pub fn remove_sync_remote(key: &str) -> Result<GitSyncStatus> {
    let dir = sync_dir_for_notebook(key);
    {
        let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if git_cmd::is_git_repo(&dir) {
            git_cmd::remove_remote(&dir)?;
        }
    }
    forget_remote_outcome(key)?;
    get_sync_status(key)
}

/// Phase 1: flush the markdown mirror (a full pass: export DB → filesystem,
/// pruning stale files) and commit. Needs the DB. Sync does not export on its own:
/// the mirror writes the files, sync commits them.
pub fn export_and_commit(db: &Database, sync_dir: &Path) -> Result<ExportPhase> {
    export_and_commit_target(db, &MirrorTarget::new(sync_dir, None))
}

/// [`export_and_commit`] for a mirror target (its state is kept current, so the
/// next incremental mirror pass knows what was written).
pub fn export_and_commit_target(db: &Database, target: &MirrorTarget) -> Result<ExportPhase> {
    let sync_dir = target.dir.as_path();
    git_cmd::abort_stale_rebase(sync_dir)?;
    ensure_gitignore(sync_dir);
    ensure_attachment_gitignore(sync_dir);
    refresh_held(db, sync_dir)?;
    let mut target = target.clone();
    target.skip = held_export_options(sync_dir);
    // Outside edits first, so what they changed is in this export — and is not
    // mistaken for an edit made during the network phase.
    if let Err(e) = crate::outside::import_outside_edits(db, &target, &crate::outside::Scope::All) {
        eprintln!("[minotes-sync] outside edits: {e}");
    }
    let mut mark = db.sync_mark()?;
    let report = crate::mirror::run(db, &target, true)?;

    let before = git_cmd::rev_parse_head(sync_dir)?;
    let committed = git_cmd::commit_all(sync_dir, &commit_message())?;
    if committed {
        // Our own commit only contains DB state; if everything before it was
        // already imported, so is it.
        let mut st = read_state(sync_dir);
        if st.imported_head.is_some() && st.imported_head == before {
            st.imported_head = git_cmd::rev_parse_head(sync_dir)?;
            write_state(sync_dir, &st)?;
        }
    }
    db.finish_sync_mark(&mut mark);
    Ok(ExportPhase { pages_exported: report.pages_rendered as u32, mark, large_attachments: report.large_attachments })
}

/// A page file of the mirror (not a sidecar, marker or conflict copy).
fn is_page_file(rel: &str) -> bool {
    let p = Path::new(rel);
    rel.ends_with(".md")
        && !p.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        && !crate::repo::sync::is_conflict_copy_name(p)
}

/// Pull --rebase; a git conflict on a page file keeps the local file and
/// records the other version (blob ids) to merge per block once the database is
/// open ([`apply_page_merges`]) — git's line merge would turn two edits of
/// neighbouring blocks into a conflict. Other files keep the local version and
/// the other one as a `.conflict-<host>` sibling, as before.
fn pull_with_resolve(sync_dir: &Path) -> Result<u32> {
    match git_cmd::pull_rebase(sync_dir) {
        Ok(_) => Ok(0),
        Err(e) if e.to_string().contains("merge_conflict") => {
            let host = git_cmd::get_hostname();
            let mut merges: Vec<crate::sync_encrypted::PendingMerge> = Vec::new();
            let resolved = git_cmd::resolve_rebase_conflicts(sync_dir, &mut |file| {
                if !is_page_file(file) {
                    return git_cmd::resolve_with_conflict_copy(sync_dir, file, &host);
                }
                let [base, theirs, local] = git_cmd::conflict_stages(sync_dir, file)?;
                if let Some(theirs) = theirs {
                    let device = git_cmd::rebase_onto(sync_dir).and_then(|o| git_cmd::device_of_last_change(sync_dir, &o, file));
                    merges.push(crate::sync_encrypted::PendingMerge {
                        path: file.to_string(),
                        base,
                        theirs,
                        local_deleted: local.is_none(),
                        device,
                    });
                }
                git_cmd::keep_local_side(sync_dir, file)
            });
            // Remember the other versions even if the rebase failed part-way.
            if !merges.is_empty() {
                let mut st = read_state(sync_dir);
                st.merges.extend(merges);
                write_state(sync_dir, &st)?;
            }
            Ok(resolved?.len() as u32)
        }
        Err(e) => Err(e),
    }
}

/// Merge the versions a git conflict kept aside ([`pull_with_resolve`]). One
/// that fails stays recorded (and is an import error, so the commit is
/// imported again next time).
fn apply_page_merges(db: &Database, sync_dir: &Path, r: &mut SyncResult) -> Result<()> {
    let mut st = read_state(sync_dir);
    if st.merges.is_empty() {
        return Ok(());
    }
    let mut left = Vec::new();
    for m in std::mem::take(&mut st.merges) {
        let host = crate::sync_encrypted::other_device(m.device.clone());
        let res = (|| -> Result<()> {
            let theirs = git_cmd::blob_text(sync_dir, &m.theirs)?.ok_or_else(|| Error::Git(format!("missing blob {}", m.theirs)))?;
            let base = match &m.base {
                Some(b) => git_cmd::blob_text(sync_dir, b)?,
                None => None,
            };
            let rel = Path::new(&m.path);
            let file = crate::repo::sync::ImportFile::from_text(rel, &theirs);
            let folder = db.ensure_folder_path(&file.folder, IMPORT_ACTOR, r, &mut HashMap::new())?;
            db.merge_remote_version(rel, &theirs, base.as_deref(), folder, IMPORT_ACTOR, &host, r)
        })();
        if let Err(e) = res {
            r.errors.push(format!("{}: could not merge the other device's changes: {e}", m.path));
            left.push(m);
        }
    }
    st.merges = left;
    write_state(sync_dir, &st)
}

/// Phase 2: pull --rebase (auto-resolving conflicts) and push. No DB access.
pub fn git_pull_push(sync_dir: &Path) -> Result<GitPhase> {
    let mut out = GitPhase::default();
    if !git_cmd::has_remote(sync_dir) {
        return Ok(out);
    }
    git_cmd::abort_stale_rebase(sync_dir)?;

    match pull_with_resolve(sync_dir) {
        Ok(n) => out.conflicts_resolved += n,
        Err(e) => {
            out.error = Some(e.to_string());
            return Ok(out);
        }
    }

    match git_cmd::push(sync_dir) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("push_rejected") => {
            // Someone pushed in between: pull-rebase-push once more.
            match pull_with_resolve(sync_dir) {
                Ok(n) => out.conflicts_resolved += n,
                Err(e2) => {
                    out.error = Some(e2.to_string());
                    return Ok(out);
                }
            }
            if let Err(e2) = git_cmd::push(sync_dir) {
                out.error = Some(format!("Push failed after retry: {e2}"));
            }
        }
        Err(e) => out.error = Some(e.to_string()),
    }
    Ok(out)
}

/// Phase 3a (no DB): is there anything to import? Only when HEAD has moved past
/// the last imported commit — i.e. the pull brought in remote commits.
pub fn pending_import(sync_dir: &Path) -> Result<Option<PendingImport>> {
    let Some(head) = git_cmd::rev_parse_head(sync_dir)? else { return Ok(None) };
    let st = read_state(sync_dir);
    if st.imported_head.as_deref() == Some(head.as_str()) {
        return Ok(None);
    }
    pending_between(sync_dir, st.imported_head.as_deref(), head).map(Some)
}

/// What changed from `old` (None: unknown — import everything) to `head`.
fn pending_between(sync_dir: &Path, old: Option<&str>, head: String) -> Result<PendingImport> {
    let mut removed_page_ids = Vec::new();
    let mut removed_folder_ids = Vec::new();
    let mut changed_paths = None;
    let mut base = None;
    if let Some(old) = old {
        if git_cmd::commit_exists(sync_dir, old) {
            base = Some(old.to_string());
            changed_paths = Some(git_cmd::changed_files_between(sync_dir, old, &head)?);
            for path in git_cmd::deleted_files_between(sync_dir, old, &head)? {
                let p = Path::new(&path);
                let hidden_dir = p
                    .parent()
                    .map(|d| d.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')))
                    .unwrap_or(false);
                if !hidden_dir
                    && p.file_name().and_then(|n| n.to_str()) == Some(crate::repo::export::FOLDER_MARKER)
                {
                    if let Some(content) = git_cmd::show_file_at(sync_dir, old, &path)? {
                        if let Ok(m) = serde_json::from_str::<crate::repo::export::FolderMarker>(&content) {
                            removed_folder_ids.push(m.id);
                        }
                    }
                    continue;
                }
                let hidden = p
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
                if hidden || !path.ends_with(".md") {
                    continue;
                }
                if let Some(content) = git_cmd::show_file_at(sync_dir, old, &path)? {
                    if let Some(id) = crate::repo::sync::parse_frontmatter_id(&content) {
                        removed_page_ids.push(id);
                    }
                }
            }
        }
    }
    Ok(PendingImport { head, removed_page_ids, removed_folder_ids, changed_paths, base })
}

/// Phase 3b (DB): import files → DB. Pages edited locally after `protect_after`
/// are left alone (they'll be exported next cycle); pages whose file the pull
/// removed are moved to trash.
pub fn apply_import(
    db: &Database,
    sync_dir: &Path,
    pending: &PendingImport,
    protect_after: Option<crate::repo::sync::SyncMark>,
) -> Result<SyncResult> {
    let opts = SyncOptions { protect_modified_after: protect_after, ..Default::default() };
    apply_import_opts(db, sync_dir, pending, opts)
}

/// [`apply_import`] with more options (the removals come from `pending`).
fn apply_import_opts(db: &Database, sync_dir: &Path, pending: &PendingImport, mut opts: SyncOptions) -> Result<SyncResult> {
    opts.trash_page_ids = pending.removed_page_ids.clone();
    opts.trash_folder_ids = pending.removed_folder_ids.clone();
    let mut r = db.sync_dir_with(sync_dir, IMPORT_ACTOR, &opts)?;
    merge_skipped_pages(db, sync_dir, pending, &mut r);
    apply_page_merges(db, sync_dir, &mut r)?;
    for e in &r.errors {
        eprintln!("[minotes-sync] import: {e}");
    }
    let mut st = read_state(sync_dir);
    // Deletions the guard refused: remember them (so the mirror doesn't write the
    // files back, silently undoing the other device's delete) until the user decides.
    if !r.held_page_ids.is_empty() || !r.held_folder_ids.is_empty() {
        let mut h = st.held.take().unwrap_or_default();
        for id in &r.held_page_ids {
            if !h.page_ids.contains(id) {
                h.page_ids.push(*id);
            }
        }
        for id in &r.held_folder_ids {
            if !h.folder_ids.contains(id) {
                h.folder_ids.push(*id);
            }
        }
        h.held_at = Utc::now().to_rfc3339();
        st.held = Some(h);
    }
    // Only mark the commit as imported when every page went in; otherwise retry.
    if r.errors.is_empty() {
        st.imported_head = Some(pending.head.clone());
    }
    write_state(sync_dir, &st)?;
    Ok(r)
}

/// F-2: pages edited here during the network phase were skipped by the import.
/// The pull may have changed their files too: merge those remote changes in
/// (three-way, against the file at the last imported commit) or keep them as a
/// conflict page — never drop them. A failure is an import error, so the commit
/// is not marked imported and the next cycle retries.
fn merge_skipped_pages(db: &Database, sync_dir: &Path, pending: &PendingImport, r: &mut SyncResult) {
    let skipped = std::mem::take(&mut r.skipped_pages);
    let range = match &pending.base {
        Some(b) => format!("{b}..{}", pending.head),
        None => pending.head.clone(),
    };
    for (id, rel) in skipped {
        let key = rel.to_string_lossy().replace('\\', "/");
        let host = crate::sync_encrypted::other_device(git_cmd::device_of_last_change(sync_dir, &range, &key));
        if let Some(changed) = &pending.changed_paths {
            if !changed.iter().any(|c| *c == key) {
                continue; // the pull didn't touch it: nothing remote to absorb
            }
        }
        let res = (|| -> Result<()> {
            let theirs = crate::repo::export::read_text_below(sync_dir, &rel)
                .map_err(|e| Error::Git(format!("Read failed for {key}: {e}")))?;
            let base = match &pending.base {
                Some(b) => git_cmd::show_file_at(sync_dir, b, &key)?,
                None => None,
            };
            let mut sr = SyncResult::default();
            db.tx(|| db.merge_into_protected_page(&id, &rel, &theirs, base.as_deref(), IMPORT_ACTOR, &host, &mut sr))?;
            r.errors.extend(sr.errors);
            r.pages_merged.extend(sr.pages_merged);
            r.conflict_copies.extend(sr.conflict_copies.iter().cloned());
            r.pages_created.extend(sr.pages_created);
            Ok(())
        })();
        if let Err(e) = res {
            r.errors.push(format!("{key}: could not merge the other device's changes: {e}"));
        }
    }
}

/// One full cycle against an explicit sync dir (see module docs).
pub fn sync_cycle_in_dir<G, F>(sync_dir: &Path, lock_db: F) -> Result<GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    sync_cycle(&MirrorTarget::new(sync_dir, None), lock_db)
}

/// One full cycle on a notebook's mirror: flush the mirror + commit, pull/push,
/// import (see module docs).
pub fn sync_cycle<G, F>(target: &MirrorTarget, lock_db: F) -> Result<GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let sync_dir = target.dir.as_path();
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // An encrypted notebook syncs encrypted files only (sync_encrypted).
    if lock_db()?.is_encrypted() {
        if !git_cmd::is_git_repo(sync_dir) {
            return Err(Error::Git("Sync directory is not a git repo".to_string()));
        }
        return crate::sync_encrypted::cycle(sync_dir, &lock_db, false);
    }
    if !git_cmd::is_git_repo(sync_dir) {
        return Err(Error::Git("Sync directory is not a git repo".to_string()));
    }
    git_cmd::harden_repo(sync_dir)?;

    // Phase 1 (DB lock)
    let export = {
        let db = lock_db()?;
        export_and_commit_target(&db, target)?
    };

    // Phase 2 (no DB lock)
    let git = git_pull_push(sync_dir)?;

    // Phase 3 (DB lock, only if the pull brought something in)
    let mut pages_imported = 0u32;
    let mut import_errors = Vec::new();
    let mut conflict_pages = Vec::new();
    if let Some(pending) = pending_import(sync_dir)? {
        let db = lock_db()?;
        let r = apply_import(&db, sync_dir, &pending, Some(export.mark))?;
        // What the pull wrote into the mirror is not an outside edit.
        if let Err(e) = crate::outside::adopt_pulled_files(&db, target, pending.changed_paths.as_deref()) {
            eprintln!("[minotes-sync] could not re-baseline pulled files: {e}");
        }
        pages_imported = (r.pages_created.len() + r.pages_updated.len() + r.pages_deleted.len() + r.pages_merged.len()) as u32;
        import_errors = r.errors.clone();
        conflict_pages = r.conflict_copies.clone();
    } else if !read_state(sync_dir).merges.is_empty() {
        // Versions a git conflict kept aside whose merge failed last time.
        let db = lock_db()?;
        let mut r = SyncResult::default();
        apply_page_merges(&db, sync_dir, &mut r)?;
        pages_imported = (r.pages_created.len() + r.pages_updated.len() + r.pages_merged.len()) as u32;
        import_errors = r.errors.clone();
        conflict_pages = r.conflict_copies.clone();
    }
    let held_deletions = {
        let db = lock_db()?;
        held_summary(&db, sync_dir)?
    };

    let offline = git.error.as_deref().map(is_offline_error).unwrap_or(false);
    let error = match (&git.error, import_errors.first()) {
        (Some(e), _) => Some(e.clone()),
        (None, Some(first)) => Some(format!(
            "Could not import {} file(s) from the other device: {first}",
            import_errors.len()
        )),
        (None, None) => None,
    };
    Ok(GitSyncResult {
        success: error.is_none(),
        pages_exported: export.pages_exported,
        pages_imported,
        conflicts_resolved: git.conflicts_resolved,
        conflict_pages,
        error,
        import_errors,
        held_deletions,
        offline,
        warnings: export
            .large_attachments
            .iter()
            .map(|a| format!("{a} is over 50 MB and was not synced"))
            .collect(),
        needs_confirmation: false,
        error_kind: None,
        no_remote: !git_cmd::has_remote(sync_dir),
    }
    .classified())
}

/// Update the last_sync timestamp in the notebook's sync config file.
pub fn update_last_sync(key: &str) -> Result<()> {
    let mut config = read_config(key);
    config.last_sync = Some(Utc::now().to_rfc3339());
    write_config(key, &config)
}

/// Full sync cycle for a notebook. `lock_db` is invoked only for the DB phases.
pub fn full_sync_with<G, F>(key: &str, lock_db: F) -> Result<GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let config = read_config(key);
    if !config.enabled {
        return Ok(GitSyncResult::not_enabled());
    }
    if !sync_trusted(key) {
        return Ok(GitSyncResult::unconfirmed());
    }
    let target = MirrorTarget::for_notebook(&notebook(key));
    let mut result = sync_cycle(&target, lock_db)?.classified();
    result.no_remote = !git_cmd::has_remote(&target.dir);
    // "Last synced" means the remote has it: a cycle without a remote only
    // committed locally.
    record_outcome(key, result.success && !result.no_remote, result.error.as_deref())?;
    Ok(result)
}

/// Convenience wrapper for callers that already own the DB.
pub fn full_sync(db: &Database, key: &str) -> Result<GitSyncResult> {
    full_sync_with(key, || Ok(db))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_cmd::tests::setup_remote_and_devices;

    fn cycle(dir: &Path, db: &Database) -> GitSyncResult {
        let r = sync_cycle_in_dir(dir, || Ok(db)).unwrap();
        assert!(r.success, "sync failed: {:?}", r.error);
        r
    }

    fn contents(db: &Database, page: &Uuid) -> Vec<String> {
        let mut v: Vec<String> = db.get_page_blocks(page).unwrap().into_iter().map(|b| b.content).collect();
        v.sort();
        v
    }

    fn all_md_files(dir: &Path) -> Vec<String> {
        crate::repo::sync::scan_markdown_tree(dir)
            .files
            .iter()
            .map(|f| f.rel.display().to_string())
            .collect()
    }

    #[test]
    fn test_sync_dir_per_notebook() {
        let _home = crate::notebook::tests::FakeHome::new();
        let d = sync_dir_for_notebook("default");
        assert!(d.ends_with("MiNotes_Sync"));
        let w = sync_dir_for_notebook("work");
        assert_eq!(w.file_name().unwrap(), "MiNotes_Sync-work");
        assert_ne!(d, w);
        let evil = sync_dir_for_notebook("../../etc");
        assert_eq!(evil.parent(), d.parent(), "notebook name must not escape HOME");
        assert_ne!(config_path("default"), config_path("work"));
    }

    // End-to-end: device A renames a page + adds a block, B syncs, A syncs again.
    // Nothing reverts, nothing is lost, no stale file lingers.
    #[test]
    fn test_two_devices_rename_and_edit_no_revert() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();

        let p = db_a.create_page("Plan", None, false, None, "user").unwrap();
        db_a.create_block(&p.id, "one", None, None, "user").unwrap();
        db_a.create_block(&p.id, "two", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(contents(&db_b, &p.id), vec!["one", "two"]);

        // A: rename + add a block.
        db_a.rename_page(&p.id, "Roadmap", "user").unwrap();
        db_a.create_block(&p.id, "three", None, None, "user").unwrap();
        cycle(&a, &db_a);
        assert!(!a.join("Plan.md").exists(), "stale file must be pruned");
        assert!(a.join("Roadmap.md").exists());
        assert_eq!(db_a.get_page(&p.id).unwrap().unwrap().title, "Roadmap");

        // B picks up the rename and the new block.
        cycle(&b, &db_b);
        let pb = db_b.get_page(&p.id).unwrap().unwrap();
        assert_eq!(pb.title, "Roadmap");
        assert!(db_b.get_page_by_title("Plan").unwrap().is_none());
        assert_eq!(contents(&db_b, &p.id), vec!["one", "three", "two"]);
        assert!(!b.join("Plan.md").exists());

        // B edits; A syncs again — A's rename must not revert, B's block arrives.
        db_b.create_block(&p.id, "from B", None, None, "user").unwrap();
        cycle(&b, &db_b);
        cycle(&a, &db_a);
        assert_eq!(db_a.get_page(&p.id).unwrap().unwrap().title, "Roadmap");
        assert_eq!(contents(&db_a, &p.id), vec!["from B", "one", "three", "two"]);

        // Steady state: more cycles change nothing.
        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for (db, dir) in [(&db_a, &a), (&db_b, &b)] {
            assert_eq!(db.list_pages(None).unwrap().len(), 1);
            assert_eq!(db.get_page(&p.id).unwrap().unwrap().title, "Roadmap");
            assert_eq!(contents(db, &p.id), vec!["from B", "one", "three", "two"]);
            assert_eq!(all_md_files(dir), vec!["Roadmap.md".to_string()]);
        }
    }

    // Conflict: both devices edit the same line. Both versions survive, the
    // original page's blocks are NOT wiped, and the remote side becomes a separate
    // "(conflict from …)" page on both devices.
    #[test]
    fn test_two_devices_conflict_keeps_both_versions() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();

        let p = db_a.create_page("Doc", None, false, None, "user").unwrap();
        let blk = db_a.create_block(&p.id, "base", None, None, "user").unwrap();
        db_a.create_block(&p.id, "untouched", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);

        db_a.update_block(&blk.id, Some("A text"), "user").unwrap();
        db_b.update_block(&blk.id, Some("B text"), "user").unwrap();
        db_b.create_block(&p.id, "B extra", None, None, "user").unwrap();
        cycle(&a, &db_a);
        let r = cycle(&b, &db_b);
        assert_eq!(r.conflicts_resolved, 1);

        let is_conflict_page = |t: &str| t.starts_with("Doc (conflict from ");
        assert_eq!(contents(&db_b, &p.id), vec!["B extra", "B text", "untouched"]);
        {
            let pages = db_b.list_pages(None).unwrap();
            let copy = pages.iter().find(|pg| is_conflict_page(&pg.title)).expect("conflict page");
            assert_ne!(copy.id, p.id);
            assert!(contents(&db_b, &copy.id).contains(&"A text".to_string()));
            for f in all_md_files(&b) {
                let text = std::fs::read_to_string(b.join(&f)).unwrap();
                assert!(!git_cmd::has_conflict_markers(&text), "{f} has markers");
            }
        }

        cycle(&a, &db_a);
        cycle(&b, &db_b);
        cycle(&a, &db_a);
        for db in [&db_a, &db_b] {
            let pages = db.list_pages(None).unwrap();
            assert_eq!(pages.len(), 2, "{:?}", pages.iter().map(|p| &p.title).collect::<Vec<_>>());
            assert_eq!(contents(db, &p.id), vec!["B extra", "B text", "untouched"]);
            let copy = pages.iter().find(|pg| is_conflict_page(&pg.title)).expect("conflict page");
            assert!(contents(db, &copy.id).contains(&"A text".to_string()));
            assert!(contents(db, &copy.id).contains(&"untouched".to_string()));
        }
    }

    // The plain side of the D14 race: device A edits one block, B another. If A's
    // startup sync pulled B's commit first, the files fast-forward and both edits
    // survive; if A edited first, git conflicted on the page file (the edited
    // lines are adjacent) and B's edit used to end up only in a "(conflict from …)"
    // page. Now a git conflict on a page file is merged per block (F-2), whichever
    // order the sync and the edit happen in.
    fn different_blocks_two_devices(startup_sync_first: bool) {
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("Doc", None, false, None, "user").unwrap();
        let x = db_a.create_block(&p.id, "one", None, None, "user").unwrap();
        let y = db_a.create_block(&p.id, "two", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        db_b.update_block(&y.id, Some("two — B"), "user").unwrap();
        cycle(&b, &db_b);
        if startup_sync_first {
            cycle(&a, &db_a);
        }
        db_a.update_block(&x.id, Some("one — A"), "user").unwrap();
        let r = cycle(&a, &db_a);
        assert_eq!(r.conflicts_resolved > 0, !startup_sync_first, "git conflicted iff A edited before pulling");
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        cycle(&a, &db_a);
        for (db, dir) in [(&db_a, &a), (&db_b, &b)] {
            assert_eq!(db.get_page_blocks(&p.id).unwrap().into_iter().map(|b| b.content).collect::<Vec<_>>(), ["one — A", "two — B"]);
            assert_eq!(titles(db), ["Doc"], "no conflict page");
            for f in all_md_files(dir) {
                assert!(!f.contains(".conflict-"), "{f}");
                assert!(!git_cmd::has_conflict_markers(&std::fs::read_to_string(dir.join(&f)).unwrap()), "{f} has markers");
            }
        }
    }

    #[test]
    fn test_different_blocks_merge_when_the_edit_came_before_the_pull() {
        if git_cmd::git_available() {
            different_blocks_two_devices(false);
        }
    }

    #[test]
    fn test_different_blocks_merge_when_the_pull_came_before_the_edit() {
        if git_cmd::git_available() {
            different_blocks_two_devices(true);
        }
    }

    // Both devices create today's journal before they first sync: one file path,
    // two page ids. They become one journal (the smaller id), with both devices'
    // lines, on both devices — no "(2)" page, no conflict page.
    #[test]
    fn test_journals_of_one_day_from_two_devices_become_one_page() {
        if git_cmd::git_available() {
            journals_of_one_day_from_two_devices(None, None, false);
        }
    }

    /// Every timestamp written so far now lies after "now", as when the wall
    /// clock steps back (NTP; WSL re-syncs by seconds at a time, ~every 30 s).
    fn clock_steps_back(db: &Database) {
        let future = "2999-01-01T00:00:00+00:00";
        for sql in [
            "UPDATE pages SET updated_at = ?1",
            "UPDATE blocks SET updated_at = ?1",
            "UPDATE trash SET deleted_at = ?1",
            "UPDATE archive SET archived_at = ?1",
            "UPDATE events SET created_at = ?1",
            "UPDATE folder_trash SET deleted_at = ?1",
            "UPDATE folder_archive SET archived_at = ?1",
        ] {
            db.conn.execute(sql, [future]).unwrap();
        }
    }

    // The test above failed ~1 run in 30 on this host (more under load): the
    // import protected pages "edited after the export" by comparing timestamps,
    // and whenever the clock stepped back between two cycles, the previous
    // import's own writes looked newer than this export. The journal was then
    // merged per block instead of imported, and a "(conflict from …)" page or a
    // duplicated block was kept. Deterministic: the clock steps back before
    // every cycle here.
    #[test]
    fn test_sync_is_unaffected_by_the_clock_stepping_back() {
        if git_cmd::git_available() {
            journals_of_one_day_from_two_devices(None, None, true);
        }
    }

    // Two devices' ids are not ordered by creation time: two journals created in
    // the same millisecond on two devices (each with its own UUIDv7 counter), or
    // with a little clock skew, can have the LATER one smaller. Here the device
    // that syncs second (B) holds the smaller id, so the first device (A) is the
    // one whose written journal gives way.
    #[test]
    fn test_journals_of_one_day_become_one_page_whichever_device_has_the_smaller_id() {
        if git_cmd::git_available() {
            let small = Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
            let big = Uuid::parse_str("01900000-0000-7000-8000-000000000002").unwrap();
            journals_of_one_day_from_two_devices(Some(big), Some(small), false);
            journals_of_one_day_from_two_devices(Some(small), Some(big), false);
        }
    }

    fn journals_of_one_day_from_two_devices(id_a: Option<Uuid>, id_b: Option<Uuid>, clock_jumps: bool) {
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let d = chrono::NaiveDate::from_ymd_opt(2026, 10, 15).unwrap();
        let ja = db_a.get_or_create_journal(d, id_a, "user").unwrap();
        db_a.create_block(&ja.id, "morning on A", None, None, "user").unwrap();
        db_a.create_block(&ja.id, "", None, None, "user").unwrap();
        let jb = db_b.get_or_create_journal(d, id_b, "user").unwrap();
        db_b.create_block(&jb.id, "", None, None, "user").unwrap();
        db_b.create_block(&jb.id, "evening on B", None, None, "user").unwrap();
        let cycle = |dir: &Path, db: &Database| {
            if clock_jumps {
                clock_steps_back(db);
            }
            cycle(dir, db)
        };
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        db_a.create_block(&db_a.find_journal(d).unwrap().unwrap().id, "later on A", None, None, "user").unwrap();
        for _ in 0..3 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(titles(db), ["Journal/2026-10-15"], "one journal, no conflict page");
            let j = db.find_journal(d).unwrap().unwrap();
            assert_eq!(j.id, ja.id.min(jb.id));
            let mut texts = contents(db, &j.id);
            texts.retain(|t| !t.is_empty());
            assert_eq!(texts, ["evening on B", "later on A", "morning on A"]);
        }
    }

    /// Every page title in the database (trash and archive included), sorted.
    fn all_titles(db: &Database) -> Vec<String> {
        let mut st = db.conn.prepare("SELECT title FROM pages ORDER BY title").unwrap();
        let v: Vec<String> = st.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect();
        v
    }

    /// What the app does on a fresh install: a "Getting Started" page with the
    /// tutorial blocks, recorded as this device's seed, and today's journal
    /// (opened, so it holds one empty block).
    fn fresh_install(db: &Database, day: chrono::NaiveDate) -> crate::models::Page {
        let p = db.create_page("Getting Started", None, false, None, "user").unwrap();
        for t in ["Welcome to MiNotes! This is a block.", "Press **Enter** to create a new block.", "Type **[[** to link to another page."] {
            db.create_block(&p.id, t, None, None, "user").unwrap();
        }
        db.mark_onboarding_seed(&p.id).unwrap();
        let j = db.get_or_create_journal(day, None, "user").unwrap();
        db.create_block(&j.id, "", None, None, "user").unwrap();
        p
    }

    // C-9: a fresh device joining sync kept its own onboarding page next to the
    // remote's: "Getting Started", "Getting Started (2)", later "(2) (2)", and a
    // "Journal/… (2)" in the Trash. Its untouched seed and its empty journal of
    // the day give way to the remote's pages instead.
    fn fresh_device_joins(a_edits_its_copy: bool) {
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let ta = MirrorTarget::new(&a, Some(tmp.path().join("a-state.json")));
        let tb = MirrorTarget::new(&b, Some(tmp.path().join("b-state.json")));
        let day = chrono::Local::now().date_naive();
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let ga = fresh_install(&db_a, day);
        if a_edits_its_copy {
            db_a.create_block(&ga.id, "my own note on A", None, None, "user").unwrap();
        }
        let ja = db_a.find_journal(day).unwrap().unwrap();
        db_a.create_block(&ja.id, "written on A", None, None, "user").unwrap();
        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();

        let gb = fresh_install(&db_b, day);
        enable_in_dir(&tb, &|| Ok::<&Database, Error>(&db_b)).unwrap();
        for _ in 0..3 {
            sync_cycle(&ta, || Ok(&db_a)).unwrap();
            sync_cycle(&tb, || Ok(&db_b)).unwrap();
        }
        let journal = db_a.find_journal(day).unwrap().unwrap().title;
        for (name, db) in [("A", &db_a), ("B", &db_b)] {
            let mut want = vec!["Getting Started".to_string(), journal.clone()];
            want.sort();
            assert_eq!(all_titles(db), want, "device {name}: one onboarding page, one journal, nothing in the Trash");
            let g = db.get_page_by_title("Getting Started").unwrap().unwrap();
            assert_eq!(g.id, ga.id, "device {name} keeps the page the remote had");
            assert_eq!(in_order(db, &g.id).contains(&"my own note on A".to_string()), a_edits_its_copy);
            assert!(db.get_page(&gb.id).unwrap().is_none(), "B's untouched seed is gone everywhere");
            let j = db.find_journal(day).unwrap().unwrap();
            assert!(in_order(db, &j.id).contains(&"written on A".to_string()));
        }
        assert!(!a.join("Getting Started (2).md").exists() && !b.join("Getting Started (2).md").exists());
    }

    #[test]
    fn test_fresh_device_join_keeps_one_getting_started() {
        if git_cmd::git_available() {
            fresh_device_joins(false);
        }
    }

    #[test]
    fn test_fresh_device_join_keeps_the_edited_getting_started() {
        if git_cmd::git_available() {
            fresh_device_joins(true);
        }
    }

    // A page this device's user touched is never dropped: two devices' own
    // same-titled pages both stay — numbered once, the same on both devices, and
    // stable over repeated syncs (no "(2) (2)" chains).
    #[test]
    fn test_same_title_pages_from_two_devices_get_one_number_and_converge() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let ta = MirrorTarget::new(&a, Some(tmp.path().join("a-state.json")));
        let tb = MirrorTarget::new(&b, Some(tmp.path().join("b-state.json")));
        let day = chrono::Local::now().date_naive();
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        // Each device's onboarding page was edited: both are real pages now.
        let ga = fresh_install(&db_a, day);
        db_a.create_block(&ga.id, "A's note", None, None, "user").unwrap();
        let ia = db_a.create_page("Ideas", None, false, None, "user").unwrap();
        db_a.create_block(&ia.id, "idea from A", None, None, "user").unwrap();
        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();
        let gb = fresh_install(&db_b, day);
        db_b.create_block(&gb.id, "B's note", None, None, "user").unwrap();
        let ib = db_b.create_page("Ideas", None, false, None, "user").unwrap();
        db_b.create_block(&ib.id, "idea from B", None, None, "user").unwrap();
        enable_in_dir(&tb, &|| Ok::<&Database, Error>(&db_b)).unwrap();
        for _ in 0..4 {
            sync_cycle(&ta, || Ok(&db_a)).unwrap();
            sync_cycle(&tb, || Ok(&db_b)).unwrap();
        }
        let a_titles = all_titles(&db_a);
        assert!(a_titles.iter().all(|t| !t.contains(") (")), "no chains: {a_titles:?}");
        assert_eq!(a_titles, all_titles(&db_b), "both devices agree");
        for db in [&db_a, &db_b] {
            assert_eq!(in_order(db, &ia.id), vec!["idea from A"]);
            assert_eq!(in_order(db, &ib.id), vec!["idea from B"]);
            let mut pair = vec![db.get_page(&ia.id).unwrap().unwrap().title, db.get_page(&ib.id).unwrap().unwrap().title];
            pair.sort();
            assert_eq!(pair, vec!["Ideas".to_string(), "Ideas (2)".to_string()]);
            let gs: Vec<String> = all_titles(db).into_iter().filter(|t| t.starts_with("Getting Started")).collect();
            assert_eq!(gs, vec!["Getting Started".to_string(), "Getting Started (2)".to_string()]);
        }
        // Stable: more syncs change nothing.
        let before = all_titles(&db_a);
        sync_cycle(&ta, || Ok(&db_a)).unwrap();
        sync_cycle(&tb, || Ok(&db_b)).unwrap();
        sync_cycle(&ta, || Ok(&db_a)).unwrap();
        assert_eq!(all_titles(&db_a), before);
        assert_eq!(all_titles(&db_b), before);
    }

    // #2: an edit made while the git network phase runs is not reverted — neither
    // when the pull brings nothing (no import at all) nor when it brings changes
    // to other pages (the edited page is protected).
    #[test]
    fn test_edit_during_network_phase_survives() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("P", None, false, None, "user").unwrap();
        let pblk = db_a.create_block(&p.id, "p1", None, None, "user").unwrap();
        let q = db_a.create_page("Q", None, false, None, "user").unwrap();
        let qblk = db_a.create_block(&q.id, "q1", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);

        // Remote unchanged: HEAD doesn't move → no import.
        export_and_commit(&db_a, &a).unwrap();
        db_a.update_block(&pblk.id, Some("edited mid-sync"), "user").unwrap();
        assert!(git_pull_push(&a).unwrap().error.is_none());
        assert!(pending_import(&a).unwrap().is_none(), "no remote commits → no import");

        // Remote changed Q; A edits P during the network phase.
        db_b.update_block(&qblk.id, Some("q from B"), "user").unwrap();
        cycle(&b, &db_b);
        let exp = export_and_commit(&db_a, &a).unwrap();
        db_a.create_block(&p.id, "late", None, None, "user").unwrap();
        assert!(git_pull_push(&a).unwrap().error.is_none());
        let pending = pending_import(&a).unwrap().expect("remote commits → import");
        let r = apply_import(&db_a, &a, &pending, Some(exp.mark)).unwrap();
        assert!(r.pages_skipped_local_edits.contains(&"P".to_string()));
        assert_eq!(contents(&db_a, &p.id), vec!["edited mid-sync", "late"]);
        assert_eq!(contents(&db_a, &q.id), vec!["q from B"]);

        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(contents(&db_b, &p.id), vec!["edited mid-sync", "late"]);
    }

    // #10: trashing a page on one device removes its file; the other device moves
    // the page to trash (not a hard delete) when the pull removes the file.
    #[test]
    fn test_deletion_propagates_to_trash() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let keep = db_a.create_page("Keep", None, false, None, "user").unwrap();
        let gone = db_a.create_page("Gone", None, false, None, "user").unwrap();
        db_a.create_block(&gone.id, "bye", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert!(db_b.get_page(&gone.id).unwrap().is_some());

        db_a.trash_page(&gone.id).unwrap();
        cycle(&a, &db_a);
        assert!(!a.join("Gone.md").exists());
        cycle(&b, &db_b);
        assert!(db_b.is_trashed(&gone.id).unwrap(), "deletion must propagate as trash");
        assert!(!db_b.is_trashed(&keep.id).unwrap());
        assert_eq!(contents(&db_b, &gone.id), vec!["bye"], "soft delete keeps content");

        // And it doesn't bounce back.
        cycle(&a, &db_a);
        assert!(db_a.is_trashed(&gone.id).unwrap());
        assert!(!a.join("Gone.md").exists());
    }

    // #4 via git: a new device's same-titled page (e.g. today's journal) is not
    // overwritten by the remote page with a different id.
    #[test]
    fn test_same_title_different_id_not_clobbered() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let pa = db_a.create_page("Sep 30th, 2026", None, false, None, "user").unwrap();
        db_a.create_block(&pa.id, "A journal", None, None, "user").unwrap();
        let pb = db_b.create_page("Sep 30th, 2026", None, false, None, "user").unwrap();
        db_b.create_block(&pb.id, "B journal", None, None, "user").unwrap();
        // Both devices write the same filename → a git add/add conflict on B's first
        // sync (B's version stays in place, A's is kept as a conflict copy). The
        // id-based import then converges: both pages exist on both devices under
        // distinct titles and neither page's blocks are overwritten.
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(contents(&db_b, &pb.id), vec!["B journal"], "local page not clobbered");
        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(contents(db, &pa.id), vec!["A journal"]);
            assert_eq!(contents(db, &pb.id), vec!["B journal"]);
            let pa_t = db.get_page(&pa.id).unwrap().unwrap().title;
            let pb_t = db.get_page(&pb.id).unwrap().unwrap().title;
            assert_ne!(pa_t, pb_t);
        }
    }

    fn board(db: &Database, id: &str) -> Option<String> {
        db.get_whiteboard(id).unwrap().map(|w| w.data)
    }

    // Whiteboards travel as `.minotes-whiteboards/<id>.json` sidecars: A draws, B
    // sees it; B edits, A sees B's edit; nothing reverts in steady state.
    #[test]
    fn test_two_devices_whiteboard_sync() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();

        let p = db_a.create_page("Sketches", None, false, None, "user").unwrap();
        db_a.create_block(&p.id, "{{whiteboard:wb-1}}", None, None, "user").unwrap();
        db_a.save_whiteboard("wb-1", r#"{"strokes":["A1"]}"#).unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(board(&db_b, "wb-1").as_deref(), Some(r#"{"strokes":["A1"]}"#));

        std::thread::sleep(std::time::Duration::from_millis(5));
        db_b.save_whiteboard("wb-1", r#"{"strokes":["A1","B2"]}"#).unwrap();
        cycle(&b, &db_b);
        cycle(&a, &db_a);
        assert_eq!(board(&db_a, "wb-1").as_deref(), Some(r#"{"strokes":["A1","B2"]}"#));

        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(board(db, "wb-1").as_deref(), Some(r#"{"strokes":["A1","B2"]}"#), "no revert");
        }

        // Concurrent edits: both devices change the board before syncing. The
        // sidecar conflicts in git; the newer drawing wins on both devices.
        db_a.save_whiteboard("wb-1", r#"{"strokes":["A-late"]}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db_b.save_whiteboard("wb-1", r#"{"strokes":["B-later"]}"#).unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        for db in [&db_a, &db_b] {
            assert_eq!(board(db, "wb-1").as_deref(), Some(r#"{"strokes":["B-later"]}"#));
        }
    }

    // #4: folder identity on disk — a rename on A renames (not duplicates) the
    // folder on B; trashing a folder on either side trashes it on the other;
    // empty folders round-trip.
    #[test]
    fn test_two_devices_folder_rename_and_delete() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();

        let inbox = db_a.create_folder("Inbox", None, None, None, "user").unwrap();
        let old = db_a.create_folder("Old", None, None, None, "user").unwrap();
        let empty = db_a.create_folder("Empty", None, None, None, "user").unwrap();
        let pi = db_a.create_page("In inbox", None, false, None, "user").unwrap();
        db_a.move_page_to_folder(&pi.id, Some(&inbox.id), "user").unwrap();
        let po = db_a.create_page("In old", None, false, None, "user").unwrap();
        db_a.move_page_to_folder(&po.id, Some(&old.id), "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        for f in [&inbox, &old, &empty] {
            assert_eq!(db_b.get_folder(&f.id).unwrap().unwrap().name, f.name, "same folder id on B");
        }

        // Rename on A.
        db_a.rename_folder(&inbox.id, "Outbox", "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(db_b.get_folder(&inbox.id).unwrap().unwrap().name, "Outbox");
        assert_eq!(db_b.get_page(&pi.id).unwrap().unwrap().folder_id, Some(inbox.id));
        let names = |db: &Database| {
            let mut v: Vec<String> = db.list_folders(None).unwrap().into_iter().map(|f| f.name).collect();
            v.sort();
            v
        };
        assert_eq!(names(&db_b), vec!["Empty", "Old", "Outbox"], "old name must not linger");
        assert!(!b.join("Inbox").exists());

        // Trash on A → trashed on B (with its page).
        db_a.trash_folder(&old.id).unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert!(db_b.list_trash().unwrap().iter().any(|t| t.id == old.id.to_string() && t.item_type == "folder"));
        assert!(db_b.is_trashed(&po.id).unwrap());

        // Trash an (empty) folder on B → trashed on A.
        db_b.trash_folder(&empty.id).unwrap();
        cycle(&b, &db_b);
        cycle(&a, &db_a);
        assert!(db_a.list_trash().unwrap().iter().any(|t| t.id == empty.id.to_string()));

        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for (db, dir) in [(&db_a, &a), (&db_b, &b)] {
            assert_eq!(names(db), vec!["Outbox"]);
            assert!(dir.join("Outbox").join(crate::repo::export::FOLDER_MARKER).exists());
            assert!(!dir.join("Old").exists() && !dir.join("Empty").exists());
        }
    }

    // #6: B imports a page and permanently deletes it before B ever exported it.
    // The file is still pruned (the delete propagates to A as trash) and the page
    // does not come back on B.
    #[test]
    fn test_page_purged_before_first_export_propagates() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let keep = db_a.create_page("Keep", None, false, None, "user").unwrap();
        let p = db_a.create_page("Doomed", None, false, None, "user").unwrap();
        db_a.create_block(&p.id, "x", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b); // B imports; B's own export (phase 1) ran BEFORE the import
        assert!(db_b.get_page(&p.id).unwrap().is_some());
        db_b.permanently_delete_page(&p.id, "user").unwrap();

        cycle(&b, &db_b);
        assert!(!b.join("Doomed.md").exists(), "purged page's file pruned");
        assert!(db_b.get_page(&p.id).unwrap().is_none(), "not re-imported");
        cycle(&a, &db_a);
        assert!(db_a.is_trashed(&p.id).unwrap(), "deletion reaches A as trash");
        assert!(!db_a.is_trashed(&keep.id).unwrap());
        cycle(&b, &db_b);
        assert!(db_b.get_page(&p.id).unwrap().is_none());
    }

    fn cycle_any(dir: &Path, db: &Database) -> GitSyncResult {
        sync_cycle_in_dir(dir, || Ok(db)).unwrap()
    }

    // P0: another device deleting most of the notebook is HELD, shown to the user,
    // and NOT silently undone by the next export; "Move to trash" applies it.
    #[test]
    fn test_mass_delete_guard_is_surfaced_and_held() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for i in 0..30 {
            let p = db_a.create_page(&format!("Note {i:02}"), None, false, None, "user").unwrap();
            db_a.create_block(&p.id, &format!("body {i}"), None, None, "user").unwrap();
            ids.push(p.id);
        }
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(db_b.list_pages(None).unwrap().len(), 30);
        // B also has today's journal and an archived page: neither is one of
        // "the pages" the notice counts (the sidebar doesn't count them either).
        let today = db_b.get_or_create_journal(chrono::Local::now().date_naive(), None, "user").unwrap();
        db_b.create_block(&today.id, "today on B", None, None, "user").unwrap();
        let old = db_b.create_page("Archived on B", None, false, None, "user").unwrap();
        db_b.archive_page(&old.id).unwrap();

        // A deletes 25 of 30 pages.
        for id in &ids[..25] {
            db_a.trash_page(id).unwrap();
        }
        cycle(&a, &db_a);
        let r = cycle(&b, &db_b);
        let held = r.held_deletions.clone().expect("guard trip is reported");
        assert_eq!(held.pages, 25);
        assert_eq!(held.total_pages, 30, "pages only: no journal days, nothing archived");
        assert_eq!(held.journals, 0);
        assert!(held.titles.contains(&"Note 00".to_string()));
        assert!(r.import_errors.is_empty(), "a held deletion is not an import error");
        assert_eq!(db_b.list_pages(None).unwrap().len(), 31, "nothing trashed without the user (30 + the journal)");

        // Further cycles keep holding: the files are NOT written back (that would
        // undo A's deletion everywhere), and the notice persists.
        for _ in 0..2 {
            let r = cycle(&b, &db_b);
            assert_eq!(r.held_deletions.as_ref().map(|h| h.pages), Some(25));
        }
        assert!(!b.join("Note 00.md").exists());
        cycle(&a, &db_a);
        assert!(db_a.is_trashed(&ids[0]).unwrap(), "A's deletion is not reverted");
        assert!(!a.join("Note 00.md").exists());

        // Editing a held page here keeps it (an edit beats a deletion).
        db_b.create_block(&ids[24], "kept by B", None, None, "user").unwrap();
        let r = cycle(&b, &db_b);
        assert_eq!(r.held_deletions.as_ref().map(|h| h.pages), Some(24));
        assert!(b.join("Note 24.md").exists());

        // "Move to trash" applies the rest.
        let n = resolve_held_deletions_in_dir(&db_b, &b, true).unwrap();
        assert_eq!(n, 24);
        assert!(db_b.is_trashed(&ids[0]).unwrap());
        assert!(!db_b.is_trashed(&ids[24]).unwrap());
        let r = cycle(&b, &db_b);
        assert!(r.held_deletions.is_none());
        assert_eq!(db_b.list_pages(None).unwrap().len(), 7, "5 notes + Note 24 + the journal");
    }

    #[test]
    fn test_keep_held_deletions_restores_files() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for i in 0..4 {
            ids.push(db_a.create_page(&format!("P{i}"), None, false, None, "user").unwrap().id);
        }
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        for id in &ids[..3] {
            db_a.trash_page(id).unwrap(); // 3 of 4 > half
        }
        cycle(&a, &db_a);
        assert_eq!(cycle(&b, &db_b).held_deletions.map(|h| h.pages), Some(3));
        assert_eq!(resolve_held_deletions_in_dir(&db_b, &b, false).unwrap(), 0);
        let r = cycle(&b, &db_b);
        assert!(r.held_deletions.is_none());
        assert!(b.join("P0.md").exists(), "kept pages are exported again");
        assert!(!db_b.is_trashed(&ids[0]).unwrap());
    }

    // UX Wave 4: the review lists every held item (ids, to open one) and a
    // partial keep trashes the rest; kept pages come back on the other device.
    #[test]
    fn test_partial_keep_of_held_deletions() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for i in 0..25 {
            ids.push(db_a.create_page(&format!("N{i:02}"), None, false, None, "user").unwrap().id);
        }
        let f = db_a.create_folder("Proj", None, None, None, "user").unwrap();
        db_a.move_page_to_folder(&ids[0], Some(&f.id), "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        for id in &ids[..22] {
            db_a.trash_page(id).unwrap();
        }
        cycle(&a, &db_a);
        let held = cycle(&b, &db_b).held_deletions.expect("held");
        assert_eq!(held.items.len(), 22, "every held page, not only the first 20 titles");
        assert!(held.items.iter().any(|i| i.id == ids[21] && i.title == "N21" && i.kind == "page"));
        // Keep N00 (in a project) and N05.
        let keep: HashSet<Uuid> = [ids[0], ids[5]].into_iter().collect();
        let n = resolve_held_deletions_keeping(&db_b, &b, true, &keep).unwrap();
        assert_eq!(n, 20, "20 pages trashed, the 2 kept ones stay");
        assert!(!db_b.is_trashed(&ids[0]).unwrap() && !db_b.is_trashed(&ids[5]).unwrap());
        assert!(db_b.is_trashed(&ids[1]).unwrap() && db_b.is_trashed(&ids[21]).unwrap());
        assert!(db_b.get_folder(&f.id).unwrap().is_some());
        assert!(cycle(&b, &db_b).held_deletions.is_none());
        assert!(b.join("N05.md").exists(), "a kept page is exported again");
        cycle(&a, &db_a);
        assert!(a.join("N05.md").exists(), "and reaches the other device again");
    }

    // P0: an import failure is a failed sync (not "success"), and is retried.
    #[test]
    fn test_import_errors_reach_the_result() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        db_a.create_page("Fine", None, false, None, "user").unwrap();
        let poison = db_a.create_page("Poison", None, false, None, "user").unwrap();
        cycle(&a, &db_a);
        db_b.conn
            .execute_batch(
                "CREATE TEMP TRIGGER no_poison BEFORE INSERT ON pages WHEN NEW.title = 'Poison'
                 BEGIN SELECT RAISE(ABORT, 'poisoned'); END;",
            )
            .unwrap();
        let r = cycle_any(&b, &db_b);
        assert!(!r.success, "import errors make the sync unsuccessful");
        assert!(!r.offline);
        assert!(r.import_errors.iter().any(|e| e.contains("Poison")), "{:?}", r.import_errors);
        assert!(r.error.as_deref().unwrap_or("").contains("import"), "{:?}", r.error);
        assert!(db_b.get_page_by_title("Fine").unwrap().is_some(), "the rest went in");
        db_b.conn.execute_batch("DROP TRIGGER no_poison").unwrap();
        let r = cycle_any(&b, &db_b);
        assert!(r.success, "{:?}", r.error);
        assert!(db_b.get_page(&poison.id).unwrap().is_some(), "retried next cycle");
    }

    // P0: an unreachable remote is "offline", not a hard failure — but a remote
    // that is gone (moved, deleted, mistyped) is an error the user must see, not
    // a quiet grey "Offline" (UX review, Sync error states).
    #[test]
    fn test_missing_remote_is_an_error_not_offline() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (remote, a, _b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        db_a.create_page("X", None, false, None, "user").unwrap();
        cycle(&a, &db_a);
        std::fs::rename(&remote, tmp.path().join("gone.git")).unwrap();
        let r = cycle_any(&a, &db_a);
        assert!(!r.success);
        assert!(!r.offline, "{:?}", r.error);
        assert_eq!(r.error_kind.as_deref(), Some(SYNC_ERR_REMOTE_NOT_FOUND), "{:?}", r.error);
        assert!(r.error.as_deref().unwrap_or("").contains("Remote not found"), "{:?}", r.error);

        // A host that can't be resolved is offline (retried quietly).
        git_cmd::run_git(&a, &["remote", "set-url", "origin", "https://nonexistent.invalid/notes.git"]).unwrap();
        let r = cycle_any(&a, &db_a);
        assert!(!r.success);
        assert!(r.offline, "{:?}", r.error);

        for (msg, kind) in [
            ("fatal: unable to access 'https://x/': Could not resolve host: x", SYNC_ERR_OFFLINE),
            ("Network error — can't reach the sync remote. Check your internet connection", SYNC_ERR_OFFLINE),
            ("Authentication failed — check your SSH keys or credentials", SYNC_ERR_AUTH),
            ("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found", SYNC_ERR_REMOTE_NOT_FOUND),
            ("fatal: '/tmp/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", SYNC_ERR_REMOTE_NOT_FOUND),
            ("Could not import 1 file(s) from the other device: x", SYNC_ERR_OTHER),
        ] {
            assert_eq!(sync_error_kind(msg), kind, "{msg}");
            assert_eq!(sync_error_kind(&git_cmd::classify_git_error(msg)), kind, "classified: {msg}");
        }
    }

    // "Last synced" only after the remote has it: never for a notebook without a
    // remote (that only commits locally), and the last error is kept until a
    // cycle reaches the remote again.
    #[test]
    fn test_status_is_honest_about_the_remote() {
        if !git_cmd::git_available() {
            return;
        }
        let _home = crate::notebook::tests::FakeHome::new();
        let db = Database::open_in_memory().unwrap();
        db.create_page("Local only", None, false, None, "user").unwrap();
        let s = enable_sync(&db, "default").unwrap();
        assert!(s.enabled && s.remote_url.is_none());
        assert_eq!(s.last_sync, None, "no remote: nothing was synced anywhere");
        let r = full_sync(&db, "default").unwrap();
        assert!(r.success && r.no_remote);
        let s = get_sync_status("default").unwrap();
        assert_eq!(s.last_sync, None);
        assert_eq!(s.last_error, None);

        // A remote that isn't there.
        let dir = sync_dir_for_notebook("default");
        let missing = dir.parent().unwrap().join("missing.git");
        git_cmd::run_git(&dir, &["remote", "add", "origin", missing.to_str().unwrap()]).unwrap();
        let r = full_sync(&db, "default").unwrap();
        assert!(!r.success && !r.offline && !r.no_remote);
        let s = get_sync_status("default").unwrap();
        assert_eq!(s.last_sync, None);
        assert_eq!(s.last_error_kind.as_deref(), Some(SYNC_ERR_REMOTE_NOT_FOUND), "{:?}", s.last_error);

        // The remote appears: synced, error cleared.
        git_cmd::run_git(dir.parent().unwrap(), &["init", "--bare", "-q", missing.to_str().unwrap()]).unwrap();
        let r = full_sync(&db, "default").unwrap();
        assert!(r.success, "{:?}", r.error);
        let s = get_sync_status("default").unwrap();
        assert!(s.last_sync.is_some());
        assert_eq!(s.last_error, None);
    }

    // Sync on top of the mirror: a notebook's sync dir IS its mirror, and the
    // mirror's incremental state stays valid across sync cycles.
    #[test]
    fn test_sync_commits_the_notebook_mirror() {
        if !git_cmd::git_available() {
            return;
        }
        let _home = crate::notebook::tests::FakeHome::new();
        let root = _home.path().join("Book");
        let nb = crate::notebook::create_in_folder(&root, "Book").unwrap();
        assert_eq!(sync_dir_for_notebook(&nb.key), root.join("notes"));
        let db = nb.open_db().unwrap();
        let p = db.create_page("Hello", None, false, None, "user").unwrap();
        let target = MirrorTarget::for_notebook(&nb);
        crate::mirror::run(&db, &target, false).unwrap();
        assert!(root.join("notes/Hello.md").exists(), "the mirror runs without git");
        git_cmd::init_repo(&root.join("notes")).unwrap();
        git_cmd::tests::configure_test_repo(&root.join("notes"));
        let r = sync_cycle(&target, || Ok(&db)).unwrap();
        assert!(r.success, "{:?}", r.error);
        assert!(git_cmd::rev_parse_head(&root.join("notes")).unwrap().is_some(), "committed");
        db.create_block(&p.id, "after sync", None, None, "user").unwrap();
        let rep = crate::mirror::run(&db, &target, false).unwrap();
        assert!(!rep.full, "state still valid after a sync cycle");
        assert_eq!(rep.written_paths, vec!["Hello.md".to_string()]);
    }

    fn mirror_target(root: &Path, name: &str) -> MirrorTarget {
        MirrorTarget::new(root.join(name), Some(root.join(format!("{name}-mirror-state.json"))))
    }

    fn in_order(db: &Database, page: &Uuid) -> Vec<String> {
        db.get_page_blocks(page).unwrap().into_iter().map(|b| b.content).collect()
    }

    /// One cycle on A with an edit made during its network phase (F-2 setup).
    fn cycle_with_edit_mid_network(a: &Path, db_a: &Database, edit: impl FnOnce()) -> SyncResult {
        let exp = export_and_commit(db_a, a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        edit();
        assert!(git_pull_push(a).unwrap().error.is_none());
        let pending = pending_import(a).unwrap().expect("remote commits");
        apply_import(db_a, a, &pending, Some(exp.mark)).unwrap()
    }

    fn titles(db: &Database) -> Vec<String> {
        let mut v: Vec<String> = db.list_pages(None).unwrap().into_iter().map(|p| p.title).collect();
        v.sort();
        v
    }

    // F-2: B edits block 2, A edits block 1 of the same page while A's sync is
    // on the network: both edits survive on both devices, no conflict page.
    #[test]
    fn test_remote_edit_survives_a_local_edit_during_sync() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("P", None, false, None, "user").unwrap();
        let b1 = db_a.create_block(&p.id, "first", None, None, "user").unwrap();
        let b2 = db_a.create_block(&p.id, "second", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        db_b.update_block(&b2.id, Some("second EDITED ON B"), "user").unwrap();
        let b3 = db_b.create_block(&p.id, "third, new on B", None, None, "user").unwrap();
        db_b.set_property(&b1.id, "block", "status", "done", "text", "user").unwrap();
        cycle(&b, &db_b);

        let r = cycle_with_edit_mid_network(&a, &db_a, || {
            db_a.update_block(&b1.id, Some("first edited on A"), "user").unwrap();
        });
        assert!(r.pages_skipped_local_edits.contains(&"P".to_string()));
        assert_eq!(r.pages_merged, vec!["P".to_string()]);
        assert!(r.conflict_copies.is_empty(), "{:?}", r.conflict_copies);
        assert_eq!(in_order(&db_a, &p.id), vec!["first edited on A", "second EDITED ON B", "third, new on B"]);
        assert_eq!(props_of(&db_a, &b1.id), kv(&[("status", "done")]));

        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(in_order(db, &p.id), vec!["first edited on A", "second EDITED ON B", "third, new on B"]);
            assert_eq!(titles(db), vec!["P".to_string()], "no conflict page");
            assert!(db.get_block(&b3.id).unwrap().is_some());
        }
    }

    // F-2: both sides change the same block: the local text stays in place and
    // the remote version is kept as a "(conflict from …)" page, on both devices.
    #[test]
    fn test_same_block_edited_on_both_sides_keeps_a_conflict_copy() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("P", None, false, None, "user").unwrap();
        let b1 = db_a.create_block(&p.id, "first", None, None, "user").unwrap();
        let b2 = db_a.create_block(&p.id, "second", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        db_b.update_block(&b1.id, Some("first from B"), "user").unwrap();
        db_b.update_block(&b2.id, Some("second from B"), "user").unwrap();
        cycle(&b, &db_b);

        let r = cycle_with_edit_mid_network(&a, &db_a, || {
            db_a.update_block(&b1.id, Some("first from A"), "user").unwrap();
        });
        assert_eq!(r.conflict_copies.len(), 1, "{r:?}");
        assert_eq!(in_order(&db_a, &p.id), vec!["first from A", "second from B"], "local kept, the rest merged");
        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(in_order(db, &p.id), vec!["first from A", "second from B"]);
            let pages = db.list_pages(None).unwrap();
            assert_eq!(pages.len(), 2, "{:?}", titles(db));
            let copy = pages.iter().find(|x| x.title.starts_with("P (conflict from ")).expect("conflict page");
            assert_eq!(in_order(db, &copy.id), vec!["first from B", "second from B"]);
        }
    }

    // F-2: no spurious copies — a page edited here mid-sync whose file the pull
    // didn't change stays as it is, with no conflict page.
    #[test]
    fn test_protected_page_untouched_by_the_pull_makes_no_copy() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("P", None, false, None, "user").unwrap();
        let pb = db_a.create_block(&p.id, "p1", None, None, "user").unwrap();
        let q = db_a.create_page("Q", None, false, None, "user").unwrap();
        let qb = db_a.create_block(&q.id, "q1", None, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        db_b.update_block(&qb.id, Some("q from B"), "user").unwrap();
        cycle(&b, &db_b);
        let r = cycle_with_edit_mid_network(&a, &db_a, || {
            db_a.update_block(&pb.id, Some("p edited mid-sync"), "user").unwrap();
        });
        assert!(r.pages_merged.is_empty() && r.conflict_copies.is_empty(), "{r:?}");
        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(titles(db), vec!["P".to_string(), "Q".to_string()]);
            assert_eq!(in_order(db, &p.id), vec!["p edited mid-sync"]);
            assert_eq!(in_order(db, &q.id), vec!["q from B"]);
        }
    }

    fn props_of(db: &Database, id: &Uuid) -> Vec<(String, String)> {
        db.get_properties(id).unwrap().into_iter().map(|p| (p.key, p.value.unwrap_or_default())).collect()
    }

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // F-7: block properties travel through git both ways; a property-only edit
    // changes the file; removing one removes it on the other device.
    #[test]
    fn test_block_properties_sync_both_ways() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("P", None, false, None, "user").unwrap();
        let blk = db_a.create_block(&p.id, "card", None, None, "user").unwrap();
        let kid = db_a.create_block(&p.id, "child", Some(&blk.id), None, "user").unwrap();
        db_a.set_property(&blk.id, "block", "status", "done", "text", "user").unwrap();
        db_a.set_property(&kid.id, "block", "note", "two\nlines", "text", "user").unwrap();
        cycle(&a, &db_a);
        let file = std::fs::read_to_string(a.join("P.md")).unwrap();
        assert!(file.contains("\n  status:: done\n"), "{file}");
        cycle(&b, &db_b);
        assert_eq!(props_of(&db_b, &blk.id), kv(&[("status", "done")]));
        assert_eq!(props_of(&db_b, &kid.id), kv(&[("note", "two\nlines")]));
        assert_eq!(in_order(&db_b, &p.id), vec!["card", "child"], "property lines are not blocks");

        // B: property-only edits (change one, add one).
        db_b.set_property(&blk.id, "block", "status", "doing", "text", "user").unwrap();
        db_b.set_property(&blk.id, "block", "due", "2026-10-20", "text", "user").unwrap();
        cycle(&b, &db_b);
        assert!(std::fs::read_to_string(b.join("P.md")).unwrap().contains("status:: doing"));
        cycle(&a, &db_a);
        assert_eq!(props_of(&db_a, &blk.id), kv(&[("due", "2026-10-20"), ("status", "doing")]));

        // A removes one: gone on B too.
        db_a.delete_property(&blk.id, "due", "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        assert_eq!(props_of(&db_b, &blk.id), kv(&[("status", "doing")]));
        // Steady state.
        for _ in 0..2 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        for db in [&db_a, &db_b] {
            assert_eq!(props_of(db, &blk.id), kv(&[("status", "doing")]));
            assert_eq!(in_order(db, &p.id), vec!["card", "child"]);
        }
    }

    // F-7: `::` in block text is not a property; property values round-trip;
    // re-rendering is stable (no mirror churn).
    #[test]
    fn test_block_property_format_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let target = mirror_target(tmp.path(), "notes");
        let p = db.create_page("Fmt", None, false, None, "user").unwrap();
        let texts = [
            "key:: value at the start of the block text",
            "C++ uses a::b and Logseq-style status:: inline",
            "multi\nnote:: in a continuation line\nend",
        ];
        let mut ids = Vec::new();
        for t in texts {
            ids.push(db.create_block(&p.id, t, None, None, "user").unwrap().id);
        }
        db.set_property(&ids[1], "block", "quoted", "\"starts with a quote", "text", "user").unwrap();
        db.set_property(&ids[1], "block", "spaces", "  padded  ", "text", "user").unwrap();
        db.set_property(&ids[1], "block", "colons", "a:: b", "text", "user").unwrap();
        db.set_property(&ids[2], "block", "bad key", "local only", "text", "user").unwrap();
        crate::mirror::run(&db, &target, false).unwrap();

        // Another database imports the file: same blocks, same properties.
        let db2 = Database::open_in_memory().unwrap();
        db2.sync_dir_with(&target.dir, "test", &SyncOptions::default()).unwrap();
        let got: Vec<String> = in_order(&db2, &p.id);
        assert_eq!(got, texts.to_vec());
        assert!(props_of(&db2, &ids[0]).is_empty());
        assert_eq!(props_of(&db2, &ids[1]), kv(&[("colons", "a:: b"), ("quoted", "\"starts with a quote"), ("spaces", "  padded  ")]));
        assert!(props_of(&db2, &ids[2]).is_empty(), "keys that can't be written stay local");

        // Importing its own file back changes nothing, and passes don't rewrite.
        let r = db.sync_dir_with(&target.dir, "test", &SyncOptions::default()).unwrap();
        assert!(r.pages_updated.is_empty(), "{:?}", r.pages_updated);
        assert_eq!(props_of(&db, &ids[2]), kv(&[("bad key", "local only")]), "local-only key kept");
        for full in [false, true, false] {
            let rep = crate::mirror::run(&db, &target, full).unwrap();
            assert_eq!(rep.files_written, 0, "full={full}: {:?}", rep.written_paths);
        }
        // A property-only edit re-renders exactly that page.
        db.set_property(&ids[0], "block", "status", "done", "text", "user").unwrap();
        let rep = crate::mirror::run(&db, &target, false).unwrap();
        assert_eq!(rep.written_paths, vec!["Fmt.md".to_string()]);
    }

    // F-1: edits the mirror has not written yet (debounce, failed pass) survive
    // turning sync on — the stale file is never imported over them.
    #[test]
    fn test_enable_keeps_unmirrored_edits() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let target = mirror_target(tmp.path(), "notes");
        let p = db.create_page("P", None, false, None, "user").unwrap();
        let b = db.create_block(&p.id, "old text", None, None, "user").unwrap();
        crate::mirror::run(&db, &target, false).unwrap();
        // Not mirrored yet (the 2 s debounce).
        db.update_block(&b.id, Some("NEW text typed just now"), "user").unwrap();
        db.create_block(&p.id, "brand new block", None, None, "user").unwrap();
        git_cmd::init_repo(&target.dir).unwrap();
        git_cmd::tests::configure_test_repo(&target.dir);
        enable_in_dir(&target, &|| Ok::<&Database, Error>(&db)).unwrap();
        assert_eq!(in_order(&db, &p.id), vec!["NEW text typed just now", "brand new block"]);
        let file = std::fs::read_to_string(target.dir.join("P.md")).unwrap();
        assert!(file.contains("NEW text typed just now") && file.contains("brand new block"), "{file}");
        let (log, _, _) = git_cmd::run_git(&target.dir, &["show", "HEAD:P.md"]).unwrap();
        assert!(log.contains("brand new block"), "the database's version is committed");
        assert!(db.list_trash().unwrap().is_empty(), "nothing parked: nothing was removed");
    }

    // F-1: a notebook whose mirror was off (Android without sync, or switched off
    // in its settings) for weeks: re-enabling sync keeps every edit made since,
    // rewrites the old files, and the other device gets the edits.
    #[test]
    fn test_reenable_after_weeks_with_mirror_off_keeps_the_database() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let ta = MirrorTarget::new(&a, Some(tmp.path().join("a-state.json")));
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("Diary", None, false, None, "user").unwrap();
        let keep = db_a.create_block(&p.id, "week 1", None, None, "user").unwrap();
        let gone = db_a.create_block(&p.id, "to be deleted", None, None, "user").unwrap();
        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();
        cycle(&b, &db_b);
        assert_eq!(in_order(&db_b, &p.id), vec!["week 1", "to be deleted"]);

        // Sync off, mirror off: weeks of edits that never reach the files.
        db_a.update_block(&keep.id, Some("week 1, revised in week 5"), "user").unwrap();
        db_a.delete_block(&gone.id, "user").unwrap();
        db_a.create_block(&p.id, "week 6", None, None, "user").unwrap();
        let q = db_a.create_page("New in week 4", None, false, None, "user").unwrap();
        db_a.create_block(&q.id, "fresh", None, None, "user").unwrap();
        let stale = std::fs::read_to_string(a.join("Diary.md")).unwrap();
        assert!(stale.contains("to be deleted"), "the files are weeks old");

        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();
        assert_eq!(in_order(&db_a, &p.id), vec!["week 1, revised in week 5", "week 6"], "nothing reverted");
        assert_eq!(in_order(&db_a, &q.id), vec!["fresh"]);
        let file = std::fs::read_to_string(a.join("Diary.md")).unwrap();
        assert!(file.contains("week 6") && !file.contains("to be deleted"), "the files were rewritten: {file}");

        cycle(&b, &db_b);
        assert_eq!(in_order(&db_b, &p.id), vec!["week 1, revised in week 5", "week 6"]);
        assert_eq!(in_order(&db_b, &q.id), vec!["fresh"]);
        // And it doesn't bounce back.
        sync_cycle(&ta, || Ok(&db_a)).unwrap();
        assert_eq!(in_order(&db_a, &p.id), vec!["week 1, revised in week 5", "week 6"]);
    }

    // F-1: what the pull does bring is imported on enable — and blocks the other
    // device removed go to the Trash (restorable), not away.
    #[test]
    fn test_enable_imports_the_pull_and_parks_removed_blocks() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let ta = MirrorTarget::new(&a, Some(tmp.path().join("a-state.json")));
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("Shared", None, false, None, "user").unwrap();
        let one = db_a.create_block(&p.id, "one", None, None, "user").unwrap();
        let two = db_a.create_block(&p.id, "two", None, None, "user").unwrap();
        let mine = db_a.create_page("Only A edits", None, false, None, "user").unwrap();
        let m1 = db_a.create_block(&mine.id, "a1", None, None, "user").unwrap();
        let doomed = db_a.create_page("Trashed on B", None, false, None, "user").unwrap();
        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();
        cycle(&b, &db_b);
        db_b.trash_page(&doomed.id).unwrap();

        // A turns sync off. B edits and deletes; A edits its own page meanwhile.
        db_b.update_block(&one.id, Some("one, from B"), "user").unwrap();
        db_b.delete_block(&two.id, "user").unwrap();
        cycle(&b, &db_b);
        db_a.update_block(&m1.id, Some("a1 edited while sync was off"), "user").unwrap();

        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();
        assert_eq!(in_order(&db_a, &p.id), vec!["one, from B"], "the pull is imported");
        assert_eq!(in_order(&db_a, &mine.id), vec!["a1 edited while sync was off"], "local edit kept");
        assert!(db_a.is_trashed(&doomed.id).unwrap(), "the pull's deletion reaches the Trash");
        assert!(!a.join("Trashed on B.md").exists(), "and is not written back");
        let removed = db_a.get_block(&two.id).unwrap().expect("parked, not deleted");
        let parked = db_a.get_page(&removed.page_id).unwrap().unwrap();
        assert!(parked.title.starts_with("Shared (removed by sync"), "{}", parked.title);
        assert!(db_a.is_trashed(&parked.id).unwrap());
        cycle(&b, &db_b);
        assert_eq!(in_order(&db_b, &mine.id), vec!["a1 edited while sync was off"]);
    }

    // F-4: a symlink committed by someone with push access is checked out as a
    // plain file on the other device (core.symlinks=false), never followed.
    #[cfg(unix)]
    #[test]
    fn test_symlink_from_a_shared_remote_is_never_followed() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        db_a.create_page("Home", None, false, None, "user").unwrap();
        cycle(&a, &db_a);
        cycle(&b, &db_b);
        // The attacker's device commits links to a secret on the victim's disk.
        let secret = tmp.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY\n").unwrap();
        std::os::unix::fs::symlink(&secret, a.join("evil.md")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), a.join("Escape")).unwrap();
        let (_, e, ok) = git_cmd::run_git(&a, &["add", "-A"]).unwrap();
        assert!(ok, "{e}");
        git_cmd::commit_all(&a, "links").unwrap();
        git_cmd::push(&a).unwrap();

        let tb = MirrorTarget::new(&b, Some(tmp.path().join("b-state.json")));
        sync_cycle(&tb, || Ok(&db_b)).unwrap();
        for name in ["evil.md", "Escape"] {
            let meta = std::fs::symlink_metadata(b.join(name)).unwrap();
            assert!(!meta.file_type().is_symlink(), "{name} was checked out as a link");
        }
        let (cfg, _, _) = git_cmd::run_git(&b, &["config", "--local", "--get", "core.symlinks"]).unwrap();
        assert_eq!(cfg.trim(), "false");
        let all: Vec<String> = db_b
            .list_pages(None)
            .unwrap()
            .iter()
            .flat_map(|p| in_order(&db_b, &p.id))
            .collect();
        assert!(all.iter().all(|c| !c.contains("PRIVATE KEY")), "{all:?}");
        for _ in 0..2 {
            sync_cycle(&tb, || Ok(&db_b)).unwrap();
        }
        let (tree, _, _) = git_cmd::run_git(&a, &["ls-tree", "-r", "origin/main"]).unwrap();
        assert!(!tree.contains("PRIVATE KEY"));
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "PRIVATE KEY\n");
    }

    /// A repo copied from someone else: hooks and a repo-local fsmonitor command
    /// that would write `marker` if git ever ran them.
    #[cfg(unix)]
    fn plant_hostile_repo_config(dir: &Path, marker: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let script = format!("#!/bin/sh\necho ran >> '{}'\nexit 0\n", marker.display());
        let hooks = dir.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        for h in ["pre-commit", "post-commit", "commit-msg", "prepare-commit-msg", "post-checkout", "post-merge", "post-rewrite", "pre-push", "pre-rebase", "reference-transaction"] {
            let f = hooks.join(h);
            std::fs::write(&f, &script).unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let fsm = dir.join(".git/fsmonitor-evil");
        std::fs::write(&fsm, &script).unwrap();
        std::fs::set_permissions(&fsm, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut cfg = std::fs::read_to_string(dir.join(".git/config")).unwrap();
        cfg.push_str(&format!("[core]\n\tfsmonitor = {}\n\tsshCommand = {}\n[filter \"evil\"]\n\tclean = {}\n", fsm.display(), fsm.display(), fsm.display()));
        std::fs::write(dir.join(".git/config"), cfg).unwrap();
    }

    // F-6: repo-local hooks and fsmonitor never run during sync.
    #[cfg(unix)]
    #[test]
    fn test_sync_never_runs_repo_hooks_or_fsmonitor() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let marker = tmp.path().join("PWNED");
        plant_hostile_repo_config(&a, &marker);
        // Sanity: plain git in this repo does run them.
        std::fs::write(a.join("probe.txt"), "x").unwrap();
        let st = std::process::Command::new("git")
            .current_dir(&a)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "probe"])
            .status()
            .unwrap();
        assert!(st.success());
        assert!(marker.exists(), "test setup: the hook should run under plain git");
        std::fs::remove_file(&marker).unwrap();
        std::fs::remove_file(a.join("probe.txt")).unwrap();

        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let p = db_a.create_page("Notes", None, false, None, "user").unwrap();
        db_a.create_block(&p.id, "hello", None, None, "user").unwrap();
        let ta = MirrorTarget::new(&a, Some(tmp.path().join("a-state.json")));
        enable_in_dir(&ta, &|| Ok::<&Database, Error>(&db_a)).unwrap();
        cycle(&b, &db_b);
        db_b.create_block(&p.id, "from B", None, None, "user").unwrap();
        cycle(&b, &db_b);
        let q = db_a.create_page("Other", None, false, None, "user").unwrap();
        db_a.create_block(&q.id, "from A", None, None, "user").unwrap();
        for _ in 0..2 {
            let r = sync_cycle(&ta, || Ok(&db_a)).unwrap();
            assert!(r.success, "{:?}", r.error);
        }
        assert_eq!(contents(&db_a, &p.id), vec!["from B", "hello"]);
        cycle(&b, &db_b);
        assert_eq!(contents(&db_b, &q.id), vec!["from A"]);
        assert!(!marker.exists(), "a repo hook or fsmonitor ran: {}", std::fs::read_to_string(&marker).unwrap_or_default());
    }

    #[test]
    fn test_command_config_keys() {
        for k in ["core.fsmonitor", "core.sshCommand", "core.hooksPath", "filter.lfs.clean", "filter.x.process", "merge.ours.driver",
            "diff.pdf.textconv", "credential.helper", "credential.https://x.helper", "gpg.ssh.program", "include.path",
            "includeIf.gitdir:/x/.path", "remote.origin.uploadpack", "alias.st", "core.pager"] {
            assert!(git_cmd::is_command_config_key(k), "{k}");
        }
        for k in ["user.name", "user.email", "remote.origin.url", "remote.origin.fetch", "branch.main.remote", "core.bare", "pull.rebase"] {
            assert!(!git_cmd::is_command_config_key(k), "{k}");
        }
    }

    // F-6: a notebook folder with sync on in its own config, copied from another
    // computer, is not synced on open; confirming strips its command-running git
    // config, records it here, and syncing then works (without running anything).
    #[cfg(unix)]
    #[test]
    fn test_copied_folder_sync_needs_confirmation() {
        if !git_cmd::git_available() {
            return;
        }
        let home = crate::notebook::tests::FakeHome::new();
        let root = home.path().join("Copied");
        let nb = crate::notebook::create_in_folder(&root, "Copied").unwrap();
        let db = nb.open_db().unwrap();
        db.create_page("Hello", None, false, None, "user").unwrap();
        let notes = root.join("notes");
        let remote = home.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        git_cmd::run_git(&remote, &["init", "--bare", "-q"]).unwrap();
        git_cmd::init_repo(&notes).unwrap();
        git_cmd::tests::configure_test_repo(&notes);
        git_cmd::run_git(&notes, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        // As copied: sync on in the folder's own config, no record on this machine.
        write_config(&nb.key, &SyncConfig { enabled: true, last_sync: Some("2026-10-01T09:00:00Z".into()), ..Default::default() }).unwrap();
        let marker = home.path().join("PWNED");
        plant_hostile_repo_config(&notes, &marker);

        assert!(!sync_trusted(&nb.key));
        assert!(get_sync_status(&nb.key).unwrap().needs_confirmation);
        assert_eq!(get_sync_status(&nb.key).unwrap().last_sync, None, "the other computer's time is not shown as ours");
        let r = full_sync_with(&nb.key, || Ok(&db)).unwrap();
        assert!(r.needs_confirmation && !r.success);
        assert_eq!(git_cmd::rev_parse_head(&notes).unwrap(), None, "nothing was committed");

        let removed = confirm_sync(&nb.key).unwrap();
        assert!(removed.iter().any(|k| k == "core.fsmonitor"), "{removed:?}");
        assert!(removed.iter().any(|k| k == "core.sshcommand"), "{removed:?}");
        assert!(removed.iter().any(|k| k == "filter.evil.clean"), "{removed:?}");
        let (name, _, _) = git_cmd::run_git(&notes, &["config", "--local", "--get", "user.name"]).unwrap();
        assert_eq!(name.trim(), "MiNotes Test", "the rest of the config is kept");
        assert!(sync_trusted(&nb.key));
        assert!(!get_sync_status(&nb.key).unwrap().needs_confirmation);
        let r = full_sync_with(&nb.key, || Ok(&db)).unwrap();
        assert!(r.success, "{:?}", r.error);
        assert!(git_cmd::rev_parse_head(&notes).unwrap().is_some());
        assert!(!marker.exists(), "nothing of the copied repo ran");

        // The same folder copied again elsewhere carries the token, but this
        // machine trusts it (it is the user's own copy); another machine's record
        // does not have it.
        std::fs::remove_file(crate::notebook::base_dir().join(TRUST_FILE)).unwrap();
        assert!(!sync_trusted(&nb.key), "a different machine (no record) asks again");

        // Turning sync on yourself is a confirmation too.
        let other = crate::notebook::create_in_folder(&home.path().join("Mine"), "Mine").unwrap();
        let odb = other.open_db().unwrap();
        enable_sync(&odb, &other.key).unwrap();
        assert!(sync_trusted(&other.key));
        assert!(!get_sync_status(&other.key).unwrap().needs_confirmation);
    }

    // Both devices created a "Work" folder independently (e.g. folders created
    // before folder ids were synced): the marker add/add conflict resolves, both
    // devices converge on ONE folder id, and no conflict-copy marker lingers.
    #[test]
    fn test_two_devices_same_named_folder_converges() {
        if !git_cmd::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let db_a = Database::open_in_memory().unwrap();
        let db_b = Database::open_in_memory().unwrap();
        let wa = db_a.create_folder("Work", None, None, None, "user").unwrap();
        let pa = db_a.create_page("From A", None, false, None, "user").unwrap();
        db_a.move_page_to_folder(&pa.id, Some(&wa.id), "user").unwrap();
        let wb = db_b.create_folder("Work", None, None, None, "user").unwrap();
        let pb = db_b.create_page("From B", None, false, None, "user").unwrap();
        db_b.move_page_to_folder(&pb.id, Some(&wb.id), "user").unwrap();

        for _ in 0..3 {
            cycle(&a, &db_a);
            cycle(&b, &db_b);
        }
        let fa = db_a.list_folders(None).unwrap();
        let fb = db_b.list_folders(None).unwrap();
        assert_eq!((fa.len(), fb.len()), (1, 1), "{fa:?} {fb:?}");
        assert_eq!(fa[0].id, fb[0].id, "converged on one folder id");
        for db in [&db_a, &db_b] {
            assert_eq!(db.get_page(&pa.id).unwrap().unwrap().folder_id, Some(fa[0].id));
            assert_eq!(db.get_page(&pb.id).unwrap().unwrap().folder_id, Some(fa[0].id));
        }
        for dir in [&a, &b] {
            let leftovers: Vec<_> = std::fs::read_dir(dir.join("Work"))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.contains("conflict"))
                .collect();
            assert!(leftovers.is_empty(), "{leftovers:?}");
        }
    }
}
