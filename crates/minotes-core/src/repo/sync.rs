use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, Utc};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};

/// Result of a sync-dir operation.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncResult {
    pub folders_created: Vec<String>,
    pub folders_existing: usize,
    pub pages_created: Vec<String>,
    pub pages_updated: Vec<String>,
    pub pages_unchanged: usize,
    pub pages_deleted: Vec<String>,
    pub blocks_created: usize,
    pub blocks_updated: usize,
    /// Pages NOT overwritten from their file because they were edited locally after
    /// the export that preceded this import (they'll be exported on the next sync).
    pub pages_skipped_local_edits: Vec<String>,
    /// Files ignored because another file carries the same page id.
    pub duplicates_ignored: Vec<String>,
    /// Per-file / per-step problems. The import of other pages still went through.
    pub errors: Vec<String>,
}

/// Options for [`Database::sync_dir_with`].
#[derive(Debug, Clone, Default)]
pub struct SyncOptions {
    /// Trash pages that have no file in the directory (guarded; see `force_delete`).
    pub delete_missing: bool,
    /// After importing, export the DB back to the directory (pruning stale files).
    pub write_back: bool,
    /// Bypass the mass-deletion guard (>20 pages or >50% of pages in one pass).
    pub force_delete: bool,
    /// Pages modified locally after this instant are not overwritten from files.
    pub protect_modified_after: Option<DateTime<Utc>>,
    /// Pages whose file was removed upstream (e.g. by a `git pull`); moved to trash.
    pub trash_page_ids: Vec<Uuid>,
}

/// One `.md` file found under a sync dir.
#[derive(Debug, Clone)]
pub(crate) struct ScannedFile {
    pub(crate) rel: PathBuf,
    pub(crate) abs: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Scan {
    pub(crate) files: Vec<ScannedFile>,
    /// Relative paths of every (non-hidden) directory visited, excluding the root.
    pub(crate) dirs: Vec<PathBuf>,
    /// False if any directory entry could not be read — the scan may be partial.
    pub(crate) complete: bool,
    pub(crate) errors: Vec<String>,
}

/// Walk a sync dir collecting `.md` files. Dot-directories (`.git`, `.minotes-trash`,
/// …) are skipped — the exporter never produces dot-prefixed names, so export and
/// import agree. Symlinks are not followed. Any unreadable entry marks the scan as
/// incomplete instead of being silently dropped.
pub(crate) fn scan_markdown_tree(root: &Path) -> Scan {
    let mut scan = Scan { complete: true, ..Default::default() };
    let mut stack: Vec<PathBuf> = vec![PathBuf::new()];
    while let Some(rel_dir) = stack.pop() {
        let abs_dir = root.join(&rel_dir);
        let rd = match fs::read_dir(&abs_dir) {
            Ok(rd) => rd,
            Err(e) => {
                scan.complete = false;
                scan.errors.push(format!("Cannot read {}: {e}", abs_dir.display()));
                continue;
            }
        };
        let mut entries = Vec::new();
        for entry in rd {
            match entry {
                Ok(e) => entries.push(e),
                Err(e) => {
                    scan.complete = false;
                    scan.errors.push(format!("Cannot read entry in {}: {e}", abs_dir.display()));
                }
            }
        }
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(e) => {
                    scan.complete = false;
                    scan.errors.push(format!("Cannot stat {}: {e}", entry.path().display()));
                    continue;
                }
            };
            let rel = rel_dir.join(&name);
            if ft.is_dir() {
                if name_str.starts_with('.') {
                    continue;
                }
                scan.dirs.push(rel.clone());
                stack.push(rel);
            } else if ft.is_file() && rel.extension().and_then(|e| e.to_str()) == Some("md") {
                scan.files.push(ScannedFile { abs: root.join(&rel), rel });
            }
        }
    }
    scan.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    scan
}

/// A parsed `.md` file ready to import.
struct ImportFile {
    rel: PathBuf,
    stem: String,
    folder: Vec<String>,
    content: String,
    fm: Frontmatter,
    mtime: Option<std::time::SystemTime>,
}

/// Is this a conflict copy written by `git_cmd::auto_resolve_conflicts`?
pub(crate) fn is_conflict_copy_name(rel: &Path) -> bool {
    rel.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.contains(".conflict-") && n.ends_with(".md"))
        .unwrap_or(false)
}

/// Mass-deletion guard: refuse to trash more than 20 pages, or more than half of
/// all pages, in one pass unless forced. A single page is always allowed.
fn deletion_allowed(n: usize, total: usize, force: bool) -> bool {
    force || n <= 1 || (n <= 20 && n * 2 <= total)
}

impl Database {
    /// Sync a filesystem directory tree into the MiNotes database.
    ///
    /// - Subdirectories become folders (nested)
    /// - .md files become pages (in the corresponding folder)
    /// - On re-sync: new files are created, changed files are updated,
    ///   deleted files optionally removed
    /// - Bidirectional: if `write_back` is true, also export DB changes
    ///   back to the filesystem
    pub fn sync_dir(
        &self,
        dir: &Path,
        actor: &str,
        delete_missing: bool,
        write_back: bool,
    ) -> Result<SyncResult> {
        let opts = SyncOptions { delete_missing, write_back, ..Default::default() };
        self.sync_dir_with(dir, actor, &opts)
    }

    /// [`sync_dir`](Self::sync_dir) with full options. The DB side runs inside a
    /// SAVEPOINT (so a hard failure leaves nothing half-applied), and each page is
    /// imported in its own nested SAVEPOINT so one bad file is rolled back and
    /// reported in `errors` without aborting the rest.
    pub fn sync_dir_with(&self, dir: &Path, actor: &str, opts: &SyncOptions) -> Result<SyncResult> {
        let mut result = SyncResult::default();

        if !dir.exists() {
            fs::create_dir_all(dir)
                .map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", dir.display())))?;
        }
        if !dir.is_dir() {
            return Err(Error::InvalidInput(format!("Not a directory: {}", dir.display())));
        }

        self.conn.execute_batch("SAVEPOINT minotes_sync_dir")?;
        match self.import_dir(dir, actor, opts, &mut result) {
            Ok(()) => self.conn.execute_batch("RELEASE minotes_sync_dir")?,
            Err(e) => {
                let _ = self
                    .conn
                    .execute_batch("ROLLBACK TO minotes_sync_dir; RELEASE minotes_sync_dir");
                return Err(e);
            }
        }

        // DB → Filesystem (write back changes, pruning stale files).
        if opts.write_back {
            self.export_markdown_synced(dir)?;
        }

        Ok(result)
    }

    fn import_dir(&self, dir: &Path, actor: &str, opts: &SyncOptions, result: &mut SyncResult) -> Result<()> {
        let scan = scan_markdown_tree(dir);
        let mut complete = scan.complete;
        result.errors.extend(scan.errors.iter().cloned());

        let expected: HashMap<Uuid, PathBuf> = self
            .plan_export_paths()?
            .pages
            .into_iter()
            .map(|(p, rel)| (p.id, rel))
            .collect();

        let mut files: Vec<ImportFile> = Vec::new();
        for f in &scan.files {
            match fs::read(&f.abs) {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let content = match text.strip_prefix('\u{feff}') {
                        Some(t) => t.to_string(),
                        None => text,
                    };
                    let fm = parse_frontmatter(&content);
                    let stem = f
                        .rel
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Untitled")
                        .to_string();
                    let folder = f
                        .rel
                        .parent()
                        .map(|p| {
                            p.components()
                                .map(|c| c.as_os_str().to_string_lossy().to_string())
                                .collect()
                        })
                        .unwrap_or_default();
                    let mtime = fs::metadata(&f.abs).and_then(|m| m.modified()).ok();
                    files.push(ImportFile { rel: f.rel.clone(), stem, folder, content, fm, mtime });
                }
                Err(e) => {
                    complete = false;
                    result.errors.push(format!("Read failed for {}: {e}", f.rel.display()));
                }
            }
        }

        // Two files carrying the same page id (a stale copy after a rename/move, or
        // a conflict copy): import exactly one. Prefer a non-conflict file, then the
        // page's current export path, then the newest mtime.
        let mut groups: HashMap<Uuid, Vec<usize>> = HashMap::new();
        for (i, f) in files.iter().enumerate() {
            if let Some(id) = f.fm.id {
                groups.entry(id).or_default().push(i);
            }
        }
        let mut skip: HashSet<usize> = HashSet::new();
        for (id, idxs) in &groups {
            if idxs.len() < 2 {
                continue;
            }
            let rank = |i: usize| {
                let f = &files[i];
                (
                    !is_conflict_copy_name(&f.rel),
                    expected.get(id) == Some(&f.rel),
                    f.mtime,
                    std::cmp::Reverse(f.rel.clone()),
                )
            };
            let best = *idxs.iter().max_by_key(|&&i| rank(i)).expect("non-empty");
            for &i in idxs {
                if i != best {
                    skip.insert(i);
                    eprintln!(
                        "[minotes-sync] ignoring {}: duplicate page id {id} (using {})",
                        files[i].rel.display(),
                        files[best].rel.display()
                    );
                    result.duplicates_ignored.push(files[i].rel.display().to_string());
                }
            }
        }

        let protected = match opts.protect_modified_after {
            Some(t) => self.pages_modified_since(t, actor)?,
            None => HashSet::new(),
        };

        // Import files whose page already exists first, so renames free up titles
        // before brand-new pages claim them.
        let mut order: Vec<(bool, usize)> = Vec::new();
        for (i, f) in files.iter().enumerate() {
            if skip.contains(&i) {
                continue;
            }
            let known = match f.fm.id {
                Some(id) => self.get_page(&id)?.is_some(),
                None => false,
            };
            order.push((!known, i));
        }
        order.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| files[a.1].rel.cmp(&files[b.1].rel)));

        let mut seen: HashSet<Uuid> = HashSet::new();
        let mut folder_cache: HashMap<Vec<String>, Uuid> = HashMap::new();
        for (_, i) in order {
            let f = &files[i];
            if let Some(id) = f.fm.id {
                seen.insert(id);
            }
            let folder_id = match self.ensure_folder_path(&f.folder, actor, result, &mut folder_cache) {
                Ok(v) => v,
                Err(e) => {
                    complete = false;
                    result.errors.push(format!("{}: {e}", f.rel.display()));
                    continue;
                }
            };
            let snapshot = result.clone();
            let seen_snapshot = seen.clone();
            self.conn.execute_batch("SAVEPOINT minotes_sync_page")?;
            match self.sync_page(f, folder_id, actor, result, &mut seen, &protected) {
                Ok(()) => self.conn.execute_batch("RELEASE minotes_sync_page")?,
                Err(e) => {
                    self.conn
                        .execute_batch("ROLLBACK TO minotes_sync_page; RELEASE minotes_sync_page")?;
                    *result = snapshot;
                    seen = seen_snapshot;
                    complete = false; // don't let a failed page look "missing"
                    eprintln!("[minotes-sync] import of {} failed: {e}", f.rel.display());
                    result.errors.push(format!("{}: {e}", f.rel.display()));
                }
            }
        }

        // Pages whose file was removed upstream → trash (recoverable), never hard-delete.
        self.trash_removed_pages(&opts.trash_page_ids, &seen, &protected, opts.force_delete, result)?;

        if opts.delete_missing {
            if complete {
                self.detect_deleted_pages(&seen, opts.force_delete, result)?;
            } else {
                result
                    .errors
                    .push("Directory scan was incomplete; skipped deleting missing pages".to_string());
            }
        }
        Ok(())
    }

    fn ensure_folder_path(
        &self,
        components: &[String],
        actor: &str,
        result: &mut SyncResult,
        cache: &mut HashMap<Vec<String>, Uuid>,
    ) -> Result<Option<Uuid>> {
        let mut parent: Option<Uuid> = None;
        let mut path: Vec<String> = Vec::new();
        for c in components {
            path.push(c.clone());
            if let Some(id) = cache.get(&path) {
                parent = Some(*id);
                continue;
            }
            let id = self.find_or_create_folder(c, parent.as_ref(), actor, result)?;
            cache.insert(path.clone(), id);
            parent = Some(id);
        }
        Ok(parent)
    }

    fn find_or_create_folder(
        &self,
        name: &str,
        parent_id: Option<&Uuid>,
        actor: &str,
        result: &mut SyncResult,
    ) -> Result<Uuid> {
        // Check if folder already exists under this parent
        let folders = self.list_folders(parent_id)?;
        for f in &folders {
            if f.name == name {
                result.folders_existing += 1;
                return Ok(f.id);
            }
        }

        // Create new folder
        let folder = self.create_folder(name, parent_id, None, None, actor)?;
        result.folders_created.push(name.to_string());
        Ok(folder.id)
    }

    /// Ids of pages changed locally (by anyone but `import_actor`) after `since`:
    /// page/block edits, deletions (via the event log), trash and archive moves.
    fn pages_modified_since(&self, since: DateTime<Utc>, import_actor: &str) -> Result<HashSet<Uuid>> {
        let t = since.to_rfc3339();
        let mut stmt = self.conn.prepare(
            "SELECT id FROM pages WHERE updated_at > ?1
             UNION SELECT page_id FROM blocks WHERE updated_at > ?1
             UNION SELECT page_id FROM trash WHERE deleted_at > ?1
             UNION SELECT page_id FROM archive WHERE archived_at > ?1
             UNION SELECT CASE
                     WHEN entity_type IN ('page', 'property') THEN entity_id
                     WHEN json_valid(payload) THEN json_extract(payload, '$.page_id')
                   END
               FROM events
              WHERE created_at > ?1 AND actor != ?2
                AND entity_type IN ('page', 'block', 'property')",
        )?;
        let rows = stmt.query_map(rusqlite::params![t, import_actor], |r| r.get::<_, Option<String>>(0))?;
        let mut out = HashSet::new();
        for r in rows {
            if let Some(s) = r? {
                if let Ok(id) = Uuid::parse_str(&s) {
                    out.insert(id);
                }
            }
        }
        Ok(out)
    }

    fn unique_page_title(&self, title: &str) -> Result<String> {
        for n in 2..1000 {
            let candidate = format!("{title} ({n})");
            if self.get_page_by_title(&candidate)?.is_none() {
                return Ok(candidate);
            }
        }
        Ok(format!("{title} ({})", Uuid::now_v7().simple()))
    }

    /// Apply page properties from frontmatter. Returns true if anything changed.
    /// (Properties missing from the file are left alone, not deleted.)
    fn apply_fm_properties(&self, page_id: &Uuid, props: &[(String, String)], actor: &str) -> Result<bool> {
        if props.is_empty() {
            return Ok(false);
        }
        let current: HashMap<String, Option<String>> = self
            .get_properties(page_id)?
            .into_iter()
            .map(|p| (p.key, p.value))
            .collect();
        let mut changed = false;
        for (k, v) in props {
            if current.get(k).and_then(|x| x.as_deref()) != Some(v.as_str()) {
                self.set_property(page_id, "page", k, v, "text", actor)?;
                changed = true;
            }
        }
        Ok(changed)
    }

    fn sync_page(
        &self,
        file: &ImportFile,
        folder_id: Option<Uuid>,
        actor: &str,
        result: &mut SyncResult,
        seen_page_ids: &mut HashSet<Uuid>,
        protected: &HashSet<Uuid>,
    ) -> Result<()> {
        let fm = &file.fm;
        // Title comes from frontmatter (lossless); the filename is only a fallback
        // for files authored outside MiNotes.
        let title = fm
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| file.stem.clone());
        let lines = strip_frontmatter(&file.content);
        let new_blocks = parse_markdown_blocks(&lines);

        // Resolve by stable id. Title matching is ONLY for files without an id
        // (legacy / hand-written): a file whose id is unknown here is a different
        // page and must never be reconciled into a same-titled local page.
        let existing = match fm.id {
            Some(id) => self.get_page(&id)?,
            None => self.get_page_by_title(&title)?,
        };

        if let Some(existing) = existing {
            seen_page_ids.insert(existing.id);
            if protected.contains(&existing.id) {
                result.pages_skipped_local_edits.push(existing.title.clone());
                return Ok(());
            }

            let mut meta_changed = false;
            if existing.title != title {
                match self.rename_page(&existing.id, &title, actor) {
                    Ok(_) => meta_changed = true,
                    Err(e) => eprintln!(
                        "[minotes-sync] could not rename '{}' to '{title}': {e}",
                        existing.title
                    ),
                }
            }
            if existing.folder_id != folder_id {
                self.move_page_to_folder(&existing.id, folder_id.as_ref(), actor)?;
                meta_changed = true;
            }
            if fm.id.is_some()
                && (existing.is_journal != fm.is_journal
                    || (fm.is_journal && fm.date.is_some() && existing.journal_date != fm.date))
            {
                let date = if fm.is_journal { fm.date.or(existing.journal_date) } else { None };
                self.conn.execute(
                    "UPDATE pages SET is_journal = ?1, journal_date = ?2 WHERE id = ?3",
                    rusqlite::params![fm.is_journal as i32, date.map(|d| d.to_string()), existing.id.to_string()],
                )?;
                meta_changed = true;
            }
            meta_changed |= self.apply_fm_properties(&existing.id, &fm.props, actor)?;

            let blocks_changed = self.reconcile_page_blocks(&existing.id, &new_blocks, actor, result)?;
            if blocks_changed {
                self.conn.execute(
                    "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), existing.id.to_string()],
                )?;
            }
            if meta_changed || blocks_changed {
                result.pages_updated.push(title);
            } else {
                result.pages_unchanged += 1;
            }
        } else {
            let mut title = title;
            if self.get_page_by_title(&title)?.is_some() {
                // Unknown id but the title is taken by a different local page (e.g.
                // both devices auto-created today's journal): import separately.
                let unique = self.unique_page_title(&title)?;
                eprintln!(
                    "[minotes-sync] {}: title '{title}' belongs to another page; importing as '{unique}'",
                    file.rel.display()
                );
                title = unique;
            }
            let date = if fm.is_journal { fm.date } else { None };
            let page = match fm.id {
                Some(id) => self.create_page_with_id(id, &title, None, fm.is_journal, date, actor)?,
                None => self.create_page(&title, None, fm.is_journal, date, actor)?,
            };
            seen_page_ids.insert(page.id);
            if let Some(fid) = folder_id {
                self.move_page_to_folder(&page.id, Some(&fid), actor)?;
            }
            self.apply_fm_properties(&page.id, &fm.props, actor)?;
            self.reconcile_page_blocks(&page.id, &new_blocks, actor, result)?;
            result.pages_created.push(title);
        }

        Ok(())
    }

    /// Reconcile a page's blocks against parsed markdown by stable id (Bug #1, #9).
    /// Returns true if anything changed. Blocks present in the file are upserted
    /// (preserving identity); blocks absent from the file are deleted (true delete
    /// propagation). Blocks without an id marker are treated as new.
    ///
    /// Order matters: every kept block is first moved to its new parent/position
    /// (and blocks that moved here from another page are re-homed), and only THEN
    /// are removed blocks deleted — so a delete cascade can never reach a block the
    /// file still keeps.
    fn reconcile_page_blocks(
        &self,
        page_id: &Uuid,
        parsed: &[ParsedBlock],
        actor: &str,
        result: &mut SyncResult,
    ) -> Result<bool> {
        let existing_blocks = self.get_page_blocks(page_id)?;
        let existing_by_id: HashMap<Uuid, &crate::models::Block> =
            existing_blocks.iter().map(|b| (b.id, b)).collect();

        // Ids referenced by explicit markers can't be claimed by content matching.
        let marker_ids: HashSet<Uuid> = parsed.iter().filter_map(|p| p.id).collect();

        // For markerless blocks (legacy files, or files authored outside MiNotes),
        // fall back to matching by content against not-yet-claimed existing blocks so
        // that identity — and idempotency — is preserved without an id marker.
        let mut content_pool: HashMap<String, Vec<Uuid>> = HashMap::new();
        for b in &existing_blocks {
            if !marker_ids.contains(&b.id) {
                content_pool.entry(normalize_content(&b.content)).or_default().push(b.id);
            }
        }
        let mut claimed: HashSet<Uuid> = HashSet::new();

        // Resolve each parsed block to a concrete id and compute parent ids from the
        // indent stack. Positions are assigned per-parent (1.0, 2.0, …) to match
        // create_block's scheme, so an unchanged tree re-syncs as unchanged.
        let mut stack: Vec<(usize, Uuid)> = Vec::new();
        let mut desired: Vec<(Uuid, Option<Uuid>, f64, &ParsedBlock)> = Vec::new();
        let mut seen_ids: HashSet<Uuid> = HashSet::new();
        let mut sibling_counter: HashMap<Option<Uuid>, f64> = HashMap::new();
        let mut changed = false;
        for pb in parsed.iter() {
            while let Some(&(d, _)) = stack.last() {
                if d >= pb.depth { stack.pop(); } else { break; }
            }
            let parent = stack.last().map(|(_, id)| *id);
            let id = match pb.id {
                Some(id) if !seen_ids.contains(&id) => id,
                Some(_) => Uuid::now_v7(),
                None => {
                    let reuse = content_pool
                        .get(&normalize_content(&pb.content))
                        .and_then(|ids| ids.iter().find(|i| !claimed.contains(*i)).copied());
                    reuse.unwrap_or_else(Uuid::now_v7)
                }
            };
            claimed.insert(id);
            let counter = sibling_counter.entry(parent).or_insert(0.0);
            *counter += 1.0;
            let position = *counter;
            seen_ids.insert(id);
            desired.push((id, parent, position, pb));
            stack.push((pb.depth, id));
        }

        // 1) Upsert desired blocks in document order (parents before children).
        for (id, parent, position, pb) in &desired {
            let now = Utc::now().to_rfc3339();
            if let Some(prev) = existing_by_id.get(id) {
                let structural = prev.parent_id != *parent
                    || (prev.position - *position).abs() > f64::EPSILON;
                let content_changed = normalize_content(&prev.content) != normalize_content(&pb.content);
                if structural {
                    let n = self.conn.execute(
                        "UPDATE blocks SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
                        rusqlite::params![parent.map(|p| p.to_string()), position, now, id.to_string()],
                    )?;
                    if n == 0 {
                        // Vanished underneath us — recreate rather than silently lose it.
                        self.create_block_with_id(*id, page_id, &pb.content, parent.as_ref(), Some(*position), actor)?;
                        result.blocks_created += 1;
                        changed = true;
                        continue;
                    }
                }
                if content_changed {
                    // update_block keeps links/FTS in sync with the new content.
                    self.update_block(id, Some(&pb.content), actor)?;
                }
                if structural || content_changed {
                    result.blocks_updated += 1;
                    changed = true;
                }
            } else if let Some(other) = self.get_block(id)? {
                // The block moved here from another page (cut/paste in an editor):
                // re-home it instead of hitting the UNIQUE constraint.
                self.conn.execute(
                    "UPDATE blocks SET page_id = ?1, parent_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?5",
                    rusqlite::params![
                        page_id.to_string(),
                        parent.map(|p| p.to_string()),
                        position,
                        now,
                        id.to_string()
                    ],
                )?;
                if normalize_content(&other.content) != normalize_content(&pb.content) {
                    self.update_block(id, Some(&pb.content), actor)?;
                }
                result.blocks_updated += 1;
                changed = true;
            } else {
                self.create_block_with_id(*id, page_id, &pb.content, parent.as_ref(), Some(*position), actor)?;
                result.blocks_created += 1;
                changed = true;
            }
        }

        // 2) Delete blocks that no longer appear in the file (true deletion — Bug #9).
        //    Every kept block has already been re-parented away from them.
        for b in &existing_blocks {
            if !seen_ids.contains(&b.id) {
                if self.get_block(&b.id)?.map(|x| x.page_id == *page_id).unwrap_or(false) {
                    self.delete_block(&b.id, actor)?;
                }
                changed = true;
            }
        }

        Ok(changed)
    }

    /// Create blocks with parent_id derived from the parsed indent depth.
    #[allow(dead_code)]
    pub(crate) fn create_blocks_with_hierarchy(
        &self,
        page_id: &Uuid,
        parsed: &[ParsedBlock],
        actor: &str,
        result: &mut SyncResult,
    ) -> Result<()> {
        // Stack of (depth, block_id) — top is current ancestor chain
        let mut stack: Vec<(usize, Uuid)> = Vec::new();
        for pb in parsed {
            while let Some(&(d, _)) = stack.last() {
                if d >= pb.depth { stack.pop(); } else { break; }
            }
            let parent = stack.last().map(|(_, id)| *id);
            // Bug #1: preserve the stable block id from the markdown marker if present.
            let block = match pb.id {
                Some(id) => self.create_block_with_id(id, page_id, &pb.content, parent.as_ref(), None, actor)?,
                None => self.create_block(page_id, &pb.content, parent.as_ref(), None, actor)?,
            };
            result.blocks_created += 1;
            stack.push((pb.depth, block.id));
        }
        Ok(())
    }

    /// Trash pages whose file was removed upstream (a deletion on another device,
    /// propagated as a file removal by git). Skips pages that still have a file
    /// (e.g. moved), pages edited locally since the export, and already-trashed pages.
    fn trash_removed_pages(
        &self,
        ids: &[Uuid],
        seen: &HashSet<Uuid>,
        protected: &HashSet<Uuid>,
        force: bool,
        result: &mut SyncResult,
    ) -> Result<()> {
        let mut to_trash = Vec::new();
        for id in ids {
            if seen.contains(id) || protected.contains(id) {
                continue;
            }
            if let Some(page) = self.get_page(id)? {
                if !self.is_trashed(id)? && !to_trash.iter().any(|p: &crate::models::Page| p.id == *id) {
                    to_trash.push(page);
                }
            }
        }
        if to_trash.is_empty() {
            return Ok(());
        }
        let total: usize = self.conn.query_row(
            "SELECT COUNT(*) FROM pages WHERE id NOT IN (SELECT page_id FROM trash)",
            [],
            |r| r.get::<_, i64>(0),
        )? as usize;
        if !deletion_allowed(to_trash.len(), total, force) {
            result.errors.push(format!(
                "Refusing to trash {} of {total} pages removed upstream in one sync (safety guard)",
                to_trash.len()
            ));
            return Ok(());
        }
        for page in to_trash {
            self.trash_page(&page.id)?;
            result.pages_deleted.push(page.title);
        }
        Ok(())
    }

    fn detect_deleted_pages(&self, seen_page_ids: &HashSet<Uuid>, force: bool, result: &mut SyncResult) -> Result<()> {
        let all_pages = self.list_pages(Some(1_000_000))?;
        let non_journal: Vec<_> = all_pages.iter().filter(|p| !p.is_journal).collect();

        // Bug #11: guard against a transiently-empty/partial working tree (e.g. a bad
        // git checkout or interrupted pull). If the import saw NO files but the DB has
        // pages, deleting "missing" pages would wipe the entire database.
        if seen_page_ids.is_empty() && !non_journal.is_empty() {
            return Ok(());
        }

        let missing: Vec<_> = non_journal
            .into_iter()
            .filter(|p| !seen_page_ids.contains(&p.id))
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        if !deletion_allowed(missing.len(), all_pages.len(), force) {
            result.errors.push(format!(
                "Refusing to trash {} of {} pages missing from the directory in one pass (use force to override)",
                missing.len(),
                all_pages.len()
            ));
            return Ok(());
        }
        for page in missing {
            result.pages_deleted.push(page.title.clone());
            // Bug #11: route sync deletions to trash (soft delete), not a hard delete.
            self.trash_page(&page.id)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct ParsedBlock {
    pub(crate) depth: usize,
    pub(crate) content: String,
    /// Stable block id parsed from an `<!-- id:UUID -->` marker, if present (Bug #1).
    pub(crate) id: Option<Uuid>,
}

/// Strip a trailing `<!-- id:UUID -->` marker from a line, returning (clean, id).
pub(crate) fn split_id_marker(line: &str) -> (String, Option<Uuid>) {
    if let Some(start) = line.rfind("<!-- id:") {
        let after = &line[start + "<!-- id:".len()..];
        if let Some(end) = after.find("-->") {
            let id_str = after[..end].trim();
            if let Ok(id) = Uuid::parse_str(id_str) {
                let clean = line[..start].trim_end().to_string();
                return (clean, Some(id));
            }
        }
    }
    (line.to_string(), None)
}

/// Normalize block content for change detection: CRLF/CR → LF and trailing
/// whitespace per line dropped (the markdown round-trip can't preserve either), so
/// unchanged blocks aren't re-marked as updated on every sync.
pub(crate) fn normalize_content(s: &str) -> String {
    let unified = s.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = unified.split('\n').map(|l| l.trim_end()).collect();
    lines.join("\n").trim_end().to_string()
}

/// Parse markdown lines into blocks, preserving indent-based hierarchy.
/// A line indented with 2 spaces (or one tab) per level becomes a nested block.
/// Continuation lines (deeper indent prefixed with `\ `, written by the exporter
/// for multi-line block content — Bug #13) are folded back into the preceding block
/// instead of becoming separate blocks. If an id marker repeats (a line
/// copy-pasted in an external editor), later occurrences get a fresh id so a block
/// can never become its own parent.
pub(crate) fn parse_markdown_blocks(lines: &[&str]) -> Vec<ParsedBlock> {
    let mut out: Vec<ParsedBlock> = Vec::new();
    let mut seen_ids: HashSet<Uuid> = HashSet::new();
    for raw in lines {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        // Count leading whitespace. A tab counts as 2 spaces' worth of indent so it
        // maps to exactly one level (fixes the previous tab double-count).
        let mut spaces = 0usize;
        let mut consumed = 0usize;
        for ch in raw.chars() {
            match ch {
                ' ' => { spaces += 1; consumed += ch.len_utf8(); }
                '\t' => { spaces += 2; consumed += ch.len_utf8(); }
                _ => break,
            }
        }
        let body = &raw[consumed..];

        // Continuation line: `\ ` (or bare `\`) marks text belonging to the previous
        // block. Append it (with a newline) so multi-line content round-trips.
        if let Some(rest) = body.strip_prefix('\\') {
            if let Some(last) = out.last_mut() {
                let text = rest.strip_prefix(' ').unwrap_or(rest);
                last.content.push('\n');
                last.content.push_str(text);
                continue;
            }
            // No preceding block — fall through and treat as ordinary content.
        }

        if body.trim().is_empty() {
            continue;
        }

        let depth = spaces / 2;
        let bullet_body = body
            .strip_prefix("- ")
            .or_else(|| body.strip_prefix("* "))
            .or_else(|| body.strip_prefix("+ "))
            .unwrap_or(body);
        // Bug #1: extract a stable `<!-- id:UUID -->` marker so block identity
        // survives the export→import round-trip.
        let (content, mut id) = split_id_marker(bullet_body);
        if content.is_empty() && id.is_none() {
            continue;
        }
        if let Some(i) = id {
            if !seen_ids.insert(i) {
                id = Some(Uuid::now_v7()); // duplicate marker → fresh identity
            }
        }
        out.push(ParsedBlock { depth, content, id });
    }
    out
}

fn strip_frontmatter(content: &str) -> Vec<&str> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) == Some("---") {
        if let Some(end) = lines[1..].iter().position(|l| l.trim() == "---") {
            return lines[end + 2..].to_vec();
        }
    }
    lines
}

/// Parsed page frontmatter.
#[derive(Debug, Clone, Default)]
pub(crate) struct Frontmatter {
    pub(crate) id: Option<Uuid>,
    pub(crate) title: Option<String>,
    pub(crate) is_journal: bool,
    pub(crate) date: Option<NaiveDate>,
    /// Remaining `key: value` pairs → page properties.
    pub(crate) props: Vec<(String, String)>,
}

/// Decode a frontmatter scalar: JSON/YAML double-quoted, single-quoted, or plain.
fn decode_fm_value(raw: &str) -> String {
    let t = raw.trim();
    if t.starts_with('"') {
        if let Ok(s) = serde_json::from_str::<String>(t) {
            return s;
        }
        // Legacy exports wrote `title: "..."` without escaping inner quotes.
        if t.len() >= 2 && t.ends_with('"') {
            return t[1..t.len() - 1].to_string();
        }
    }
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        return t[1..t.len() - 1].replace("''", "'");
    }
    t.to_string()
}

pub(crate) fn parse_frontmatter(content: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return fm;
    }
    let Some(end) = lines[1..].iter().position(|l| l.trim() == "---") else { return fm };
    let mut reserved_seen: HashSet<&str> = HashSet::new();
    for line in &lines[1..=end] {
        if line.starts_with(' ') || line.starts_with('\t') || line.trim_start().starts_with('-') {
            continue; // YAML continuation / list item — not a flat key
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim();
        if key.is_empty() || key.starts_with('#') {
            continue;
        }
        if let Some(r) = crate::repo::export::RESERVED_FM_KEYS.iter().find(|r| **r == key) {
            if !reserved_seen.insert(r) {
                continue;
            }
            match key {
                "id" => fm.id = Uuid::parse_str(v.trim()).ok(),
                "title" => fm.title = Some(decode_fm_value(v)),
                "type" => fm.is_journal = v.trim() == "journal",
                "date" => fm.date = NaiveDate::parse_from_str(decode_fm_value(v).trim(), "%Y-%m-%d").ok(),
                _ => {}
            }
            continue;
        }
        fm.props.push((key.to_string(), decode_fm_value(v)));
    }
    fm
}

/// Parse the `id: UUID` field from a page's YAML frontmatter, if present (Bug #3).
/// Used by sync/import to reconcile pages by stable identity rather than by title.
pub(crate) fn parse_frontmatter_id(content: &str) -> Option<Uuid> {
    parse_frontmatter(content).id
}

/// Turn the remote side of a conflicted page into a SEPARATE page: fresh page id,
/// title `"<title> (conflict from <host>)"`, block ids replaced by fresh ones (so its
/// blocks get new ids instead of stealing the original page's blocks), journal
/// flag dropped. Properties are kept.
pub(crate) fn rewrite_as_conflict_copy(content: &str, fallback_title: &str, host: &str) -> String {
    let fm = parse_frontmatter(content);
    let base = fm
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| fallback_title.to_string());
    let title = format!("{base} (conflict from {host})");
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", Uuid::now_v7()));
    out.push_str(&format!("title: {}\n", serde_json::to_string(&title).unwrap_or_default()));
    for (k, v) in &fm.props {
        let needs_quote = v.contains('\n') || v.contains('\r') || v.starts_with('"') || v.trim() != v;
        let val = if needs_quote { serde_json::to_string(v).unwrap_or_default() } else { v.clone() };
        out.push_str(&format!("{k}: {val}\n"));
    }
    out.push_str("---\n\n");
    for line in strip_frontmatter(content) {
        out.push_str(&refresh_marker(line));
        out.push('\n');
    }
    out
}

/// Replace a line's block id marker with a FRESH id. The new id is written into
/// the file, so every device that imports this copy agrees on its block ids (and
/// re-exports byte-identical files), while never colliding with the original's.
fn refresh_marker(line: &str) -> String {
    if let Some(start) = line.rfind("<!-- id:") {
        let after = &line[start + "<!-- id:".len()..];
        if let Some(end) = after.find("-->") {
            if Uuid::parse_str(after[..end].trim()).is_ok() {
                let rest = &after[end + 3..];
                return format!("{}<!-- id:{} -->{rest}", &line[..start], Uuid::now_v7());
            }
        }
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::io::Write;

    #[test]
    fn test_sync_dir_creates_folders_and_pages() {
        let dir = tempfile::tempdir().unwrap();

        // Create directory structure
        fs::create_dir_all(dir.path().join("Work/Projects")).unwrap();
        fs::write(dir.path().join("README.md"), "- Welcome to my notes").unwrap();
        fs::write(dir.path().join("Work/goals.md"), "- Hit Q1 targets\n- Ship v2").unwrap();
        fs::write(dir.path().join("Work/Projects/alpha.md"), "- Alpha project\n- [[goals]]").unwrap();

        let db = Database::open_in_memory().unwrap();
        let result = db.sync_dir(dir.path(), "user", false, false).unwrap();

        // 3 .md files but [[goals]] link in alpha.md may auto-create "goals" page
        // before goals.md is synced, so pages_created can vary by 1
        let total_pages = db.list_pages(Some(100)).unwrap().len();
        assert!(total_pages >= 3, "Should have at least 3 pages, got {total_pages}");
        assert_eq!(result.folders_created.len(), 2); // Work + Projects
        assert!(result.folders_created.contains(&"Work".to_string()));
        assert!(result.folders_created.contains(&"Projects".to_string()));

        // Verify folder structure
        let tree = db.get_folder_tree().unwrap();
        assert_eq!(tree.len(), 1); // Work
        assert_eq!(tree[0].folder.name, "Work");
        assert_eq!(tree[0].children.len(), 1); // Projects

        // Verify pages exist
        assert!(db.get_page_by_title("README").unwrap().is_some());
        assert!(db.get_page_by_title("goals").unwrap().is_some());
        assert!(db.get_page_by_title("alpha").unwrap().is_some());
    }

    #[test]
    fn test_sync_dir_preserves_nested_hierarchy() {
        let dir = tempfile::tempdir().unwrap();
        let content = "- Parent\n  - Child A\n  - Child B\n    - Grandchild\n- Sibling";
        fs::write(dir.path().join("nested.md"), content).unwrap();

        let db = Database::open_in_memory().unwrap();
        db.sync_dir(dir.path(), "user", false, false).unwrap();

        let page = db.get_page_by_title("nested").unwrap().unwrap();
        let blocks = db.get_page_blocks(&page.id).unwrap();
        // 5 blocks total
        assert_eq!(blocks.len(), 5, "blocks: {:?}", blocks.iter().map(|b| &b.content).collect::<Vec<_>>());

        let by_content = |s: &str| blocks.iter().find(|b| b.content == s).unwrap();
        let parent = by_content("Parent");
        let child_a = by_content("Child A");
        let child_b = by_content("Child B");
        let grandchild = by_content("Grandchild");
        let sibling = by_content("Sibling");

        assert_eq!(parent.parent_id, None);
        assert_eq!(sibling.parent_id, None);
        assert_eq!(child_a.parent_id, Some(parent.id));
        assert_eq!(child_b.parent_id, Some(parent.id));
        assert_eq!(grandchild.parent_id, Some(child_b.id));
    }

    #[test]
    fn test_sync_dir_updates_changed_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("notes.md"), "- Version 1").unwrap();

        let db = Database::open_in_memory().unwrap();
        let r1 = db.sync_dir(dir.path(), "user", false, false).unwrap();
        assert_eq!(r1.pages_created.len(), 1);

        // Modify the file
        fs::write(dir.path().join("notes.md"), "- Version 2\n- New block").unwrap();

        let r2 = db.sync_dir(dir.path(), "user", false, false).unwrap();
        assert_eq!(r2.pages_updated.len(), 1);
        assert_eq!(r2.pages_created.len(), 0);

        // Verify updated content
        let page = db.get_page_by_title("notes").unwrap().unwrap();
        let blocks = db.get_page_blocks(&page.id).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].content, "Version 2");
        assert_eq!(blocks[1].content, "New block");
    }

    #[test]
    fn test_sync_dir_detects_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("keep.md"), "- Keep this").unwrap();
        fs::write(dir.path().join("remove.md"), "- Remove this").unwrap();

        let db = Database::open_in_memory().unwrap();
        db.sync_dir(dir.path(), "user", false, false).unwrap();

        // Delete one file
        fs::remove_file(dir.path().join("remove.md")).unwrap();

        let r = db.sync_dir(dir.path(), "user", true, false).unwrap();
        assert_eq!(r.pages_deleted, vec!["remove"]);
        // Bug #11: sync deletions are soft (routed to trash) so they're recoverable.
        let removed = db.get_page_by_title("remove").unwrap().unwrap();
        assert!(db.is_trashed(&removed.id).unwrap(), "deleted page should be in trash");
        // And it no longer appears in the normal page list.
        let listed = db.list_pages(Some(100)).unwrap();
        assert!(listed.iter().all(|p| p.title != "remove"));
        assert!(db.get_page_by_title("keep").unwrap().is_some());
    }

    #[test]
    fn test_sync_dir_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("test.md"), "- Hello world").unwrap();

        let db = Database::open_in_memory().unwrap();
        db.sync_dir(dir.path(), "user", false, false).unwrap();
        let r = db.sync_dir(dir.path(), "user", false, false).unwrap();

        assert_eq!(r.pages_unchanged, 1);
        assert_eq!(r.pages_created.len(), 0);
        assert_eq!(r.pages_updated.len(), 0);
    }

    #[test]
    fn test_sync_dir_write_back() {
        let dir = tempfile::tempdir().unwrap();

        let db = Database::open_in_memory().unwrap();
        let folder = db.create_folder("Notes", None, None, None, "user").unwrap();
        let page = db.create_page("Test", None, false, None, "user").unwrap();
        db.move_page_to_folder(&page.id, Some(&folder.id), "user").unwrap();
        db.create_block(&page.id, "Written from DB", None, None, "user").unwrap();

        db.sync_dir(dir.path(), "user", false, true).unwrap();

        // Verify filesystem
        assert!(dir.path().join("Notes").is_dir());
        assert!(dir.path().join("Notes/Test.md").exists());
        let content = fs::read_to_string(dir.path().join("Notes/Test.md")).unwrap();
        assert!(content.contains("Written from DB"));
    }

    fn md(id: Uuid, title: &str, body: &str) -> String {
        format!("---\nid: {id}\ntitle: {}\n---\n\n{body}", serde_json::to_string(title).unwrap())
    }

    fn texts(db: &Database, page: &Uuid) -> Vec<String> {
        db.get_page_blocks(page).unwrap().into_iter().map(|b| b.content).collect()
    }

    // #1: a rename moves the old file out of the import path, and even if a stale
    // copy reappears, import prefers the file at the page's current export path.
    #[test]
    fn test_rename_prunes_stale_file_and_import_does_not_revert() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("Old", None, false, None, "user").unwrap();
        db.create_block(&p.id, "a", None, None, "user").unwrap();
        db.export_markdown_synced(dir.path()).unwrap();
        let stale = fs::read_to_string(dir.path().join("Old.md")).unwrap();

        db.rename_page(&p.id, "New", "user").unwrap();
        db.create_block(&p.id, "b", None, None, "user").unwrap();
        let rep = db.export_markdown_synced(dir.path()).unwrap();
        assert_eq!(rep.pruned, vec!["Old.md".to_string()]);
        assert!(!dir.path().join("Old.md").exists());
        assert!(dir.path().join("New.md").exists());

        let r = db.sync_dir(dir.path(), "git-sync", false, false).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(db.get_page(&p.id).unwrap().unwrap().title, "New");

        // A stale copy (e.g. from an unsynced device) with the same id.
        fs::write(dir.path().join("Old.md"), &stale).unwrap();
        let r = db.sync_dir(dir.path(), "git-sync", false, false).unwrap();
        assert_eq!(r.duplicates_ignored, vec!["Old.md".to_string()]);
        assert_eq!(db.get_page(&p.id).unwrap().unwrap().title, "New");
        assert_eq!(texts(&db, &p.id), vec!["a", "b"]);
    }

    // #1: trashing a page removes its file on the next synced export.
    #[test]
    fn test_trashed_page_file_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("Bye", None, false, None, "user").unwrap();
        db.export_markdown_synced(dir.path()).unwrap();
        db.trash_page(&p.id).unwrap();
        db.export_markdown_synced(dir.path()).unwrap();
        assert!(!dir.path().join("Bye.md").exists());
        // A file with an id this DB has never seen is NOT pruned (not imported yet).
        fs::write(dir.path().join("Foreign.md"), md(Uuid::now_v7(), "Foreign", "- x\n")).unwrap();
        db.export_markdown_synced(dir.path()).unwrap();
        assert!(dir.path().join("Foreign.md").exists());
    }

    // #4: unknown id + same title as an unrelated local page → separate page.
    #[test]
    fn test_unknown_id_never_overwrites_same_titled_page() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let local = db.create_page("Sep 30th, 2026", None, false, None, "user").unwrap();
        db.create_block(&local.id, "local note", None, None, "user").unwrap();
        let remote_id = Uuid::now_v7();
        fs::write(dir.path().join("Sep 30th, 2026.md"), md(remote_id, "Sep 30th, 2026", "- remote note\n")).unwrap();

        db.sync_dir(dir.path(), "git-sync", false, false).unwrap();
        assert_eq!(texts(&db, &local.id), vec!["local note"]);
        let imported = db.get_page(&remote_id).unwrap().expect("imported separately");
        assert_eq!(imported.title, "Sep 30th, 2026 (2)");
        assert_eq!(texts(&db, &remote_id), vec!["remote note"]);
    }

    // #5: deleting a parent in the file while keeping its child must not lose the child.
    #[test]
    fn test_reconcile_keeps_child_when_parent_removed() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let (pid, parent, child) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let f = dir.path().join("T.md");
        fs::write(&f, md(pid, "T", &format!("- P <!-- id:{parent} -->\n  - C <!-- id:{child} -->\n"))).unwrap();
        db.sync_dir(dir.path(), "u", false, false).unwrap();
        assert_eq!(db.get_block(&child).unwrap().unwrap().parent_id, Some(parent));

        fs::write(&f, md(pid, "T", &format!("- C <!-- id:{child} -->\n"))).unwrap();
        let r = db.sync_dir(dir.path(), "u", false, false).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let c = db.get_block(&child).unwrap().expect("kept child survives");
        assert_eq!(c.parent_id, None);
        assert!(db.get_block(&parent).unwrap().is_none());
    }

    // #8: a duplicated id marker (copy-pasted line) gets a fresh id; nothing hides.
    #[test]
    fn test_duplicate_block_marker_gets_fresh_id() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let (pid, bid) = (Uuid::now_v7(), Uuid::now_v7());
        fs::write(
            dir.path().join("D.md"),
            md(pid, "D", &format!("- one <!-- id:{bid} -->\n  - copy <!-- id:{bid} -->\n")),
        )
        .unwrap();
        db.sync_dir(dir.path(), "u", false, false).unwrap();
        let blocks = db.get_page_blocks(&pid).unwrap();
        assert_eq!(blocks.len(), 2);
        for b in &blocks {
            assert_ne!(b.parent_id, Some(b.id), "block must not be its own parent");
        }
        let copy = blocks.iter().find(|b| b.content == "copy").unwrap();
        assert_ne!(copy.id, bid);
        assert_eq!(copy.parent_id, Some(bid));
    }

    // #9: a block id moving to another page is re-homed (no UNIQUE failure).
    #[test]
    fn test_block_moves_between_pages() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let (a, b, blk) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        fs::write(dir.path().join("A.md"), md(a, "A", &format!("- moving <!-- id:{blk} -->\n- stays\n"))).unwrap();
        fs::write(dir.path().join("B.md"), md(b, "B", "- b1\n")).unwrap();
        db.sync_dir(dir.path(), "u", false, false).unwrap();

        fs::write(dir.path().join("A.md"), md(a, "A", "- stays\n")).unwrap();
        fs::write(dir.path().join("B.md"), md(b, "B", &format!("- b1\n- moving <!-- id:{blk} -->\n"))).unwrap();
        let r = db.sync_dir(dir.path(), "u", false, false).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(db.get_block(&blk).unwrap().unwrap().page_id, b);
        assert_eq!(texts(&db, &a), vec!["stays"]);
        let mut bt = texts(&db, &b);
        bt.sort();
        assert_eq!(bt, vec!["b1", "moving"]);
    }

    // #9: one failing page is rolled back and reported; other pages still import.
    #[test]
    fn test_failing_page_rolls_back_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER boom BEFORE INSERT ON blocks WHEN NEW.content = 'BOOM'
                 BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            )
            .unwrap();
        let (bad, good) = (Uuid::now_v7(), Uuid::now_v7());
        fs::write(dir.path().join("Bad.md"), md(bad, "Bad", "- fine\n- BOOM\n")).unwrap();
        fs::write(dir.path().join("Good.md"), md(good, "Good", "- ok\n")).unwrap();
        let r = db.sync_dir(dir.path(), "u", true, false).unwrap();
        assert_eq!(r.errors.len(), 2, "{:?}", r.errors); // page error + delete-missing skipped
        assert!(db.get_page(&bad).unwrap().is_none(), "failed page fully rolled back");
        assert_eq!(texts(&db, &good), vec!["ok"]);
        assert!(!r.pages_created.contains(&"Bad".to_string()));
    }

    // #7: non-injective sanitization + case-insensitive collisions get unique names,
    // and titles round-trip through frontmatter (not the filename).
    #[test]
    fn test_colliding_titles_get_unique_files_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let titles = ["a/b", "a:b", "A_B", "say \"hi\": now"];
        for t in titles {
            db.create_page(t, None, false, None, "user").unwrap();
        }
        let rep = db.export_markdown_synced(dir.path()).unwrap();
        let mut lower: Vec<String> = rep.written.iter().map(|p| p.to_lowercase()).collect();
        lower.sort();
        lower.dedup();
        assert_eq!(lower.len(), titles.len(), "{:?}", rep.written);

        let db2 = Database::open_in_memory().unwrap();
        db2.sync_dir(dir.path(), "u", false, false).unwrap();
        let mut got: Vec<String> = db2.list_pages(None).unwrap().into_iter().map(|p| p.title).collect();
        got.sort();
        let mut want: Vec<String> = titles.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(got, want);
    }

    // #13: hostile folder names can't escape the sync dir or land in .git.
    #[test]
    fn test_hostile_folder_names_stay_inside() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("sync");
        let db = Database::open_in_memory().unwrap();
        for name in ["..", ".git", "a/../../x", "."] {
            let f = db.create_folder(name, None, None, None, "user").unwrap();
            let p = db.create_page(&format!("in {name}"), None, false, None, "user").unwrap();
            db.move_page_to_folder(&p.id, Some(&f.id), "user").unwrap();
        }
        let rep = db.export_markdown_synced(&dir).unwrap();
        for w in &rep.written {
            assert!(Path::new(w).starts_with(&dir), "{w} escaped");
        }
        assert!(!dir.join(".git").exists());
        let entries: Vec<_> = fs::read_dir(root.path()).unwrap().collect();
        assert_eq!(entries.len(), 1, "nothing written next to the sync dir");
        // Export and import agree (no dot-folders produced, so nothing is skipped).
        let db2 = Database::open_in_memory().unwrap();
        db2.sync_dir(&dir, "u", false, false).unwrap();
        assert_eq!(db2.list_pages(None).unwrap().len(), 4);
    }

    // #11: a partial scan or a mass disappearance must not mass-trash.
    #[test]
    fn test_delete_missing_guard() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        for i in 0..30 {
            fs::write(dir.path().join(format!("p{i}.md")), format!("- {i}\n")).unwrap();
        }
        db.sync_dir(dir.path(), "u", false, false).unwrap();
        for i in 1..30 {
            fs::remove_file(dir.path().join(format!("p{i}.md"))).unwrap();
        }
        let r = db.sync_dir(dir.path(), "u", true, false).unwrap();
        assert!(r.pages_deleted.is_empty());
        assert!(r.errors.iter().any(|e| e.contains("Refusing")), "{:?}", r.errors);
        assert_eq!(db.list_pages(None).unwrap().len(), 30);

        let opts = SyncOptions { delete_missing: true, force_delete: true, ..Default::default() };
        let r = db.sync_dir_with(dir.path(), "u", &opts).unwrap();
        assert_eq!(r.pages_deleted.len(), 29);
    }

    // #14: journal flag/date and properties round-trip; CRLF and trailing
    // whitespace don't re-mark unchanged blocks every sync.
    #[test]
    fn test_journal_properties_and_normalized_idempotency() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        let d = chrono::NaiveDate::from_ymd_opt(2026, 9, 30).unwrap();
        let j = db.create_page("Sep 30th, 2026", None, true, Some(d), "user").unwrap();
        db.set_property(&j.id, "page", "mood", "good: very", "text", "user").unwrap();
        db.set_property(&j.id, "page", "note", "two\nlines", "text", "user").unwrap();
        db.create_block(&j.id, "trailing   ", None, None, "user").unwrap();
        db.export_markdown_synced(dir.path()).unwrap();

        let db2 = Database::open_in_memory().unwrap();
        db2.sync_dir(dir.path(), "u", false, false).unwrap();
        let j2 = db2.get_page(&j.id).unwrap().unwrap();
        assert!(j2.is_journal);
        assert_eq!(j2.journal_date, Some(d));
        let props: std::collections::HashMap<String, Option<String>> =
            db2.get_properties(&j.id).unwrap().into_iter().map(|p| (p.key, p.value)).collect();
        assert_eq!(props.get("mood").cloned().flatten().as_deref(), Some("good: very"));
        assert_eq!(props.get("note").cloned().flatten().as_deref(), Some("two\nlines"));

        // Re-import into the ORIGINAL db: unchanged despite the trailing spaces.
        let r = db.sync_dir(dir.path(), "u", false, false).unwrap();
        assert_eq!((r.pages_updated.len(), r.blocks_updated), (0, 0), "{r:?}");
        // CRLF line endings (e.g. a Windows checkout) are also a no-op.
        let f = dir.path().join("Sep 30th, 2026.md");
        let crlf = fs::read_to_string(&f).unwrap().replace('\n', "\r\n");
        fs::write(&f, crlf).unwrap();
        let r = db.sync_dir(dir.path(), "u", false, false).unwrap();
        assert_eq!((r.pages_updated.len(), r.blocks_updated), (0, 0), "{r:?}");
    }

    // #3: conflict copy is rewritten as a separate page.
    #[test]
    fn test_conflict_copy_rewrite() {
        let (pid, bid) = (Uuid::now_v7(), Uuid::now_v7());
        let orig = md(pid, "Doc", &format!("- hello <!-- id:{bid} -->\n"));
        let copy = rewrite_as_conflict_copy(&orig, "Doc", "laptop");
        let fm = parse_frontmatter(&copy);
        assert_ne!(fm.id, Some(pid));
        assert_eq!(fm.title.as_deref(), Some("Doc (conflict from laptop)"));
        assert!(!copy.contains(&bid.to_string()));
        let body = strip_frontmatter(&copy);
        let blocks = parse_markdown_blocks(&body);
        assert_eq!(blocks[0].content, "hello");
        assert!(blocks[0].id.is_some());
    }
}
