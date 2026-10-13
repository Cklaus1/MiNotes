//! The continuous markdown mirror: a plain-markdown copy of a notebook, kept
//! current within seconds of an edit (PRD-notebooks Phase 2).
//!
//! It writes exactly what the exporter writes (`export_markdown_synced`): one
//! `.md` per page with id/title frontmatter, folder directories with a
//! `.minotes-folder.json` identity file, `.minotes-whiteboards/<id>.json`
//! sidecars, stale files moved to `.minotes-trash/`. Git sync commits this folder.
//!
//! A pass is split in two so the database lock is only held to read:
//! [`prepare`] (needs the DB: plans paths and renders what changed) and
//! [`apply`] (filesystem only: atomic writes, pruning, state). The first pass —
//! and "Rebuild markdown copy" — is a full export; later passes are incremental:
//! only pages/folders/whiteboards whose fingerprint or path moved since the last
//! pass are rendered and written, and only files the mirror itself wrote are
//! pruned. The per-page content hash recorded here is what outside-edit
//! detection (Phase 4, [`crate::outside`]) compares against: a page file that no
//! longer has the hash the mirror wrote is never overwritten or pruned — it is
//! left for the outside-edit import.
//!
//! Callers serialise passes with [`FS_LOCK`] (git sync holds it for a whole
//! cycle, so a pull never races a mirror write).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::repo::export::{
    self, atomic_write, content_hash, folder_marker_json, move_to_sync_trash, write_if_changed, ExportOptions,
    FolderMarker, PreparedExport, WhiteboardFile, FOLDER_MARKER, WHITEBOARD_DIR,
};

/// Serialises everything that writes into a mirror / sync directory: mirror
/// passes and git sync cycles. Lock order: `FS_LOCK` before the DB lock.
pub static FS_LOCK: Mutex<()> = Mutex::new(());

const STATE_VERSION: u32 = 1;

/// Where a mirror lives and what it leaves out.
#[derive(Debug, Clone, Default)]
pub struct MirrorTarget {
    pub dir: PathBuf,
    /// Where the pass state is kept. `None`: no state, every pass is full.
    pub state_path: Option<PathBuf>,
    /// Pages/folders not to write (deletions awaiting the user's decision).
    pub skip: ExportOptions,
}

impl MirrorTarget {
    pub fn new(dir: impl Into<PathBuf>, state_path: Option<PathBuf>) -> Self {
        MirrorTarget { dir: dir.into(), state_path, skip: ExportOptions::default() }
    }

    /// The mirror of a notebook, honouring deletions held back by git sync.
    pub fn for_notebook(nb: &crate::notebook::Notebook) -> Self {
        let dir = nb.mirror_dir();
        let skip = crate::sync_manager::held_export_options(&dir);
        MirrorTarget { dir, state_path: Some(nb.mirror_state_path()), skip }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PageEntry {
    /// Path relative to the mirror root.
    pub path: String,
    /// sha256 of the file content the mirror wrote.
    pub hash: String,
    /// Fingerprint of the page in the DB when it was written (or when an
    /// outside edit of the file was imported — file and page agreed then).
    pub fp: String,
    /// Re-render the file on the next pass even if the fingerprint is unchanged
    /// (an outside edit was imported: the file still lacks block id markers).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rewrite: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FolderEntry {
    pub path: String,
    pub fp: String,
}

/// Persistent mirror state (in the notebook's private dir, never in the mirror).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MirrorState {
    #[serde(default)]
    pub version: u32,
    /// The mirror directory this state describes (a different dir ⇒ full pass).
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub pages: BTreeMap<Uuid, PageEntry>,
    #[serde(default)]
    pub folders: BTreeMap<Uuid, FolderEntry>,
    /// Whiteboard id → `updated_at` of the sidecar the mirror wrote.
    #[serde(default)]
    pub boards: BTreeMap<String, String>,
    /// Last time a pass changed a file.
    #[serde(default)]
    pub last_written_at: Option<String>,
    /// Last successful pass (changed something or not).
    #[serde(default)]
    pub last_pass_at: Option<String>,
    #[serde(default)]
    pub last_full_at: Option<String>,
    /// Set when the last pass failed; cleared by the next good one.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Files the outside-edit import could not read (relative path → hash of
    /// the bytes reported), so each bad version is reported once.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rejected: BTreeMap<String, String>,
}

/// Does `st` describe the mirror at `dir` well enough to tell our files from
/// files changed by someone else?
pub(crate) fn state_usable(st: &MirrorState, dir: &Path) -> bool {
    st.version == STATE_VERSION && st.dir.as_deref() == Some(dir.display().to_string().as_str()) && st.last_full_at.is_some()
}

pub fn load_state(path: &Path) -> MirrorState {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn save_state(path: &Path, st: &MirrorState) -> Result<()> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string(st)?;
    atomic_write(path, json.as_bytes())
        .map_err(|e| Error::InvalidInput(format!("Cannot save mirror state {}: {e}", path.display())))
}

/// Remember that a pass failed (shown as "Markdown copy is behind — retry").
pub fn record_error(target: &MirrorTarget, msg: &str) {
    if let Some(p) = &target.state_path {
        let mut st = load_state(p);
        st.last_error = Some(msg.to_string());
        let _ = save_state(p, &st);
    }
}

/// What the app shows in Settings.
#[derive(Debug, Clone, Serialize)]
pub struct MirrorStatus {
    pub dir: String,
    pub enabled: bool,
    pub last_written_at: Option<String>,
    pub last_pass_at: Option<String>,
    pub last_full_at: Option<String>,
    pub error: Option<String>,
    pub pages: usize,
}

pub fn status(target: &MirrorTarget, enabled: bool) -> MirrorStatus {
    let st = target.state_path.as_deref().map(load_state).unwrap_or_default();
    MirrorStatus {
        dir: target.dir.display().to_string(),
        enabled,
        last_written_at: st.last_written_at,
        last_pass_at: st.last_pass_at,
        last_full_at: st.last_full_at,
        error: st.last_error,
        pages: st.pages.len(),
    }
}

/// Outcome of one pass.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MirrorReport {
    pub full: bool,
    /// Pages rendered (incremental: the changed ones; full: all).
    pub pages_rendered: usize,
    /// Files whose content actually changed on disk.
    pub files_written: usize,
    /// Files moved into `.minotes-trash/`.
    pub files_trashed: usize,
    pub prepare_ms: u128,
    pub apply_ms: u128,
    /// Relative paths of the files written (for tests and diagnostics).
    #[serde(skip)]
    pub written_paths: Vec<String>,
    /// Attachments over the git-sync size limit (kept out of git).
    #[serde(default)]
    pub large_attachments: Vec<String>,
    /// Page files NOT rewritten because they were changed outside MiNotes since
    /// the mirror wrote them (relative paths) — left for the outside-edit import.
    #[serde(default)]
    pub guarded: Vec<String>,
    /// What [`run`] imported from outside edits before writing.
    #[serde(default)]
    pub outside: crate::outside::OutsideReport,
}

fn rel_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn short_hash(s: &str) -> String {
    content_hash(s)[..16].to_string()
}

/// A per-page fingerprint of everything that shows in its markdown file: title,
/// folder, journal flag/date, blocks (count, last change, total length, layout)
/// and page properties. Cheap: one indexed pass over blocks.
pub(crate) fn page_fingerprints(db: &Database) -> Result<HashMap<Uuid, String>> {
    let mut stmt = db.conn.prepare(
        "SELECT p.id,
                p.title || char(31) || IFNULL(p.folder_id,'') || char(31) || p.is_journal || char(31)
                  || IFNULL(p.journal_date,'') || char(31) || p.updated_at || char(31)
                  || IFNULL((SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at),'') || ':' || IFNULL(SUM(LENGTH(content)),0)
                                    || ':' || IFNULL(SUM(position),0) || ':' || IFNULL(SUM(parent_id IS NULL),0)
                             FROM blocks b WHERE b.page_id = p.id), '')
                  || char(31)
                  || IFNULL((SELECT GROUP_CONCAT(key || '=' || IFNULL(value,''), char(30))
                             FROM properties WHERE entity_id = p.id), '')
           FROM pages p",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, fp) = r?;
        if let Ok(id) = Uuid::parse_str(&id) {
            out.insert(id, short_hash(&fp));
        }
    }
    Ok(out)
}

fn folder_fp(f: &crate::models::Folder) -> String {
    short_hash(&format!("{}\u{1f}{}", f.name, f.parent_id.map(|p| p.to_string()).unwrap_or_default()))
}

fn board_times(db: &Database) -> Result<HashMap<String, String>> {
    let mut stmt = db.conn.prepare("SELECT id, updated_at FROM whiteboards")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for r in rows {
        let (id, at) = r?;
        out.insert(id, at);
    }
    Ok(out)
}

/// Which file a prune expects to find before moving it to `.minotes-trash/`.
#[derive(Debug, Clone)]
enum Expect {
    Page(Uuid),
    Folder(Uuid),
    /// A sidecar, unless it is newer than this `updated_at` (pulled, not imported).
    Board(String, Option<String>),
}

#[derive(Debug, Clone)]
struct TrashOp {
    rel: PathBuf,
    expect: Expect,
    /// Page files: the hash the mirror wrote. A file edited since is left alone.
    hash: Option<String>,
}

/// The incremental work rendered from the database.
pub struct IncrementalPlan {
    /// (relative path, content, the page it is for — guarded against
    /// overwriting a page this DB doesn't know)
    writes: Vec<(PathBuf, String, Option<Uuid>)>,
    known_pages: HashSet<Uuid>,
    trash: Vec<TrashOp>,
    remove_dirs: Vec<PathBuf>,
    manifest_add: Vec<Uuid>,
    state: MirrorState,
    pages_rendered: usize,
    /// Attachments the rewritten pages link to.
    copies: Vec<export::AttachmentCopy>,
    /// Previous entry of each page rewritten at the same path: its file is not
    /// overwritten if it changed since (outside edit), and the entry is kept.
    guard: HashMap<Uuid, PageEntry>,
}

/// A pass rendered from the database, ready to be written by [`apply`].
pub enum Prepared {
    Full {
        export: PreparedExport,
        state: MirrorState,
        fps: HashMap<Uuid, String>,
        /// The previous pass's page entries (kept for pages the guard skips).
        old_pages: BTreeMap<Uuid, PageEntry>,
        prepare_ms: u128,
    },
    Incremental { plan: IncrementalPlan, prepare_ms: u128 },
}

impl Prepared {
    pub fn is_full(&self) -> bool {
        matches!(self, Prepared::Full { .. })
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Read the database for one pass (hold the DB lock only around this).
/// `force_full` (startup, "Rebuild markdown copy", git sync) re-exports
/// everything and prunes the whole tree.
pub fn prepare(db: &Database, target: &MirrorTarget, force_full: bool) -> Result<Prepared> {
    // An encrypted notebook has no plaintext markdown copy (PRD-encryption §4.5):
    // refuse here, whichever caller forgot to check `mirror_enabled`.
    if db.is_encrypted() {
        return Err(Error::InvalidInput("An encrypted notebook has no markdown copy".into()));
    }
    let t0 = Instant::now();
    let old = target.state_path.as_deref().map(load_state).unwrap_or_default();
    let dir_s = target.dir.display().to_string();
    let usable = target.state_path.is_some()
        && old.version == STATE_VERSION
        && old.dir.as_deref() == Some(dir_s.as_str())
        && old.last_full_at.is_some()
        && target.dir.is_dir();
    if force_full || !usable {
        let mut export = db.prepare_export(&target.dir, true, &target.skip)?;
        let fps = page_fingerprints(db)?;
        // Outside-edit guard: only with a state that describes this dir.
        let same_dir = old.version == STATE_VERSION && old.dir.as_deref() == Some(dir_s.as_str());
        if same_dir {
            for (id, rel, _) in &export.pages {
                if let Some(e) = old.pages.get(id).filter(|e| e.path == rel_str(rel)) {
                    export.guard.insert(*id, e.hash.clone());
                }
            }
        }
        let old_pages = if same_dir { old.pages.clone() } else { BTreeMap::new() };
        let mut state = MirrorState { version: STATE_VERSION, dir: Some(dir_s), ..Default::default() };
        if same_dir {
            state.rejected = old.rejected.clone();
        }
        let referenced: HashSet<String> = export
            .sidecars
            .iter()
            .filter_map(|(rel, _)| rel.file_stem().and_then(|s| s.to_str()).map(str::to_string))
            .collect();
        let times = board_times(db)?;
        for id in referenced {
            if let Some(at) = times.get(&id) {
                state.boards.insert(id, at.clone());
            }
        }
        for (f, rel) in &export.plan.folders {
            state.folders.insert(f.id, FolderEntry { path: rel_str(rel), fp: folder_fp(f) });
        }
        state.last_written_at = old.last_written_at;
        return Ok(Prepared::Full { export, state, fps, old_pages, prepare_ms: t0.elapsed().as_millis() });
    }
    let plan = prepare_incremental(db, target, old)?;
    Ok(Prepared::Incremental { plan, prepare_ms: t0.elapsed().as_millis() })
}

fn prepare_incremental(db: &Database, target: &MirrorTarget, old: MirrorState) -> Result<IncrementalPlan> {
    let mut plan = db.plan_export_paths()?;
    let skip = &target.skip;
    plan.pages.retain(|(p, _)| !skip.skip_pages.contains(&p.id));
    plan.folders.retain(|(f, _)| !skip.skip_folders.contains(&f.id));

    let mut state = MirrorState {
        version: STATE_VERSION,
        dir: old.dir.clone(),
        last_written_at: old.last_written_at.clone(),
        last_full_at: old.last_full_at.clone(),
        rejected: old.rejected.clone(),
        ..Default::default()
    };
    let mut guard: HashMap<Uuid, PageEntry> = HashMap::new();
    let mut writes: Vec<(PathBuf, String, Option<Uuid>)> = Vec::new();
    let mut trash: Vec<TrashOp> = Vec::new();
    let mut remove_dirs: Vec<PathBuf> = Vec::new();
    let mut manifest_add: Vec<Uuid> = Vec::new();
    let mut pages_rendered = 0usize;
    let mut copies: Vec<export::AttachmentCopy> = Vec::new();

    // ── Folders ──
    let mut known_folders: HashSet<Uuid> = HashSet::new();
    let mut trashed_folders: HashSet<Uuid> = HashSet::new();
    {
        let mut stmt = db.conn.prepare(&format!(
            "WITH RECURSIVE {} SELECT id, id IN (SELECT id FROM trashed_tree) FROM folders",
            crate::repo::trash::TRASHED_FOLDER_TREE
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
        for r in rows {
            let (id, t) = r?;
            if let Ok(id) = Uuid::parse_str(&id) {
                known_folders.insert(id);
                if t {
                    trashed_folders.insert(id);
                }
            }
        }
    }
    for (f, rel) in &plan.folders {
        let entry = FolderEntry { path: rel_str(rel), fp: folder_fp(f) };
        let prev = old.folders.get(&f.id);
        if prev != Some(&entry) {
            writes.push((rel.join(FOLDER_MARKER), folder_marker_json(f)?, None));
            if prev.is_none() {
                manifest_add.push(f.id);
            }
            if let Some(p) = prev.filter(|p| p.path != entry.path) {
                trash.push(TrashOp {
                    rel: PathBuf::from(&p.path).join(FOLDER_MARKER),
                    expect: Expect::Folder(f.id),
                    hash: None,
                });
                remove_dirs.push(PathBuf::from(&p.path));
            }
        }
        state.folders.insert(f.id, entry);
    }
    for (id, prev) in &old.folders {
        if state.folders.contains_key(id) {
            continue;
        }
        let gone = !known_folders.contains(id) || trashed_folders.contains(id);
        if gone {
            trash.push(TrashOp { rel: PathBuf::from(&prev.path).join(FOLDER_MARKER), expect: Expect::Folder(*id), hash: None });
            remove_dirs.push(PathBuf::from(&prev.path));
        }
        // Archived / held back: the full pass leaves such files alone too.
    }

    // ── Pages ──
    let fps = page_fingerprints(db)?;
    let mut trashed_pages: HashSet<Uuid> = HashSet::new();
    {
        let mut stmt = db.conn.prepare("SELECT page_id FROM trash")?;
        for r in stmt.query_map([], |r| r.get::<_, String>(0))? {
            if let Ok(id) = Uuid::parse_str(&r?) {
                trashed_pages.insert(id);
            }
        }
    }
    let mut changed_has_boards = false;
    for (page, rel) in &plan.pages {
        let fp = fps.get(&page.id).cloned().unwrap_or_default();
        let path = rel_str(rel);
        match old.pages.get(&page.id) {
            Some(prev) if prev.path == path && prev.fp == fp && !prev.rewrite => {
                state.pages.insert(page.id, prev.clone());
            }
            prev => {
                // ── Import / attachments: relative links + the files they need ──
                let (md, att) = db.render_page_for_export(page, rel)?;
                copies.extend(att);
                pages_rendered += 1;
                changed_has_boards |= md.contains("{{whiteboard:");
                if let Some(p) = prev.filter(|p| p.path == path) {
                    guard.insert(page.id, p.clone());
                }
                if let Some(p) = prev.filter(|p| p.path != path) {
                    trash.push(TrashOp { rel: PathBuf::from(&p.path), expect: Expect::Page(page.id), hash: Some(p.hash.clone()) });
                    if let Some(parent) = Path::new(&p.path).parent().filter(|d| !d.as_os_str().is_empty()) {
                        remove_dirs.push(parent.to_path_buf());
                    }
                }
                if prev.is_none() {
                    manifest_add.push(page.id);
                }
                state.pages.insert(page.id, PageEntry { path, hash: content_hash(&md), fp, rewrite: false });
                writes.push((rel.clone(), md, Some(page.id)));
            }
        }
    }
    let mut pages_removed = false;
    for (id, prev) in &old.pages {
        if state.pages.contains_key(id) {
            continue;
        }
        pages_removed = true;
        let still_there = fps.contains_key(id) && !trashed_pages.contains(id);
        if !still_there {
            // Trashed or permanently deleted.
            trash.push(TrashOp { rel: PathBuf::from(&prev.path), expect: Expect::Page(*id), hash: Some(prev.hash.clone()) });
        }
        // Archived / held back: leave the file (as the full pass does).
    }

    // ── Whiteboard sidecars ──
    let times = board_times(db)?;
    let boards_changed = times.iter().any(|(id, at)| old.boards.get(id).map(|o| o != at).unwrap_or(true))
        || old.boards.keys().any(|id| !times.contains_key(id));
    if boards_changed || changed_has_boards || pages_removed {
        let mut ids: Vec<Uuid> = plan.pages.iter().map(|(p, _)| p.id).collect();
        ids.extend(plan.archived_ids.iter().copied());
        let referenced = db.whiteboards_on_pages(&ids)?;
        let need: Vec<String> = referenced
            .iter()
            .filter(|id| match times.get(*id) {
                Some(at) => old.boards.get(*id) != Some(at),
                None => false, // never saved
            })
            .cloned()
            .collect();
        let need_set: HashSet<String> = need.iter().cloned().collect();
        for (rel, json) in db.render_whiteboard_sidecars(&target.dir, need)? {
            writes.push((rel, json, None));
        }
        for id in &referenced {
            if let Some(at) = times.get(id) {
                if need_set.contains(id) || old.boards.contains_key(id) {
                    state.boards.insert(id.clone(), at.clone());
                }
            }
        }
        for id in old.boards.keys() {
            if !referenced.contains(id) {
                trash.push(TrashOp {
                    rel: Path::new(WHITEBOARD_DIR).join(format!("{id}.json")),
                    expect: Expect::Board(id.clone(), times.get(id).cloned()),
                    hash: None,
                });
            }
        }
    } else {
        state.boards = old.boards.clone();
    }

    let known_pages: HashSet<Uuid> = fps.keys().copied().collect();
    Ok(IncrementalPlan { writes, known_pages, trash, remove_dirs, manifest_add, state, pages_rendered, copies, guard })
}

/// Does `rel` still hold what the prune expects (never trash someone else's file)?
fn holds_expected(root: &Path, op: &TrashOp) -> bool {
    // Never read through (or move) a symbolic link: it is not a file we wrote.
    let Ok(text) = export::read_text_below(root, &op.rel) else { return false };
    if let Some(h) = &op.hash {
        if content_hash(&text) != *h {
            return false; // edited outside since we wrote it: the outside-edit import decides
        }
    }
    match &op.expect {
        Expect::Page(id) => crate::repo::sync::parse_frontmatter_id(&text) == Some(*id),
        Expect::Folder(id) => serde_json::from_str::<FolderMarker>(&text).map(|m| m.id == *id).unwrap_or(false),
        Expect::Board(id, db_at) => match serde_json::from_str::<WhiteboardFile>(&text) {
            Ok(f) => {
                f.id == *id
                    && match db_at {
                        Some(at) => !export::ts_newer(&f.updated_at, at),
                        None => false, // not in the DB at all: maybe pulled, keep it
                    }
            }
            Err(_) => false,
        },
    }
}

/// Write a prepared pass (filesystem only — no database needed).
pub fn apply(target: &MirrorTarget, prepared: Prepared) -> Result<MirrorReport> {
    let t0 = Instant::now();
    let dir = &target.dir;
    let res = (|| -> Result<MirrorReport> {
        match prepared {
            Prepared::Full { export, mut state, fps, old_pages, prepare_ms } => {
                let pages_rendered = export.pages.len();
                let rep = export::apply_export(dir, export)?;
                for (id, rel, hash) in &rep.page_files {
                    let fp = fps.get(id).cloned().unwrap_or_default();
                    state.pages.insert(*id, PageEntry { path: rel_str(rel), hash: hash.clone(), fp, rewrite: false });
                }
                // Not overwritten (edited outside): keep what we knew about the file.
                for (id, _) in &rep.guarded {
                    if let Some(e) = old_pages.get(id) {
                        state.pages.insert(*id, e.clone());
                    }
                }
                let stamp = now();
                state.last_pass_at = Some(stamp.clone());
                state.last_full_at = Some(stamp.clone());
                if rep.changed > 0 || !rep.pruned.is_empty() {
                    state.last_written_at = Some(stamp);
                }
                state.last_error = None;
                if let Some(p) = &target.state_path {
                    save_state(p, &state)?;
                }
                Ok(MirrorReport {
                    full: true,
                    pages_rendered,
                    files_written: rep.changed,
                    files_trashed: rep.pruned.len(),
                    prepare_ms,
                    apply_ms: 0,
                    written_paths: vec![],
                    large_attachments: rep.large_attachments,
                    guarded: rep.guarded.iter().map(|(_, r)| rel_str(r)).collect(),
                    outside: Default::default(),
                })
            }
            Prepared::Incremental { plan, prepare_ms } => {
                let mut report = MirrorReport { pages_rendered: plan.pages_rendered, prepare_ms, ..Default::default() };
                fs::create_dir_all(dir)
                    .map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", dir.display())))?;
                let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f").to_string();
                for op in &plan.trash {
                    if export::link_in_the_way(dir, &Path::new(export::SYNC_TRASH_DIR).join(&op.rel)) {
                        continue; // `.minotes-trash` is a link: stale files stay where they are
                    }
                    if holds_expected(dir, op) {
                        match move_to_sync_trash(dir, &op.rel, &stamp) {
                            Ok(()) => report.files_trashed += 1,
                            Err(e) => {
                                return Err(Error::InvalidInput(format!(
                                    "Cannot move {} aside: {e}",
                                    op.rel.display()
                                )))
                            }
                        }
                    }
                }
                let mut state = plan.state;
                for (rel, content, page) in &plan.writes {
                    let abs = export::safe_join(dir, rel)?;
                    if export::link_in_the_way(dir, rel) {
                        // A symbolic link (file or directory) is foreign: never
                        // written through. A page keeps its previous record.
                        if let Some(id) = page {
                            match plan.guard.get(id) {
                                Some(prev) => {
                                    state.pages.insert(*id, prev.clone());
                                }
                                None => {
                                    state.pages.remove(id);
                                }
                            }
                            report.guarded.push(rel_str(rel));
                        }
                        continue;
                    }
                    if let Some(parent) = abs.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", parent.display())))?;
                    }
                    if let Some(id) = page {
                        if export::holds_unknown_page(&abs, id, &plan.known_pages) {
                            // Not imported yet: leave it; retry this page next pass.
                            state.pages.remove(id);
                            continue;
                        }
                        if let Some(prev) = plan.guard.get(id) {
                            if export::edited_outside(&abs, &prev.hash, content) {
                                // Edited outside MiNotes since we wrote it: never
                                // overwrite; the outside-edit import takes it from here.
                                eprintln!("[minotes-mirror] not overwriting {} (edited outside MiNotes)", rel.display());
                                state.pages.insert(*id, prev.clone());
                                report.guarded.push(rel_str(rel));
                                continue;
                            }
                        }
                    }
                    if write_if_changed(&abs, content)? {
                        report.files_written += 1;
                        report.written_paths.push(rel_str(rel));
                    }
                }
                // Directories a folder (or the last page) left: deepest first, only if empty.
                let mut dirs: Vec<PathBuf> = Vec::new();
                for d in &plan.remove_dirs {
                    for a in d.ancestors() {
                        if !a.as_os_str().is_empty() && !dirs.iter().any(|x| x == a) {
                            dirs.push(a.to_path_buf());
                        }
                    }
                }
                let live: HashSet<&str> = state.folders.values().map(|f| f.path.as_str()).collect();
                dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
                for d in dirs {
                    if !live.contains(rel_str(&d).as_str()) && export::symlink_below(dir, &d).is_none() {
                        let _ = fs::remove_dir(dir.join(&d));
                    }
                }
                let _ = fs::remove_dir(dir.join(WHITEBOARD_DIR)); // only when empty
                // ── Import / attachments ──
                let (n, large) = export::apply_attachment_copies(dir, &plan.copies)?;
                report.files_written += n;
                report.large_attachments = large;
                if !plan.manifest_add.is_empty() {
                    export::add_to_manifest(dir, plan.manifest_add.iter().copied());
                }
                let ts = now();
                state.last_pass_at = Some(ts.clone());
                if report.files_written > 0 || report.files_trashed > 0 {
                    state.last_written_at = Some(ts);
                }
                state.last_error = None;
                if let Some(p) = &target.state_path {
                    save_state(p, &state)?;
                }
                Ok(report)
            }
        }
    })();
    match res {
        Ok(mut r) => {
            r.apply_ms = t0.elapsed().as_millis();
            Ok(r)
        }
        Err(e) => {
            record_error(target, &e.to_string());
            Err(e)
        }
    }
}

/// Prepare and apply in one go (the caller holds the DB for the whole pass).
/// Outside edits of the mirror are imported first (see [`crate::outside`]), so a
/// pass never writes over them.
pub fn run(db: &Database, target: &MirrorTarget, force_full: bool) -> Result<MirrorReport> {
    if db.is_encrypted() {
        return Err(Error::InvalidInput("An encrypted notebook has no markdown copy".into()));
    }
    let outside = match crate::outside::import_outside_edits(db, target, &crate::outside::Scope::All) {
        Ok(r) => r,
        Err(e) => crate::outside::OutsideReport { errors: vec![e.to_string()], ..Default::default() },
    };
    let prepared = match prepare(db, target, force_full) {
        Ok(p) => p,
        Err(e) => {
            record_error(target, &e.to_string());
            return Err(e);
        }
    };
    let mut report = apply(target, prepared)?;
    report.outside = outside;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Database, MirrorTarget) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let target = MirrorTarget::new(tmp.path().join("notes"), Some(tmp.path().join("state.json")));
        (tmp, db, target)
    }

    fn mtime(p: &Path) -> std::time::SystemTime {
        fs::metadata(p).unwrap().modified().unwrap()
    }

    fn md_files(dir: &Path) -> Vec<String> {
        crate::repo::sync::scan_markdown_tree(dir).files.iter().map(|f| rel_str(&f.rel)).collect()
    }

    fn no_temp_files(dir: &Path) -> bool {
        fn walk(d: &Path) -> bool {
            fs::read_dir(d).map(|rd| {
                rd.flatten().all(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.ends_with(export::TMP_SUFFIX) {
                        return false;
                    }
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { walk(&e.path()) } else { true }
                })
            }).unwrap_or(true)
        }
        walk(dir)
    }

    #[test]
    fn test_first_pass_is_full_then_incremental_touches_only_changed_pages() {
        let (_tmp, db, target) = setup();
        let mut ids = Vec::new();
        for i in 0..20 {
            let p = db.create_page(&format!("Page {i}"), None, false, None, "user").unwrap();
            db.create_block(&p.id, &format!("block {i}"), None, None, "user").unwrap();
            ids.push(p.id);
        }
        let r = run(&db, &target, false).unwrap();
        assert!(r.full);
        assert_eq!(md_files(&target.dir).len(), 20);
        let st = load_state(target.state_path.as_ref().unwrap());
        assert_eq!(st.pages.len(), 20);
        assert!(st.last_written_at.is_some());

        // Nothing changed: nothing rendered, nothing written.
        let r = run(&db, &target, false).unwrap();
        assert!(!r.full);
        assert_eq!((r.pages_rendered, r.files_written, r.files_trashed), (0, 0, 0));

        // Edit one page: only that file is rewritten.
        let untouched = target.dir.join("Page 3.md");
        let before = mtime(&untouched);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let blocks = db.get_page_blocks(&ids[7]).unwrap();
        db.update_block(&blocks[0].id, Some("edited seven"), "user").unwrap();
        let r = run(&db, &target, false).unwrap();
        assert!(!r.full);
        assert_eq!(r.pages_rendered, 1);
        assert_eq!(r.written_paths, vec!["Page 7.md".to_string()]);
        assert!(fs::read_to_string(target.dir.join("Page 7.md")).unwrap().contains("edited seven"));
        assert_eq!(mtime(&untouched), before, "untouched page not rewritten");
        let st = load_state(target.state_path.as_ref().unwrap());
        assert_eq!(st.pages[&ids[7]].hash, content_hash(&fs::read_to_string(target.dir.join("Page 7.md")).unwrap()));

        // Adding a block, a property and deleting a block are all seen.
        let b = db.create_block(&ids[1], "second", None, None, "user").unwrap();
        db.set_property(&ids[2], "page", "status", "draft", "text", "user").unwrap();
        let r = run(&db, &target, false).unwrap();
        assert_eq!(r.pages_rendered, 2);
        assert!(fs::read_to_string(target.dir.join("Page 2.md")).unwrap().contains("status: draft"));
        db.delete_block(&b.id, "user").unwrap();
        let r = run(&db, &target, false).unwrap();
        assert_eq!(r.written_paths, vec!["Page 1.md".to_string()]);
        assert!(!fs::read_to_string(target.dir.join("Page 1.md")).unwrap().contains("second"));
        assert!(no_temp_files(&target.dir));
    }

    #[test]
    fn test_incremental_prune_matches_full_export() {
        let (tmp, db, target) = setup();
        let work = db.create_folder("Work", None, None, None, "user").unwrap();
        let old = db.create_folder("Old", None, None, None, "user").unwrap();
        let a = db.create_page("Alpha", None, false, None, "user").unwrap();
        db.create_block(&a.id, "a", None, None, "user").unwrap();
        db.move_page_to_folder(&a.id, Some(&work.id), "user").unwrap();
        let b = db.create_page("Beta", None, false, None, "user").unwrap();
        db.create_block(&b.id, "{{whiteboard:wb-1}}", None, None, "user").unwrap();
        db.save_whiteboard("wb-1", r#"{"s":1}"#).unwrap();
        let c = db.create_page("Gamma", None, false, None, "user").unwrap();
        db.move_page_to_folder(&c.id, Some(&old.id), "user").unwrap();
        let d = db.create_page("Delta", None, false, None, "user").unwrap();
        run(&db, &target, false).unwrap();
        assert!(target.dir.join("Work/Alpha.md").exists());
        assert!(target.dir.join(WHITEBOARD_DIR).join("wb-1.json").exists());

        // Rename a page, rename a folder, trash a folder, delete a page, drop the
        // whiteboard reference, and draw on a new board.
        db.rename_page(&a.id, "Alpha 2", "user").unwrap();
        db.rename_folder(&work.id, "Job", "user").unwrap();
        db.trash_folder(&old.id).unwrap();
        db.trash_page(&d.id).unwrap();
        let bb = db.get_page_blocks(&b.id).unwrap();
        db.update_block(&bb[0].id, Some("{{whiteboard:wb-2}}"), "user").unwrap();
        db.save_whiteboard("wb-2", r#"{"s":2}"#).unwrap();
        let r = run(&db, &target, false).unwrap();
        assert!(!r.full);

        let mut incremental = md_files(&target.dir);
        incremental.sort();
        assert_eq!(incremental, vec!["Beta.md".to_string(), "Job/Alpha 2.md".to_string()]);
        assert!(!target.dir.join("Work").exists(), "old folder dir removed");
        assert!(!target.dir.join("Old").exists(), "trashed folder dir removed");
        assert!(target.dir.join("Job").join(FOLDER_MARKER).exists());
        assert!(target.dir.join(WHITEBOARD_DIR).join("wb-2.json").exists());
        assert!(!target.dir.join(WHITEBOARD_DIR).join("wb-1.json").exists(), "unreferenced sidecar pruned");
        assert!(target.dir.join(export::SYNC_TRASH_DIR).is_dir(), "stale files moved aside, not deleted");

        // The same DB exported from scratch gives the same tree.
        let fresh = tmp.path().join("fresh");
        db.export_markdown_synced(&fresh).unwrap();
        let mut full = md_files(&fresh);
        full.sort();
        assert_eq!(incremental, full);
        for f in &full {
            assert_eq!(
                fs::read_to_string(target.dir.join(f)).unwrap(),
                fs::read_to_string(fresh.join(f)).unwrap(),
                "{f}"
            );
        }
        // And a forced full pass over the incremental mirror changes nothing.
        let r = run(&db, &target, true).unwrap();
        assert!(r.full);
        assert_eq!((r.files_written, r.files_trashed), (0, 0));
    }

    #[test]
    fn test_incremental_never_trashes_a_file_it_did_not_write() {
        let (_tmp, db, target) = setup();
        let p = db.create_page("Mine", None, false, None, "user").unwrap();
        run(&db, &target, false).unwrap();
        // Another page's file now sits where "Mine" was (e.g. pulled by git).
        let foreign = format!("---\nid: {}\ntitle: \"Mine\"\n---\n\n- pulled\n", Uuid::now_v7());
        fs::write(target.dir.join("Mine.md"), &foreign).unwrap();
        db.trash_page(&p.id).unwrap();
        run(&db, &target, false).unwrap();
        assert_eq!(fs::read_to_string(target.dir.join("Mine.md")).unwrap(), foreign);
    }

    #[test]
    fn test_never_overwrites_a_pulled_page_not_imported_yet() {
        let (_tmp, db, target) = setup();
        fs::create_dir_all(&target.dir).unwrap();
        let foreign = format!("---\nid: {}\ntitle: \"Shared\"\n---\n\n- from the other device\n", Uuid::now_v7());
        fs::write(target.dir.join("Shared.md"), &foreign).unwrap();
        let p = db.create_page("Shared", None, false, None, "user").unwrap();
        run(&db, &target, false).unwrap(); // full
        assert_eq!(fs::read_to_string(target.dir.join("Shared.md")).unwrap(), foreign);
        db.create_block(&p.id, "local", None, None, "user").unwrap();
        apply(&target, prepare(&db, &target, false).unwrap()).unwrap(); // incremental, no import
        assert_eq!(fs::read_to_string(target.dir.join("Shared.md")).unwrap(), foreign);
        assert!(!load_state(target.state_path.as_ref().unwrap()).pages.contains_key(&p.id), "retried next pass");
        // `run` imports outside files first: the foreign page arrives as a page of
        // its own (the title is taken), and only then does "Shared" get its file.
        let fid = crate::repo::sync::parse_frontmatter_id(&foreign).unwrap();
        let r = run(&db, &target, false).unwrap();
        assert_eq!(r.outside.created.len(), 1);
        let other = db.get_page(&fid).unwrap().expect("imported with its id");
        assert_eq!(other.title, "Shared (2)");
        assert_eq!(db.get_page_blocks(&fid).unwrap()[0].content, "from the other device");
        assert!(fs::read_to_string(target.dir.join("Shared (2).md")).unwrap().contains("from the other device"));
        assert!(fs::read_to_string(target.dir.join("Shared.md")).unwrap().contains("local"));
    }

    #[test]
    fn test_atomic_writes_leave_no_partial_files_and_failures_are_recorded() {
        let (_tmp, db, target) = setup();
        let p = db.create_page("Atomic", None, false, None, "user").unwrap();
        db.create_block(&p.id, "x".repeat(100_000).as_str(), None, None, "user").unwrap();
        run(&db, &target, false).unwrap();
        let text = fs::read_to_string(target.dir.join("Atomic.md")).unwrap();
        assert!(text.ends_with("-->\n"), "complete file");
        assert!(no_temp_files(&target.dir));

        // A file in the way of the mirror dir: the pass fails and says so.
        let blocked = MirrorTarget::new(target.dir.join("Atomic.md").join("sub"), target.state_path.clone());
        assert!(run(&db, &blocked, true).is_err());
        let st = status(&blocked, true);
        assert!(st.error.is_some(), "failure recorded for the 'behind — retry' status");
        // The next good pass clears it.
        run(&db, &target, true).unwrap();
        assert!(status(&target, true).error.is_none());
    }

    #[test]
    fn test_skip_holds_back_pages() {
        let (_tmp, db, mut target) = setup();
        let keep = db.create_page("Keep", None, false, None, "user").unwrap();
        let held = db.create_page("Held", None, false, None, "user").unwrap();
        run(&db, &target, false).unwrap();
        fs::remove_file(target.dir.join("Held.md")).unwrap(); // deleted by a pull
        target.skip.skip_pages.insert(held.id);
        db.create_block(&held.id, "edited", None, None, "user").unwrap();
        db.create_block(&keep.id, "edited", None, None, "user").unwrap();
        run(&db, &target, false).unwrap();
        run(&db, &target, true).unwrap();
        assert!(!target.dir.join("Held.md").exists(), "a held-back page is not written back");
        assert!(target.dir.join("Keep.md").exists());
    }

    /// The Phase-2 budget: an edit to one page mirrors in < 200 ms at 20k blocks.
    /// (Debug builds are several times slower than release; the bound here is
    /// generous for CI, the measured numbers are printed.)
    #[test]
    fn test_incremental_pass_budget_at_20k_blocks() {
        let (_tmp, db, target) = setup();
        let mut first = None;
        db.conn.execute_batch("BEGIN").unwrap();
        for i in 0..400 {
            let p = db.create_page(&format!("Scale {i}"), None, false, None, "user").unwrap();
            first.get_or_insert(p.id);
            let mut parent = None;
            for j in 0..50 {
                let b = db
                    .create_block(&p.id, &format!("block {j} of page {i} with [[Scale {}]]", (i + 1) % 400), parent.as_ref(), None, "user")
                    .unwrap();
                if j % 5 == 0 {
                    parent = Some(b.id);
                } else if j % 5 == 4 {
                    parent = None;
                }
            }
        }
        db.conn.execute_batch("COMMIT").unwrap();
        run(&db, &target, false).unwrap();
        let pid = first.unwrap();
        let blocks = db.get_page_blocks(&pid).unwrap();
        db.update_block(&blocks[0].id, Some("changed"), "user").unwrap();
        let t = Instant::now();
        let r = run(&db, &target, false).unwrap();
        let ms = t.elapsed().as_millis();
        eprintln!("[mirror budget] 20k blocks, one page edited: {ms} ms (prepare {} ms, apply {} ms)", r.prepare_ms, r.apply_ms);
        assert_eq!(r.pages_rendered, 1);
        assert!(ms < 1500, "incremental pass took {ms} ms");
    }
}
