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

        // Restore folder
        self.conn.execute(
            "DELETE FROM folder_trash WHERE folder_id = ?1",
            rusqlite::params![folder_id.to_string()],
        )?;
        // Restore all pages in this folder
        self.conn.execute(
            "DELETE FROM trash WHERE page_id IN (SELECT id FROM pages WHERE folder_id = ?1)",
            rusqlite::params![folder_id.to_string()],
        )?;
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
        // Delete all trashed pages in this folder
        let pages = self.get_folder_pages_including_trash(folder_id)?;
        for page in &pages {
            self.conn.execute(
                "DELETE FROM trash WHERE page_id = ?1",
                rusqlite::params![page.id.to_string()],
            )?;
            self.delete_page(&page.id, actor)?;
        }
        // Remove folder from trash and delete it
        self.conn.execute(
            "DELETE FROM folder_trash WHERE folder_id = ?1",
            rusqlite::params![folder_id.to_string()],
        )?;
        self.delete_folder(&folder_id, actor)?;
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
