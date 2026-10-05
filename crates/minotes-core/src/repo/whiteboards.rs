//! Whiteboard storage.
//!
//! Each whiteboard block has content `{{whiteboard:<id>}}`; its drawing data
//! (strokes, notes, images, ...) is stored here as an opaque JSON string keyed
//! by that id. Previously this lived only in the webview's localStorage.

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::db::Database;
use crate::error::{Error, Result};

const WHITEBOARDS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS whiteboards (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

/// A stored whiteboard.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Whiteboard {
    pub id: String,
    pub data: String,
    pub updated_at: String,
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::InvalidInput(format!("invalid whiteboard id: {id:?}")));
    }
    Ok(())
}

impl Database {
    /// Idempotent migration: create the whiteboards table if missing.
    pub fn migrate_whiteboards(&self) -> Result<()> {
        self.conn.execute_batch(WHITEBOARDS_SCHEMA)?;
        Ok(())
    }

    /// Fetch a whiteboard by id. Returns `None` if it has never been saved.
    pub fn get_whiteboard(&self, id: &str) -> Result<Option<Whiteboard>> {
        validate_id(id)?;
        let wb = self
            .conn
            .query_row(
                "SELECT id, data, updated_at FROM whiteboards WHERE id = ?1",
                [id],
                |row| {
                    Ok(Whiteboard {
                        id: row.get(0)?,
                        data: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(wb)
    }

    /// Insert or replace a whiteboard's data. `data` must be valid JSON.
    pub fn save_whiteboard(&self, id: &str, data: &str) -> Result<Whiteboard> {
        validate_id(id)?;
        serde_json::from_str::<serde_json::Value>(data)?;
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO whiteboards (id, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            rusqlite::params![id, data, now],
        )?;
        Ok(Whiteboard {
            id: id.to_string(),
            data: data.to_string(),
            updated_at: now,
        })
    }

    /// Delete a whiteboard. Returns true if a row was removed.
    pub fn delete_whiteboard(&self, id: &str) -> Result<bool> {
        validate_id(id)?;
        let n = self
            .conn
            .execute("DELETE FROM whiteboards WHERE id = ?1", [id])?;
        Ok(n > 0)
    }

    /// List all stored whiteboard ids.
    pub fn list_whiteboard_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM whiteboards ORDER BY id")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_get_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_whiteboard("wb-1").unwrap().is_none());
        db.save_whiteboard("wb-1", r#"{"strokes":[]}"#).unwrap();
        let wb = db.get_whiteboard("wb-1").unwrap().unwrap();
        assert_eq!(wb.data, r#"{"strokes":[]}"#);
        db.save_whiteboard("wb-1", r#"{"strokes":[1]}"#).unwrap();
        assert_eq!(
            db.get_whiteboard("wb-1").unwrap().unwrap().data,
            r#"{"strokes":[1]}"#
        );
        assert_eq!(db.list_whiteboard_ids().unwrap(), vec!["wb-1".to_string()]);
    }

    #[test]
    fn rejects_invalid_json_and_ids() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.save_whiteboard("wb-1", "not json").is_err());
        assert!(db.save_whiteboard("", "{}").is_err());
        assert!(db.save_whiteboard("a b", "{}").is_err());
        assert!(db.get_whiteboard("../x").is_err());
    }

    #[test]
    fn delete_and_idempotent_migration() {
        let db = Database::open_in_memory().unwrap();
        db.migrate_whiteboards().unwrap();
        db.migrate_whiteboards().unwrap();
        db.save_whiteboard("abc_1", "{}").unwrap();
        assert!(db.delete_whiteboard("abc_1").unwrap());
        assert!(!db.delete_whiteboard("abc_1").unwrap());
    }
}
