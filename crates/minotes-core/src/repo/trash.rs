use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Page;

/// A trash item — either a page or a folder (with page count).
#[derive(Debug, Clone, Serialize)]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub item_type: String, // "page" or "folder"
    pub page_count: u32,   // for folders: how many pages inside
    pub deleted_at: String,
}

impl Database {
    /// Move a page to trash (soft delete).
    pub fn trash_page(&self, page_id: &Uuid) -> Result<()> {
        let now = Utc::now();
        let _ = self.remove_favorite(page_id);
        self.conn.execute(
            "INSERT OR IGNORE INTO trash (page_id, deleted_at) VALUES (?1, ?2)",
            rusqlite::params![page_id.to_string(), now.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Trash a folder and all its pages.
    pub fn trash_folder(&self, folder_id: &Uuid) -> Result<u32> {
        let now = Utc::now();
        // Trash all pages in this folder
        let pages = self.get_pages_in_folder(Some(folder_id))?;
        for page in &pages {
            let _ = self.remove_favorite(&page.id);
            self.conn.execute(
                "INSERT OR IGNORE INTO trash (page_id, deleted_at) VALUES (?1, ?2)",
                rusqlite::params![page.id.to_string(), now.to_rfc3339()],
            )?;
        }
        // Mark folder as trashed
        self.conn.execute(
            "INSERT OR IGNORE INTO folder_trash (folder_id, deleted_at) VALUES (?1, ?2)",
            rusqlite::params![folder_id.to_string(), now.to_rfc3339()],
        )?;
        Ok(pages.len() as u32)
    }

    /// Restore a page from trash.
    pub fn restore_page(&self, page_id: &Uuid) -> Result<()> {
        let count = self.conn.execute(
            "DELETE FROM trash WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound("Page not in trash".to_string()));
        }
        Ok(())
    }

    /// Restore a folder and all its pages from trash.
    /// Also restores nested subfolders and their pages using BFS to avoid recursion limits.
    pub fn restore_folder(&self, folder_id: &Uuid) -> Result<()> {
        // Check for name conflict
        let folder_name: String = self.conn.query_row(
            "SELECT name FROM folders WHERE id = ?1",
            rusqlite::params![folder_id.to_string()],
            |row| row.get(0),
        ).map_err(|_| Error::NotFound("Folder not found".to_string()))?;

        // Check if another folder with this name exists (not trashed)
        let conflict: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM folders WHERE name = ?1 AND id != ?2 AND id NOT IN (SELECT folder_id FROM folder_trash)",
            rusqlite::params![folder_name, folder_id.to_string()],
            |row| row.get(0),
        )?;
        if conflict > 0 {
            // Rename to avoid conflict
            let new_name = format!("{} (restored)", folder_name);
            self.conn.execute(
                "UPDATE folders SET name = ?1 WHERE id = ?2",
                rusqlite::params![new_name, folder_id.to_string()],
            )?;
        }

        // BFS queue for nested subfolders
        let mut queue: Vec<Uuid> = vec![*folder_id];
        let mut visited = std::collections::HashSet::new();
        visited.insert(*folder_id);

        while let Some(current_id) = queue.pop() {
            // Restore this folder
            self.conn.execute(
                "DELETE FROM folder_trash WHERE folder_id = ?1",
                rusqlite::params![current_id.to_string()],
            )?;
            // Restore all pages in this folder (any depth)
            self.conn.execute(
                "DELETE FROM trash WHERE page_id IN (SELECT id FROM pages WHERE folder_id = ?1)",
                rusqlite::params![current_id.to_string()],
            )?;
            // Enqueue child folders
            let mut stmt = self.conn.prepare(
                "SELECT id FROM folders WHERE parent_id = ?1",
            )?;
            let rows = stmt.query_map(
                rusqlite::params![current_id.to_string()],
                |row| {
                    let id_str: String = row.get(0)?;
                    Ok(id_str)
                },
            )?;
            let mut child_folders: Vec<Uuid> = Vec::new();
            for row in rows {
                let id_str = row.map_err(Error::Database)?;
                if let Ok(uuid) = Uuid::parse_str(&id_str) {
                    child_folders.push(uuid);
                }
            }
            for child in child_folders {
                if visited.insert(child) {
                    queue.push(child);
                }
            }
        }

        Ok(())
    }

    /// Permanently delete a page (from trash).
    pub fn permanently_delete_page(&self, page_id: &Uuid, actor: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM trash WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
        )?;
        self.delete_page(page_id, actor)?;
        Ok(())
    }

    /// Permanently delete a folder and its pages.
    pub fn permanently_delete_folder(&self, folder_id: &Uuid, actor: &str) -> Result<()> {
        // Bug #30: walk the ENTIRE subtree (subfolders too), not just direct children.
        // `pages.folder_id ON DELETE SET NULL` means subfolder pages would otherwise
        // survive as orphaned root pages — data the user believed they purged.
        // Collect all descendant folder ids (including this one) via BFS.
        let mut all_folders: Vec<Uuid> = Vec::new();
        let mut queue: Vec<Uuid> = vec![*folder_id];
        let mut visited = std::collections::HashSet::new();
        visited.insert(*folder_id);
        while let Some(current) = queue.pop() {
            all_folders.push(current);
            let mut stmt = self.conn.prepare("SELECT id FROM folders WHERE parent_id = ?1")?;
            let children: Vec<Uuid> = stmt
                .query_map(rusqlite::params![current.to_string()], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .filter_map(|s| Uuid::parse_str(&s).ok())
                .collect();
            for child in children {
                if visited.insert(child) {
                    queue.push(child);
                }
            }
        }

        // Delete every page in every descendant folder (including trashed ones).
        for fid in &all_folders {
            let pages = self.get_folder_pages_including_trash(fid)?;
            for page in &pages {
                self.conn.execute(
                    "DELETE FROM trash WHERE page_id = ?1",
                    rusqlite::params![page.id.to_string()],
                )?;
                self.delete_page(&page.id, actor)?;
            }
        }

        // Remove folders from trash, then delete them. Delete deepest-first (BFS
        // discovery order reversed) so child rows go before parents.
        for fid in all_folders.iter().rev() {
            self.conn.execute(
                "DELETE FROM folder_trash WHERE folder_id = ?1",
                rusqlite::params![fid.to_string()],
            )?;
        }
        // Deleting the root folder cascades to subfolders via FK, but we've already
        // emptied them; delete explicitly to fire events and be order-independent.
        self.delete_folder(folder_id, actor)?;
        Ok(())
    }

    /// List all trash items (pages + folders) as a flat recovery list.
    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        let mut items = Vec::new();

        // Trashed folders
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.name, ft.deleted_at
             FROM folder_trash ft
             JOIN folders f ON f.id = ft.folder_id
             ORDER BY ft.deleted_at DESC",
        )?;
        let folder_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let deleted_at: String = row.get(2)?;
            Ok((id, name, deleted_at))
        })?;
        for row in folder_rows {
            let (id, name, deleted_at) = row.map_err(Error::Database)?;
            // Count pages in this trashed folder
            let count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM trash t JOIN pages p ON p.id = t.page_id WHERE p.folder_id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )?;
            items.push(TrashItem {
                id,
                title: name,
                item_type: "folder".to_string(),
                page_count: count as u32,
                deleted_at,
            });
        }

        // Trashed pages (not in a trashed folder)
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.title, t.deleted_at
             FROM trash t
             JOIN pages p ON p.id = t.page_id
             WHERE p.folder_id IS NULL
                OR p.folder_id NOT IN (SELECT folder_id FROM folder_trash)
             ORDER BY t.deleted_at DESC",
        )?;
        let page_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let deleted_at: String = row.get(2)?;
            Ok((id, title, deleted_at))
        })?;
        for row in page_rows {
            let (id, title, deleted_at) = row.map_err(Error::Database)?;
            items.push(TrashItem {
                id,
                title,
                item_type: "page".to_string(),
                page_count: 0,
                deleted_at,
            });
        }

        // Sort all by deleted_at descending
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(items)
    }

    /// Empty the entire trash.
    pub fn empty_trash(&self, actor: &str) -> Result<u32> {
        let items = self.list_trash()?;
        let count = items.len() as u32;
        // Delete folders first (they cascade to pages)
        for item in &items {
            if item.item_type == "folder" {
                let uuid = Uuid::parse_str(&item.id).unwrap_or_default();
                let _ = self.permanently_delete_folder(&uuid, actor);
            }
        }
        // Delete remaining pages
        for item in &items {
            if item.item_type == "page" {
                let uuid = Uuid::parse_str(&item.id).unwrap_or_default();
                let _ = self.permanently_delete_page(&uuid, actor);
            }
        }
        Ok(count)
    }

    /// Check if a page is in the trash.
    pub fn is_trashed(&self, page_id: &Uuid) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM trash WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // Helper: get pages in folder including trashed ones (for permanent delete)
    fn get_folder_pages_including_trash(&self, folder_id: &Uuid) -> Result<Vec<Page>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, icon, folder_id, position, is_journal, journal_date, created_at, updated_at
             FROM pages WHERE folder_id = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![folder_id.to_string()], |row| {
            crate::repo::pages::row_to_page_sqlite(row)
        })?;
        let mut pages = Vec::new();
        for row in rows {
            pages.push(row.map_err(Error::Database)?);
        }
        Ok(pages)
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    // Bug #30: permanently deleting a folder must purge pages in NESTED subfolders,
    // not orphan them to root.
    #[test]
    fn test_permanently_delete_folder_recurses_subfolders() {
        let db = Database::open_in_memory().unwrap();
        let parent = db.create_folder("Parent", None, None, None, "user").unwrap();
        let child = db.create_folder("Child", Some(&parent.id), None, None, "user").unwrap();

        let p_root = db.create_page("RootPage", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p_root.id, Some(&parent.id), "user").unwrap();
        let p_nested = db.create_page("NestedPage", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p_nested.id, Some(&child.id), "user").unwrap();

        db.trash_folder(&parent.id).unwrap();
        db.permanently_delete_folder(&parent.id, "user").unwrap();

        // Both pages gone; neither orphaned to root.
        assert!(db.get_page(&p_root.id).unwrap().is_none());
        assert!(db.get_page(&p_nested.id).unwrap().is_none(), "nested page must be purged, not orphaned");
        let roots = db.list_pages(Some(100)).unwrap();
        assert!(roots.iter().all(|p| p.id != p_nested.id && p.id != p_root.id));
    }
}
