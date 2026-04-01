use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Page;

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

    pub fn list_archived(&self) -> Result<Vec<Page>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.title, p.icon, p.folder_id, p.position, p.is_journal, p.journal_date, p.created_at, p.updated_at
             FROM archive a
             JOIN pages p ON p.id = a.page_id
             ORDER BY a.archived_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            crate::repo::pages::row_to_page_sqlite(row)
        })?;
        let mut pages = Vec::new();
        for row in rows {
            pages.push(row.map_err(Error::Database)?);
        }
        Ok(pages)
    }

    pub fn archived_count(&self) -> Result<u32> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM archive",
            [],
            |row| row.get(0),
        )?;
        Ok(count as u32)
    }
}
