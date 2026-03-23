use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Page;

impl Database {
    /// Add an alias for a page.
    pub fn add_alias(&self, page_id: &Uuid, alias: &str, actor: &str) -> Result<()> {
        // Verify page exists
        self.get_page(page_id)?
            .ok_or_else(|| Error::NotFound(format!("Page {page_id}")))?;

        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO page_aliases (id, page_id, alias, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                id.to_string(),
                page_id.to_string(),
                alias,
                now.to_rfc3339(),
            ],
        ).map_err(|e| match e {
            rusqlite::Error::SqliteFailure(_, _) => {
                Error::AlreadyExists(format!("Alias '{alias}'"))
            }
            other => Error::Database(other),
        })?;

        self.emit_event(
            "alias.created",
            page_id,
            "alias",
            &serde_json::json!({ "alias": alias }),
            actor,
        )?;
        Ok(())
    }

    /// Remove an alias. Returns true if found and deleted.
    pub fn remove_alias(&self, alias: &str, actor: &str) -> Result<bool> {
        // Get page_id before deleting for event emission
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT page_id FROM page_aliases WHERE alias = ?1",
                rusqlite::params![alias],
                |row| row.get(0),
            )
            .ok();

        let count = self.conn.execute(
            "DELETE FROM page_aliases WHERE alias = ?1",
            rusqlite::params![alias],
        )?;

        if count > 0 {
            if let Some(pid) = page_id {
                if let Ok(uuid) = Uuid::parse_str(&pid) {
                    self.emit_event(
                        "alias.deleted",
                        &uuid,
                        "alias",
                        &serde_json::json!({ "alias": alias }),
                        actor,
                    )?;
                }
            }
        }

        Ok(count > 0)
    }

    /// Get all aliases for a page.
    pub fn get_aliases(&self, page_id: &Uuid) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY created_at")?;
        let rows = stmt.query_map(rusqlite::params![page_id.to_string()], |row| {
            row.get::<_, String>(0)
        })?;

        let mut aliases = Vec::new();
        for row in rows {
            aliases.push(row.map_err(Error::Database)?);
        }
        Ok(aliases)
    }

    /// Resolve an alias to a page. Checks aliases table first, then falls back to title.
    pub fn resolve_alias(&self, alias: &str) -> Result<Option<Page>> {
        // Check aliases table
        let page_id: Option<String> = self
            .conn
            .query_row(
                "SELECT page_id FROM page_aliases WHERE alias = ?1",
                rusqlite::params![alias],
                |row| row.get(0),
            )
            .ok();

        if let Some(pid) = page_id {
            if let Ok(uuid) = Uuid::parse_str(&pid) {
                return self.get_page(&uuid);
            }
        }

        // Fall back to title match
        self.get_page_by_title(alias)
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_add_and_get_aliases() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Test", None, false, None, "user").unwrap();
        db.add_alias(&page.id, "my-alias", "user").unwrap();
        db.add_alias(&page.id, "another", "user").unwrap();

        let aliases = db.get_aliases(&page.id).unwrap();
        assert_eq!(aliases.len(), 2);
        assert!(aliases.contains(&"my-alias".to_string()));
    }

    #[test]
    fn test_resolve_alias() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Test", None, false, None, "user").unwrap();
        db.add_alias(&page.id, "shortcut", "user").unwrap();

        let resolved = db.resolve_alias("shortcut").unwrap().unwrap();
        assert_eq!(resolved.id, page.id);

        // Also resolves by title
        let by_title = db.resolve_alias("Test").unwrap().unwrap();
        assert_eq!(by_title.id, page.id);
    }

    #[test]
    fn test_remove_alias() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Test", None, false, None, "user").unwrap();
        db.add_alias(&page.id, "rm-me", "user").unwrap();

        assert!(db.remove_alias("rm-me", "user").unwrap());
        assert!(!db.remove_alias("rm-me", "user").unwrap());
        assert_eq!(db.get_aliases(&page.id).unwrap().len(), 0);
    }

    #[test]
    fn test_duplicate_alias() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Test", None, false, None, "user").unwrap();
        db.add_alias(&page.id, "dup", "user").unwrap();
        assert!(db.add_alias(&page.id, "dup", "user").is_err());
    }
}
