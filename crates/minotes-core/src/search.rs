use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Block;

/// Escape a user query into a single FTS5 string literal so arbitrary punctuation
/// (`C++`, `foo:bar`, unbalanced `"`, leading `*`) is treated as literal text rather
/// than FTS5 query syntax (Bug #7). We wrap the whole input in double quotes and
/// double any embedded quotes, which FTS5 interprets as a phrase of bareword tokens.
fn escape_fts_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

impl Database {
    /// Full-text search over blocks using SQLite FTS5.
    ///
    /// Excludes blocks belonging to trashed or archived pages (Bug #6) — those are
    /// hidden from the user everywhere else, so they must not leak through search.
    pub fn search(&self, query: &str, limit: Option<i64>) -> Result<Vec<Block>> {
        let limit = limit.unwrap_or(20);
        // Treat an all-whitespace query as no results rather than an FTS error.
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let fts_query = escape_fts_query(query);
        let mut stmt = self.conn.prepare(
            "SELECT b.id, b.page_id, b.parent_id, b.position, b.content, b.format, b.collapsed, b.created_at, b.updated_at
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             WHERE blocks_fts MATCH ?1
               AND b.page_id NOT IN (SELECT page_id FROM trash)
               AND b.page_id NOT IN (SELECT page_id FROM archive)
               AND b.page_id NOT IN (
                   SELECT id FROM pages WHERE folder_id IN (SELECT folder_id FROM folder_trash)
                      OR folder_id IN (SELECT folder_id FROM folder_archive)
               )
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![fts_query, limit], |row| {
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

    // Bug #6: trashed/archived page content must not appear in search.
    #[test]
    fn test_fts_excludes_trashed_and_archived() {
        let db = Database::open_in_memory().unwrap();
        let trashed = db.create_page("Trashed", None, false, None, "user").unwrap();
        db.create_block(&trashed.id, "launch codes secret", None, None, "user").unwrap();
        let archived = db.create_page("Archived", None, false, None, "user").unwrap();
        db.create_block(&archived.id, "launch codes secret", None, None, "user").unwrap();
        let live = db.create_page("Live", None, false, None, "user").unwrap();
        db.create_block(&live.id, "launch codes secret", None, None, "user").unwrap();

        db.trash_page(&trashed.id).unwrap();
        db.archive_page(&archived.id).unwrap();

        let results = db.search("launch codes", None).unwrap();
        assert_eq!(results.len(), 1, "only the live page's block should match");
        assert_eq!(results[0].page_id, live.id);
    }

    // Bug #7: punctuation must not raise an FTS syntax error.
    #[test]
    fn test_fts_handles_punctuation() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "use C++ for speed", None, None, "user").unwrap();

        // These previously raised "fts5: syntax error"; now they return cleanly.
        assert!(db.search("C++", None).is_ok());
        assert!(db.search("\"unterminated", None).is_ok());
        assert!(db.search("foo:bar", None).is_ok());
        assert!(db.search("*", None).is_ok());
        // And a literal phrase still matches.
        let results = db.search("C++", None).unwrap();
        assert_eq!(results.len(), 1);
    }
}
