use std::collections::HashMap;
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
        let new_blocks: Vec<&str> = lines
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| {
                l.strip_prefix("- ")
                    .or_else(|| l.strip_prefix("* "))
                    .or_else(|| l.strip_prefix("+ "))
                    .unwrap_or(l)
            })
            .filter(|l| !l.is_empty())
            .collect();

        if let Some(existing) = self.get_page_by_title(title)? {
            seen_page_ids.push(existing.id);

            // Ensure page is in the right folder
            if existing.folder_id.as_ref() != folder_id {
                self.move_page_to_folder(&existing.id, folder_id, actor)?;
            }

            // Compare existing blocks with file content
            let existing_blocks = self.get_page_blocks(&existing.id)?;
            let existing_contents: Vec<&str> = existing_blocks.iter().map(|b| b.content.as_str()).collect();

            if existing_contents == new_blocks {
                result.pages_unchanged += 1;
                return Ok(());
            }

            // Content changed — delete old blocks and re-create
            for block in &existing_blocks {
                self.delete_block(&block.id, actor)?;
                result.blocks_updated += 1;
            }
            for content in &new_blocks {
                self.create_block(&existing.id, content, None, None, actor)?;
                result.blocks_created += 1;
            }

            // Touch updated_at
            let now = Utc::now();
            self.conn.execute(
                "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now.to_rfc3339(), existing.id.to_string()],
            )?;

            result.pages_updated.push(title.to_string());
        } else {
            // New page
            let page = self.create_page(title, None, false, None, actor)?;
            seen_page_ids.push(page.id);

            if let Some(fid) = folder_id {
                self.move_page_to_folder(&page.id, Some(fid), actor)?;
            }

            for content in &new_blocks {
                self.create_block(&page.id, content, None, None, actor)?;
                result.blocks_created += 1;
            }

            result.pages_created.push(title.to_string());
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
        for page in &all_pages {
            // Skip journals — they're not filesystem-synced
            if page.is_journal {
                continue;
            }
            if !seen_page_ids.contains(&page.id) {
                result.pages_deleted.push(page.title.clone());
                self.delete_page(&page.id, actor)?;
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

fn strip_frontmatter(content: &str) -> Vec<&str> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) == Some("---") {
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
        assert!(db.get_page_by_title("remove").unwrap().is_none());
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
