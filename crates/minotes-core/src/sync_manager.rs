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

use std::collections::HashSet;
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

const IMPORT_ACTOR: &str = "git-sync";
const STATE_FILE: &str = "minotes-sync-state.json";

/// The notebook a sync is for (`graph` = the active notebook key).
fn notebook(graph: &str) -> crate::notebook::Notebook {
    crate::notebook::resolve(graph).unwrap_or_else(|_| crate::notebook::Notebook::legacy("default"))
}

/// Sync directory for a graph = its markdown mirror. Legacy notebooks keep
/// `~/MiNotes_Sync` ("default") or `~/MiNotes_Sync-<graph>` (a nested
/// `~/MiNotes_Sync/<graph>` would be tracked by — and imported into — the
/// default graph's repo); notebooks in a folder sync `<folder>/notes`.
pub fn sync_dir_for_graph(graph: &str) -> PathBuf {
    match crate::notebook::resolve(graph) {
        Ok(nb) => nb.mirror_dir(),
        // Not a valid name: never escape HOME.
        Err(_) => crate::notebook::legacy_mirror_dir(&crate::repo::export::sanitize_component(graph)),
    }
}

/// Sync directory of the default graph: ~/MiNotes_Sync
pub fn default_sync_dir() -> PathBuf {
    sync_dir_for_graph("default")
}

fn config_path(graph: &str) -> PathBuf {
    let p = notebook(graph).sync_config_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    p
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncConfig {
    pub enabled: bool,
    pub last_sync: Option<String>,
}

fn read_config(graph: &str) -> SyncConfig {
    std::fs::read_to_string(config_path(graph))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(graph: &str, config: &SyncConfig) -> Result<()> {
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(config_path(graph), json)
        .map_err(|e| Error::Git(format!("Failed to write sync config: {e}")))?;
    Ok(())
}

/// Per-repo sync state (kept inside `.git`, never committed).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RepoState {
    /// Commit whose tree has been fully imported into the DB.
    imported_head: Option<String>,
    /// Deletions from another device that the mass-delete guard refused to
    /// apply, waiting for the user. Their files stay deleted (the mirror does not
    /// write them back) until the user picks "Move to trash" or "Keep them".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held: Option<HeldState>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
struct HeldState {
    page_ids: Vec<Uuid>,
    folder_ids: Vec<Uuid>,
    held_at: String,
}

/// Deletions held back by the mass-delete guard, as shown to the user.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HeldDeletions {
    pub pages: usize,
    pub folders: usize,
    /// Up to 20 page titles (then folder names), for the notice.
    pub titles: Vec<String>,
    /// Pages in the notebook (excluding trash), for "34 of 50".
    pub total_pages: usize,
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

fn read_state(dir: &Path) -> RepoState {
    std::fs::read_to_string(dir.join(".git").join(STATE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(dir: &Path, st: &RepoState) -> Result<()> {
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
    for id in &h.page_ids {
        if titles.len() >= 20 {
            break;
        }
        if let Some(p) = db.get_page(id)? {
            titles.push(p.title);
        }
    }
    for id in &h.folder_ids {
        if titles.len() >= 20 {
            break;
        }
        if let Some(f) = db.get_folder(id)? {
            titles.push(format!("{}/", f.name));
        }
    }
    let total_pages: usize = db.conn.query_row(
        "SELECT COUNT(*) FROM pages WHERE id NOT IN (SELECT page_id FROM trash)",
        [],
        |r| r.get::<_, i64>(0),
    )? as usize;
    Ok(Some(HeldDeletions { pages: h.page_ids.len(), folders: h.folder_ids.len(), titles, total_pages }))
}

/// The user's answer to held deletions. `move_to_trash`: apply them (to trash,
/// recoverable). Otherwise keep the pages: the hold is dropped and the next
/// export writes their files again. Returns how many items were trashed.
///
/// Callers serialise this with sync cycles (hold `mirror::FS_LOCK`, then the DB).
pub fn resolve_held_deletions_in_dir(db: &Database, dir: &Path, move_to_trash: bool) -> Result<usize> {
    let mut st = read_state(dir);
    let Some(h) = st.held.take() else { return Ok(0) };
    let mut n = 0;
    if move_to_trash {
        db.tx(|| {
            for id in &h.folder_ids {
                if db.get_folder(id)?.is_some() {
                    db.trash_folder(id)?;
                    n += 1;
                }
            }
            for id in &h.page_ids {
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

/// [`resolve_held_deletions_in_dir`] for a graph's sync dir.
pub fn resolve_held_deletions(db: &Database, graph: &str, move_to_trash: bool) -> Result<usize> {
    resolve_held_deletions_in_dir(db, &sync_dir_for_graph(graph), move_to_trash)
}

fn ensure_gitignore(dir: &Path) {
    let path = dir.join(".gitignore");
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
        let _ = std::fs::write(&path, out);
    }
}

// ── Import / attachments ──
/// Attachments over the git-sync limit are listed in `_attachments/.gitignore`
/// by the mirror; make sure git also never sees half-copied temp files.
fn ensure_attachment_gitignore(dir: &Path) {
    let gi = dir.join(".gitignore");
    let existing = std::fs::read_to_string(&gi).unwrap_or_default();
    let line = format!("{}/**/.*{}", crate::repo::attachments::MIRROR_DIR, crate::repo::export::TMP_SUFFIX);
    if !existing.lines().any(|l| l.trim() == line) {
        let mut out = existing.clone();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&line);
        out.push('\n');
        let _ = std::fs::write(&gi, out);
    }
}
// ── End import ──

fn commit_message() -> String {
    format!("sync: {} @ {}", git_cmd::get_hostname(), Utc::now().to_rfc3339())
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
    /// Git AND the import went through.
    pub success: bool,
    pub pages_exported: u32,
    pub pages_imported: u32,
    pub conflicts_resolved: u32,
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
}

impl GitSyncResult {
    fn not_enabled() -> Self {
        GitSyncResult {
            success: false,
            pages_exported: 0,
            pages_imported: 0,
            conflicts_resolved: 0,
            error: Some("Sync is not enabled".to_string()),
            import_errors: vec![],
            held_deletions: None,
            offline: false,
            warnings: vec![],
        }
    }
}

/// Does a git error mean "the remote is unreachable" (offline) rather than a
/// real failure?
pub fn is_offline_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "network error",
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "network is unreachable",
        "no route to host",
        "could not read from remote repository",
        "unable to access",
        "failed to connect",
        "operation timed out",
        "temporary failure in name resolution",
    ]
    .iter()
    .any(|k| m.contains(k))
}

/// Outcome of phase 1.
#[derive(Debug, Clone)]
pub struct ExportPhase {
    pub pages_exported: u32,
    /// Attachments left out of git (over the size limit).
    pub large_attachments: Vec<String>,
    /// Instant just before the DB was read for export. Local edits after this are
    /// protected from being overwritten by the phase-3 import.
    pub export_time: DateTime<Utc>,
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
}

// ── Public API ──

/// Check if git is available on the system.
pub fn git_available() -> bool {
    git_cmd::git_available()
}

/// Get current sync status for a graph by reading config + git repo state.
pub fn get_sync_status(graph: &str) -> Result<GitSyncStatus> {
    let config = read_config(graph);
    let sync_dir = sync_dir_for_graph(graph);

    if !config.enabled || !git_cmd::is_git_repo(&sync_dir) {
        return Ok(GitSyncStatus {
            enabled: config.enabled,
            remote_url: None,
            branch: None,
            last_sync: config.last_sync,
        });
    }

    let remote_url = git_cmd::get_remote_url(&sync_dir)?;
    let branch = git_cmd::get_branch(&sync_dir).ok().flatten();

    Ok(GitSyncStatus {
        enabled: config.enabled,
        remote_url,
        branch,
        last_sync: config.last_sync,
    })
}

/// Enable git sync for a graph. `lock_db` is called only around the DB work (never
/// across git network calls), so the UI stays responsive.
pub fn enable_sync_with<G, F>(graph: &str, lock_db: F) -> Result<GitSyncStatus>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    if !git_cmd::git_available() {
        return Err(Error::Git("Git is not installed".to_string()));
    }
    {
        let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let sync_dir = sync_dir_for_graph(graph);
        enable_in_dir(&sync_dir, &lock_db)?;
        // The mirror's own bookkeeping must match what enable just wrote.
        let db = lock_db()?;
        let _ = crate::mirror::run(&db, &MirrorTarget::for_notebook(&notebook(graph)), true);
    }

    let mut config = read_config(graph);
    config.enabled = true;
    config.last_sync = Some(Utc::now().to_rfc3339());
    write_config(graph, &config)?;

    get_sync_status(graph)
}

/// Convenience wrapper for callers that already own the DB.
pub fn enable_sync(db: &Database, graph: &str) -> Result<GitSyncStatus> {
    enable_sync_with(graph, || Ok(db))
}

/// Init (if needed), pull, merge remote content into the DB, export, commit, push.
pub fn enable_in_dir<G, F>(sync_dir: &Path, lock_db: &F) -> Result<()>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    if !git_cmd::is_git_repo(sync_dir) {
        git_cmd::init_repo(sync_dir)?;
    }
    ensure_gitignore(sync_dir);
    git_cmd::abort_stale_rebase(sync_dir)?;

    // Pull existing remote content first (no DB lock).
    if git_cmd::has_remote(sync_dir) {
        match git_cmd::pull_rebase(sync_dir) {
            Ok(_) => {}
            Err(e) if e.to_string().contains("merge_conflict") => {
                if let Err(e) = git_cmd::auto_resolve_conflicts(sync_dir) {
                    eprintln!("[minotes-sync] enable: conflict resolution failed: {e}");
                }
            }
            // Empty/unreachable remote — first push will create it.
            Err(e) => eprintln!("[minotes-sync] enable: pull skipped: {e}"),
        }
    }

    {
        let db = lock_db()?;
        // Import (merge) remote files, then export + prune.
        let opts = SyncOptions { write_back: true, ..Default::default() };
        let r = db.sync_dir_with(sync_dir, IMPORT_ACTOR, &opts)?;
        for e in &r.errors {
            eprintln!("[minotes-sync] enable: {e}");
        }
        git_cmd::commit_all(sync_dir, &commit_message())?;
        if let Some(head) = git_cmd::rev_parse_head(sync_dir)? {
            set_imported_head(sync_dir, Some(head))?;
        }
    }

    if git_cmd::has_remote(sync_dir) {
        if let Err(e) = git_cmd::push(sync_dir) {
            eprintln!("[minotes-sync] enable: push failed: {e}");
        }
    }
    Ok(())
}

/// Disable sync for a graph (does not delete the git repo).
pub fn disable_sync(graph: &str) -> Result<()> {
    let mut config = read_config(graph);
    config.enabled = false;
    write_config(graph, &config)?;
    Ok(())
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
    let export_time = Utc::now();
    let mut target = target.clone();
    target.skip = held_export_options(sync_dir);
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
    Ok(ExportPhase { pages_exported: report.pages_rendered as u32, export_time, large_attachments: report.large_attachments })
}

fn pull_with_resolve(sync_dir: &Path) -> Result<u32> {
    match git_cmd::pull_rebase(sync_dir) {
        Ok(_) => Ok(0),
        Err(e) if e.to_string().contains("merge_conflict") => {
            Ok(git_cmd::auto_resolve_conflicts(sync_dir)?.len() as u32)
        }
        Err(e) => Err(e),
    }
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
    let mut removed_page_ids = Vec::new();
    let mut removed_folder_ids = Vec::new();
    let mut changed_paths = None;
    if let Some(old) = st.imported_head.as_deref() {
        if git_cmd::commit_exists(sync_dir, old) {
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
    Ok(Some(PendingImport { head, removed_page_ids, removed_folder_ids, changed_paths }))
}

/// Phase 3b (DB): import files → DB. Pages edited locally after `protect_after`
/// are left alone (they'll be exported next cycle); pages whose file the pull
/// removed are moved to trash.
pub fn apply_import(
    db: &Database,
    sync_dir: &Path,
    pending: &PendingImport,
    protect_after: Option<DateTime<Utc>>,
) -> Result<SyncResult> {
    let opts = SyncOptions {
        protect_modified_after: protect_after,
        trash_page_ids: pending.removed_page_ids.clone(),
        trash_folder_ids: pending.removed_folder_ids.clone(),
        ..Default::default()
    };
    let r = db.sync_dir_with(sync_dir, IMPORT_ACTOR, &opts)?;
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
    if !git_cmd::is_git_repo(sync_dir) {
        return Err(Error::Git("Sync directory is not a git repo".to_string()));
    }

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
    if let Some(pending) = pending_import(sync_dir)? {
        let db = lock_db()?;
        let r = apply_import(&db, sync_dir, &pending, Some(export.export_time))?;
        // What the pull wrote into the mirror is not an outside edit.
        if let Err(e) = crate::outside::adopt_pulled_files(&db, target, pending.changed_paths.as_deref()) {
            eprintln!("[minotes-sync] could not re-baseline pulled files: {e}");
        }
        pages_imported = (r.pages_created.len() + r.pages_updated.len() + r.pages_deleted.len()) as u32;
        import_errors = r.errors.clone();
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
        error,
        import_errors,
        held_deletions,
        offline,
        warnings: export
            .large_attachments
            .iter()
            .map(|a| format!("{a} is over 50 MB and was not synced"))
            .collect(),
    })
}

/// Update the last_sync timestamp in the graph's config file.
pub fn update_last_sync(graph: &str) -> Result<()> {
    let mut config = read_config(graph);
    config.last_sync = Some(Utc::now().to_rfc3339());
    write_config(graph, &config)
}

/// Full sync cycle for a graph. `lock_db` is invoked only for the DB phases.
pub fn full_sync_with<G, F>(graph: &str, lock_db: F) -> Result<GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let config = read_config(graph);
    if !config.enabled {
        return Ok(GitSyncResult::not_enabled());
    }
    let result = sync_cycle(&MirrorTarget::for_notebook(&notebook(graph)), lock_db)?;
    if result.success {
        update_last_sync(graph)?;
    }
    Ok(result)
}

/// Convenience wrapper for callers that already own the DB.
pub fn full_sync(db: &Database, graph: &str) -> Result<GitSyncResult> {
    full_sync_with(graph, || Ok(db))
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
    fn test_sync_dir_per_graph() {
        let _home = crate::notebook::tests::FakeHome::new();
        let d = sync_dir_for_graph("default");
        assert!(d.ends_with("MiNotes_Sync"));
        let w = sync_dir_for_graph("work");
        assert_eq!(w.file_name().unwrap(), "MiNotes_Sync-work");
        assert_ne!(d, w);
        let evil = sync_dir_for_graph("../../etc");
        assert_eq!(evil.parent(), d.parent(), "graph name must not escape HOME");
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
        let r = apply_import(&db_a, &a, &pending, Some(exp.export_time)).unwrap();
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

        // A deletes 25 of 30 pages.
        for id in &ids[..25] {
            db_a.trash_page(id).unwrap();
        }
        cycle(&a, &db_a);
        let r = cycle(&b, &db_b);
        let held = r.held_deletions.clone().expect("guard trip is reported");
        assert_eq!(held.pages, 25);
        assert_eq!(held.total_pages, 30);
        assert!(held.titles.contains(&"Note 00".to_string()));
        assert!(r.import_errors.is_empty(), "a held deletion is not an import error");
        assert_eq!(db_b.list_pages(None).unwrap().len(), 30, "nothing trashed without the user");

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
        assert_eq!(db_b.list_pages(None).unwrap().len(), 6);
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

    // P0: an unreachable remote is "offline", not a hard failure.
    #[test]
    fn test_unreachable_remote_is_offline() {
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
        assert!(r.offline, "{:?}", r.error);
        assert!(is_offline_error("fatal: unable to access 'https://x/': Could not resolve host: x"));
        assert!(!is_offline_error("Authentication failed — check your SSH keys or credentials"));
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
        assert_eq!(sync_dir_for_graph(&nb.key), root.join("notes"));
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
