use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Block;

impl Database {
    /// Full-text search over blocks using SQLite FTS5.
    pub fn search(&self, query: &str, limit: Option<i64>) -> Result<Vec<Block>> {
        let limit = limit.unwrap_or(20);
        let mut stmt = self.conn.prepare(
            "SELECT b.id, b.page_id, b.parent_id, b.position, b.content, b.format, b.collapsed, b.created_at, b.updated_at
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             WHERE blocks_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![query, limit], |row| {
            row_to_block(row)
        })?;
        let mut blocks = Vec::new();
        for row in rows {
            blocks.push(row.map_err(Error::Database)?);
        }
        Ok(blocks)
    }
}

fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<Block> {
    use chrono::Utc;
    use uuid::Uuid;

    let id_str: String = row.get(0)?;
    let page_id_str: String = row.get(1)?;
    let parent_id_str: Option<String> = row.get(2)?;
    let created_str: String = row.get(7)?;
    let updated_str: String = row.get(8)?;

    Ok(Block {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        page_id: Uuid::parse_str(&page_id_str).unwrap_or_default(),
        parent_id: parent_id_str.and_then(|s| Uuid::parse_str(&s).ok()),
        position: row.get(3)?,
        content: row.get(4)?,
        format: row.get(5)?,
        collapsed: row.get::<_, i32>(6)? != 0,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_fts_search() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "The quick brown fox", None, None, "user").unwrap();
        db.create_block(&page.id, "Lazy dog sleeping", None, None, "user").unwrap();

        let results = db.search("quick brown", None).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("quick"));
    }

    #[test]
    fn test_fts_no_results() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "Hello world", None, None, "user").unwrap();

        let results = db.search("nonexistent", None).unwrap();
        assert!(results.is_empty());
    }
}
