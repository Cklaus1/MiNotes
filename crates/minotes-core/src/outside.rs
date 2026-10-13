//! Safe outside edits of the markdown mirror (PRD-notebooks Phase 4).
//!
//! The mirror records, per page, the sha256 of the file it wrote
//! ([`crate::mirror::PageEntry`]). A file that no longer has that hash was
//! changed by something other than MiNotes. Such a file is never overwritten
//! (the mirror's guard, see `mirror::apply` / `export::edited_outside`); this
//! module imports it instead:
//!
//! - **Changed file, page unchanged in the app** since the last mirror write →
//!   the id-preserving reconcile git sync uses (`sync_page` /
//!   `reconcile_page_blocks`). Lines removed from the file are not deleted:
//!   their blocks move to a page "<title> (removed outside …)" that is put in
//!   the Trash (ids kept, restorable). The report carries before/after block
//!   snapshots so the app can offer one undo step per file.
//! - **Changed file AND page changed in the app** (or trashed, or the file now
//!   carries another page's id) → the outside version becomes a separate page
//!   "<title> (edited outside)" — the policy of a git-sync conflict copy — and
//!   the mirror then writes the app's version back to the file.
//! - **New `.md` file** → a new page (folder from its directory; a taken title
//!   gets a " (2)" suffix — never merged into a same-titled page). A file
//!   carrying a known page's id at a new path is a move/rename of that page; a
//!   second copy of a page that still has its file becomes a separate page.
//! - **Deleted file** → its page goes to the Trash, under the same mass-delete
//!   guard as git sync (more than 20 pages, or more than half of them, in one
//!   go is refused: the pages are kept and their files written again). A page
//!   edited in the app since its file was written is kept (an edit beats a
//!   deletion).
//! - **Unreadable files** (binary, not UTF-8, over [`MAX_FILE_BYTES`], merge
//!   conflict markers, unclosed frontmatter) are left untouched and reported
//!   once per version — and, being "edited outside", never rewritten.
//!
//! Our own writes are recognised by hash, never by timestamp, so a watcher
//! that fires on every mirror write costs one hash per file and imports
//! nothing. Callers hold `mirror::FS_LOCK` and the DB (lock order: FS before
//! DB). A read-only database (another window holds the notebook) never imports.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::mirror::{self, MirrorTarget, PageEntry};
use crate::models::{Page, RestoreBlock};
use crate::repo::export::{self, bytes_hash, content_hash};
use crate::repo::sync::{self as syncmod, ImportFile, SyncResult};

/// Actor recorded on everything an outside-edit import changes.
pub const ACTOR: &str = "outside-edit";
/// Bigger `.md` files are not imported (reported, left untouched).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Which files to look at.
#[derive(Debug, Clone)]
pub enum Scope {
    /// Every `.md` file under the mirror, plus every file the mirror wrote
    /// (startup, before full passes).
    All,
    /// Paths relative to the mirror root reported by a file watcher. Anything
    /// that isn't a page file (a directory renamed or removed) widens the check
    /// to [`Scope::All`]; so does a removed page file (to tell a move from a
    /// deletion).
    Paths(Vec<PathBuf>),
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PageRef {
    pub page_id: Uuid,
    pub title: String,
    pub path: String,
}

/// A file whose outside edit went into its page.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedPage {
    pub page_id: Uuid,
    pub title: String,
    pub path: String,
    pub blocks_created: usize,
    pub blocks_updated: usize,
    pub blocks_removed: usize,
    /// The trashed page holding the blocks whose lines were removed.
    pub removed_page_id: Option<Uuid>,
    /// The page's blocks before / after the import (one undo step).
    pub before: Vec<RestoreBlock>,
    pub after: Vec<RestoreBlock>,
}

/// An outside version kept as a separate page.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictCopy {
    /// The page the file belonged to (None: it is gone).
    pub page_id: Option<Uuid>,
    pub title: String,
    pub copy_id: Uuid,
    pub copy_title: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Rejected {
    pub path: String,
    pub reason: String,
}

/// What one check imported. Empty when nothing was changed outside.
#[derive(Debug, Clone, Default, Serialize)]
pub struct OutsideReport {
    pub imported: Vec<ImportedPage>,
    /// New pages from new files (including copies of a page's file).
    pub created: Vec<PageRef>,
    pub conflicts: Vec<ConflictCopy>,
    /// Pages moved to the Trash because their file was deleted.
    pub trashed: Vec<PageRef>,
    /// Deleted files whose pages the mass-delete guard kept (written again).
    pub kept: Vec<PageRef>,
    /// Deleted files whose pages were edited in the app since (written again).
    pub restored: Vec<PageRef>,
    /// Files left untouched because they can't be imported.
    pub rejected: Vec<Rejected>,
    pub errors: Vec<String>,
}

impl OutsideReport {
    pub fn is_empty(&self) -> bool {
        self.imported.is_empty()
            && self.created.is_empty()
            && self.conflicts.is_empty()
            && self.trashed.is_empty()
            && self.kept.is_empty()
            && self.restored.is_empty()
            && self.rejected.is_empty()
            && self.errors.is_empty()
    }

    /// Pages whose content or state this check changed.
    pub fn touched_pages(&self) -> Vec<Uuid> {
        let mut v: Vec<Uuid> = self.imported.iter().map(|i| i.page_id).collect();
        v.extend(self.created.iter().map(|p| p.page_id));
        v.extend(self.conflicts.iter().map(|c| c.copy_id));
        v.extend(self.trashed.iter().map(|p| p.page_id));
        v.sort();
        v.dedup();
        v
    }
}

fn rel_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Paths an outside-edit check never looks at: dot-files and dot-dirs (`.git`,
/// `.minotes-*`, the mirror's temp files, editors' swap files), the root
/// `_attachments/` store, and anything that isn't a plain relative path.
pub fn is_ignored(rel: &Path) -> bool {
    for (i, c) in rel.components().enumerate() {
        let Component::Normal(n) = c else { return true };
        let n = n.to_string_lossy();
        if n.starts_with('.') || n.ends_with('~') {
            return true;
        }
        if i == 0 && n == crate::repo::attachments::MIRROR_DIR {
            return true;
        }
    }
    rel.as_os_str().is_empty() || rel_str(rel).ends_with(export::TMP_SUFFIX)
}

fn is_md(rel: &Path) -> bool {
    rel.extension().and_then(|e| e.to_str()) == Some("md")
}

/// A watcher path that can't be checked on its own (a directory).
fn wants_full_scan(dir: &Path, rel: &Path) -> bool {
    if is_ignored(rel) || is_md(rel) {
        return false;
    }
    let abs = dir.join(rel);
    abs.is_dir() || (rel.extension().is_none() && !abs.exists())
}

/// Why a symbolic link in the mirror is left alone (reported once per link).
pub const SYMLINK_REASON: &str = "skipped: symbolic link";

/// Read the page file `dir/rel`: (hash of the bytes, its text — or why it can't
/// be imported). Nothing is followed: a symbolic link as the file or as any
/// directory on the way is refused (it could point anywhere — `~/.ssh/id_rsa` —
/// and what is imported gets written back as a real file and committed).
fn read_candidate(dir: &Path, rel: &Path) -> (String, std::result::Result<String, String>) {
    if let Some(link) = export::symlink_below(dir, rel) {
        let target = fs::read_link(&link).map(|t| t.display().to_string()).unwrap_or_default();
        return (format!("symlink:{}:{target}", link.display()), Err(SYMLINK_REASON.into()));
    }
    let abs = dir.join(rel);
    let abs = abs.as_path();
    let meta = match fs::symlink_metadata(abs) {
        Ok(m) => m,
        Err(e) => return (String::new(), Err(format!("cannot read: {e}"))),
    };
    if meta.len() > MAX_FILE_BYTES {
        let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
        return (
            format!("size:{}:{stamp}", meta.len()),
            Err(format!("larger than {} MB", MAX_FILE_BYTES / (1024 * 1024))),
        );
    }
    let bytes = match fs::read(abs) {
        Ok(b) => b,
        Err(e) => return (String::new(), Err(format!("cannot read: {e}"))),
    };
    let hash = bytes_hash(&bytes);
    if bytes.contains(&0) {
        return (hash, Err("binary file".into()));
    }
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return (hash, Err("not UTF-8 text".into())),
    };
    if crate::git_cmd::has_conflict_markers(&text) {
        return (hash, Err("contains merge-conflict markers".into()));
    }
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut lines = body.lines();
    if lines.next().map(|l| l.trim()) == Some("---") && !lines.any(|l| l.trim() == "---") {
        return (hash, Err("frontmatter is not closed with ---".into()));
    }
    (hash, Ok(text))
}

/// The page's blocks as `restore_blocks` takes them (outline order, properties).
pub fn snapshot(db: &Database, page_id: &Uuid) -> Result<Vec<RestoreBlock>> {
    let mut out = Vec::new();
    for b in db.get_page_blocks(page_id)? {
        let properties = db
            .get_properties(&b.id)?
            .into_iter()
            .filter_map(|p| p.value.map(|v| (p.key, v)))
            .collect();
        out.push(RestoreBlock {
            id: b.id,
            page_id: b.page_id,
            parent_id: b.parent_id,
            content: b.content,
            position: b.position,
            properties,
        });
    }
    Ok(out)
}

fn free_title(db: &Database, wanted: &str) -> Result<String> {
    if db.get_page_by_title(wanted)?.is_some() {
        db.unique_page_title(wanted)
    } else {
        Ok(wanted.to_string())
    }
}

/// Move the block subtrees rooted at `roots` to a new page in the Trash, titled
/// "<base> (removed outside <time>)". Ids, children and properties travel with
/// them; restoring that page from the Trash brings the text back.
pub(crate) fn park_blocks_in_trash(db: &Database, base: &str, roots: &[Uuid]) -> Result<Uuid> {
    park_blocks_as(db, base, "removed outside", roots, ACTOR)
}

/// [`park_blocks_in_trash`] with the title "<base> (<what> <time>)" and `actor`.
pub(crate) fn park_blocks_as(db: &Database, base: &str, what: &str, roots: &[Uuid], actor: &str) -> Result<Uuid> {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M");
    let title = free_title(db, &format!("{base} ({what} {stamp})"))?;
    let page = db.create_page(&title, None, false, None, actor)?;
    let now = chrono::Utc::now().to_rfc3339();
    for (i, root) in roots.iter().enumerate() {
        let ids = db.block_subtree_ids(root)?;
        let json = serde_json::to_string(&ids)?;
        db.conn.execute(
            "UPDATE blocks SET page_id = ?1, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?3))",
            rusqlite::params![page.id.to_string(), now, json],
        )?;
        db.conn.execute(
            "UPDATE blocks SET parent_id = NULL, position = ?1 WHERE id = ?2",
            rusqlite::params![(i + 1) as f64, root.to_string()],
        )?;
    }
    db.trash_page(&page.id)?;
    Ok(page.id)
}

/// Folder for a file at `components` (its directory): the `.minotes-folder.json`
/// markers on the way win (directory names may be de-duplicated), then folders
/// by name, created when missing.
fn resolve_folder(db: &Database, dir: &Path, components: &[String]) -> Result<Option<Uuid>> {
    let mut cache: HashMap<Vec<String>, Uuid> = HashMap::new();
    let mut acc = PathBuf::new();
    let mut key: Vec<String> = Vec::new();
    for c in components {
        acc.push(c);
        key.push(c.clone());
        if let Some(m) = export::read_folder_marker(dir, &acc) {
            if db.get_folder(&m.id)?.is_some() && !db.is_folder_trashed(&m.id)? {
                cache.insert(key.clone(), m.id);
            }
        }
    }
    let mut sr = SyncResult::default();
    db.ensure_folder_path(components, ACTOR, &mut sr, &mut cache)
}

/// A file written for `page` but missing (some of) our frontmatter: the page
/// keeps its identity, title, journal date and — with no frontmatter at all —
/// its properties.
fn fill_frontmatter(db: &Database, file: &mut ImportFile, page: &Page) -> Result<()> {
    if file.fm.id.is_some() {
        return Ok(());
    }
    let body = file.content.strip_prefix('\u{feff}').unwrap_or(&file.content);
    let had_fm = body.lines().next().map(|l| l.trim()) == Some("---");
    file.fm.id = Some(page.id);
    if file.fm.title.as_deref().map(|t| t.trim().is_empty()).unwrap_or(true) {
        file.fm.title = Some(page.title.clone());
    }
    file.fm.is_journal = page.is_journal;
    file.fm.date = page.journal_date;
    if !had_fm {
        file.fm.props = db
            .get_properties(&page.id)?
            .into_iter()
            .filter(|p| export::fm_key_exportable(&p.key))
            .filter_map(|p| p.value.map(|v| (p.key, v)))
            .collect();
    }
    Ok(())
}

/// Give block markers that already belong to another page's blocks fresh ids
/// (a dropped-in file must never pull blocks out of other pages).
fn refresh_known_markers(db: &Database, content: &str) -> Result<String> {
    let mut out = String::with_capacity(content.len());
    for line in content.split_inclusive('\n') {
        let (_, id) = syncmod::split_id_marker(line.trim_end_matches(['\n', '\r']));
        match id {
            Some(id) if db.get_block(&id)?.is_some() => out.push_str(&syncmod::refresh_marker(line)),
            _ => out.push_str(line),
        }
    }
    Ok(out)
}

/// What the mirror state should say about a file after it was handled.
enum Settle {
    /// File and page agree now (or the file was imported): `rewrite` makes the
    /// next pass write the page's rendering (block ids) over it.
    Track { id: Uuid, rel: PathBuf, hash: String, rewrite: bool },
    /// The file's content lives on in a page; let the mirror write that page's
    /// own rendering over the file.
    Overwrite { id: Uuid, rel: PathBuf, hash: String },
    /// An untracked file now imported as `page`: tracked if the page's file
    /// goes exactly there, otherwise moved to `.minotes-trash/`.
    Untracked { page: Uuid, rel: PathBuf, hash: String, same_id: bool },
}

struct Ctx<'a> {
    db: &'a Database,
    dir: &'a Path,
    report: OutsideReport,
    settle: Vec<Settle>,
}

impl Ctx<'_> {
    /// Reconcile `file` into `page` (ids kept, removed lines parked in Trash).
    fn import_into(&mut self, rel: &Path, mut file: ImportFile, page: &Page, folder: Option<Option<Uuid>>, title: Option<String>) -> Result<()> {
        let db = self.db;
        fill_frontmatter(db, &mut file, page)?;
        if let Some(t) = title {
            file.fm.title = Some(t);
        }
        let before = snapshot(db, &page.id)?;
        let mut sr = SyncResult::default();
        let mut removed: Vec<Uuid> = Vec::new();
        let dir = self.dir;
        let parked = db.tx(|| {
            let folder_id = match folder {
                Some(f) => f,
                None => resolve_folder(db, dir, &file.folder)?,
            };
            let mut seen = HashSet::new();
            db.sync_page(&file, folder_id, ACTOR, &mut sr, &mut seen, &HashSet::new(), Some(&mut removed))?;
            if removed.is_empty() {
                Ok(None)
            } else {
                let base = db.get_page(&page.id)?.map(|p| p.title).unwrap_or_else(|| page.title.clone());
                Ok(Some(park_blocks_in_trash(db, &base, &removed)?))
            }
        })?;
        if sr.pages_updated.is_empty() && parked.is_none() {
            return Ok(()); // nothing that shows changed (e.g. whitespace only)
        }
        let now = db.get_page(&page.id)?.ok_or_else(|| Error::NotFound(format!("Page {}", page.id)))?;
        let after = snapshot(db, &page.id)?;
        let blocks_removed = match parked {
            Some(pid) => db.get_page_blocks(&pid)?.len(),
            None => 0,
        };
        self.report.imported.push(ImportedPage {
            page_id: page.id,
            title: now.title,
            path: rel_str(rel),
            blocks_created: sr.blocks_created,
            blocks_updated: sr.blocks_updated,
            blocks_removed,
            removed_page_id: parked,
            before,
            after,
        });
        Ok(())
    }

    /// Keep `file` as a separate page "<base> (<suffix>)" in `folder`.
    fn keep_as_copy(&mut self, rel: &Path, file: &ImportFile, base: &str, suffix: Option<&str>, folder: Option<Uuid>) -> Result<(Uuid, String)> {
        let db = self.db;
        let wanted = match suffix {
            Some(s) => format!("{base} ({s})"),
            None => base.to_string(),
        };
        let title = free_title(db, &wanted)?;
        let content = syncmod::rewrite_as_separate_page(&file.content, &title);
        let copy = ImportFile::from_text(rel, &content);
        let id = copy.fm.id.ok_or_else(|| Error::InvalidInput("copy without id".into()))?;
        let mut sr = SyncResult::default();
        db.tx(|| db.sync_page(&copy, folder, ACTOR, &mut sr, &mut HashSet::new(), &HashSet::new(), None))?;
        Ok((id, title))
    }

    /// A new page from a dropped-in file (unknown or no id).
    fn create_from(&mut self, mut file: ImportFile) -> Result<(Uuid, String)> {
        let db = self.db;
        let base = file.fm.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| file.stem.clone());
        let title = free_title(db, &base)?;
        file.fm.title = Some(title.clone());
        let id = *file.fm.id.get_or_insert_with(Uuid::now_v7);
        file.content = refresh_known_markers(db, &file.content)?;
        let dir = self.dir;
        let mut sr = SyncResult::default();
        db.tx(|| {
            let folder = resolve_folder(db, dir, &file.folder)?;
            db.sync_page(&file, folder, ACTOR, &mut sr, &mut HashSet::new(), &HashSet::new(), None)
        })?;
        Ok((id, title))
    }
}

/// Was the page changed in the app since the mirror wrote (or last imported)
/// its file? Trashed / archived counts as changed.
fn changed_in_app(db: &Database, fps: &HashMap<Uuid, String>, st: &mirror::MirrorState, id: &Uuid) -> Result<bool> {
    let entry_fp = st.pages.get(id).map(|e| e.fp.as_str());
    Ok(fps.get(id).map(String::as_str) != entry_fp || db.is_page_hidden(id)?)
}

fn read_manifest(dir: &Path) -> HashSet<Uuid> {
    export::read_text_below(dir, Path::new(export::EXPORT_MANIFEST))
        .map(|s| s.lines().filter_map(|l| Uuid::parse_str(l.trim()).ok()).collect())
        .unwrap_or_default()
}

/// Import what was changed outside MiNotes in the mirror at `target` (see the
/// module docs). Needs the mirror state (`target.state_path`) of a completed
/// full pass; without it nothing can be told apart and nothing is imported.
pub fn import_outside_edits(db: &Database, target: &MirrorTarget, scope: &Scope) -> Result<OutsideReport> {
    let empty = OutsideReport::default();
    if db.is_read_only() {
        return Ok(empty);
    }
    let Some(state_path) = target.state_path.as_deref() else { return Ok(empty) };
    let dir = target.dir.as_path();
    if !dir.is_dir() {
        return Ok(empty);
    }
    let mut st = mirror::load_state(state_path);
    if !mirror::state_usable(&st, dir) {
        return Ok(empty);
    }
    let tracked: HashMap<String, Uuid> = st.pages.iter().map(|(id, e)| (e.path.clone(), *id)).collect();

    // ── Which files ──
    let mut full = matches!(scope, Scope::All);
    let mut rels: Vec<PathBuf> = Vec::new();
    if let Scope::Paths(ps) = scope {
        for p in ps {
            if is_ignored(p) {
                continue;
            }
            if wants_full_scan(dir, p) || (is_md(p) && tracked.contains_key(&rel_str(p)) && !dir.join(p).exists()) {
                full = true;
                break;
            }
            if is_md(p) {
                rels.push(p.clone());
            }
        }
    }
    let mut complete = true;
    if full {
        let scan = syncmod::scan_markdown_tree(dir);
        complete = scan.complete;
        let mut set: BTreeSet<PathBuf> = scan.files.into_iter().map(|f| f.rel).collect();
        set.extend(st.pages.values().map(|e| PathBuf::from(&e.path)));
        rels = set.into_iter().collect();
        // Keep the "reported" mark of files (and links) that are still there.
        st.rejected.retain(|k, _| fs::symlink_metadata(dir.join(k)).map(|m| !m.is_dir()).unwrap_or(false));
    } else {
        rels.sort();
        rels.dedup();
    }
    if rels.is_empty() {
        return Ok(empty);
    }

    // ── Classify (hash first: our own writes stop here) ──
    let mut changed: Vec<(PathBuf, Uuid, String, String)> = Vec::new();
    let mut new_files: Vec<(PathBuf, String, String)> = Vec::new();
    let mut missing: Vec<(PathBuf, Uuid)> = Vec::new();
    let mut report = OutsideReport::default();
    let mut state_dirty = false;
    for rel in &rels {
        let key = rel_str(rel);
        let abs = dir.join(rel);
        let tracked_id = tracked.get(&key).copied();
        let linked = export::symlink_below(dir, rel).is_some();
        if !linked && !abs.is_file() {
            if let Some(id) = tracked_id {
                if !abs.exists() {
                    missing.push((rel.clone(), id));
                }
            }
            state_dirty |= st.rejected.remove(&key).is_some();
            continue;
        }
        let (hash, body) = read_candidate(dir, rel);
        if let Some(id) = tracked_id {
            if st.pages.get(&id).map(|e| e.hash == hash).unwrap_or(false) {
                state_dirty |= st.rejected.remove(&key).is_some();
                continue; // what we wrote
            }
        }
        match body {
            Err(reason) => {
                if st.rejected.get(&key) != Some(&hash) {
                    eprintln!("[minotes-outside] leaving {key} untouched: {reason}");
                    report.rejected.push(Rejected { path: key.clone(), reason });
                    st.rejected.insert(key, hash);
                    state_dirty = true;
                }
            }
            Ok(text) => {
                state_dirty |= st.rejected.remove(&key).is_some();
                match tracked_id {
                    Some(id) => changed.push((rel.clone(), id, text, hash)),
                    None => new_files.push((rel.clone(), text, hash)),
                }
            }
        }
    }
    if changed.is_empty() && new_files.is_empty() && missing.is_empty() {
        if state_dirty {
            mirror::save_state(state_path, &st)?;
        }
        return Ok(report);
    }

    let fps = mirror::page_fingerprints(db)?;
    let skip = &target.skip.skip_pages;
    let mut cx = Ctx { db, dir, report, settle: Vec::new() };
    let app_changed = |st: &mirror::MirrorState, id: &Uuid| changed_in_app(db, &fps, st, id);

    // ── Changed files ──
    for (rel, id, text, hash) in changed {
        if skip.contains(&id) {
            continue;
        }
        let file = ImportFile::from_text(&rel, &text);
        let page = db.get_page(&id)?;
        let foreign = matches!(file.fm.id, Some(x) if x != id);
        let res = (|| -> Result<()> {
            match page {
                Some(p) if !foreign => {
                    let (rendered, _) = db.render_page_for_export(&p, &rel)?;
                    if rendered == text {
                        cx.settle.push(Settle::Track { id, rel: rel.clone(), hash: hash.clone(), rewrite: false });
                    } else if !app_changed(&st, &id)? {
                        cx.import_into(&rel, file, &p, Some(p.folder_id), None)?;
                        cx.settle.push(Settle::Track { id, rel: rel.clone(), hash: hash.clone(), rewrite: true });
                    } else {
                        let (copy_id, copy_title) = cx.keep_as_copy(&rel, &file, &p.title, Some("edited outside"), p.folder_id)?;
                        cx.report.conflicts.push(ConflictCopy {
                            page_id: Some(id),
                            title: p.title.clone(),
                            copy_id,
                            copy_title,
                            path: rel_str(&rel),
                        });
                        cx.settle.push(Settle::Overwrite { id, rel: rel.clone(), hash: hash.clone() });
                    }
                }
                other => {
                    let base = other.as_ref().map(|p| p.title.clone()).or_else(|| file.fm.title.clone()).unwrap_or_else(|| file.stem.clone());
                    let folder = match &other {
                        Some(p) => p.folder_id,
                        None => resolve_folder(db, dir, &file.folder)?,
                    };
                    let (copy_id, copy_title) = cx.keep_as_copy(&rel, &file, &base, Some("edited outside"), folder)?;
                    cx.report.conflicts.push(ConflictCopy {
                        page_id: other.as_ref().map(|p| p.id),
                        title: base,
                        copy_id,
                        copy_title,
                        path: rel_str(&rel),
                    });
                    cx.settle.push(Settle::Overwrite { id, rel: rel.clone(), hash: hash.clone() });
                }
            }
            Ok(())
        })();
        if let Err(e) = res {
            cx.report.errors.push(format!("{}: {e}", rel.display()));
        }
    }

    // ── New files (moves first, so their old paths don't read as deletions) ──
    let manifest = read_manifest(dir);
    let mut moved: HashSet<Uuid> = HashSet::new();
    for (rel, text, hash) in new_files {
        let file = ImportFile::from_text(&rel, &text);
        let res = (|| -> Result<()> {
            let known = match file.fm.id {
                Some(x) => db.get_page(&x)?.map(|p| (x, p)),
                None => None,
            };
            match (file.fm.id, known) {
                (Some(x), Some((_, page))) => {
                    if skip.contains(&x) || db.is_page_hidden(&x)? {
                        return Ok(()); // archived / trashed / held: its file is the mirror's business
                    }
                    match st.pages.get(&x).cloned() {
                        Some(e) if fs::symlink_metadata(dir.join(&e.path)).is_err() && !moved.contains(&x) => {
                            // Moved or renamed outside.
                            moved.insert(x);
                            if app_changed(&st, &x)? {
                                let (copy_id, copy_title) = cx.keep_as_copy(&rel, &file, &page.title, Some("edited outside"), page.folder_id)?;
                                cx.report.conflicts.push(ConflictCopy {
                                    page_id: Some(x),
                                    title: page.title.clone(),
                                    copy_id,
                                    copy_title,
                                    path: rel_str(&rel),
                                });
                                cx.settle.push(Settle::Untracked { page: copy_id, rel: rel.clone(), hash: hash.clone(), same_id: false });
                            } else {
                                let old_stem = Path::new(&e.path).file_stem().map(|s| s.to_string_lossy().to_string());
                                let fm_title_kept = file.fm.title.as_deref().map(|t| t == page.title).unwrap_or(true);
                                let title = (old_stem.as_deref() != Some(file.stem.as_str()) && fm_title_kept).then(|| file.stem.clone());
                                cx.import_into(&rel, file, &page, None, title)?;
                                if !cx.report.imported.iter().any(|i| i.page_id == x) {
                                    // Only the path moved: still worth a notice.
                                    let t = db.get_page(&x)?.map(|p| p.title).unwrap_or_default();
                                    cx.report.imported.push(ImportedPage {
                                        page_id: x,
                                        title: t,
                                        path: rel_str(&rel),
                                        blocks_created: 0,
                                        blocks_updated: 0,
                                        blocks_removed: 0,
                                        removed_page_id: None,
                                        before: vec![],
                                        after: vec![],
                                    });
                                }
                                cx.settle.push(Settle::Untracked { page: x, rel: rel.clone(), hash: hash.clone(), same_id: true });
                            }
                        }
                        Some(_) => {
                            // A copy of a page that still has its file: a page of its own.
                            let (id, title) = cx.keep_as_copy(&rel, &file, &file.stem, None, resolve_folder(db, dir, &file.folder)?)?;
                            cx.report.created.push(PageRef { page_id: id, title, path: rel_str(&rel) });
                            cx.settle.push(Settle::Untracked { page: id, rel: rel.clone(), hash: hash.clone(), same_id: false });
                        }
                        None => {
                            // Known, visible, but the mirror has no record of its file.
                            let (rendered, _) = db.render_page_for_export(&page, &rel)?;
                            if rendered == text {
                                cx.settle.push(Settle::Untracked { page: x, rel: rel.clone(), hash: hash.clone(), same_id: true });
                            } else {
                                let (copy_id, copy_title) = cx.keep_as_copy(&rel, &file, &page.title, Some("edited outside"), page.folder_id)?;
                                cx.report.conflicts.push(ConflictCopy {
                                    page_id: Some(x),
                                    title: page.title.clone(),
                                    copy_id,
                                    copy_title,
                                    path: rel_str(&rel),
                                });
                                cx.settle.push(Settle::Untracked { page: copy_id, rel: rel.clone(), hash: hash.clone(), same_id: false });
                            }
                        }
                    }
                }
                (Some(x), None) if manifest.contains(&x) => {} // deleted here; the next full pass moves it aside
                _ => {
                    let same_id = file.fm.id.is_some();
                    let (id, title) = cx.create_from(file)?;
                    cx.report.created.push(PageRef { page_id: id, title, path: rel_str(&rel) });
                    cx.settle.push(Settle::Untracked { page: id, rel: rel.clone(), hash: hash.clone(), same_id });
                }
            }
            Ok(())
        })();
        if let Err(e) = res {
            cx.report.errors.push(format!("{}: {e}", rel.display()));
        }
    }

    // ── Deleted files ──
    let mut doomed: Vec<(PathBuf, Page)> = Vec::new();
    for (rel, id) in missing {
        if moved.contains(&id) || skip.contains(&id) {
            continue;
        }
        let Some(page) = db.get_page(&id)? else { continue };
        if db.is_page_hidden(&id)? {
            continue; // already trashed / archived: the mirror tidies its own record
        }
        if app_changed(&st, &id)? {
            // Edited here since its file was written: an edit beats a deletion.
            st.pages.remove(&id);
            cx.report.restored.push(PageRef { page_id: id, title: page.title, path: rel_str(&rel) });
            continue;
        }
        doomed.push((rel, page));
    }
    if !doomed.is_empty() {
        if !complete {
            cx.report.errors.push("The markdown folder could not be read completely; no pages were deleted".into());
        } else {
            let total: usize =
                db.conn.query_row("SELECT COUNT(*) FROM pages WHERE id NOT IN (SELECT page_id FROM trash)", [], |r| r.get::<_, i64>(0))?
                    as usize;
            let allowed = syncmod::deletion_allowed(doomed.len(), total, false);
            if allowed {
                db.tx(|| {
                    for (_, p) in &doomed {
                        db.trash_page(&p.id)?;
                    }
                    Ok(())
                })?;
            }
            for (rel, p) in doomed {
                st.pages.remove(&p.id);
                let r = PageRef { page_id: p.id, title: p.title, path: rel_str(&rel) };
                if allowed {
                    cx.report.trashed.push(r);
                } else {
                    cx.report.kept.push(r);
                }
            }
            if !allowed {
                eprintln!("[minotes-outside] {} page files were deleted at once; pages kept (mass-delete guard)", cx.report.kept.len());
            }
        }
    }

    // ── Record what the files are now ──
    let Ctx { report, settle, .. } = cx;
    let fps_after = mirror::page_fingerprints(db)?;
    let planned: HashMap<Uuid, String> = if settle.iter().any(|s| matches!(s, Settle::Untracked { .. })) {
        db.plan_export_paths()?.pages.into_iter().map(|(p, rel)| (p.id, rel_str(&rel))).collect()
    } else {
        HashMap::new()
    };
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f").to_string();
    for s in settle {
        match s {
            Settle::Track { id, rel, hash, rewrite } => {
                let fp = fps_after.get(&id).cloned().unwrap_or_default();
                st.pages.insert(id, PageEntry { path: rel_str(&rel), hash, fp, rewrite });
            }
            Settle::Overwrite { id, rel, hash } => {
                if let Some(e) = st.pages.get_mut(&id) {
                    e.hash = hash;
                } else {
                    st.pages.insert(id, PageEntry { path: rel_str(&rel), hash, fp: String::new(), rewrite: true });
                }
            }
            Settle::Untracked { page, rel, hash, same_id } => {
                let key = rel_str(&rel);
                if planned.get(&page) == Some(&key) || (same_id && planned.contains_key(&page)) {
                    let fp = fps_after.get(&page).cloned().unwrap_or_default();
                    st.pages.insert(page, PageEntry { path: key, hash, fp, rewrite: true });
                } else if let Err(e) = export::move_to_sync_trash(dir, &rel, &stamp) {
                    eprintln!("[minotes-outside] could not move imported {key} aside: {e}");
                }
            }
        }
    }
    mirror::save_state(state_path, &st)?;
    Ok(report)
}

/// After git sync imported pulled files into the database: they are the
/// mirror's files now (not outside edits). Re-baseline the hashes of the files
/// the pull changed (`paths`, relative; None = all), so the next pass simply
/// writes the database's version where the two differ — exactly what it did
/// before outside edits were tracked.
pub fn adopt_pulled_files(db: &Database, target: &MirrorTarget, paths: Option<&[String]>) -> Result<()> {
    let Some(state_path) = target.state_path.as_deref() else { return Ok(()) };
    let dir = target.dir.as_path();
    let mut st = mirror::load_state(state_path);
    if !dir.is_dir() || !mirror::state_usable(&st, dir) {
        return Ok(());
    }
    let rels: Vec<PathBuf> = match paths {
        Some(ps) => ps.iter().map(PathBuf::from).filter(|p| is_md(p) && !is_ignored(p)).collect(),
        None => syncmod::scan_markdown_tree(dir).files.into_iter().map(|f| f.rel).collect(),
    };
    if rels.is_empty() {
        return Ok(());
    }
    let tracked: HashMap<String, Uuid> = st.pages.iter().map(|(id, e)| (e.path.clone(), *id)).collect();
    let fps = mirror::page_fingerprints(db)?;
    for rel in rels {
        let key = rel_str(&rel);
        // A symbolic link the pull wrote is never read through.
        let Ok(bytes) = export::read_below(dir, &rel) else { continue };
        let hash = bytes_hash(&bytes);
        if let Some(id) = tracked.get(&key) {
            if let Some(e) = st.pages.get_mut(id) {
                e.hash = hash;
            }
            continue;
        }
        let Some(id) = syncmod::parse_frontmatter_id(&String::from_utf8_lossy(&bytes)) else { continue };
        if st.pages.contains_key(&id) || db.get_page(&id)?.is_none() || db.is_page_hidden(&id)? {
            continue;
        }
        let fp = fps.get(&id).cloned().unwrap_or_default();
        st.pages.insert(id, PageEntry { path: key, hash, fp, rewrite: true });
    }
    mirror::save_state(state_path, &st)
}

/// Make `page_id`'s blocks exactly `blocks` (an [`ImportedPage`] snapshot): the
/// undo / redo of one outside-edit import. Blocks that exist anywhere (e.g. in
/// the "removed outside" page in the Trash) are moved back with their ids;
/// missing ones are recreated. Blocks on the page that are not in `blocks` are
/// deleted — or, with `park_as`, parked in a new Trash page (returned).
/// `cleanup`: a "removed outside" page left empty is deleted for good.
pub fn set_page_blocks(
    db: &Database,
    page_id: &Uuid,
    blocks: &[RestoreBlock],
    park_as: Option<&str>,
    cleanup: Option<&Uuid>,
) -> Result<Option<Uuid>> {
    let parked = db.tx(|| {
        if db.get_page(page_id)?.is_none() {
            return Err(Error::NotFound(format!("Page {page_id}")));
        }
        let want: HashSet<Uuid> = blocks.iter().map(|b| b.id).collect();
        let now = chrono::Utc::now().to_rfc3339();
        let mut missing: Vec<RestoreBlock> = Vec::new();
        for b in blocks {
            match db.get_block(&b.id)? {
                Some(cur) => {
                    db.conn.execute(
                        "UPDATE blocks SET page_id = ?1, parent_id = NULL, position = ?2, updated_at = ?3 WHERE id = ?4",
                        rusqlite::params![page_id.to_string(), b.position, now, b.id.to_string()],
                    )?;
                    if syncmod::normalize_content(&cur.content) != syncmod::normalize_content(&b.content) {
                        db.update_block(&b.id, Some(&b.content), ACTOR)?;
                    }
                }
                None => missing.push(RestoreBlock { page_id: *page_id, parent_id: None, ..b.clone() }),
            }
        }
        if !missing.is_empty() {
            db.restore_blocks(&missing, ACTOR)?;
        }
        // Parents in snapshot (outline) order: ancestors are final before children.
        for b in blocks {
            db.conn.execute(
                "UPDATE blocks SET parent_id = ?1, position = ?2 WHERE id = ?3",
                rusqlite::params![b.parent_id.map(|p| p.to_string()), b.position, b.id.to_string()],
            )?;
        }
        let extras: Vec<crate::models::Block> =
            db.get_page_blocks(page_id)?.into_iter().filter(|b| !want.contains(&b.id)).collect();
        let extra_ids: HashSet<Uuid> = extras.iter().map(|b| b.id).collect();
        let roots: Vec<Uuid> = extras
            .iter()
            .filter(|b| b.parent_id.map(|p| !extra_ids.contains(&p)).unwrap_or(true))
            .map(|b| b.id)
            .collect();
        let mut parked = None;
        if !roots.is_empty() {
            match park_as {
                Some(base) => parked = Some(park_blocks_in_trash(db, base, &roots)?),
                None => {
                    for r in &roots {
                        db.delete_block(r, ACTOR)?;
                    }
                }
            }
        }
        db.conn.execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, page_id.to_string()],
        )?;
        Ok(parked)
    })?;
    if let Some(c) = cleanup {
        if db.get_page(c)?.is_some() && db.is_trashed(c)? && db.get_page_blocks(c)?.is_empty() {
            db.permanently_delete_page(c, ACTOR)?;
        }
    }
    Ok(parked)
}

/// Hash of `content` as the mirror records it (for tests and tools).
pub fn file_hash(content: &str) -> String {
    content_hash(content)
}

#[cfg(test)]
mod tests;
