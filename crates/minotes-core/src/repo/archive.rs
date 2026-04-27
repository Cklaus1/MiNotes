use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Page;

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveItem {
    pub id: String,
    pub title: String,
    pub item_type: String, // "page" or "folder"
    pub page_count: u32,
    pub archived_at: String,
}

impl Database {
    pub fn archive_page(&self, page_id: &Uuid) -> Result<()> {
        let now = Utc::now();
        let _ = self.remove_favorite(page_id);
        self.conn.execute(
            "INSERT OR IGNORE INTO archive (page_id, archived_at) VALUES (?1, ?2)",
            rusqlite::params![page_id.to_string(), now.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn unarchive_page(&self, page_id: &Uuid) -> Result<()> {
        self.conn.execute(
            "DELETE FROM archive WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
        )?;
        Ok(())
    }

    pub fn archive_folder(&self, folder_id: &Uuid) -> Result<u32> {
        let now = Utc::now();
        let pages = self.get_pages_in_folder(Some(folder_id))?;
        for page in &pages {
            let _ = self.remove_favorite(&page.id);
            self.conn.execute(
                "INSERT OR IGNORE INTO archive (page_id, archived_at) VALUES (?1, ?2)",
                rusqlite::params![page.id.to_string(), now.to_rfc3339()],
            )?;
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO folder_archive (folder_id, archived_at) VALUES (?1, ?2)",
            rusqlite::params![folder_id.to_string(), now.to_rfc3339()],
        )?;
        Ok(pages.len() as u32)
    }

    pub fn unarchive_folder(&self, folder_id: &Uuid) -> Result<()> {
        self.conn.execute(
            "DELETE FROM folder_archive WHERE folder_id = ?1",
            rusqlite::params![folder_id.to_string()],
        )?;
        self.conn.execute(
            "DELETE FROM archive WHERE page_id IN (SELECT id FROM pages WHERE folder_id = ?1)",
            rusqlite::params![folder_id.to_string()],
        )?;
        Ok(())
    }

    /// List all archived items as a flat recovery list (folders + standalone pages).
    pub fn list_archived_items(&self) -> Result<Vec<ArchiveItem>> {
        let mut items = Vec::new();

        // Archived folders
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.name, fa.archived_at
             FROM folder_archive fa
             JOIN folders f ON f.id = fa.folder_id
             ORDER BY fa.archived_at DESC",
        )?;
        let folder_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let archived_at: String = row.get(2)?;
            Ok((id, name, archived_at))
        })?;
        for row in folder_rows {
            let (id, name, archived_at) = row.map_err(Error::Database)?;
            let count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM pages WHERE folder_id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )?;
            items.push(ArchiveItem {
                id,
                title: name,
                item_type: "folder".to_string(),
                page_count: count as u32,
                archived_at,
            });
        }

        // Archived standalone pages (not in an archived folder)
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.title, a.archived_at
             FROM archive a
             JOIN pages p ON p.id = a.page_id
             WHERE p.folder_id IS NULL
                OR p.folder_id NOT IN (SELECT folder_id FROM folder_archive)
             ORDER BY a.archived_at DESC",
        )?;
        let page_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let archived_at: String = row.get(2)?;
            Ok((id, title, archived_at))
        })?;
        for row in page_rows {
            let (id, title, archived_at) = row.map_err(Error::Database)?;
            items.push(ArchiveItem {
                id,
                title,
                item_type: "page".to_string(),
                page_count: 0,
                archived_at,
            });
        }

        items.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
        Ok(items)
    }

    pub fn archived_count(&self) -> Result<u32> {
        let folders: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM folder_archive", [], |row| row.get(0),
        )?;
        let pages: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM archive a JOIN pages p ON p.id = a.page_id WHERE p.folder_id IS NULL OR p.folder_id NOT IN (SELECT folder_id FROM folder_archive)",
            [], |row| row.get(0),
        )?;
        Ok((folders + pages) as u32)
    }
}
