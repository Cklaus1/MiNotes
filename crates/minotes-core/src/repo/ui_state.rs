//! Small key → JSON-text store for UI state that names content (e.g. the recent
//! pages list). Encrypted notebooks keep it here, inside the encrypted database,
//! instead of in webview storage (PRD-encryption §4.5).

use chrono::Utc;
use rusqlite::OptionalExtension;

use crate::db::Database;
use crate::error::{Error, Result};

/// Keys are short identifiers; values are capped (this is UI state, not notes).
const MAX_KEY: usize = 100;
const MAX_VALUE: usize = 256 * 1024;

fn check_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > MAX_KEY || !key.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c)) {
        return Err(Error::InvalidInput(format!("Invalid UI state key '{key}'")));
    }
    Ok(())
}

impl Database {
    pub fn get_ui_state(&self, key: &str) -> Result<Option<String>> {
        check_key(key)?;
        Ok(self
            .conn
            .query_row("SELECT value FROM ui_state WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_ui_state(&self, key: &str, value: &str) -> Result<()> {
        check_key(key)?;
        if value.len() > MAX_VALUE {
            return Err(Error::InvalidInput("UI state value too large".into()));
        }
        self.conn.execute(
            "INSERT INTO ui_state (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![key, value, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn ui_state_round_trip_and_key_rules() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.get_ui_state("recent-pages").unwrap(), None);
        db.set_ui_state("recent-pages", "[1]").unwrap();
        db.set_ui_state("recent-pages", "[1,2]").unwrap();
        assert_eq!(db.get_ui_state("recent-pages").unwrap().as_deref(), Some("[1,2]"));
        assert!(db.set_ui_state("bad key/../", "x").is_err());
        assert!(db.set_ui_state("big", &"x".repeat(300 * 1024)).is_err());
    }
}
