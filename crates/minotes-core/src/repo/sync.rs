use std::fs;
use std::path::Path;

use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};

/// Result of a sync-dir operation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncResult {
    pub folders_created: Vec<String>,
    pub folders_existing: usize,
    pub pages_created: Vec<String>,
    pub pages_updated: Vec<String>,
    pub pages_unchanged: usize,
    pub pages_deleted: Vec<String>,
    pub blocks_created: usize,
    pub blocks_updated: usize,
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
        let mut result = SyncResult {
            folders_created: Vec::new(),
            folders_existing: 0,
            pages_created: Vec::new(),
            pages_updated: Vec::new(),
            pages_unchanged: 0,
            pages_deleted: Vec::new(),
            blocks_created: 0,
            blocks_updated: 0,
        };

        if !dir.exists() {
            fs::create_dir_all(dir)
                .map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", dir.display())))?;
        }
        if !dir.is_dir() {
            return Err(Error::InvalidInput(format!("Not a directory: {}", dir.display())));
        }

        // Phase 1: Filesystem → DB (import new/changed files)
        let mut seen_page_ids: Vec<Uuid> = Vec::new();
        self.sync_dir_recursive(dir, dir, None, actor, &mut result, &mut seen_page_ids)?;

        // Phase 2: Detect deleted files (pages in DB whose source file is gone)
        if delete_missing {
            self.detect_deleted_pages(dir, &seen_page_ids, actor, &mut result)?;
        }

        // Phase 3: DB → Filesystem (write back changes)
        if write_back {
            self.write_back_to_dir(dir)?;
        }

        Ok(result)
    }

    fn sync_dir_recursive(
        &self,
        root: &Path,
        current: &Path,
        parent_folder_id: Option<&Uuid>,
        actor: &str,
        result: &mut SyncResult,
        seen_page_ids: &mut Vec<Uuid>,
    ) -> Result<()> {
        let mut entries: Vec<_> = fs::read_dir(current)
            .map_err(|e| Error::InvalidInput(format!("Cannot read {}: {e}", current.display())))?
            .filter_map(|e| e.ok())
            .collect();
        entries.sort_by_key(|e| e.file_name());

        // Process subdirectories as folders
        for entry in &entries {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden directories
            if name.starts_with('.') {
                continue;
            }

            // Find or create folder
            let folder_id = self.find_or_create_folder(&name, parent_folder_id, actor, result)?;
            self.sync_dir_recursive(root, &path, Some(&folder_id), actor, result, seen_page_ids)?;
        }

        // Process .md files as pages
        for entry in &entries {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }

            let title = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();

            let file_content = fs::read_to_string(&path)
                .map_err(|e| Error::InvalidInput(format!("Read failed: {e}")))?;

            let file_modified = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok();

            self.sync_page(
                &title,
                &file_content,
                parent_folder_id,
                file_modified,
                actor,
                result,
                seen_page_ids,
            )?;
        }

        Ok(())
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

    fn sync_page(
        &self,
        title: &str,
        file_content: &str,
        folder_id: Option<&Uuid>,
        _file_modified: Option<std::time::SystemTime>,
        actor: &str,
        result: &mut SyncResult,
        seen_page_ids: &mut Vec<Uuid>,
    ) -> Result<()> {
        let lines = strip_frontmatter(file_content);
        let new_blocks = parse_markdown_blocks(&lines);

        // Bug #3: resolve the page by its stable UUID (from frontmatter) first, so
        // distinct pages that happen to share a title are never conflated, and a
        // renamed page is matched to its real row. Fall back to title for files that
        // predate id frontmatter.
        let fm_id = parse_frontmatter_id(file_content);
        let existing = match fm_id {
            Some(id) => match self.get_page(&id)? {
                Some(p) => Some(p),
                None => self.get_page_by_title(title)?,
            },
            None => self.get_page_by_title(title)?,
        };

        if let Some(existing) = existing {
            seen_page_ids.push(existing.id);

            // Reconcile title (a rename on another device).
            if existing.title != title {
                let _ = self.rename_page(&existing.id, title, actor);
            }
            // Ensure page is in the right folder
            if existing.folder_id.as_ref() != folder_id {
                self.move_page_to_folder(&existing.id, folder_id, actor)?;
            }

            // Bug #1 + #9: reconcile blocks BY ID instead of delete-all-then-recreate,
            // which destroyed block identity (cards/links/refs) and could never delete.
            let changed = self.reconcile_page_blocks(&existing.id, &new_blocks, actor, result)?;
            if changed {
                let now = Utc::now();
                self.conn.execute(
                    "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![now.to_rfc3339(), existing.id.to_string()],
                )?;
                result.pages_updated.push(title.to_string());
            } else {
                result.pages_unchanged += 1;
            }
        } else {
            // Create the page, preserving its UUID if the file carried one (Bug #3).
            let page = match fm_id {
                Some(id) => self.create_page_with_id(id, title, None, false, None, actor)?,
                None => self.create_page(title, None, false, None, actor)?,
            };
            seen_page_ids.push(page.id);

            if let Some(fid) = folder_id {
                self.move_page_to_folder(&page.id, Some(fid), actor)?;
            }

            self.create_blocks_with_hierarchy(&page.id, &new_blocks, actor, result)?;

            result.pages_created.push(title.to_string());
        }

        Ok(())
    }

    /// Reconcile a page's blocks against parsed markdown by stable id (Bug #1, #9).
    /// Returns true if anything changed. Blocks present in the file are upserted
    /// (preserving identity); blocks absent from the file are deleted (true delete
    /// propagation). Blocks without an id marker are treated as new.
    fn reconcile_page_blocks(
        &self,
        page_id: &Uuid,
        parsed: &[ParsedBlock],
        actor: &str,
        result: &mut SyncResult,
    ) -> Result<bool> {
        use std::collections::{HashMap, HashSet};
        let existing_blocks = self.get_page_blocks(page_id)?;
        let existing_by_id: HashMap<Uuid, &crate::models::Block> =
            existing_blocks.iter().map(|b| (b.id, b)).collect();

        // For markerless blocks (legacy files, or files authored outside MiNotes),
        // fall back to matching by content against not-yet-claimed existing blocks so
        // that identity — and idempotency — is preserved without an id marker.
        let mut content_pool: HashMap<&str, Vec<Uuid>> = HashMap::new();
        for b in &existing_blocks {
            content_pool.entry(b.content.as_str()).or_default().push(b.id);
        }
        let mut claimed: HashSet<Uuid> = HashSet::new();

        // Resolve each parsed block to a concrete id (reuse marker id, else match by
        // content, else mint one), and compute parent ids from the indent stack.
        // Positions are assigned per-parent (1.0, 2.0, …) to match create_block's
        // scheme, so an unchanged tree re-syncs as unchanged (idempotency).
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
                Some(id) => id, // stable marker id (existing or new)
                None => {
                    // Reuse an existing block with identical content, if any remain.
                    let reuse = content_pool
                        .get_mut(pb.content.as_str())
                        .and_then(|ids| ids.iter().position(|i| !claimed.contains(i)).map(|p| ids[p]));
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

        // Delete blocks that no longer appear in the file (true deletion — Bug #9).
        for b in &existing_blocks {
            if !seen_ids.contains(&b.id) {
                self.delete_block(&b.id, actor)?;
                changed = true;
            }
        }

        // Upsert desired blocks in order, preserving identity.
        for (id, parent, position, pb) in &desired {
            match existing_by_id.get(id) {
                Some(prev) => {
                    let structural = prev.parent_id != *parent
                        || (prev.position - *position).abs() > f64::EPSILON;
                    let content_changed = prev.content != pb.content;
                    if structural {
                        let now = Utc::now();
                        self.conn.execute(
                            "UPDATE blocks SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
                            rusqlite::params![
                                parent.map(|p| p.to_string()),
                                position,
                                now.to_rfc3339(),
                                id.to_string(),
                            ],
                        )?;
                    }
                    if content_changed {
                        // update_block keeps links/FTS in sync with the new content.
                        self.update_block(id, Some(&pb.content), actor)?;
                    }
                    if structural || content_changed {
                        result.blocks_updated += 1;
                        changed = true;
                    }
                }
                None => {
                    self.create_block_with_id(*id, page_id, &pb.content, parent.as_ref(), Some(*position), actor)?;
                    result.blocks_created += 1;
                    changed = true;
                }
            }
        }

        Ok(changed)
    }

    /// Create blocks with parent_id derived from the parsed indent depth.
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

    fn detect_deleted_pages(
        &self,
        _dir: &Path,
        seen_page_ids: &[Uuid],
        actor: &str,
        result: &mut SyncResult,
    ) -> Result<()> {
        let all_pages = self.list_pages(Some(10000))?;
        let non_journal: Vec<_> = all_pages.iter().filter(|p| !p.is_journal).collect();

        // Bug #11: guard against a transiently-empty/partial working tree (e.g. a bad
        // git checkout or interrupted pull). If the import saw NO files but the DB has
        // pages, deleting "missing" pages would wipe the entire database. Refuse to
        // delete-all in that case.
        if seen_page_ids.is_empty() && !non_journal.is_empty() {
            return Ok(());
        }

        for page in non_journal {
            if !seen_page_ids.contains(&page.id) {
                result.pages_deleted.push(page.title.clone());
                // Bug #11: route sync deletions to trash (soft delete), not a hard
                // delete, so an erroneous removal is recoverable.
                self.trash_page(&page.id)?;
            }
        }
        Ok(())
    }

    fn write_back_to_dir(&self, dir: &Path) -> Result<()> {
        // Use the existing folder-aware export
        self.export_markdown(dir)?;
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

/// Parse markdown lines into blocks, preserving indent-based hierarchy.
/// A line indented with 2 spaces (or one tab) per level becomes a nested block.
/// Continuation lines (deeper indent prefixed with `\ `, written by the exporter
/// for multi-line block content — Bug #13) are folded back into the preceding block
/// instead of becoming separate blocks.
pub(crate) fn parse_markdown_blocks(lines: &[&str]) -> Vec<ParsedBlock> {
    let mut out: Vec<ParsedBlock> = Vec::new();
    for raw in lines {
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
        let (content, id) = split_id_marker(bullet_body);
        if content.is_empty() && id.is_none() {
            continue;
        }
        out.push(ParsedBlock { depth, content, id });
    }
    out
}

fn strip_frontmatter(content: &str) -> Vec<&str> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) == Some("---") {
        if let Some(end) = lines[1..].iter().position(|l| l.trim() == "---") {
            return lines[end + 2..].to_vec();
        }
    }
    lines
}

/// Parse the `id: UUID` field from a page's YAML frontmatter, if present (Bug #3).
/// Used by sync/import to reconcile pages by stable identity rather than by title.
pub(crate) fn parse_frontmatter_id(content: &str) -> Option<Uuid> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return None;
    }
    let end = lines[1..].iter().position(|l| l.trim() == "---")?;
    for line in &lines[1..=end] {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("id:") {
            if let Ok(id) = Uuid::parse_str(rest.trim()) {
                return Some(id);
            }
        }
    }
    None
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
}
