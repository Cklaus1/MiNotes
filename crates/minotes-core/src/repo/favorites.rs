use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Page;

impl Database {
    pub fn add_favorite(&self, page_id: &Uuid, _actor: &str) -> Result<()> {
        let now = Utc::now();
        let max_pos: Option<f64> = self.conn.query_row(
            "SELECT MAX(position) FROM favorites",
            [],
            |row| row.get(0),
        )?;
        let position = max_pos.unwrap_or(0.0) + 1.0;

        self.conn.execute(
            "INSERT OR IGNORE INTO favorites (page_id, position, created_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![page_id.to_string(), position, now.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn remove_favorite(&self, page_id: &Uuid) -> Result<bool> {
        let count = self.conn.execute(
            "DELETE FROM favorites WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
        )?;
        Ok(count > 0)
    }

    pub fn list_favorites(&self) -> Result<Vec<Page>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.title, p.icon, p.folder_id, f.position, p.is_journal, p.journal_date, p.created_at, p.updated_at
             FROM favorites f
             JOIN pages p ON p.id = f.page_id
             ORDER BY f.position",
        )?;
        let rows = stmt.query_map([], |row| {
            let id_str: String = row.get(0)?;
            let folder_str: Option<String> = row.get(3)?;
            let journal_date_str: Option<String> = row.get(6)?;
            let created_str: String = row.get(7)?;
            let updated_str: String = row.get(8)?;
            Ok(Page {
                id: Uuid::parse_str(&id_str).unwrap_or_default(),
                title: row.get(1)?,
                icon: row.get(2)?,
                folder_id: folder_str.and_then(|s| Uuid::parse_str(&s).ok()),
                position: row.get(4)?,
                is_journal: row.get::<_, i32>(5)? != 0,
                journal_date: journal_date_str
                    .and_then(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok()),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut pages = Vec::new();
        for row in rows {
            pages.push(row.map_err(Error::Database)?);
        }
        Ok(pages)
    }

    pub fn reorder_favorite(&self, page_id: &Uuid, new_position: f64) -> Result<()> {
        self.conn.execute(
            "UPDATE favorites SET position = ?1 WHERE page_id = ?2",
            rusqlite::params![new_position, page_id.to_string()],
        )?;
        Ok(())
    }

    pub fn is_favorite(&self, page_id: &Uuid) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM favorites WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }
}
