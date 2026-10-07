use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::db::Database;
use crate::error::Result;
use crate::models::Page;

/// Directory (inside a sync dir) that receives stale/superseded `.md` files instead
/// of deleting them outright. Dot-prefixed, so the importer never reads it.
pub const SYNC_TRASH_DIR: &str = ".minotes-trash";
/// Manifest of page ids written by the last synced export (one per line). Lets the
/// pruner tell "a page we exported that has since been permanently deleted" apart
/// from "a page that arrived from a remote but has not been imported yet".
pub const EXPORT_MANIFEST: &str = ".minotes-exported";

/// Page frontmatter keys owned by the exporter; never treated as properties.
pub(crate) const RESERVED_FM_KEYS: &[&str] = &["id", "title", "type", "date"];

/// Directory (at the export root) holding one `<board id>.json` sidecar per
/// whiteboard referenced by an exported page (see [`WhiteboardFile`]). It is
/// dot-prefixed on purpose: the `.md` scanner and the "removed by pull" page diff
/// both skip dot paths, so pages never see it; the whiteboard importer/pruner
/// handle it explicitly. Unlike `.minotes-trash`, it IS committed by git sync.
pub const WHITEBOARD_DIR: &str = ".minotes-whiteboards";
/// Folder identity marker written into every exported folder directory
/// (see [`FolderMarker`]). Not a `.md`, so it is never imported as a page.
pub const FOLDER_MARKER: &str = ".minotes-folder.json";

/// On-disk whiteboard sidecar. `data` is the board's opaque JSON kept as a
/// STRING so it round-trips byte-for-byte; `updated_at` decides which copy wins
/// when two devices both changed a board (newer wins, never older-over-newer).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WhiteboardFile {
    pub id: String,
    pub updated_at: String,
    pub data: String,
}

/// On-disk folder identity: directory names carry no ids, so renames and
/// deletes are recognised through this marker's stable `id`. `name` is the
/// lossless folder name (the directory name is sanitized / de-duplicated).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct FolderMarker {
    pub id: Uuid,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<Uuid>,
}

/// Result of a sync-aware export.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ExportReport {
    pub written: Vec<String>,
    /// Relative paths of stale files moved into `.minotes-trash/`.
    pub pruned: Vec<String>,
}

/// Where each page / folder lands on disk, relative to the export root.
pub(crate) struct ExportPlan {
    pub(crate) folder_dirs: Vec<PathBuf>,
    pub(crate) folders: Vec<(crate::models::Folder, PathBuf)>,
    pub(crate) pages: Vec<(Page, PathBuf)>,
    pub(crate) archived_ids: HashSet<Uuid>,
}

fn parse_ts(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&chrono::Utc))
}

/// Is `a` strictly newer than `b`? Unparseable timestamps never win.
pub(crate) fn ts_newer(a: &str, b: &str) -> bool {
    match (parse_ts(a), parse_ts(b)) {
        (Some(x), Some(y)) => x > y,
        (Some(_), None) => true,
        _ => false,
    }
}

/// Read every whiteboard sidecar under `<root>/.minotes-whiteboards/` (including
/// git conflict copies such as `<id>.conflict-<host>.json` — the id comes from the
/// content, not the name). Returns (relative path, parsed file) pairs, plus
/// errors for unreadable entries.
pub(crate) fn read_whiteboard_files(root: &Path) -> (Vec<(PathBuf, WhiteboardFile)>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let dir = root.join(WHITEBOARD_DIR);
    let Ok(rd) = fs::read_dir(&dir) else { return (out, errors) };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        let rel = Path::new(WHITEBOARD_DIR).join(e.file_name());
        match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<WhiteboardFile>(&text) {
                Ok(wb) => out.push((rel, wb)),
                // A malformed file won't fix itself on retry: log, don't block.
                Err(err) => eprintln!("[minotes-sync] ignoring malformed {}: {err}", rel.display()),
            },
            Err(err) => errors.push(format!("Read failed for {}: {err}", rel.display())),
        }
    }
    (out, errors)
}

/// Read the folder marker in `<root>/<rel>/`, if any.
pub(crate) fn read_folder_marker(root: &Path, rel: &Path) -> Option<FolderMarker> {
    let text = fs::read_to_string(root.join(rel).join(FOLDER_MARKER)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Can this page property be represented as a frontmatter key? The exporter
/// writes exactly these; import deletes exactly these when a file drops them.
pub(crate) fn fm_key_exportable(key: &str) -> bool {
    !(key.is_empty()
        || key.trim() != key
        || key.contains(':')
        || key.contains('\n')
        || key.contains('\r')
        || key.starts_with("---")
        || key.starts_with('#')
        || key.starts_with('-')
        || RESERVED_FM_KEYS.contains(&key))
}

/// Add ids to the sync manifest — only if it already exists (i.e. this dir is
/// managed by a synced export), so plain directories don't gain a dotfile.
/// Called by import so that a page/folder imported from the dir and later
/// permanently deleted locally (before any export listed it) is still recognised
/// as "ours" and pruned, instead of being re-imported forever.
pub(crate) fn add_to_manifest(root: &Path, ids: impl IntoIterator<Item = Uuid>) {
    let path = root.join(EXPORT_MANIFEST);
    let Ok(existing) = fs::read_to_string(&path) else { return };
    let mut set: std::collections::BTreeSet<String> =
        existing.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let before = set.len();
    set.extend(ids.into_iter().map(|i| i.to_string()));
    if set.len() != before {
        let body: Vec<String> = set.into_iter().collect();
        let _ = fs::write(&path, body.join("\n") + "\n");
    }
}

/// Move `rel` (relative to `root`) into `.minotes-trash/<stamp>/rel`.
fn move_to_sync_trash(root: &Path, rel: &Path, stamp: &str) -> std::io::Result<()> {
    let mut dest = root.join(SYNC_TRASH_DIR).join(stamp).join(rel);
    if dest.exists() {
        let ext = rel.extension().and_then(|e| e.to_str()).unwrap_or("bak").to_string();
        dest = dest.with_extension(format!("{}.{ext}", Uuid::now_v7().simple()));
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::rename(root.join(rel), &dest)
}

/// Write `content` to `path` unless it already holds exactly that.
fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    if fs::read_to_string(path).map(|c| c == content).unwrap_or(false) {
        return Ok(());
    }
    fs::write(path, content)
        .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))
}

impl Database {
    /// Export entire graph as markdown files into a directory,
    /// mirroring the folder hierarchy as real filesystem directories.
    ///
    /// Besides the `.md` files this writes, exactly like the sync export:
    /// - `<dir>/.minotes-folder.json` in every folder directory ([`FolderMarker`]);
    /// - `.minotes-whiteboards/<id>.json` at the root for every whiteboard a page
    ///   references ([`WhiteboardFile`]; the block itself stays
    ///   `{{whiteboard:<id>}}` in the markdown). `import_markdown_dir` and sync
    ///   import read these back.
    pub fn export_markdown(&self, output_dir: &Path) -> Result<Vec<String>> {
        Ok(self.export_markdown_inner(output_dir, false)?.written)
    }

    /// Export for sync: like `export_markdown`, but afterwards moves every stale
    /// `.md` (a renamed/moved page's old file, a trashed or deleted page's file) into
    /// `.minotes-trash/`, so a stale copy can never be re-imported and revert the DB.
    pub fn export_markdown_synced(&self, output_dir: &Path) -> Result<ExportReport> {
        self.export_markdown_inner(output_dir, true)
    }

    fn export_markdown_inner(&self, output_dir: &Path, prune: bool) -> Result<ExportReport> {
        fs::create_dir_all(output_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;

        let plan = self.plan_export_paths()?;
        for (folder, rel) in &plan.folders {
            let dir = safe_join(output_dir, rel)?;
            fs::create_dir_all(&dir)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;
            // Stable folder identity (renames/deletes propagate; empty folders
            // round-trip because git now has a file to track).
            let marker = FolderMarker { id: folder.id, name: folder.name.clone(), parent: folder.parent_id };
            let json = serde_json::to_string_pretty(&marker)? + "\n";
            write_if_changed(&dir.join(FOLDER_MARKER), &json)?;
        }

        let mut report = ExportReport::default();
        for (page, rel) in &plan.pages {
            let filepath = safe_join(output_dir, rel)?;
            if let Some(parent) = filepath.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;
            }
            let md = self.render_page_markdown(page)?;
            // Skip unchanged files so mtimes stay meaningful (used to break ties).
            let unchanged = fs::read_to_string(&filepath).map(|c| c == md).unwrap_or(false);
            if !unchanged {
                fs::write(&filepath, &md)
                    .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
            }
            report.written.push(filepath.display().to_string());
        }

        self.export_whiteboards(output_dir, &plan)?;

        if prune {
            report.pruned = self.prune_stale_files(output_dir, &plan)?;
        }
        Ok(report)
    }

    /// Compute a deterministic, collision-free export path for every live page.
    /// Names are unique per directory case-insensitively (macOS/Windows), and ties
    /// are broken by page id so every device picks the same name.
    pub(crate) fn plan_export_paths(&self) -> Result<ExportPlan> {
        let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
        let mut folder_map: HashMap<Uuid, PathBuf> = HashMap::new();
        let mut folders = Vec::new();
        self.plan_folder_dirs(Path::new(""), None, &mut taken, &mut folder_map, &mut folders, 0)?;
        let folder_dirs = folders.iter().map(|(_, d): &(crate::models::Folder, PathBuf)| d.clone()).collect();

        let mut pages = self.list_pages(Some(1_000_000))?;
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::with_capacity(pages.len());
        for page in pages {
            let dir = page
                .folder_id
                .and_then(|f| folder_map.get(&f).cloned())
                .unwrap_or_default();
            let base = sanitize_component(&page.title);
            let set = taken.entry(dir.clone()).or_default();
            let name = unique_name(&base, ".md", &page.id, set);
            out.push((page, dir.join(name)));
        }

        let mut archived_ids = HashSet::new();
        let mut stmt = self.conn.prepare("SELECT page_id FROM archive")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            if let Ok(id) = Uuid::parse_str(&r?) {
                archived_ids.insert(id);
            }
        }
        Ok(ExportPlan { folder_dirs, folders, pages: out, archived_ids })
    }

    fn plan_folder_dirs(
        &self,
        base: &Path,
        parent_id: Option<&Uuid>,
        taken: &mut HashMap<PathBuf, HashSet<String>>,
        map: &mut HashMap<Uuid, PathBuf>,
        dirs: &mut Vec<(crate::models::Folder, PathBuf)>,
        depth: usize,
    ) -> Result<()> {
        if depth > 64 {
            return Ok(()); // guard against a folder parent cycle
        }
        let mut folders = self.list_folders(parent_id)?;
        folders.sort_by_key(|f| f.id);
        for folder in &folders {
            let set = taken.entry(base.to_path_buf()).or_default();
            let name = unique_name(&sanitize_component(&folder.name), "", &folder.id, set);
            let dir_path = base.join(&name);
            map.insert(folder.id, dir_path.clone());
            dirs.push((folder.clone(), dir_path.clone()));
            self.plan_folder_dirs(&dir_path, Some(&folder.id), taken, map, dirs, depth + 1)?;
        }
        Ok(())
    }

    /// Write a sidecar for every whiteboard referenced by an exported page.
    /// A sidecar that is NEWER than the DB copy (pulled, not imported yet) is left
    /// alone — an older board must never overwrite a newer one.
    fn export_whiteboards(&self, root: &Path, plan: &ExportPlan) -> Result<()> {
        let ids: Vec<Uuid> = plan.pages.iter().map(|(p, _)| p.id).collect();
        let mut refs: Vec<String> = self.whiteboards_on_pages(&ids)?.into_iter().collect();
        refs.sort();
        let dir = root.join(WHITEBOARD_DIR);
        for id in refs {
            let Ok(Some(wb)) = self.get_whiteboard(&id) else { continue }; // never saved
            let path = dir.join(format!("{id}.json"));
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(f) = serde_json::from_str::<WhiteboardFile>(&text) {
                    if ts_newer(&f.updated_at, &wb.updated_at) {
                        continue;
                    }
                }
            }
            fs::create_dir_all(&dir)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;
            let file = WhiteboardFile { id: wb.id, updated_at: wb.updated_at, data: wb.data };
            write_if_changed(&path, &(serde_json::to_string_pretty(&file)? + "\n"))?;
        }
        Ok(())
    }

    /// Move stale files into `.minotes-trash/` (see `export_markdown_synced`).
    ///
    /// Pages: a `.md` is stale when its frontmatter id belongs to a page that is
    /// trashed, lives at a different path now, or is gone locally although this
    /// dir's manifest lists it (exported or imported here before — so it was
    /// deleted locally, possibly before its first export). Files with an id this
    /// DB has never seen are left alone: they may be pages pulled from a remote
    /// that simply haven't been imported yet.
    ///
    /// Folder markers: same rules by folder id (planned elsewhere, trashed, or
    /// gone-but-listed ⇒ stale); then directories that are no longer a folder are
    /// removed once empty.
    ///
    /// Whiteboard sidecars: stale when no surviving `.md` and no live/archived page
    /// references the board — unless the file is newer than the DB copy (not
    /// imported yet). Conflict copies are dropped once the DB is at least as new.
    fn prune_stale_files(&self, root: &Path, plan: &ExportPlan) -> Result<Vec<String>> {
        let expected: HashMap<Uuid, &PathBuf> = plan.pages.iter().map(|(p, rel)| (p.id, rel)).collect();
        let mut known: HashSet<Uuid> = HashSet::new();
        let mut trashed: HashSet<Uuid> = HashSet::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id, id IN (SELECT page_id FROM trash) FROM pages",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
            for r in rows {
                let (id, is_trashed) = r?;
                if let Ok(id) = Uuid::parse_str(&id) {
                    known.insert(id);
                    if is_trashed {
                        trashed.insert(id);
                    }
                }
            }
        }
        let mut known_folders: HashSet<Uuid> = HashSet::new();
        let mut trashed_folders: HashSet<Uuid> = HashSet::new();
        {
            let mut stmt = self.conn.prepare(&format!(
                "WITH RECURSIVE {} SELECT id, id IN (SELECT id FROM trashed_tree) FROM folders",
                crate::repo::trash::TRASHED_FOLDER_TREE
            ))?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
            for r in rows {
                let (id, is_trashed) = r?;
                if let Ok(id) = Uuid::parse_str(&id) {
                    known_folders.insert(id);
                    if is_trashed {
                        trashed_folders.insert(id);
                    }
                }
            }
        }
        let planned_folders: HashMap<Uuid, &PathBuf> =
            plan.folders.iter().map(|(f, rel)| (f.id, rel)).collect();
        let manifest_path = root.join(EXPORT_MANIFEST);
        let previously_exported: HashSet<Uuid> = fs::read_to_string(&manifest_path)
            .map(|s| s.lines().filter_map(|l| Uuid::parse_str(l.trim()).ok()).collect())
            .unwrap_or_default();

        let scan = crate::repo::sync::scan_markdown_tree(root);
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f").to_string();
        let mut pruned = Vec::new();
        // Whiteboards referenced by .md files that stay in the dir.
        let mut wb_keep: HashSet<String> = HashSet::new();
        for file in &scan.files {
            let Ok(content) = fs::read_to_string(&file.abs) else { continue };
            let stale = match crate::repo::sync::parse_frontmatter_id(&content) {
                None => false,
                Some(id) => {
                    if trashed.contains(&id) {
                        true
                    } else if let Some(exp) = expected.get(&id) {
                        file.rel != **exp
                    } else if known.contains(&id) {
                        false // archived: not exported, leave its file untouched
                    } else {
                        previously_exported.contains(&id) // deleted locally
                    }
                }
            };
            if !stale {
                wb_keep.extend(crate::repo::whiteboards::whiteboard_refs(&content));
                continue;
            }
            match move_to_sync_trash(root, &file.rel, &stamp) {
                Ok(()) => pruned.push(file.rel.display().to_string()),
                Err(e) => eprintln!("[minotes-sync] could not prune stale {}: {e}", file.abs.display()),
            }
        }

        // Folder markers.
        for d in &scan.dirs {
            // Git conflict copies of a marker (two devices wrote the same folder
            // dir, e.g. right after upgrading): the in-place marker wins and the
            // other id is adopted by name on import, so the copies are just noise.
            if let Ok(rd) = fs::read_dir(root.join(d)) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with(".minotes-folder.conflict-") && name.ends_with(".json") {
                        let rel = d.join(&name);
                        if move_to_sync_trash(root, &rel, &stamp).is_ok() {
                            pruned.push(rel.display().to_string());
                        }
                    }
                }
            }
            let Some(m) = read_folder_marker(root, d) else { continue };
            let stale = if trashed_folders.contains(&m.id) {
                true
            } else if let Some(exp) = planned_folders.get(&m.id) {
                d != *exp
            } else if known_folders.contains(&m.id) {
                false // archived folder: leave untouched
            } else {
                previously_exported.contains(&m.id)
            };
            if stale {
                let rel = d.join(FOLDER_MARKER);
                match move_to_sync_trash(root, &rel, &stamp) {
                    Ok(()) => pruned.push(rel.display().to_string()),
                    Err(e) => eprintln!("[minotes-sync] could not prune stale {}: {e}", rel.display()),
                }
            }
        }

        // Remove directories left empty that no longer correspond to a folder, so an
        // old (renamed) folder name can't be resurrected on the next import.
        let wanted: HashSet<PathBuf> = plan
            .folder_dirs
            .iter()
            .flat_map(|d| d.ancestors().map(Path::to_path_buf).collect::<Vec<_>>())
            .collect();
        let mut dirs = scan.dirs.clone();
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        for d in dirs {
            if !wanted.contains(&d) {
                let _ = fs::remove_dir(root.join(&d)); // only succeeds when empty
            }
        }

        // Whiteboard sidecars.
        let mut live_and_archived: Vec<Uuid> = plan.pages.iter().map(|(p, _)| p.id).collect();
        live_and_archived.extend(plan.archived_ids.iter().copied());
        wb_keep.extend(self.whiteboards_on_pages(&live_and_archived)?);
        let (wb_files, _) = read_whiteboard_files(root);
        for (rel, f) in &wb_files {
            let canonical = rel.file_name().and_then(|n| n.to_str()) == Some(format!("{}.json", f.id).as_str());
            let newer_than_db = match self.get_whiteboard(&f.id).ok().flatten() {
                Some(w) => ts_newer(&f.updated_at, &w.updated_at),
                None => true,
            };
            let stale = if newer_than_db {
                false // not imported yet: never drop newer data
            } else if !canonical {
                true // conflict copy already absorbed
            } else {
                !wb_keep.contains(&f.id)
            };
            if stale {
                match move_to_sync_trash(root, rel, &stamp) {
                    Ok(()) => pruned.push(rel.display().to_string()),
                    Err(e) => eprintln!("[minotes-sync] could not prune stale {}: {e}", rel.display()),
                }
            }
        }
        let _ = fs::remove_dir(root.join(WHITEBOARD_DIR)); // only when empty

        let mut ids: Vec<String> = plan.pages.iter().map(|(p, _)| p.id.to_string()).collect();
        ids.extend(plan.archived_ids.iter().filter(|i| known.contains(i)).map(|i| i.to_string()));
        ids.extend(known_folders.iter().filter(|i| !trashed_folders.contains(i)).map(|i| i.to_string()));
        ids.sort();
        let _ = fs::write(&manifest_path, ids.join("\n") + "\n");
        Ok(pruned)
    }

    /// Render a page as markdown with YAML frontmatter.
    fn render_page_markdown(&self, page: &crate::models::Page) -> Result<String> {
        let blocks = self.get_page_blocks(&page.id)?;
        let properties = self.get_properties(&page.id)?;

        let mut md = String::new();

        // YAML frontmatter. Always emit a frontmatter block carrying the stable page
        // UUID (Bug #3) so import reconciles by identity, not by title/filename.
        // The title is written as a JSON (= YAML double-quoted) string so quotes,
        // colons and newlines survive; import prefers it over the lossy filename.
        {
            md.push_str("---\n");
            md.push_str(&format!("id: {}\n", page.id));
            md.push_str(&format!("title: {}\n", quote_fm_value(&page.title, true)));
            if page.is_journal {
                md.push_str("type: journal\n");
                if let Some(ref d) = page.journal_date {
                    md.push_str(&format!("date: {d}\n"));
                }
            }
            for prop in &properties {
                let key = prop.key.trim();
                if key.is_empty()
                    || key.contains(':')
                    || key.contains('\n')
                    || key.contains('\r')
                    || key.starts_with("---")
                    || RESERVED_FM_KEYS.contains(&key)
                {
                    continue; // not representable as a frontmatter key
                }
                if let Some(ref v) = prop.value {
                    md.push_str(&format!("{key}: {}\n", quote_fm_value(v, false)));
                }
            }
            md.push_str("---\n\n");
        }

        // Bug #12: emit blocks depth-first by walking the parent→children tree, with
        // children sorted by position WITHIN each parent. The previous code iterated
        // the globally position-ordered flat list and only computed indent depth, so
        // a child at position 1.0 could sort ahead of a root sibling at 2.0 and the
        // outline order scrambled. Build the tree and walk it instead.
        use std::collections::HashMap;
        let mut children: HashMap<Option<uuid::Uuid>, Vec<&crate::models::Block>> = HashMap::new();
        for block in &blocks {
            children.entry(block.parent_id).or_default().push(block);
        }
        for kids in children.values_mut() {
            kids.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap_or(std::cmp::Ordering::Equal));
        }

        // Iterative DFS (explicit stack) to avoid recursion-depth limits on deep trees.
        let mut stack: Vec<(Option<uuid::Uuid>, usize)> = Vec::new();
        if let Some(roots) = children.get(&None) {
            for root in roots.iter().rev() {
                stack.push((Some(root.id), 0));
            }
        }
        let mut emitted = 0usize;
        while let Some((Some(id), depth)) = stack.pop() {
            if let Some(block) = blocks.iter().find(|b| b.id == id) {
                md.push_str(&render_block_lines(&block.content, depth, &block.id));
                emitted += 1;
            }
            if let Some(kids) = children.get(&Some(id)) {
                for child in kids.iter().rev() {
                    stack.push((Some(child.id), depth + 1));
                }
            }
            if emitted > 100_000 { break; } // safety cap against cycles
        }

        Ok(md)
    }

    /// Export entire graph as OPML (outline format).
    pub fn export_opml(&self) -> Result<String> {
        let pages = self.list_pages(Some(10000))?;
        let mut opml = String::new();
        opml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        opml.push_str("<opml version=\"2.0\">\n");
        opml.push_str("  <head>\n");
        opml.push_str("    <title>MiNotes Export</title>\n");
        opml.push_str(&format!("    <dateCreated>{}</dateCreated>\n", chrono::Utc::now().to_rfc2822()));
        opml.push_str("  </head>\n");
        opml.push_str("  <body>\n");

        for page in &pages {
            let blocks = self.get_page_blocks(&page.id)?;
            let escaped_title = xml_escape_attr(&page.title);
            opml.push_str(&format!("    <outline text=\"{}\">\n", escaped_title));
            for block in &blocks {
                let escaped = xml_escape_attr(&block.content);
                opml.push_str(&format!("      <outline text=\"{}\"/>\n", escaped));
            }
            opml.push_str("    </outline>\n");
        }

        opml.push_str("  </body>\n");
        opml.push_str("</opml>\n");
        Ok(opml)
    }

    /// Export entire graph as a single JSON object.
    pub fn export_json(&self) -> Result<serde_json::Value> {
        let pages = self.list_pages(Some(10000))?;
        let mut pages_with_blocks = Vec::new();

        for page in &pages {
            let blocks = self.get_page_blocks(&page.id)?;
            let properties = self.get_properties(&page.id)?;
            pages_with_blocks.push(serde_json::json!({
                "page": page,
                "blocks": blocks,
                "properties": properties,
            }));
        }

        // Boards referenced by the exported pages (data kept as the stored string).
        let ids: Vec<Uuid> = pages.iter().map(|p| p.id).collect();
        let mut wb_ids: Vec<String> = self.whiteboards_on_pages(&ids)?.into_iter().collect();
        wb_ids.sort();
        let whiteboards: Vec<WhiteboardFile> = wb_ids
            .iter()
            .filter_map(|id| self.get_whiteboard(id).ok().flatten())
            .map(|w| WhiteboardFile { id: w.id, updated_at: w.updated_at, data: w.data })
            .collect();

        Ok(serde_json::json!({
            "version": "1.0",
            "exported_at": chrono::Utc::now().to_rfc3339(),
            "pages": pages_with_blocks,
            "whiteboards": whiteboards,
        }))
    }

    /// Parse markdown body text into blocks (hierarchy + multi-line continuations)
    /// and create them under `page_id`. Shared by the directory and single-file
    /// importers so the export→import round-trip is faithful (Bug #12, #13).
    fn import_blocks_into_page(&self, page_id: &uuid::Uuid, body: &[&str], actor: &str) -> Result<usize> {
        let parsed = crate::repo::sync::parse_markdown_blocks(body);
        // Recreate parent_id from indent depth using an ancestor stack (mirrors
        // create_blocks_with_hierarchy, but counts created blocks locally).
        let mut stack: Vec<(usize, uuid::Uuid)> = Vec::new();
        let mut count = 0usize;
        for pb in &parsed {
            while let Some(&(d, _)) = stack.last() {
                if d >= pb.depth { stack.pop(); } else { break; }
            }
            let parent = stack.last().map(|(_, id)| *id);
            // Bug #1: preserve stable block id if the marker was present.
            let block = match pb.id {
                Some(id) => self.create_block_with_id(id, page_id, &pb.content, parent.as_ref(), None, actor)?,
                None => self.create_block(page_id, &pb.content, parent.as_ref(), None, actor)?,
            };
            count += 1;
            stack.push((pb.depth, block.id));
        }
        Ok(count)
    }

    /// Import markdown files from a directory into the graph.
    pub fn import_markdown_dir(&self, input_dir: &Path, actor: &str) -> Result<Vec<String>> {
        let mut imported = Vec::new();

        let entries = fs::read_dir(input_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot read dir: {e}")))?;

        for entry in entries {
            let entry = entry
                .map_err(|e| crate::error::Error::InvalidInput(format!("Dir entry error: {e}")))?;
            let path = entry.path();

            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }

            let content = fs::read_to_string(&path)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Read failed: {e}")))?;

            // Prefer the frontmatter title: filenames are a lossy encoding of it.
            let title = crate::repo::sync::parse_frontmatter(&content)
                .title
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Untitled")
                        .to_string()
                });

            // Skip if page already exists
            if self.get_page_by_title(&title)?.is_some() {
                continue;
            }

            let page = self.create_page(&title, None, false, None, actor)?;

            // Parse blocks preserving hierarchy + multi-line content (Bug #12, #13).
            let lines = strip_frontmatter(&content);
            self.import_blocks_into_page(&page.id, &lines, actor)?;

            imported.push(title);
        }

        // Whiteboard sidecars written by `export_markdown` (newer wins).
        let mut r = crate::repo::sync::SyncResult::default();
        self.import_whiteboards(input_dir, &mut r);

        Ok(imported)
    }

    /// Import a single markdown file.
    pub fn import_markdown_file(&self, file_path: &Path, target_title: Option<&str>, actor: &str) -> Result<String> {
        let content = fs::read_to_string(file_path)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Read failed: {e}")))?;

        let title = target_title
            .map(String::from)
            .unwrap_or_else(|| {
                file_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled")
                    .to_string()
            });

        let page = if let Some(existing) = self.get_page_by_title(&title)? {
            existing
        } else {
            self.create_page(&title, None, false, None, actor)?
        };

        let lines = strip_frontmatter(&content);
        let count = self.import_blocks_into_page(&page.id, &lines, actor)?;

        Ok(format!("Imported {count} blocks into '{title}'"))
    }

    /// Import an Org-mode file, converting headings and content to pages and blocks.
    pub fn import_org_file(&self, file_path: &Path, actor: &str) -> Result<String> {
        let content = fs::read_to_string(file_path)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Read failed: {e}")))?;

        let title = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();

        let page = if let Some(existing) = self.get_page_by_title(&title)? {
            existing
        } else {
            self.create_page(&title, None, false, None, actor)?
        };

        let mut count = 0;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Convert org headings (* / ** / ***) to markdown headings
            let clean = if trimmed.starts_with("*** ") {
                format!("### {}", &trimmed[4..])
            } else if trimmed.starts_with("** ") {
                format!("## {}", &trimmed[3..])
            } else if trimmed.starts_with("* ") {
                format!("# {}", &trimmed[2..])
            } else if trimmed.starts_with("- ") || trimmed.starts_with("+ ") {
                trimmed.to_string()
            } else if trimmed.starts_with("#+") {
                // Skip org-mode directives
                continue;
            } else {
                trimmed.to_string()
            };
            if !clean.is_empty() {
                self.create_block(&page.id, &clean, None, None, actor)?;
                count += 1;
            }
        }

        Ok(format!("Imported {count} blocks from org-mode into '{title}'"))
    }

    /// Export a page to Org-mode format.
    pub fn export_org(&self, page_id: &uuid::Uuid) -> Result<String> {
        let page = self.get_page(page_id)?
            .ok_or_else(|| crate::error::Error::NotFound("Page not found".into()))?;
        let blocks = self.get_page_blocks(page_id)?;
        let properties = self.get_properties(page_id)?;

        let mut org = String::new();
        // Org-mode properties drawer
        if !properties.is_empty() {
            org.push_str(":PROPERTIES:\n");
            org.push_str(&format!(":TITLE: {}\n", page.title));
            for prop in &properties {
                if let Some(ref v) = prop.value {
                    org.push_str(&format!(":{}: {v}\n", prop.key.to_uppercase()));
                }
            }
            org.push_str(":END:\n\n");
        }

        for block in &blocks {
            let c = &block.content;
            // Convert markdown headings back to org
            if c.starts_with("### ") {
                org.push_str(&format!("*** {}\n", &c[4..]));
            } else if c.starts_with("## ") {
                org.push_str(&format!("** {}\n", &c[3..]));
            } else if c.starts_with("# ") {
                org.push_str(&format!("* {}\n", &c[2..]));
            } else {
                org.push_str(&format!("{c}\n"));
            }
        }

        Ok(org)
    }

    /// Generate a static HTML site from the graph.
    pub fn publish_static_site(&self, output_dir: &Path) -> Result<Vec<String>> {
        fs::create_dir_all(output_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;

        let pages = self.list_pages(Some(10000))?;
        let mut published = Vec::new();

        // Write index.html
        let mut index_html = String::new();
        index_html.push_str("<!DOCTYPE html><html><head><meta charset=\"utf-8\">\n");
        index_html.push_str("<title>MiNotes</title>\n");
        index_html.push_str("<style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:20px;background:#1e1e2e;color:#cdd6f4}");
        index_html.push_str("a{color:#89b4fa}h1{border-bottom:1px solid #45475a;padding-bottom:8px}");
        index_html.push_str("ul{list-style:none;padding:0}li{padding:4px 0}</style>\n");
        index_html.push_str("</head><body>\n<h1>MiNotes</h1>\n<ul>\n");
        for page in &pages {
            if page.is_journal { continue; }
            let slug = sanitize_filename(&page.title);
            index_html.push_str(&format!("<li><a href=\"{slug}.html\">{}</a></li>\n", xml_escape(&page.title)));
        }
        index_html.push_str("</ul>\n</body></html>");
        let index_path = output_dir.join("index.html");
        fs::write(&index_path, &index_html)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
        published.push("index.html".to_string());

        // Write individual page HTMLs
        for page in &pages {
            let blocks = self.get_page_blocks(&page.id)?;
            let slug = sanitize_filename(&page.title);

            let mut html = String::new();
            html.push_str("<!DOCTYPE html><html><head><meta charset=\"utf-8\">\n");
            html.push_str(&format!("<title>{}</title>\n", xml_escape(&page.title)));
            html.push_str("<style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:20px;background:#1e1e2e;color:#cdd6f4}");
            html.push_str("a{color:#89b4fa}pre{background:#181825;padding:12px;border-radius:6px;overflow-x:auto}");
            html.push_str("code{background:#313244;padding:2px 4px;border-radius:3px}</style>\n");
            html.push_str("</head><body>\n");
            html.push_str(&format!("<p><a href=\"index.html\">← Back</a></p>\n"));
            html.push_str(&format!("<h1>{}</h1>\n", xml_escape(&page.title)));

            for block in &blocks {
                // A whiteboard block: its drawing is published as a JSON file
                // next to the page (`whiteboards/<id>.json`) and linked here.
                let wb_refs = crate::repo::whiteboards::whiteboard_refs(&block.content);
                if wb_refs.len() == 1 && block.content.trim() == format!("{{{{whiteboard:{}}}}}", wb_refs[0]) {
                    let id = &wb_refs[0];
                    match self.get_whiteboard(id).ok().flatten() {
                        Some(wb) => {
                            let wb_dir = output_dir.join("whiteboards");
                            fs::create_dir_all(&wb_dir).map_err(|e| {
                                crate::error::Error::InvalidInput(format!("Cannot create dir: {e}"))
                            })?;
                            fs::write(wb_dir.join(format!("{id}.json")), &wb.data).map_err(|e| {
                                crate::error::Error::InvalidInput(format!("Write failed: {e}"))
                            })?;
                            let rel = format!("whiteboards/{id}.json");
                            if !published.contains(&rel) {
                                published.push(rel.clone());
                            }
                            html.push_str(&format!(
                                "<p class=\"minotes-whiteboard\">Whiteboard: <a href=\"{rel}\">{id}.json</a></p>\n"
                            ));
                        }
                        None => html.push_str("<p class=\"minotes-whiteboard\">Whiteboard (empty)</p>\n"),
                    }
                    continue;
                }
                let escaped = xml_escape(&block.content);
                // Simple markdown-to-HTML conversion for publishing
                if escaped.starts_with("# ") {
                    html.push_str(&format!("<h2>{}</h2>\n", &escaped[2..]));
                } else if escaped.starts_with("## ") {
                    html.push_str(&format!("<h3>{}</h3>\n", &escaped[3..]));
                } else if escaped.starts_with("- [ ] ") {
                    html.push_str(&format!("<p>☐ {}</p>\n", &escaped[6..]));
                } else if escaped.starts_with("- [x] ") {
                    html.push_str(&format!("<p>☑ {}</p>\n", &escaped[6..]));
                } else {
                    html.push_str(&format!("<p>{escaped}</p>\n"));
                }
            }

            html.push_str("</body></html>");
            let file_path = output_dir.join(format!("{slug}.html"));
            fs::write(&file_path, &html)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
            published.push(format!("{slug}.html"));
        }

        Ok(published)
    }
}

/// Render one block as a bullet at `depth`, encoding multi-line content safely
/// (Bug #13). The first line follows `- `; any further lines are written as
/// continuation lines indented two spaces DEEPER than a child bullet and WITHOUT a
/// bullet marker, so the importer folds them back into a single block instead of
/// splitting one block into several.
fn render_block_lines(content: &str, depth: usize, id: &uuid::Uuid) -> String {
    let bullet_indent = "  ".repeat(depth);
    // Continuation lines are indented one level deeper than this block's *children*
    // would be, and carry no bullet, so they're unambiguous on import.
    let cont_indent = "  ".repeat(depth + 1);
    let mut out = String::new();
    let mut lines = content.split('\n');
    let first = lines.next().unwrap_or("");
    // Bug #1: append a stable id marker on the first line. Continuation lines come
    // after, so the marker sits at the end of the block's first line only.
    out.push_str(&format!("{bullet_indent}- {first} <!-- id:{id} -->\n"));
    for line in lines {
        // Mark continuations with a zero-width-safe sentinel: deeper indent + no
        // bullet. A literal empty line is preserved as an empty continuation.
        out.push_str(&format!("{cont_indent}\\ {line}\n"));
    }
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Escape for an XML *attribute* value. Beyond the element-content escapes,
/// literal newlines/CR/tabs must become character references: XML parsers
/// normalize raw whitespace in attributes to spaces, so an unescaped newline
/// in `text="..."` silently mangles the value (or breaks the document).
fn xml_escape_attr(s: &str) -> String {
    xml_escape(s)
        .replace('\n', "&#10;")
        .replace('\r', "&#13;")
        .replace('\t', "&#9;")
}

fn sanitize_filename(name: &str) -> String {
    sanitize_component(name)
}

/// Turn an arbitrary page title / folder name into ONE safe path component.
/// Separators, reserved characters and control chars (incl. NUL) become `_`;
/// trailing dots/spaces are dropped (Windows); a name that is empty or starts with
/// `.` (`.`, `..`, `.git`, hidden) gets a `_` prefix so it can never escape the
/// sync dir, land in `.git`, or be skipped by the importer (which ignores
/// dot-folders). Long names are truncated to stay under filesystem limits.
pub(crate) fn sanitize_component(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() || s.starts_with('.') {
        s.insert(0, '_');
    }
    const MAX_BYTES: usize = 180;
    if s.len() > MAX_BYTES {
        let mut cut = MAX_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// Pick `base + ext`, or `base--<id suffix> + ext` if that name is already taken in
/// this directory (compared case-insensitively). Records the chosen name.
fn unique_name(base: &str, ext: &str, id: &Uuid, taken: &mut HashSet<String>) -> String {
    let simple = id.simple().to_string();
    let candidates = [
        format!("{base}{ext}"),
        format!("{base}--{}{ext}", &simple[simple.len() - 8..]),
        format!("{base}--{simple}{ext}"),
    ];
    for c in candidates.iter() {
        if taken.insert(c.to_lowercase()) {
            return c.clone();
        }
    }
    let mut n = 2u32;
    loop {
        let c = format!("{base}--{simple}-{n}{ext}");
        if taken.insert(c.to_lowercase()) {
            return c;
        }
        n += 1;
    }
}

/// Join a planned relative path onto `root`, refusing anything that could escape it.
fn safe_join(root: &Path, rel: &Path) -> Result<PathBuf> {
    use std::path::Component;
    for c in rel.components() {
        match c {
            Component::Normal(n) if n != ".git" => {}
            _ => {
                return Err(crate::error::Error::InvalidInput(format!(
                    "Refusing unsafe export path: {}",
                    rel.display()
                )))
            }
        }
    }
    let full = root.join(rel);
    debug_assert!(full.starts_with(root));
    Ok(full)
}

/// Encode a frontmatter value. Titles are always JSON-quoted; property values only
/// when they would otherwise not round-trip (newlines, edge whitespace, quotes).
fn quote_fm_value(v: &str, always: bool) -> String {
    if always || v.contains('\n') || v.contains('\r') || v.starts_with('"') || v.trim() != v {
        serde_json::to_string(v).unwrap_or_else(|_| v.to_string())
    } else {
        v.to_string()
    }
}

fn strip_frontmatter(content: &str) -> Vec<&str> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) == Some("---") {
        // Find closing ---
        if let Some(end) = lines[1..].iter().position(|l| l.trim() == "---") {
            return lines[end + 2..].to_vec();
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::io::Write;
    use tempfile::TempDir;

    fn temp_dir() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn test_export_import_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("Test Export", None, false, None, "user").unwrap();
        let page = db.get_page_by_title("Test Export").unwrap().unwrap();
        db.create_block(&page.id, "First block", None, None, "user").unwrap();
        db.create_block(&page.id, "Second block", None, None, "user").unwrap();

        let dir = temp_dir();
        let exported = db.export_markdown(dir.path()).unwrap();
        assert_eq!(exported.len(), 1);

        // Import into a fresh DB
        let db2 = Database::open_in_memory().unwrap();
        let imported = db2.import_markdown_dir(dir.path(), "user").unwrap();
        assert_eq!(imported, vec!["Test Export"]);

        let blocks = db2.get_page_blocks(&db2.get_page_by_title("Test Export").unwrap().unwrap().id).unwrap();
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn test_export_json() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("JSON Test", None, false, None, "user").unwrap();
        let json = db.export_json().unwrap();
        assert_eq!(json["pages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_import_single_file() {
        let dir = temp_dir();
        let file = dir.path().join("notes.md");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "---\ntitle: Notes\n---\n\n- Alpha\n- Beta\n- Gamma").unwrap();

        let db = Database::open_in_memory().unwrap();
        let result = db.import_markdown_file(&file, None, "user").unwrap();
        assert!(result.contains("3 blocks"));
    }

    // Bug #12 + #13: hierarchy and multi-line block content survive an export→import
    // round-trip (order correct, nesting preserved, one block stays one block).
    #[test]
    fn test_roundtrip_preserves_hierarchy_and_multiline() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Tree", None, false, None, "user").unwrap();
        let a = db.create_block(&page.id, "Parent A", None, None, "user").unwrap();
        db.create_block(&page.id, "Child A1", Some(&a.id), None, "user").unwrap();
        db.create_block(&page.id, "Child A2", Some(&a.id), None, "user").unwrap();
        // A root sibling AFTER the children — the old global position sort scrambled this.
        db.create_block(&page.id, "Root B", None, None, "user").unwrap();
        // A multi-line block (e.g. a fenced code block stored as one block).
        db.create_block(&page.id, "line one\nline two\nline three", None, None, "user").unwrap();

        let dir = temp_dir();
        db.export_markdown(dir.path()).unwrap();

        let db2 = Database::open_in_memory().unwrap();
        db2.import_markdown_dir(dir.path(), "user").unwrap();
        let imported = db2.get_page_by_title("Tree").unwrap().unwrap();
        let blocks = db2.get_page_blocks(&imported.id).unwrap();

        // 5 blocks, not split: Parent A, Child A1, Child A2, Root B, multi-line.
        assert_eq!(blocks.len(), 5, "multi-line block must not split: {:?}", blocks.iter().map(|b| &b.content).collect::<Vec<_>>());

        let parent = blocks.iter().find(|b| b.content == "Parent A").unwrap();
        let c1 = blocks.iter().find(|b| b.content == "Child A1").unwrap();
        let c2 = blocks.iter().find(|b| b.content == "Child A2").unwrap();
        assert_eq!(c1.parent_id, Some(parent.id), "Child A1 nested under Parent A");
        assert_eq!(c2.parent_id, Some(parent.id), "Child A2 nested under Parent A");
        let root_b = blocks.iter().find(|b| b.content == "Root B").unwrap();
        assert_eq!(root_b.parent_id, None, "Root B stays a root");
        let multi = blocks.iter().find(|b| b.content.contains("line two")).unwrap();
        assert_eq!(multi.content, "line one\nline two\nline three");
        assert_eq!(multi.parent_id, None);
    }

    #[test]
    fn test_export_respects_folder_hierarchy() {
        let db = Database::open_in_memory().unwrap();

        // Create folder structure: Work > Projects
        let work = db.create_folder("Work", None, None, None, "user").unwrap();
        let projects = db.create_folder("Projects", Some(&work.id), None, None, "user").unwrap();

        // Create pages in different locations
        let root_page = db.create_page("README", None, false, None, "user").unwrap();
        db.create_block(&root_page.id, "Root page", None, None, "user").unwrap();

        let work_page = db.create_page("Q1 Goals", None, false, None, "user").unwrap();
        db.move_page_to_folder(&work_page.id, Some(&work.id), "user").unwrap();
        db.create_block(&work_page.id, "Hit targets", None, None, "user").unwrap();

        let proj_page = db.create_page("Alpha", None, false, None, "user").unwrap();
        db.move_page_to_folder(&proj_page.id, Some(&projects.id), "user").unwrap();
        db.create_block(&proj_page.id, "Project Alpha notes", None, None, "user").unwrap();

        let dir = temp_dir();
        let exported = db.export_markdown(dir.path()).unwrap();
        assert_eq!(exported.len(), 3);

        // Verify filesystem structure
        assert!(dir.path().join("README.md").exists(), "Root page should be at root");
        assert!(dir.path().join("Work").is_dir(), "Work folder should exist");
        assert!(dir.path().join("Work/Q1 Goals.md").exists(), "Q1 Goals should be in Work/");
        assert!(dir.path().join("Work/Projects").is_dir(), "Projects subfolder should exist");
        assert!(dir.path().join("Work/Projects/Alpha.md").exists(), "Alpha should be in Work/Projects/");
    }

    // #2: whiteboards in exports. Markdown keeps the `{{whiteboard:<id>}}` block
    // and writes `.minotes-whiteboards/<id>.json`, which import reads back; HTML
    // publishing links a `whiteboards/<id>.json`; JSON export embeds the boards.
    #[test]
    fn test_whiteboard_in_markdown_html_and_json_export() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Sketch", None, false, None, "user").unwrap();
        db.create_block(&page.id, "{{whiteboard:wb-1}}", None, None, "user").unwrap();
        db.create_block(&page.id, "{{whiteboard:never-saved}}", None, None, "user").unwrap();
        db.save_whiteboard("wb-1", r#"{"strokes":[[1,2]]}"#).unwrap();

        let dir = temp_dir();
        db.export_markdown(dir.path()).unwrap();
        let md = fs::read_to_string(dir.path().join("Sketch.md")).unwrap();
        assert!(md.contains("{{whiteboard:wb-1}}"));
        let side: WhiteboardFile = serde_json::from_str(
            &fs::read_to_string(dir.path().join(WHITEBOARD_DIR).join("wb-1.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(side.data, r#"{"strokes":[[1,2]]}"#);
        assert!(!dir.path().join(WHITEBOARD_DIR).join("never-saved.json").exists());

        let db2 = Database::open_in_memory().unwrap();
        db2.import_markdown_dir(dir.path(), "user").unwrap();
        assert_eq!(db2.get_whiteboard("wb-1").unwrap().unwrap().data, r#"{"strokes":[[1,2]]}"#);

        let site = temp_dir();
        let published = db.publish_static_site(site.path()).unwrap();
        assert!(published.contains(&"whiteboards/wb-1.json".to_string()), "{published:?}");
        let html = fs::read_to_string(site.path().join("Sketch.html")).unwrap();
        assert!(html.contains("href=\"whiteboards/wb-1.json\""), "{html}");
        assert!(html.contains("Whiteboard (empty)"));
        assert_eq!(
            fs::read_to_string(site.path().join("whiteboards/wb-1.json")).unwrap(),
            r#"{"strokes":[[1,2]]}"#
        );

        let json = db.export_json().unwrap();
        let boards = json["whiteboards"].as_array().unwrap();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0]["id"], "wb-1");
        assert_eq!(boards[0]["data"], r#"{"strokes":[[1,2]]}"#);
    }
}
