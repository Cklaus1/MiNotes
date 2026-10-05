//! Git Sync manager — orchestrates the full sync cycle.
//! Connects the existing `sync_dir` (DB ↔ filesystem) to git (filesystem ↔ remote).
//!
//! A cycle is split into phases so the DB lock is never held across network I/O:
//!
//! 1. (DB lock) export DB → files, prune stale files, commit. Record the export time.
//! 2. (no lock)  pull --rebase (auto-resolving conflicts), push.
//! 3. (DB lock) import files → DB, but ONLY if HEAD moved past the last imported
//!    commit, and never overwrite a page edited locally after phase 1's export.
//!    Pages whose file was deleted by the pull are moved to trash.
//!
//! The last imported commit is persisted in `.git/minotes-sync-state.json`, so an
//! import that failed or was interrupted is retried on the next cycle.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::git_cmd;
use crate::repo::sync::{SyncOptions, SyncResult};

/// Serializes sync cycles within the process (a timer and a manual click, say).
static SYNC_LOCK: Mutex<()> = Mutex::new(());

const IMPORT_ACTOR: &str = "git-sync";
const STATE_FILE: &str = "minotes-sync-state.json";

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn is_default_graph(graph: &str) -> bool {
    graph.is_empty() || graph == "default"
}

/// Sync directory for a graph. The "default" graph keeps the historical
/// `~/MiNotes_Sync`; every other graph gets its own sibling repo
/// `~/MiNotes_Sync-<graph>` so graphs never share (and bleed) content. (A nested
/// `~/MiNotes_Sync/<graph>` would be tracked by — and imported into — the default
/// graph's repo.)
pub fn sync_dir_for_graph(graph: &str) -> PathBuf {
    if is_default_graph(graph) {
        home_dir().join("MiNotes_Sync")
    } else {
        home_dir().join(format!(
            "MiNotes_Sync-{}",
            crate::repo::export::sanitize_component(graph)
        ))
    }
}

/// Sync directory of the default graph: ~/MiNotes_Sync
pub fn default_sync_dir() -> PathBuf {
    sync_dir_for_graph("default")
}

fn config_path(graph: &str) -> PathBuf {
    let dir = home_dir().join(".minotes");
    std::fs::create_dir_all(&dir).ok();
    if is_default_graph(graph) {
        dir.join("sync-config.json")
    } else {
        dir.join(format!(
            "sync-config-{}.json",
            crate::repo::export::sanitize_component(graph)
        ))
    }
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
}

fn read_state(dir: &Path) -> RepoState {
    std::fs::read_to_string(dir.join(".git").join(STATE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(dir: &Path, st: &RepoState) -> Result<()> {
    let json = serde_json::to_string(st)?;
    std::fs::write(dir.join(".git").join(STATE_FILE), json)
        .map_err(|e| Error::Git(format!("Failed to write sync state: {e}")))
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
    pub success: bool,
    pub pages_exported: u32,
    pub pages_imported: u32,
    pub conflicts_resolved: u32,
    pub error: Option<String>,
}

/// Outcome of phase 1.
#[derive(Debug, Clone)]
pub struct ExportPhase {
    pub pages_exported: u32,
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
            write_state(sync_dir, &RepoState { imported_head: Some(head) })?;
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

/// Phase 1: export DB → filesystem (pruning stale files) and commit. Needs the DB.
pub fn export_and_commit(db: &Database, sync_dir: &Path) -> Result<ExportPhase> {
    git_cmd::abort_stale_rebase(sync_dir)?;
    ensure_gitignore(sync_dir);
    let export_time = Utc::now();
    let report = db.export_markdown_synced(sync_dir)?;

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
    Ok(ExportPhase { pages_exported: report.written.len() as u32, export_time })
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
    if let Some(old) = st.imported_head.as_deref() {
        if git_cmd::commit_exists(sync_dir, old) {
            for path in git_cmd::deleted_files_between(sync_dir, old, &head)? {
                let hidden = Path::new(&path)
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
    Ok(Some(PendingImport { head, removed_page_ids }))
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
        ..Default::default()
    };
    let r = db.sync_dir_with(sync_dir, IMPORT_ACTOR, &opts)?;
    for e in &r.errors {
        eprintln!("[minotes-sync] import: {e}");
    }
    // Only mark the commit as imported when every page went in; otherwise retry.
    if r.errors.is_empty() {
        write_state(sync_dir, &RepoState { imported_head: Some(pending.head.clone()) })?;
    }
    Ok(r)
}

/// One full cycle against an explicit sync dir (see module docs).
pub fn sync_cycle_in_dir<G, F>(sync_dir: &Path, lock_db: F) -> Result<GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if !git_cmd::is_git_repo(sync_dir) {
        return Err(Error::Git("Sync directory is not a git repo".to_string()));
    }

    // Phase 1 (DB lock)
    let export = {
        let db = lock_db()?;
        export_and_commit(&db, sync_dir)?
    };

    // Phase 2 (no DB lock)
    let git = git_pull_push(sync_dir)?;

    // Phase 3 (DB lock, only if the pull brought something in)
    let mut pages_imported = 0u32;
    if let Some(pending) = pending_import(sync_dir)? {
        let db = lock_db()?;
        let r = apply_import(&db, sync_dir, &pending, Some(export.export_time))?;
        pages_imported = (r.pages_created.len() + r.pages_updated.len() + r.pages_deleted.len()) as u32;
    }

    Ok(GitSyncResult {
        success: git.error.is_none(),
        pages_exported: export.pages_exported,
        pages_imported,
        conflicts_resolved: git.conflicts_resolved,
        error: git.error,
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
        return Ok(GitSyncResult {
            success: false,
            pages_exported: 0,
            pages_imported: 0,
            conflicts_resolved: 0,
            error: Some("Sync is not enabled".to_string()),
        });
    }
    let result = sync_cycle_in_dir(&sync_dir_for_graph(graph), lock_db)?;
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
}
